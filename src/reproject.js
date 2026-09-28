'use strict';
// Project restructuring engine — recluster a profile's sessions into projects
// using CHEAP models (not Claude), interactively and reversibly.
//
// Motivation (approved with the user, 2026-09-12): a profile can accumulate dozens
// of sessions that logically belong to different projects (e.g. one vacancy = one
// recruiting project), but were all created before the projects abstraction or under
// the wrong project. Re-sorting them by hand is Claude-expensive and error-prone.
// This engine does the classification with several passes of a cheap/free model and
// leaves Claude only for orchestration + talking to the user.
//
// Non-negotiable rules baked in here (product-owner constraints):
//   1. NOTHING moves on disk without an explicit apply({confirm:true}).
//   2. Every apply writes a LEDGER (prior projectId per session) → fully reversible
//      via revertPlan(). No silent, unrecoverable mutation.
//   3. Classification uses cheap models (REPROJECT_MODEL, default deepseek/deepseek-chat).
//      Model is swappable so we can move to free models later without touching logic.
//   4. Iteration state is durable on disk (projects/.reproject-state.json) so the loop
//      survives a crash / SIGTERM and the user can refine "as many cycles as they want".
//
// This module is PURE logic + I/O helpers. The MCP tool layer (tools/06-reproject.js)
// turns it into reproject_preview / reproject_apply / reproject_revert.

const fs = require('fs');
const path = require('path');
const { atomicJson } = require('./atomic-json');

const projects = require('./projects');

const STATE_FILE = '.reproject-state.json';
const LEDGER_FILE = '.reproject-ledger.json';
// gemini-2.5-flash: fast, accurate at Russian clustering, cheap. deepseek-chat was
// the original default but it both UNDER-split (everything → one "file_management"
// cluster) and ran 4× slower (49s vs 11s per 20 sessions) in live testing.
// Free-tier slugs (:free) 404 on this OpenRouter account — so cheap+good wins.
const DEFAULT_MODEL = process.env.REPROJECT_MODEL || 'google/gemini-2.5-flash';
// Consolidation/naming can use an even cheaper tier; override independently if wanted.
const CONSOLIDATE_MODEL = process.env.REPROJECT_CONSOLIDATE_MODEL || DEFAULT_MODEL;

// ── Profile / session I/O ─────────────────────────────────────────────────────

function sessionIndexPath(profileRoot) {
  return path.join(profileRoot, 'sessions.json');
}
function sessionFilePath(profileRoot, id) {
  return path.join(profileRoot, 'sessions', `${id}.json`);
}
function stateFilePath(profileRoot) {
  return path.join(profileRoot, 'projects', STATE_FILE);
}
function ledgerPath(profileRoot) {
  return path.join(profileRoot, 'projects', LEDGER_FILE);
}

function readIndex(profileRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionIndexPath(profileRoot), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.sessions)) return raw.sessions;
    return Object.values(raw);
  } catch {
    return [];
  }
}

// Compact digest of a session for the classifier: head (goal) + tail (outcome),
// heavily clipped so a whole profile fits in one cheap-model prompt.
function digestSession(profileRoot, meta, { headMsgs = 2, tailMsgs = 3, perMsg = 400 } = {}) {
  let messages = [];
  try {
    const s = JSON.parse(fs.readFileSync(sessionFilePath(profileRoot, meta.id), 'utf8'));
    messages = Array.isArray(s.messages) ? s.messages : [];
  } catch {
    /* fall back to index-level snippets */
  }
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, perMsg);
  let lines;
  if (messages.length === 0) {
    lines = [meta.topic, meta.lastUserMessage, meta.lastAssistantSnippet].filter(Boolean).map(clip);
  } else {
    const picked = messages.length <= headMsgs + tailMsgs
      ? messages
      : [...messages.slice(0, headMsgs), ...messages.slice(-tailMsgs)];
    lines = picked.map(m => `${m.role === 'user' ? 'U' : 'A'}: ${clip(m.content)}`);
  }
  return {
    id: meta.id,
    topic: String(meta.topic || '').slice(0, 120),
    projectId: meta.projectId || null,
    messageCount: meta.messageCount || messages.length || 0,
    lastAt: meta.lastAt || 0,
    digest: lines.join('\n').slice(0, 1400),
  };
}

function gatherSessions(profileRoot, opts = {}) {
  return readIndex(profileRoot).map(m => digestSession(profileRoot, m, opts));
}

// ── Cheap model call (service-LLM ladder, src/service-llm.js) ─────────────────

async function callModel({ system, user, apiKey, timeoutMs = 60000 }) {
  const serviceLlm = require('./service-llm');
  if (!serviceLlm.available(apiKey)) throw new Error('no LLM key (OpenCode Go / OPENROUTER_API_KEY) — cheap-model classification unavailable');
  const r = await serviceLlm.serviceChat({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    json: true, maxTokens: 4000, timeoutMs, apiKey, source: 'reproject',
  });
  if (!r) throw new Error('reproject: no service-llm rung answered');
  return r.value;
}

// Cheap models sometimes wrap JSON in prose/markdown — extract the first balanced object.
function parseJsonLoose(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* try to extract */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* give up */ }
  }
  throw new Error('Model did not return parseable JSON');
}

// ── Cycle 1: assign each session a raw cluster ────────────────────────────────

const CLUSTER_SYSTEM = [
  'Ты классифицируешь рабочие сессии пользователя по проектам.',
  'Проект — это одна связная линия работы (например: одна вакансия/найм, одна выставка, одна разработка).',
  'Тебе дают критерий группировки от пользователя и список сессий (id + краткая выжимка).',
  'Верни СТРОГО JSON: {"assignments":[{"id","cluster","name","type","confidence","reason"}]}.',
  '- cluster: короткий стабильный ключ кластера (латиница/цифры/дефис), одинаковый для сессий одного проекта.',
  '- name: человекочитаемое имя проекта на языке сессий.',
  `- type: один из ${projects.selectableTypesPrompt()}.`,
  '- confidence: 0..1.',
  '- reason: 1 короткая фраза почему.',
  'Не выдумывай факты. Одинаковые проекты обязаны иметь одинаковый cluster.',
].join('\n');

async function clusterSessions(sessions, criteria, opts = {}) {
  const chunkSize = opts.chunkSize || 40;
  const assignments = [];
  for (let i = 0; i < sessions.length; i += chunkSize) {
    const chunk = sessions.slice(i, i + chunkSize);
    const user = [
      `Критерий группировки от пользователя: ${criteria || 'одна линия работы = один проект; для рекрутинга одна вакансия = один проект'}`,
      '',
      'Сессии:',
      ...chunk.map(s => `--- id=${s.id} (msgs=${s.messageCount})\ntopic: ${s.topic}\n${s.digest}`),
    ].join('\n');
    const out = await callModel({ system: CLUSTER_SYSTEM, user, model: opts.model || DEFAULT_MODEL, apiKey: opts.apiKey });
    for (const a of (out.assignments || [])) {
      if (a && a.id) assignments.push(a);
    }
  }
  return assignments;
}

// ── Cycle 2: consolidate near-duplicate clusters into canonical projects ──────

const CONSOLIDATE_SYSTEM = [
  'Ты сводишь черновые кластеры сессий в НАСТОЯЩИЕ проекты по критерию пользователя.',
  'Черновой кластер обычно = одна сессия/одна тема. Твоя задача — собрать в один проект ВСЕ кластеры,',
  'которые по критерию относятся к одной единице работы (напр. одна вакансия/наём: поиск кандидатов,',
  'контакты, анализ ЗП, правки бота, КП по этой вакансии — это ОДИН проект, а не пять).',
  'Тебе дают критерий, и по каждому кластеру: ключ, имя, тип, число сессий и выжимку содержания.',
  'Опирайся на СОДЕРЖАНИЕ, а не только на имя — разные формулировки одной вакансии/линии работы объединяй.',
  'Верни СТРОГО JSON: {"map":{"<исходный cluster>":"<канонический cluster>"},"projects":[{"cluster","name","type"}]}.',
  `Канонический cluster — латиница/цифры/дефис. name — самое ясное имя проекта. type — ${projects.selectableTypes().join('|')}.`,
  'Цель — компактная структура по критерию. Объединяй охотно; раздельно оставляй только явно НЕсвязанные линии работы.',
].join('\n');

async function consolidateClusters(assignments, sessions = [], criteria = '', opts = {}) {
  const byId = new Map((sessions || []).map(s => [s.id, s]));
  const byCluster = new Map();
  for (const a of assignments) {
    const k = a.cluster || 'unassigned';
    if (!byCluster.has(k)) byCluster.set(k, { cluster: k, name: a.name || k, type: a.type || 'generic', count: 0, sample: '' });
    const c = byCluster.get(k);
    c.count++;
    // Keep a representative content snippet so the merger can judge semantic sameness,
    // not just name-duplication (the over-split fix): richest session wins the sample slot.
    const s = byId.get(a.id);
    if (s) {
      const snip = String(s.topic || '') + ' — ' + String(s.digest || '').replace(/\s+/g, ' ');
      if (snip.length > c.sample.length) c.sample = snip.slice(0, 320);
    }
  }
  const raw = [...byCluster.values()];
  // Nothing to merge → identity map.
  if (raw.length <= 1) {
    return { map: Object.fromEntries(raw.map(r => [r.cluster, r.cluster])), projects: raw };
  }
  const user = [
    `Критерий группировки от пользователя: ${criteria || 'одна линия работы = один проект; для рекрутинга одна вакансия = один проект'}`,
    '',
    'Черновые кластеры:',
    ...raw.map(r => `- ${r.cluster} | "${r.name}" | ${r.type} | ${r.count} сессий\n    содержание: ${r.sample || '(нет)'}`),
  ].join('\n');
  let out;
  try {
    out = await callModel({ system: CONSOLIDATE_SYSTEM, user, model: opts.model || CONSOLIDATE_MODEL, apiKey: opts.apiKey });
  } catch {
    out = null; // consolidation is best-effort; fall back to identity
  }
  const map = (out && out.map) || Object.fromEntries(raw.map(r => [r.cluster, r.cluster]));
  const projects = (out && Array.isArray(out.projects) && out.projects.length)
    ? out.projects
    : raw.map(r => ({ cluster: r.cluster, name: r.name, type: r.type }));
  // Ensure every source cluster has a mapping.
  for (const r of raw) if (!map[r.cluster]) map[r.cluster] = r.cluster;
  return { map, projects };
}

// ── Build a plan (structured, non-destructive) ────────────────────────────────

function buildPlan(profileRoot, sessions, assignments, consolidation) {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const existing = projects.listProjects(profileRoot);
  // canonical cluster -> project bucket
  const buckets = new Map();
  const projMeta = new Map((consolidation.projects || []).map(p => [p.cluster, p]));
  const unassigned = [];

  for (const s of sessions) {
    const a = assignments.find(x => x.id === s.id);
    // Literal cluster "unassigned" from the model is the unassigned bucket, not a
    // real project — otherwise file-upload/empty sessions become a fake "Unassigned"
    // folder (seen live: 7 sessions with undefined topic → a phantom project).
    if (!a || !a.cluster || /^unassigned$/i.test(String(a.cluster))) {
      unassigned.push({
        id: s.id,
        topic: s.topic,
        reason: (a && a.reason) ? a.reason : 'модель не отнесла сессию ни к одному проекту',
      });
      continue;
    }
    const canon = consolidation.map[a.cluster] || a.cluster;
    if (!buckets.has(canon)) {
      const pm = projMeta.get(canon) || { name: a.name || canon, type: a.type || 'generic' };
      buckets.set(canon, {
        cluster: canon,
        name: pm.name || a.name || canon,
        type: pm.type || a.type || 'generic',
        sessionIds: [],
        confidences: [],
        members: [], // per-session detail for the report
      });
    }
    const b = buckets.get(canon);
    b.sessionIds.push(s.id);
    const conf = typeof a.confidence === 'number' ? a.confidence : null;
    if (conf != null) b.confidences.push(conf);
    b.members.push({ id: s.id, topic: s.topic, confidence: conf, reason: a.reason || '' });
  }

  const plannedProjects = [...buckets.values()].map(b => {
    // Match to an existing project by (type + slug) so we re-tag instead of duplicating.
    const slug = `${b.type}-${projects.slugify(b.name)}`;
    const match = existing.find(e => e.id === slug || e.id.startsWith(slug + '-'));
    const avgConf = b.confidences.length ? b.confidences.reduce((x, y) => x + y, 0) / b.confidences.length : null;
    const minConf = b.confidences.length ? Math.min(...b.confidences) : null;
    // Sessions the model was unsure about — these are the "ambiguous fit to this folder".
    const weakMembers = b.members
      .filter(m => m.confidence != null && m.confidence < 0.6)
      .sort((x, y) => (x.confidence || 0) - (y.confidence || 0));
    // Clarity of the folder itself: how cleanly its sessions belong here.
    //   clear    — everything confidently in one line of work (a good, obvious folder)
    //   mixed    — mostly fits but a few sessions are borderline (check those)
    //   weak     — low average / single lonely session → the folder itself is doubtful
    let clarity;
    if (avgConf == null) clarity = 'weak';
    else if (avgConf >= 0.75 && weakMembers.length === 0) clarity = 'clear';
    else if (avgConf >= 0.55) clarity = 'mixed';
    else clarity = 'weak';
    if (b.sessionIds.length === 1 && (avgConf == null || avgConf < 0.85)) clarity = 'weak';
    return {
      cluster: b.cluster,
      name: b.name,
      type: b.type,
      existingProjectId: match ? match.id : null,
      sessionCount: b.sessionIds.length,
      sessionIds: b.sessionIds,
      memberTopics: b.members.map(m => ({ id: m.id, topic: m.topic || m.id })),
      avgConfidence: avgConf == null ? null : Math.round(avgConf * 100) / 100,
      minConfidence: minConf == null ? null : Math.round(minConf * 100) / 100,
      clarity,
      weakMembers: weakMembers.map(m => ({ ...m, confidence: m.confidence == null ? null : Math.round(m.confidence * 100) / 100 })),
    };
  }).sort((a, b) => b.sessionCount - a.sessionCount);

  const warnings = [];
  if (unassigned.length) warnings.push(`${unassigned.length} сессий не классифицированы — останутся без проекта.`);
  const weakProjects = plannedProjects.filter(p => p.clarity === 'weak');
  if (weakProjects.length) warnings.push(`${weakProjects.length} проект(ов) со спорной границей — модель не уверена, что это отдельная линия работы.`);

  return {
    generatedAt: null, // stamped by caller (Date.now unavailable in some harnesses)
    totalSessions: sessions.length,
    projects: plannedProjects,
    unassigned,
    warnings,
  };
}

// ── Render a human report ─────────────────────────────────────────────────────

const CLARITY = {
  clear: { icon: '🟢', label: 'чёткая папка', note: 'все сессии уверенно про одно и то же — папку можно принимать как есть.' },
  mixed: { icon: '🟡', label: 'в основном ок, есть спорные', note: 'ядро сессий подходит, но пару сессий стоит глянуть глазами (ниже помечены).' },
  weak: { icon: '🔴', label: 'спорная папка', note: 'модель не уверена, что это отдельная линия работы (низкая уверенность или одинокая сессия). Возможно, это часть другого проекта или наоборот две разные темы в одной куче.' },
};

function renderReport(plan) {
  const L = [];
  L.push('# Предлагаемая структура проектов');
  L.push('');

  // ── Что это и как читать ────────────────────────────────────────────────
  L.push('## Что произошло');
  L.push('Я прошёлся по всем сессиям профиля дешёвой моделью-классификатором (не Claude — несколько быстрых проходов) и сгруппировал их в **проекты**. Проект = одна связная линия работы: одна вакансия, одна выставка, одна разработка. Каждой сессии модель поставила проект и **уверенность** (0–1) — насколько ей очевидно, что сессия относится именно сюда.');
  L.push('');
  L.push('**Ничего пока не перемещено** — это только предложение. Смотрим, где границы папок хорошие, а где спорные, правим критерий и повторяем сколько нужно. Применение (когда одобрите) полностью обратимо.');
  L.push('');
  L.push('**Как читать статус папки:**');
  L.push(`- ${CLARITY.clear.icon} **${CLARITY.clear.label}** — ${CLARITY.clear.note}`);
  L.push(`- ${CLARITY.mixed.icon} **${CLARITY.mixed.label}** — ${CLARITY.mixed.note}`);
  L.push(`- ${CLARITY.weak.icon} **${CLARITY.weak.label}** — ${CLARITY.weak.note}`);
  L.push('');

  const clear = plan.projects.filter(p => p.clarity === 'clear').length;
  const mixed = plan.projects.filter(p => p.clarity === 'mixed').length;
  const weak = plan.projects.filter(p => p.clarity === 'weak').length;
  L.push(`**Итого:** ${plan.totalSessions} сессий → ${plan.projects.length} проектов (${CLARITY.clear.icon} ${clear} чётких · ${CLARITY.mixed.icon} ${mixed} со спорными · ${CLARITY.weak.icon} ${weak} спорных) · без проекта: ${plan.unassigned.length}.`);
  L.push('');
  L.push('---');
  L.push('');

  // ── Проекты ─────────────────────────────────────────────────────────────
  for (const p of plan.projects) {
    const c = CLARITY[p.clarity] || CLARITY.mixed;
    const tag = p.existingProjectId ? `существующая папка \`${p.existingProjectId}\`` : '**новая папка**';
    const conf = p.avgConfidence == null ? 'уверенность: н/д' : `уверенность ${p.avgConfidence}`;
    L.push(`## ${c.icon} ${p.name}`);
    L.push(`тип: ${p.type} · ${p.sessionCount} сессий · ${conf} · ${tag}`);
    L.push(`_${c.label}: ${c.note}_`);
    if (p.weakMembers && p.weakMembers.length) {
      L.push('');
      L.push('Сессии, которые сюда легли неоднозначно (проверь — возможно, им место в другом проекте):');
      for (const m of p.weakMembers.slice(0, 8)) {
        const why = m.reason ? ` — ${m.reason}` : '';
        L.push(`- «${m.topic || m.id}» (уверенность ${m.confidence ?? '—'})${why}`);
      }
    }
    L.push('');
  }

  // ── Без проекта ─────────────────────────────────────────────────────────
  if (plan.unassigned.length) {
    L.push('---');
    L.push(`## ⚪ Без проекта (${plan.unassigned.length})`);
    L.push('Модель не смогла отнести эти сессии ни к одной линии работы — останутся без папки, пока не уточним критерий:');
    for (const u of plan.unassigned.slice(0, 10)) {
      L.push(`- «${u.topic || u.id}»${u.reason ? ` — ${u.reason}` : ''}`);
    }
    L.push('');
  }

  // ── Что дальше ──────────────────────────────────────────────────────────
  L.push('---');
  if (plan.warnings.length) {
    L.push('**На что обратить внимание:**');
    for (const w of plan.warnings) L.push(`- ${w}`);
    L.push('');
  }
  L.push('**Дальше:**');
  L.push('- Всё нравится → скажите «применяй» (перепривяжу сессии к папкам, обратимо — откат одной командой).');
  L.push('- Что-то не так → скажите, что именно (напр. «разбей X по заказчикам» / «объедини Y и Z» / «это не отдельный проект»), уточню критерий и пересоберу.');
  return L.join('\n');
}

// ── Apply / revert (reversible) ───────────────────────────────────────────────

// Top-level files that belong to the PROJECT ITSELF (identity/config), never to an
// individual session — these stay put when a project's artifacts are merged elsewhere.
const PROJECT_META_FILES = new Set(['project.json', 'PROFILE.md', 'agent-project-notes.md']);

function listFilesRecursive(dir, base = dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (dir === base && PROJECT_META_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listFilesRecursive(full, base));
    else out.push(full);
  }
  return out;
}

function pruneEmptyDirs(dir, base = dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), base);
  }
  if (dir === base) return;
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
}

// A project's artifacts (interviews/, applylink/, site/, data/, criteria.md, …) live
// under its own projects/<id>/ folder, keyed by cwd — not by session. So relocating a
// SESSION only makes sense without breaking links when the project it's leaving is
// fully vacated (every one of its sessions moved) to exactly one destination: only then
// do we know the whole artifact tree should follow. Partial moves / fan-out to several
// destinations are left untouched and reported as a warning — merging file trees blind
// risks silently scattering a shared artifact folder across unrelated projects.
// Update gtd/*.json records whose projectDir points into a project folder that
// was vacated/moved by this apply. Mirrors the retag logic for sessions.json:
// old path is preserved in staleProjectDir for reversibility, projectDir is
// repointed to the new project folder resolved from the session's final project.
function syncGtdRecords(profileRoot, sessionMoves) {
  const gtdDir = path.join(profileRoot, 'gtd');
  const actions = [];
  if (!fs.existsSync(gtdDir)) return actions;
  const moveTo = new Map(sessionMoves.map(mv => [mv.id, mv.to]));
  const byOldDir = new Map(sessionMoves.map(mv => [mv.from, mv.to])); // from-project → to-project
  for (const f of fs.readdirSync(gtdDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(gtdDir, f);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    const pd = rec && rec.projectDir;
    if (!pd || fs.existsSync(pd)) continue; // live path — nothing to do
    // Resolve new project: prefer the session's explicit move, else same old project.
    const sid = rec.sessionId;
    const newPid = (sid && moveTo.get(sid)) || (sid && (() => {
      const meta = moveTo.has(sid) ? null : null; // sessionId not in moves → fall through
      return meta;
    })()) || null;
    let target = null;
    if (sid && moveTo.has(sid)) {
      target = path.join(profileRoot, 'projects', moveTo.get(sid));
    } else {
      // No direct move for this session — repoint only if its old dir matches a
      // vacated project that itself moved wholesale.
      for (const [fromId, toId] of byOldDir) {
        if (pd === projects.projectDir(profileRoot, fromId)) { target = projects.projectDir(profileRoot, toId); break; }
      }
    }
    if (!target) { actions.push({ kind: 'gtd-stale', file: f, projectDir: pd, warning: 'не удалось определить новый проект — осталось указывать на мёртвый путь' }); continue; }
    rec.staleProjectDir = pd;
    rec.projectDir = target;
    atomicJson(fp, rec);
    actions.push({ kind: 'gtd-sync', file: f, from: pd, to: target });
  }
  return actions;
}

function planFolderMoves(profileRoot, index, sessionMoves) {
  const moveTo = new Map(sessionMoves.map(mv => [mv.id, mv.to]));
  const finalProjectId = new Map(index.map(m => [m.id, moveTo.has(m.id) ? moveTo.get(m.id) : (m.projectId || null)]));
  const remaining = new Map();
  for (const pid of finalProjectId.values()) if (pid) remaining.set(pid, (remaining.get(pid) || 0) + 1);

  const destsByFrom = new Map();
  for (const mv of sessionMoves) {
    if (!mv.from || mv.from === mv.to) continue;
    if (!destsByFrom.has(mv.from)) destsByFrom.set(mv.from, new Set());
    destsByFrom.get(mv.from).add(mv.to);
  }

  const folderMoves = [];
  const warnings = [];
  for (const [from, dests] of destsByFrom) {
    if (remaining.get(from)) {
      warnings.push(`Проект «${from}» не опустел (остались другие сессии) — артефакты (папки) остаются на месте, сессии просто перепривязаны.`);
      continue;
    }
    if (dests.size > 1) {
      warnings.push(`Сессии проекта «${from}» разъехались по ${dests.size} новым проектам — артефакты НЕ перенесены автоматически (неясно, куда), перенеси вручную при необходимости.`);
      continue;
    }
    folderMoves.push({ from, to: [...dests][0] });
  }
  return { folderMoves, warnings };
}

// Physically merge one project's artifact files into another's, file-by-file (so a
// partially-populated destination doesn't get clobbered). Conflicts (same relative path
// already exists at destination) are left in place at the source and reported, never
// overwritten. Returns the ledger entries needed to revert.
function mergeProjectFolder(profileRoot, fromId, toId) {
  const fromDir = projects.projectDir(profileRoot, fromId);
  const toDir = projects.projectDir(profileRoot, toId);
  const moved = [];
  const conflicts = [];
  for (const srcPath of listFilesRecursive(fromDir)) {
    const rel = path.relative(fromDir, srcPath);
    const destPath = path.join(toDir, rel);
    if (fs.existsSync(destPath)) {
      conflicts.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(srcPath, destPath);
    moved.push({ from: srcPath, to: destPath });
  }
  pruneEmptyDirs(fromDir);
  return { moved, conflicts };
}

// Re-tag sessions to their planned projects. Creates new projects as needed.
// Writes a ledger of prior projectId per session (and any physical folder moves) so
// revertPlan() can undo everything — including moving artifact files back.
function applyPlan(profileRoot, plan, { dryRun = true, now = Date.now() } = {}) {
  const index = readIndex(profileRoot);
  const byId = new Map(index.map(m => [m.id, m]));
  const actions = [];
  const ledger = { at: now, moves: [] };

  // Resolve/ensure a project id for each planned project.
  const projectIdFor = new Map();
  for (const p of plan.projects) {
    let id = p.existingProjectId;
    if (!id) {
      if (dryRun) {
        id = `${p.type}-${projects.slugify(p.name)}`; // predicted id
        actions.push({ kind: 'create-project', id, name: p.name, type: p.type, dryRun: true });
      } else {
        const meta = projects.createProject(profileRoot, { name: p.name, type: p.type }, { now });
        id = meta.id;
        actions.push({ kind: 'create-project', id, name: p.name, type: p.type });
      }
    }
    projectIdFor.set(p, id);
  }

  // Re-tag sessions.
  for (const p of plan.projects) {
    const pid = projectIdFor.get(p);
    for (const sid of p.sessionIds) {
      const meta = byId.get(sid);
      const prev = meta ? (meta.projectId || null) : null;
      if (prev === pid) continue;
      ledger.moves.push({ id: sid, from: prev, to: pid });
      actions.push({ kind: 'retag', id: sid, from: prev, to: pid, dryRun });
      if (!dryRun && meta) {
        meta.projectId = pid;
        // mirror into the per-session file if present
        try {
          const fp = sessionFilePath(profileRoot, sid);
          const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
          s.projectId = pid;
          atomicJson(fp, s);
        } catch { /* session file may not exist */ }
      }
    }
  }

  // Keep GTD records (gtd/*.json) in sync: they hold an absolute projectDir that
  // the tick loop reads as the ONE source of truth (checklist.md location). A missed
  // update here leaves dead paths after any project move (bug found 2026-09-23:
  // 37/40 GTD records pointed at pre-reorg folders → readChecklist() returned null).
  if (!dryRun && ledger.moves.length) {
    const gtdActions = syncGtdRecords(profileRoot, ledger.moves);
    ledger.gtdSyncs = gtdActions.filter(a => a.kind === 'gtd-sync').map(a => ({ file: a.file, from: a.from, to: a.to }));
    actions.push(...gtdActions);
  }

  // A vacated project's artifact folder (interviews/, applylink/, site/, data/, …)
  // follows its sessions IF AND ONLY IF the whole project emptied out into one single
  // destination — see planFolderMoves() for why partial/fan-out cases are skipped.
  const { folderMoves: plannedFolderMoves, warnings: folderWarnings } = planFolderMoves(profileRoot, index, ledger.moves);
  ledger.folderMoves = [];
  ledger.pinMoves = [];
  for (const fm of plannedFolderMoves) {
    if (dryRun) {
      actions.push({ kind: 'merge-folder', from: fm.from, to: fm.to, dryRun: true });
      continue;
    }
    // A chat pinned to the merged-away project follows it to the destination (#1318) —
    // otherwise the pin silently keeps feeding new sessions into the emptied project.
    const pinMoves = projects.repointPins(profileRoot, fm.from, fm.to, { now });
    ledger.pinMoves.push(...pinMoves);
    for (const pm of pinMoves) actions.push({ kind: 'repoint-pin', ...pm });
    const { moved, conflicts } = mergeProjectFolder(profileRoot, fm.from, fm.to);
    ledger.folderMoves.push(...moved);
    actions.push({ kind: 'merge-folder', from: fm.from, to: fm.to, filesMoved: moved.length, conflicts });
    if (conflicts.length) {
      folderWarnings.push(`Проект «${fm.from}» → «${fm.to}»: ${conflicts.length} файл(ов) не перенесены — уже есть в «${fm.to}» с тем же именем (оставлены в «${fm.from}»).`);
    }
  }

  if (!dryRun) {
    atomicJson(sessionIndexPath(profileRoot), index, { space: 2 });
    // PUSH onto the ledger stack — never overwrite. A second apply used to replace the
    // first apply's ledger, so the first reorg could no longer be reverted and its moved
    // artifact files had no way back (one mechanism behind "reorg cut my folders").
    const stack = readLedgerStack(profileRoot);
    stack.push(ledger);
    writeLedgerStack(profileRoot, stack);
  }

  return { dryRun, actions, moves: ledger.moves.length, ledgerWritten: !dryRun, warnings: folderWarnings };
}

// Ledger file holds a STACK of applies ({ stack: [oldest … newest] }). Legacy files
// (a single { at, moves, folderMoves } object) are read as a one-element stack.
function readLedgerStack(profileRoot) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ledgerPath(profileRoot), 'utf8')); } catch { return []; }
  if (raw && Array.isArray(raw.stack)) return raw.stack;
  if (raw && Array.isArray(raw.moves)) return [raw];
  return [];
}
function writeLedgerStack(profileRoot, stack) {
  atomicJson(ledgerPath(profileRoot), { stack }, { space: 2 });
}

// Undo the MOST RECENT apply only (LIFO). Earlier applies stay on the stack and can be
// reverted by calling again — so N applies are undone by N reverts, in reverse order.
function revertPlan(profileRoot, { now = Date.now() } = {}) {
  const stack = readLedgerStack(profileRoot);
  if (!stack.length) return { reverted: 0, error: 'no ledger found — nothing to revert' };
  const ledger = stack[stack.length - 1];
  const index = readIndex(profileRoot);
  const byId = new Map(index.map(m => [m.id, m]));
  let n = 0;
  for (const mv of (ledger.moves || [])) {
    const meta = byId.get(mv.id);
    if (!meta) continue;
    meta.projectId = mv.from;
    n++;
    try {
      const fp = sessionFilePath(profileRoot, mv.id);
      const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
      s.projectId = mv.from;
      atomicJson(fp, s);
    } catch { /* best-effort */ }
  }
  atomicJson(sessionIndexPath(profileRoot), index, { space: 2 });

  // Move artifact files back to their original project folder. Anything that can't be
  // moved back is REPORTED (path + reason), never silently skipped.
  let foldersReverted = 0;
  const notReverted = [];
  for (const fm of [...(ledger.folderMoves || [])].reverse()) {
    try {
      if (!fs.existsSync(fm.to)) { notReverted.push({ file: fm.to, reason: 'missing at destination' }); continue; }
      if (fs.existsSync(fm.from)) { notReverted.push({ file: fm.to, reason: `original path occupied: ${fm.from}` }); continue; }
      fs.mkdirSync(path.dirname(fm.from), { recursive: true });
      fs.renameSync(fm.to, fm.from);
      foldersReverted++;
    } catch (e) { notReverted.push({ file: fm.to, reason: e.message }); }
  }

  // Restore chat pins that apply moved along with a merged project.
  let pinsReverted = 0;
  for (const pm of (ledger.pinMoves || [])) {
    const fp = path.join(projects.projectsRoot(profileRoot), pm.file);
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (rec.id !== pm.to) continue; // user re-pinned since — don't clobber
      atomicJson(fp, { id: pm.from, at: now });
      pinsReverted++;
    } catch { /* best-effort */ }
  }

  // Restore gtd/*.json projectDir that apply repointed.
  let gtdReverted = 0;
  for (const g of (ledger.gtdSyncs || [])) {
    const fp = path.join(profileRoot, 'gtd', g.file);
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (rec.projectDir !== g.to) continue; // changed since — don't clobber
      rec.projectDir = g.from;
      delete rec.staleProjectDir;
      atomicJson(fp, rec);
      gtdReverted++;
    } catch { /* best-effort */ }
  }

  // Pop the consumed entry (so a double-revert undoes the PREVIOUS apply, not this one
  // twice) and keep an audit copy of what was reverted.
  stack.pop();
  try { atomicJson(`${ledgerPath(profileRoot)}.reverted-${now}`, ledger, { space: 2 }); } catch { /* ignore */ }
  if (stack.length) writeLedgerStack(profileRoot, stack);
  else { try { fs.unlinkSync(ledgerPath(profileRoot)); } catch { /* ignore */ } }
  return { reverted: n, foldersReverted, gtdReverted, pinsReverted, notReverted, remainingApplies: stack.length };
}

// ── State persistence (iterative refinement across cycles/crashes) ────────────

function saveState(profileRoot, state) {
  atomicJson(stateFilePath(profileRoot), state, { space: 2 });
}
function loadState(profileRoot) {
  try { return JSON.parse(fs.readFileSync(stateFilePath(profileRoot), 'utf8')); } catch { return null; }
}

// ── One full preview cycle (gather → cluster → consolidate → plan) ────────────

async function preview(profileRoot, { criteria, apiKey, model, now = Date.now() } = {}) {
  const sessions = gatherSessions(profileRoot);
  if (!sessions.length) return { error: 'no sessions found for this profile' };
  const assignments = await clusterSessions(sessions, criteria, { apiKey, model });
  const consolidation = await consolidateClusters(assignments, sessions, criteria, { apiKey });
  const plan = buildPlan(profileRoot, sessions, assignments, consolidation);
  plan.generatedAt = now;
  const state = { criteria: criteria || null, at: now, plan, assignments };
  saveState(profileRoot, state);
  return { plan, report: renderReport(plan) };
}

// ── Manual adjustment of a saved plan (the interactive edit step) ─────────────
// The user looks at a preview and says "this session belongs to project X, that
// project is misnamed". This edits the SAVED plan in place (durable, re-rendered,
// still nothing moves on disk until apply). Moves re-point a session to another
// cluster (creating it if needed); renames fix cluster name/type. After edits the
// consolidation is identity (the user's clusters are canonical — no re-merging).
function adjustPlan(profileRoot, { moves = [], renames = [] } = {}, { now = Date.now() } = {}) {
  const state = loadState(profileRoot);
  if (!state || !state.plan) return { error: 'no saved plan — run preview first' };
  const sessions = gatherSessions(profileRoot);
  const assignments = (state.assignments || []).map(a => ({ ...a }));
  const byId = new Map(assignments.map(a => [a.id, a]));

  // Apply renames first so moves to a renamed cluster inherit name/type.
  const nameByCluster = new Map();
  const typeByCluster = new Map();
  for (const r of renames) {
    if (!r || !r.cluster) continue;
    if (r.name) nameByCluster.set(r.cluster, r.name);
    if (r.type) typeByCluster.set(r.cluster, r.type);
  }

  // Apply moves: re-point a session to another (possibly new) cluster.
  for (const m of moves) {
    if (!m || !m.sessionId || !m.toCluster) continue;
    let a = byId.get(m.sessionId);
    if (!a) {
      const s = sessions.find(x => x.id === m.sessionId);
      if (!s) continue;
      a = { id: s.id, topic: s.topic, cluster: m.toCluster, name: m.toCluster, type: 'generic', confidence: 1, reason: 'перенесено пользователем' };
      assignments.push(a);
      byId.set(a.id, a);
    }
    a.cluster = m.toCluster;
    if (m.name) { a.name = m.name; nameByCluster.set(m.toCluster, m.name); }
    if (m.type) { a.type = m.type; typeByCluster.set(m.toCluster, m.type); }
    a.confidence = 1;
    a.reason = 'перенесено пользователем';
  }

  // Apply renames to every assignment in the renamed cluster.
  for (const a of assignments) {
    if (nameByCluster.has(a.cluster)) a.name = nameByCluster.get(a.cluster);
    if (typeByCluster.has(a.cluster)) a.type = typeByCluster.get(a.cluster);
  }

  // Identity consolidation — after manual edits the user's clusters are canonical.
  const clusters = [];
  const seen = new Set();
  for (const a of assignments) {
    if (!a.cluster || seen.has(a.cluster)) continue;
    seen.add(a.cluster);
    clusters.push({
      cluster: a.cluster,
      name: nameByCluster.get(a.cluster) || a.name || a.cluster,
      type: typeByCluster.get(a.cluster) || a.type || 'generic',
    });
  }
  const consolidation = {
    map: Object.fromEntries(clusters.map(c => [c.cluster, c.cluster])),
    projects: clusters,
  };

  const plan = buildPlan(profileRoot, sessions, assignments, consolidation);
  plan.generatedAt = now;
  const newState = { ...state, criteria: state.criteria || null, at: now, plan, assignments };
  saveState(profileRoot, newState);
  return { plan, report: renderReport(plan), adjusted: true };
}

module.exports = {
  DEFAULT_MODEL,
  gatherSessions,
  digestSession,
  clusterSessions,
  consolidateClusters,
  buildPlan,
  renderReport,
  applyPlan,
  revertPlan,
  preview,
  adjustPlan,
  saveState,
  loadState,
  callModel,
  parseJsonLoose,
  stateFilePath,
  ledgerPath,
  readLedgerStack,
  syncGtdRecords,
};
