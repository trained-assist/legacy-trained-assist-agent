'use strict';
// Playbook reachability (issue #1756): «доехал ли плейбук» до живого юзера.
//
// Schema/compile/conformance each pass on their own, yet the chain can still break
// between them — 2026-09-28 the exhibition playbook was valid, its sibling mounted and
// provisioned, but no prompt route led the agent to playbook_run(<id>). This module is
// the one check over the whole chain:
//
//   resolve / schema-scope   PlaybookStore.resolve() finds the file at a level it may live
//   compile                  compilePlaybook() builds a plan out of it
//   sibling-registration     owning sibling is in skill-catalog AND DEFAULT_SIBLING_REPOS
//   dispatch                 how the agent learns about the playbook from a plain request:
//     A1  a prompt domain names playbook_run + "<id>"                  strong
//     A2  a prompt domain names <id> next to "playbook/плейбук"        warn
//     B   config/audience-default-playbooks.json maps an audience to it warn
//     E   dev-task auto-offer (ENGINEERING_FAMILY + DEV_TASK_RE)       warn
//     C   a tools module (list_skills meta catalog) names it           warn
//     D   none of the above                                            FAIL
//   no-shadow                the id lives at one level only (else edits hit a dead copy)
//   sections / sibling-mounted / section-enabled / tools-visible / pointer-in-prompt
//                            skills.resolve() for one profile: is it visible to THAT profile
//   audience-map             optional: the id is the default for the asked audience
//
// Pure over its inputs: fs reads only, no network, no LLM. Every input is injectable so
// tests (and a domain repo's CI, which checks core out next to itself) run it hermetically.
// Rows: {gate, status: 'pass'|'warn'|'fail', detail}. ok = no 'fail' row.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCAL_SERVER = 'trained-skills';
// Renamed checkouts: the catalog keeps the old repo name (see playbook-store DEFAULT_SIBLING_REPOS).
const REPO_ALIASES = { 'software-engineering-playbooks': 'trained-assist-engineering' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Does catalog module key `m` belong to `server`? Local modules are bare file names.
function moduleOf(server, m) {
  return server === LOCAL_SERVER ? !m.includes('/') : m.startsWith(server + '/');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// tools/*.js dirs to scan for route C: core + every sibling checkout present on disk.
function defaultToolDirs(catalog, siblingRepoDir) {
  const dirs = [path.join(REPO_ROOT, 'src', 'mcp-skills', 'tools')];
  for (const s of Object.values(catalog.servers || {})) {
    if (s.kind !== 'sibling' || !s.repo) continue;
    let base = null;
    try { base = siblingRepoDir(s.repo); } catch { /* hh sibling lookup may throw off-host */ }
    const d = base ? path.join(base, 'src', 'mcp-skills', 'tools') : null;
    if (d && fs.existsSync(d)) dirs.push(d);
  }
  return dirs;
}

function checkPlaybookReachability(id, opts = {}) {
  const rows = [];
  const add = (gate, ok, detail, { warn = false, soft = false } = {}) =>
    rows.push({ gate, status: ok ? (warn ? 'warn' : 'pass') : (soft ? 'warn' : 'fail'), detail });

  const { PlaybookStore, DEFAULT_SIBLING_REPOS } = require('./playbook-store');
  const { compilePlaybook } = require('./playbook-compiler');
  const catalogLib = require('./skills/catalog');
  const { resolve: resolveSkills } = require('./skills/resolve');

  const profileId = opts.profileId || null;
  const audience = opts.audience || null;
  const store = opts.store || new PlaybookStore({ profileId });
  const catalog = opts.catalog || catalogLib.loadCatalog();
  const domains = opts.domains || require('./prompt-domains').loadDomains();
  const audienceMap = opts.audienceMap
    || readJson(path.join(REPO_ROOT, 'config', 'audience-default-playbooks.json'), {}).playbooks || {};
  const devFamily = opts.devFamily || require('./dev-task-playbook-suggestion').ENGINEERING_FAMILY;
  const siblingRepos = opts.siblingRepos || DEFAULT_SIBLING_REPOS;
  const toolDirs = opts.toolDirs || defaultToolDirs(catalog, catalogLib.siblingRepoDir);

  // ── resolve + schema/scope ─────────────────────────────────────────────────
  let pb = null;
  try {
    pb = store.resolve(id);
  } catch (e) {
    add('resolve', false, String(e.message).slice(0, 220));
  }
  if (!pb && rows.length === 0) add('resolve', false, `playbook "${id}" не найден ни на одном уровне (profile/sibling/system)`);
  if (pb) {
    add('resolve', true, `${pb.source} — ${pb.path}`);
    add('schema-scope', true, `scope=${pb.scope}, v${pb.version}`);
  }

  // ── compile ────────────────────────────────────────────────────────────────
  if (pb) {
    try {
      const plan = compilePlaybook(pb, { goal: 'reachability-probe' });
      add('compile', true, `${(pb.stages || []).length} стадий, ${(plan.items || plan.steps || []).length} шагов`);
    } catch (e) {
      add('compile', false, String(e.message).slice(0, 220));
    }
  }

  // ── ownership ──────────────────────────────────────────────────────────────
  let owningServer = null;
  if (pb) {
    const parts = pb.path.split(path.sep).map(p => REPO_ALIASES[p] || p);
    const sibling = Object.entries(catalog.servers || {}).find(([, s]) =>
      s.kind === 'sibling' && s.repo && parts.includes(s.repo));
    if (pb.source === 'sibling' && sibling) {
      const [serverId, s] = sibling;
      owningServer = serverId;
      const registered = siblingRepos.includes(s.repo);
      add('sibling-registration', registered, registered
        ? `${serverId} ← ${s.repo}: есть в skill-catalog и DEFAULT_SIBLING_REPOS`
        : `${s.repo} есть в skill-catalog, но нет в DEFAULT_SIBLING_REPOS — resolve его не увидит`);
    } else if (pb.source === 'sibling') {
      add('sibling-registration', false, `сиблинг ${pb.path} не объявлен сервером в config/skill-catalog.json — его тулы никто не смонтирует`);
    } else if (pb.source === 'system') {
      owningServer = LOCAL_SERVER;
      add('sibling-registration', true, 'system-уровень core (сиблинг не нужен)');
    } else {
      add('sibling-registration', true, `profile-уровень (${profileId}) — сиблинг не нужен`);
    }
  }

  // ── dispatch ───────────────────────────────────────────────────────────────
  const idQuoted = new RegExp(`["'\`]${escapeRe(id)}["'\`]`);
  const nearPlaybook = line => /playbook|плейбук/i.test(line);
  const pointerHits = new Set();
  const mentionHits = new Set();
  for (const d of domains) {
    for (const line of String(d.body || '').split('\n')) {
      if (idQuoted.test(line) && /playbook_run/.test(line)) pointerHits.add(d.name);
      else if (line.includes(id) && nearPlaybook(line)) mentionHits.add(d.name);
    }
  }
  const audienceHits = Object.entries(audienceMap).filter(([, v]) => v === id).map(([k]) => k);
  const devOffer = devFamily.includes(id);
  const metaHits = [];
  for (const dir of toolDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch { continue; }
    for (const f of files) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (txt.split('\n').some(l => l.includes(id) && nearPlaybook(l))) metaHits.push(f);
    }
  }
  const weak = [
    mentionHits.size ? `A2 промпт-домены: ${[...mentionHits].join(', ')}` : null,
    audienceHits.length ? `B audience-map: ${audienceHits.join(', ')}` : null,
    devOffer ? 'E автооффер dev-задач (только при совпадении DEV_TASK_RE)' : null,
    metaHits.length ? `C tools: ${metaHits.join(', ')}` : null,
  ].filter(Boolean);
  if (pointerHits.size) {
    add('dispatch', true, [`A1 playbook_run в промпт-доменах: ${[...pointerHits].join(', ')}`, ...weak].join('; '));
  } else if (weak.length) {
    add('dispatch', true, `${weak.join('; ')}; нет прямого playbook_run("${id}") в промпт-домене`, { warn: true });
  } else {
    add('dispatch', false, 'нет маршрута: ни playbook_run(<id>) в prompt-domains/*.md, ни audience-map, ни автооффера, ни упоминания в tools — из обычной просьбы агент плейбук не предложит');
  }

  // ── no-shadow ──────────────────────────────────────────────────────────────
  if (typeof store._levels === 'function') {
    const levels = store._levels().filter(l => fs.existsSync(path.join(l.dir, `${id}.json`)));
    if (levels.length > 1) {
      add('no-shadow', false, `id лежит на ${levels.length} уровнях (${levels.map(l => `${l.kind}:${l.dir}`).join(', ')}) — верхний затеняет остальные, правки в нижних молча не применяются`, { soft: true });
    } else {
      add('no-shadow', true, `одна копия${levels[0] ? ` (${levels[0].kind})` : ''}`);
    }
  }

  // ── sections: who can switch the playbook's tools on ───────────────────────
  const owningSections = [];
  if (owningServer) {
    for (const [sid, sec] of Object.entries(catalog.sections || {})) {
      const mods = (sec.modules || []).filter(m => moduleOf(owningServer, m));
      if (mods.length) owningSections.push({ sid, mods, promptDomains: sec.promptDomains || [] });
    }
    add('sections', owningSections.length > 0, owningSections.length
      ? owningSections.map(s => `${s.sid} (${s.mods.length} модулей)`).join('; ')
      : `ни одна секция skill-catalog не содержит модулей ${owningServer} — их никто не включит`);
  }
  // Gate on the section whose prompt domain carries the A1 pointer, not on any section of
  // the owning server: another section (e.g. recruiting/company) may own the same sibling
  // modules and would give a false positive while the carrier section is off.
  const hardGating = pointerHits.size > 0;
  const carrier = owningSections.filter(s => s.promptDomains.some(d => pointerHits.has(d)));
  const gated = hardGating && carrier.length ? carrier : owningSections;

  // ── exposure for one profile ───────────────────────────────────────────────
  if (profileId && owningServer) {
    const profileSkills = opts.profileSkills !== undefined
      ? opts.profileSkills
      : catalogLib.readProfileSkills(require('./data-paths').userWorkDir(profileId));
    // Without a live probe: a sibling checkout on disk = attached, module readiness unknown
    // (resolve() then counts modules as exposed). Callers inside the agent pass real readiness.
    const readiness = opts.readiness || (() => {
      const r = {};
      for (const [serverId, s] of Object.entries(catalog.servers || {})) {
        if (s.kind !== 'sibling') continue;
        const entry = catalogLib.siblingIndexPath(catalog, serverId);
        r[serverId] = !!entry && fs.existsSync(entry);
        if (r[serverId]) r[`${serverId}/*`] = null;
      }
      return r;
    })();
    const r = resolveSkills(catalog, profileSkills, readiness);

    const mounted = owningServer === LOCAL_SERVER || r.siblings.includes(owningServer);
    add('sibling-mounted', mounted, mounted
      ? (owningServer === LOCAL_SERVER ? 'core-сервер' : `монтируются: ${r.siblings.join(', ')}`)
      : `${owningServer} не смонтирован у ${profileId} (нет в .mcp.json)`);

    if (owningSections.length) {
      const on = gated.filter(s => r.sections.includes(s.sid));
      add('section-enabled', on.length > 0, on.length
        ? `включены: ${on.map(s => s.sid).join(', ')}`
        : `у ${profileId} выключены все секции-носители (${gated.map(s => s.sid).join('/')}); skills.json enabled: ${profileSkills ? (profileSkills.enabled || []).join(', ') : 'legacy'}`,
        { soft: !hardGating });

      const gatedMods = gated.flatMap(s => s.mods);
      const hidden = gatedMods.filter(m => !r.modules.includes(m) && !r.setupOnly.includes(m));
      add('tools-visible', hidden.length === 0, hidden.length
        ? `скрыты модули: ${hidden.join(', ')}`
        : `модули открыты (${gatedMods.length}/${gatedMods.length})`, { soft: !hardGating });
    }

    if (hardGating) {
      const picked = [...pointerHits].filter(n => r.promptDomains.includes(n));
      add('pointer-in-prompt', picked.length > 0, picked.length
        ? `в системный промпт попадает: ${picked.join(', ')}`
        : `указатель есть в ${[...pointerHits].join('/')}, но домен не выбран профилю ${profileId}`);
    }
  }

  // ── audience map ───────────────────────────────────────────────────────────
  if (audience) {
    add('audience-map', audienceHits.includes(audience), audienceHits.length
      ? `дефолт для аудиторий: ${audienceHits.join(', ')} (запрошено: ${audience})`
      : `нет в audience-default-playbooks.json (запрошено: ${audience})`);
  }

  return { id, profileId, audience, ok: !rows.some(r => r.status === 'fail'), rows };
}

function formatReport(report) {
  const head = `playbook-reachability: ${report.id}`
    + (report.profileId ? `  profile=${report.profileId}` : '')
    + (report.audience ? `  audience=${report.audience}` : '');
  const lines = report.rows.map(r => `  [${r.status.toUpperCase()}] ${r.gate.padEnd(21)} ${r.detail}`);
  const failed = report.rows.filter(r => r.status === 'fail').map(r => r.gate);
  const warned = report.rows.filter(r => r.status === 'warn').length;
  lines.push(failed.length
    ? `  → FAIL (${failed.join(', ')}): плейбук не доезжает`
    : `  → OK${warned ? ` (${warned} warn)` : ''}: file → dispatch → exposure замкнута`);
  return [head, ...lines].join('\n');
}

module.exports = { checkPlaybookReachability, formatReport };
