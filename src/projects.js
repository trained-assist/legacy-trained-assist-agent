'use strict';
// Project abstraction — the durable "container" that a session belongs to.
//
// Model (approved with the user, 2026-09-11):
//   profile (user workspace)  ─┬─> PROJECT ─┬─> session
//                              │            └─> session   (many sessions per project)
//                              └─> PROJECT ...
//
// This inverts the old broken model where a "session" was just a Telegram chat thread
// with nowhere to live, so artifacts piled up in the workspace root (interviews/,
// expo-pipeline/, vacancy-drafts/, dozens of *.bak files …). Now every session is
// anchored to a project folder, and that folder is the session's cwd.
//
// Layout (FLAT — projects are typed by a name prefix, never nested by domain):
//   <workDir>/projects/<id>/
//       project.json           meta {id,name,type,createdAt,lastAt}
//       PROFILE.md             domain rules for this project (hand-authored, merged into system prompt)
//       agent-project-notes.md agent-LEARNED notes scoped to this project (mirrors profile-tier
//                               agent-notes.md; not seeded — Claude writes it as it learns).
//       <type scaffold>       recruiting → interviews/{transcripts,analysis}, criteria.md, applylink/
//   <workDir>/projects/active-<chatId>.json   which project this chat is currently in
//
// Project TYPE is declared by a prefix at creation time (user's "recruiting: name" idea):
//   "recruiting: Менеджер продаж"  -> {type:'recruiting', name:'Менеджер продаж'}
//   "Проект без типа"              -> {type:'generic',    name:'Проект без типа'}

const fs = require('fs');
const path = require('path');
const { atomicJson } = require('./atomic-json');
const { siblingModules } = require('./domains/sibling-lib');

const PROJECTS_DIR = 'projects';
const META_FILE = 'project.json';
const PROFILE_FILE = 'PROFILE.md';
const NOTES_FILE = 'agent-project-notes.md';
const MAX_NAME = 120;

// ── Type registry ─────────────────────────────────────────────────────────────
// Each type declares: matching prefixes, a human label, the folder scaffold to roll
// out on creation, and a PROFILE.md seed with domain rules that stack with the persona.
// Start with `recruiting` (structure matches the existing interview/applylink paths so
// migration is a move, not a rewrite). Domain siblings add their own types by the same
// schema in src/project-types.js (sales-skill: `expo`, #1717) — merged below.
// `hint` marks a user-selectable type: shown to the project-classifier LLMs
// (project-summary, reproject) and accepted by POST /web/project-create. Reserved
// types (bugs) carry none.
const TYPES = {
  recruiting: {
    label: 'Рекрутинг',
    hint: 'подбор/вакансии/интервью',
    prefixes: ['recruiting', 'рекрутинг', 'hr', 'вакансия', 'найм'],
    dirs: ['interviews', 'interviews/transcripts', 'interviews/analysis', 'applylink'],
    seedFiles: {
      'criteria.md': '# Критерии оценки (эталон заказчика)\n\nОпиши здесь профиль ДА / красные флаги. Используется interview_analyze для всех разборов этого проекта.\n',
    },
    profile:
      '# Домен проекта: Рекрутинг\n\n' +
      '- Тип работы: подбор кандидатов на конкретную вакансию.\n' +
      '- Разборы интервью — через interview_analyze; эталон — criteria.md этого проекта.\n' +
      '- Отклики/форма — applylink/ этого проекта.\n' +
      '- Все транскрипты и анализы кладём в interviews/, не в корень профиля.\n',
  },
  bugs: {
    label: 'Баги и фичи',
    // Canonical id — one reserved project per profile (owner's voice: "создаётся сессия
    // в папке Bugs and Features"), never a fresh id-<n> per report like other types.
    id: 'bugs-and-features',
    prefixes: [
      'bugs', 'bug', 'баги', 'баг', 'фичи', 'фича', 'features', 'feature',
      'bugs and features', 'bug and features',
    ],
    dirs: ['reports', '_processed', 'collector'],
    seedFiles: {
      'reports/README.md':
        '# Контракт: reports/\n\n' +
        'Одна папка на один инцидент/фичу: `reports/<YYYY-MM-DD>-<slug>/`.\n\n' +
        '- `report.json` — `{id, kind:"bug"|"feature", title, summary, status:"open", severity, area, createdAt, sessionId, attachments:[]}`\n' +
        '- `transcript.md` — сырые сообщения пользователя (текст + транскрипты голоса)\n' +
        '- `attachments/` — скопированные скриншоты/фото/файлы\n' +
        '- `evidence/` — логи/сниппеты\n\n' +
        'На каждый отчёт обязательна одна строка в `../index.jsonl` (главный фид сборщика).\n',
      'collector/README.md':
        '# Контракт: как сборщик читает этот проект\n\n' +
        'Сборщик — отдельный сервис (`src/bugs-collector.js`, крона `scripts/bugs-collector-cron.sh`),\n' +
        'вне доступа пользователей. Он:\n\n' +
        '1. Читает `../index.jsonl` (append-only, 1 строка = 1 отчёт).\n' +
        '2. Берёт записи со `status:"open"`, которых ещё нет в `collector/state.json`.\n' +
        '3. Ждёт «тишины»: папка отчёта не менялась ~3 минуты (не хватает недописанный отчёт).\n' +
        '4. Составляет подробную GitHub-заявку (что/кто/зачем/что хочет пользователь) и создаёт issue.\n' +
        '5. Помечает обработанное в `collector/state.json` (`{processed:{<id>:{issue,url,at}}}`).\n\n' +
        '`index.jsonl` сборщик НЕ перезаписывает — он append-only. Если `collector/` удалить,\n' +
        'он пересоздаётся при следующем прогоне, а дубли отсекаются по маркеру в теле issue.\n\n' +
        'Формат строки индекса: `{id, kind, title, dir, status, createdAt, sessionId}`.\n',
    },
    profile:
      '# Домен проекта: Приём баг/фич\n\n' +
      '- Ты — приёмщик багов и предложений. Вход — сессия из нескольких сообщений (текст, голос,\n' +
      '  скриншоты), накопленных пользователем.\n' +
      '- Классифицируй: баг или фича.\n' +
      '- Для КАЖДОГО инцидента создай `reports/<дата>-<slug>/`: `report.json` (см. reports/README.md),\n' +
      '  `transcript.md` (сырые сообщения), `attachments/` (скопируй вложения), `evidence/`.\n' +
      '- Допиши одну строку в `index.jsonl` — это фид сборщика. Не создавай GitHub issues.\n' +
      '- Ничего не удаляй; структурируй как считаешь полезным, «от души».\n',
  },
  generic: {
    label: 'Проект',
    hint: 'всё остальное',
    prefixes: ['project', 'проект'],
    dirs: [],
    seedFiles: {},
    profile: '# Проект\n\nДоменных правил пока нет. Добавь их сюда — они попадут в системный промпт сессий этого проекта.\n',
  },
};

for (const { id, mod } of siblingModules('src/project-types.js')) {
  for (const [key, def] of Object.entries(mod)) {
    if (TYPES[key]) console.warn(`[projects] ${id} sibling type "${key}" ignored: core already defines it`);
    else TYPES[key] = def;
  }
}

// User-selectable type keys, `generic` last (the classifier prompts' fallback).
function selectableTypes() {
  const keys = Object.keys(TYPES).filter(k => TYPES[k].hint);
  return [...keys.filter(k => k !== 'generic'), 'generic'];
}

// "recruiting" (подбор/вакансии/интервью), "expo" (…), "generic" (всё остальное)
function selectableTypesPrompt() {
  return selectableTypes().map(k => `"${k}" (${TYPES[k].hint})`).join(', ');
}

function typeOf(key) {
  return TYPES[key] || TYPES.generic;
}

// ── Naming ──────────────────────────────────────────────────────────────────

// Split a "type: name" input into {type, name}. Unknown/absent prefix -> generic.
function parseTypedName(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^([\p{L}]+)\s*[:：]\s*(.+)$/u);
  if (m) {
    const key = m[1].toLowerCase();
    for (const [type, def] of Object.entries(TYPES)) {
      if (type === key || def.prefixes.includes(key)) {
        return { type, name: m[2].trim().slice(0, MAX_NAME) };
      }
    }
  }
  return { type: 'generic', name: raw.slice(0, MAX_NAME) };
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'project';
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function projectsRoot(workDir) {
  return path.join(workDir, PROJECTS_DIR);
}
function projectDir(workDir, id) {
  return path.join(projectsRoot(workDir), id);
}
function metaPath(workDir, id) {
  return path.join(projectDir(workDir, id), META_FILE);
}
function profilePath(workDir, id) {
  return path.join(projectDir(workDir, id), PROFILE_FILE);
}
function notesPath(workDir, id) {
  return path.join(projectDir(workDir, id), NOTES_FILE);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function getProject(workDir, id) {
  if (!workDir || !id) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(workDir, id), 'utf8'));
  } catch {
    return null;
  }
}

// Resolve the cwd for a bound project, self-healing when its folder is gone — e.g.
// archived/merged by reproject.js's restructuring since a session last touched it, or any
// other out-of-band move. meta.json lives inside the project's own dir, so if we can't
// read it the dir doesn't exist either; callers must treat a null return as "this binding
// is stale, clear it" rather than falling back to whatever cwd happened to be set before
// (that silent fallback was the bug — a session could keep running in the wrong/default
// folder with no explanation after a reorg).
function resolveProjectDir(workDir, id) {
  if (!id || !getProject(workDir, id)) return null;
  return projectDir(workDir, id);
}

// List projects (meta only), most-recently-touched first.
// `audience` (default 'default') scopes the list the same way as session-store.listSessions
// — a project with no `audience` field (every project created before this feature existed)
// counts as 'default'. Pass audience: null explicitly to bypass filtering (internal/debug
// tools only — never an HTTP path reachable by an external bot).
function listProjects(workDir, audience = 'default') {
  const root = projectsRoot(workDir);
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
  const all = ids
    .map(id => getProject(workDir, id))
    .filter(Boolean);
  const filtered = audience === null
    ? all
    : all.filter(p => (p.audience || 'default') === audience);
  return filtered.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

// Re-sort a project list by usage (session count) descending, most-recent as tiebreaker.
// `countByProject` ({id: count}) lives in session-store, not here, so callers that have
// it (server.js) pass it in; without it we keep the recency-only order from listProjects.
function sortByUsage(list, countByProject) {
  if (!countByProject) return list;
  return [...list].sort((a, b) => {
    const ca = countByProject[a.id] || 0, cb = countByProject[b.id] || 0;
    if (cb !== ca) return cb - ca;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
}

// Create a project from a raw "type: name" string (or explicit {name,type}).
// Rolls out the type scaffold + PROFILE.md. Idempotent by id: existing project is returned.
// `audience` (default 'default') stamps the project so listProjects/decideNewSessionProject
// can scope it to the bot/surface that created it (see AUDIENCE-SCOPE-SPEC).
function createProject(workDir, input, { now = Date.now(), audience } = {}) {
  const parsed = typeof input === 'string'
    ? parseTypedName(input)
    : { type: input.type || 'generic', name: input.name || 'project' };
  const def = typeOf(parsed.type);
  const aud = audience || 'default';

  // Singleton types (e.g. bugs -> bugs-and-features) declare a fixed canonical id: reuse
  // the existing project instead of minting a sibling. Other types: <type>-<slug>[-n].
  let id;
  if (def.id) {
    id = def.id;
    const existing = getProject(workDir, id);
    if (existing) return existing;
  } else {
    const base = `${parsed.type}-${slugify(parsed.name)}`;
    id = base;
    let n = 2;
    // If a real project already lives at `id`, make a fresh sibling instead of colliding.
    while (getProject(workDir, id)) id = `${base}-${n++}`;
  }

  const dir = projectDir(workDir, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of def.dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const [rel, content] of Object.entries(def.seedFiles)) {
    const fp = path.join(dir, rel);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  }
  const pfp = profilePath(workDir, id);
  if (!fs.existsSync(pfp)) fs.writeFileSync(pfp, def.profile);

  const meta = { id, name: parsed.name, type: parsed.type, label: def.label, audience: aud, createdAt: now, lastAt: now };
  atomicJson(metaPath(workDir, id), meta, { space: 2 });
  return meta;
}

function touchProject(workDir, id, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return;
  meta.lastAt = now;
  try { atomicJson(metaPath(workDir, id), meta, { space: 2 }); } catch { /* best-effort */ }
}

// ── Name + 3-sense summary (durable, LLM-generated, regenerated as project grows) ──
// The folder/id is immutable; only the display `name` + `summary` change. `nameLocked`
// is set when the user renames by hand — auto-naming then leaves the name alone but may
// still refresh the summary. `summarySessionCount` records how many sessions the summary
// reflects, so we know when it's stale.
function setProjectSummary(workDir, id, { name, summary, type } = {}, sessionCount, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return false;
  if (name && !meta.nameLocked) meta.name = name;
  if (summary) meta.summary = summary;
  if (type && meta.type === 'generic' && TYPES[type]) { meta.type = type; meta.label = typeOf(type).label; }
  if (typeof sessionCount === 'number') meta.summarySessionCount = sessionCount;
  meta.summaryAt = now;
  try { atomicJson(metaPath(workDir, id), meta, { space: 2 }); return true; }
  catch { return false; }
}

// True when a project's summary is missing or the session count grew since we last made it.
function needsSummary(meta, sessionCount) {
  if (!meta) return false;
  if (!meta.summary || !meta.summary.start) return true;
  if (typeof sessionCount === 'number') return (meta.summarySessionCount || 0) !== sessionCount;
  return false;
}

// Manual rename — display-only, and locks the name against auto-naming.
function renameProject(workDir, id, name, { now = Date.now() } = {}) {
  const meta = getProject(workDir, id);
  if (!meta) return null;
  meta.name = String(name || '').trim().slice(0, MAX_NAME) || meta.name;
  meta.nameLocked = true;
  meta.lastAt = now;
  try { atomicJson(metaPath(workDir, id), meta, { space: 2 }); } catch { /* best-effort */ }
  return meta;
}

// Reversible "delete": move the project folder under projects/_archive/ instead of rm.
// Returns the archive path, or null if nothing moved. Never removes session data.
function archiveProject(workDir, id) {
  const dir = projectDir(workDir, id);
  if (!fs.existsSync(dir)) return null;
  const archiveRoot = path.join(projectsRoot(workDir), '_archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  let dest = path.join(archiveRoot, id);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(archiveRoot, `${id}-${n++}`);
  fs.renameSync(dir, dest);
  return dest;
}

// Canonical "Bugs and Features" reserved project — finds the existing bugs-type project,
// or creates the singleton if none exists yet. Idempotent; safe to call on every
// /bug_or_feature invocation.
function bugsProject(workDir, { now = Date.now(), audience } = {}) {
  const existing = listProjects(workDir, audience || 'default').find(p => p.type === 'bugs');
  if (existing) return existing;
  return createProject(workDir, { type: 'bugs', name: TYPES.bugs.label }, { now, audience });
}

// ── Active project per chat ─────────────────────────────────────────────────

// `audience` scopes the active-project pointer per bot/surface sharing the same chatId,
// same pattern as session-store's _currentSessionFile. Falsy or 'default' → EXACTLY the
// pre-existing filename (note: the chatId-less fallback already used the literal string
// 'default' before audience existed — preserved as-is so that path never moves).
function _activePath(workDir, chatId, audience, threadId = null) {
  const suffix = Number.isInteger(threadId) && threadId > 0 ? `-${threadId}` : '';
  if (!audience || audience === 'default') {
    return path.join(projectsRoot(workDir), `active-${chatId || 'default'}${suffix}.json`);
  }
  return path.join(projectsRoot(workDir), `active-${audience}-${chatId || 'default'}${suffix}.json`);
}
function _readActive(workDir, chatId, audience, threadId = null) {
  try { return JSON.parse(fs.readFileSync(_activePath(workDir, chatId, audience, threadId), 'utf8')); } catch { return null; }
}
function getActiveProjectId(workDir, chatId, audience, threadId = null) {
  const rec = _readActive(workDir, chatId, audience, threadId);
  return rec && rec.id && getProject(workDir, rec.id) ? rec.id : null; // ignore stale pointer
}

// The chat's PINNED project (issue #1312, "чат = проект") lives in its OWN file, separate
// from the "last used" pointer above (#1318): the runner rewrites active-*.json on every
// run, so sharing one file made the pin depend on read-modify-write ordering. pin-*.json
// is written ONLY by an explicit user choice (menu pick, «➕ Новый проект», /project).
function _pinPath(workDir, chatId, audience, threadId = null) {
  const suffix = Number.isInteger(threadId) && threadId > 0 ? `-${threadId}` : '';
  if (!audience || audience === 'default') {
    return path.join(projectsRoot(workDir), `pin-${chatId || 'default'}${suffix}.json`);
  }
  return path.join(projectsRoot(workDir), `pin-${audience}-${chatId || 'default'}${suffix}.json`);
}
function _readPin(workDir, chatId, audience, threadId = null) {
  try { return JSON.parse(fs.readFileSync(_pinPath(workDir, chatId, audience, threadId), 'utf8')); } catch { /* fall through */ }
  // Legacy (#1316 shipped the pin as pinned:true inside active-*.json) — read-through.
  const rec = _readActive(workDir, chatId, audience, threadId);
  return rec && rec.pinned ? { id: rec.id, at: rec.at } : null;
}
// null if none / archived (a dead pin is ignored, never bound to).
function getPinnedProjectId(workDir, chatId, audience, threadId = null) {
  const rec = _readPin(workDir, chatId, audience, threadId);
  return rec && rec.id && getProject(workDir, rec.id) ? rec.id : null;
}
function setPinnedProjectId(workDir, id, chatId, { now = Date.now(), audience, threadId = null } = {}) {
  try {
    fs.mkdirSync(projectsRoot(workDir), { recursive: true });
    atomicJson(_pinPath(workDir, chatId, audience, threadId), { id, at: now });
  } catch (e) {
    console.warn('[projects] setPinnedProjectId:', e.message);
  }
}
// Explicit «сними закрепление» — the chat goes back to automatic project choice. Also drops
// a legacy pinned:true flag in active-*.json, otherwise _readPin would read it through and
// the pin would silently come back. Returns the id that was pinned (null if none).
function clearPinnedProjectId(workDir, chatId, { audience, threadId = null } = {}) {
  const had = getPinnedProjectId(workDir, chatId, audience, threadId);
  try { fs.unlinkSync(_pinPath(workDir, chatId, audience, threadId)); } catch { /* no pin file */ }
  const cur = _readActive(workDir, chatId, audience, threadId);
  if (cur && cur.pinned) {
    try { atomicJson(_activePath(workDir, chatId, audience, threadId), { id: cur.id, at: cur.at }); }
    catch (e) { console.warn('[projects] clearPinnedProjectId legacy:', e.message); }
  }
  return had;
}
// Every pin file of the profile that points at `fromId` → `toId` (projects reorg merged
// the pinned project away). Returns [{ file, from, to }] for the reorg ledger.
function repointPins(workDir, fromId, toId, { now = Date.now() } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(projectsRoot(workDir)); } catch { return out; }
  for (const name of names) {
    const isPin = /^pin-.+\.json$/.test(name);
    const isLegacy = /^active-.+\.json$/.test(name);
    if (!isPin && !isLegacy) continue;
    const fp = path.join(projectsRoot(workDir), name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    if (!rec || rec.id !== fromId || (isLegacy && !rec.pinned)) continue;
    const target = isPin ? fp : path.join(projectsRoot(workDir), name.replace(/^active-/, 'pin-'));
    if (isLegacy && fs.existsSync(target)) continue; // a real pin file wins over legacy
    atomicJson(target, { id: toId, at: now });
    out.push({ file: path.basename(target), from: fromId, to: toId, createdFromLegacy: isLegacy || undefined });
  }
  return out;
}
// "Last used" bookkeeping (runner binding on every run). `pinned:true` = explicit user
// choice → ALSO pins the chat. Bookkeeping never touches the pin file, so continuing an
// old session from another project can't re-pin the chat.
function setActiveProjectId(workDir, id, chatId, { now = Date.now(), audience, pinned = false, threadId = null } = {}) {
  try {
    fs.mkdirSync(projectsRoot(workDir), { recursive: true });
    // Legacy pin (pinned:true inside active-*.json) → move it to its own file before this
    // write drops the flag.
    if (!fs.existsSync(_pinPath(workDir, chatId, audience, threadId))) {
      const cur = _readActive(workDir, chatId, audience, threadId);
      if (cur && cur.pinned && cur.id) atomicJson(_pinPath(workDir, chatId, audience, threadId), { id: cur.id, at: cur.at || now });
    }
    atomicJson(_activePath(workDir, chatId, audience, threadId), { id, at: now });
    if (pinned) setPinnedProjectId(workDir, id, chatId, { now, audience, threadId });
    touchProject(workDir, id, { now });
  } catch (e) {
    console.warn('[projects] setActiveProjectId:', e.message);
  }
}

// ── Binding decision for a NEW session ──────────────────────────────────────
// The bot NEVER asks "which project?" (owner decision 2026-09-26: the question annoyed
// users more than a wrong bucket costs — misplaced sessions are fixed later by reproject).
// Every chat has a CURRENT project; silence = it stays what it was.
//   { action:'auto',   project, pinned? }  pinned → last used in this chat → default «Все подряд»
//                                          (legacy «Основной») → the profile's only project
//   { action:'create', suggestType }       nothing to reuse → create the default «Все подряд»
// A CONTINUING session never calls this — it keeps the project stored on the session.
const DEFAULT_PROJECT_NAME = 'Все подряд';
const DEFAULT_PROJECT_NAMES = [DEFAULT_PROJECT_NAME, 'Основной'];
function findDefaultProject(projects) {
  return projects.find(p => (p.type || 'generic') === 'generic' && DEFAULT_PROJECT_NAMES.includes(p.name)) || null;
}
function decideNewSessionProject(workDir, chatId, countByProject, audience = 'default', threadId = null) {
  const projects = sortByUsage(listProjects(workDir, audience), countByProject);
  const pinnedId = getPinnedProjectId(workDir, chatId, audience, threadId);
  const pinned = pinnedId && projects.find(p => p.id === pinnedId);
  if (pinned) return { action: 'auto', project: pinned, pinned: true };
  const activeId = getActiveProjectId(workDir, chatId, audience, threadId);
  const active = activeId && projects.find(p => p.id === activeId);
  if (active) return { action: 'auto', project: active };
  const def = findDefaultProject(projects) || (projects.length === 1 ? projects[0] : null);
  if (def) return { action: 'auto', project: def };
  return { action: 'create', suggestType: 'generic', name: DEFAULT_PROJECT_NAME };
}

// Which project a run binds to + whether that pins the chat — the runner's decision,
// pure over disk state so it's testable at the run level (#1318). `continuingProjectId`
// is the project stored on an existing session (undefined for a new session).
//   continuing session        → its own project (or the last-used one), never pins
//   projectId + projectPicked → the user's explicit choice → pins
//   projectId alone           → the gateway resolved it itself → binds; pins only if nothing is pinned
//   newProjectName            → «➕ Новый проект» → creates + pins
//   otherwise                 → decideNewSessionProject; the result becomes the chat's
//                               current project (pinned), so it stays put until /project
function resolveRunProject(workDir, { chatId, audience = 'default', continuing = false, continuingProjectId = null,
  projectId = null, projectPicked = false, newProjectName = null, threadId = null } = {}) {
  if (continuing) return { projectId: continuingProjectId || getActiveProjectId(workDir, chatId, audience, threadId), pin: false };
  // No pin yet → whatever the gateway resolved becomes the chat's current project.
  if (projectId && getProject(workDir, projectId)) return { projectId, pin: projectPicked === true || !getPinnedProjectId(workDir, chatId, audience, threadId) };
  if (newProjectName) return { projectId: createProject(workDir, newProjectName, { audience }).id, pin: true };
  const d = decideNewSessionProject(workDir, chatId, undefined, audience, threadId);
  if (d.action === 'auto') return { projectId: d.project.id, pin: !d.pinned };
  return { projectId: createProject(workDir, { type: 'generic', name: DEFAULT_PROJECT_NAME }, { audience }).id, pin: true };
}

// PROFILE.md text for merging into the system prompt (null if none).
function profileText(workDir, id) {
  if (!id) return null;
  try {
    const t = fs.readFileSync(profilePath(workDir, id), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

// agent-project-notes.md text — same shape as profile-tier agent-notes.md, but scoped to
// one project. Never seeded (unlike PROFILE.md): only exists once Claude/Hermes writes
// something project-specific it learned, so an empty file never pollutes the prompt.
function notesText(workDir, id) {
  if (!id) return null;
  try {
    const t = fs.readFileSync(notesPath(workDir, id), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

module.exports = {
  TYPES,
  selectableTypes,
  selectableTypesPrompt,
  parseTypedName,
  slugify,
  projectsRoot,
  projectDir,
  profilePath,
  notesPath,
  getProject,
  resolveProjectDir,
  listProjects,
  sortByUsage,
  createProject,
  bugsProject,
  touchProject,
  getActiveProjectId,
  getPinnedProjectId,
  setPinnedProjectId,
  clearPinnedProjectId,
  repointPins,
  setActiveProjectId,
  DEFAULT_PROJECT_NAME,
  decideNewSessionProject,
  resolveRunProject,
  profileText,
  notesText,
  setProjectSummary,
  needsSummary,
  renameProject,
  archiveProject,
};
