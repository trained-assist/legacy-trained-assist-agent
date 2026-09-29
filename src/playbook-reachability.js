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
//     F   code of the owning repo launches it (a UI button calling
//         playbook_run with the quoted id, e.g. the hh recruiting hub)  warn
//     D   none of the above                                            FAIL
//   no-shadow                the id lives at one level only (else edits hit a dead copy)
//   sections / sibling-mounted / section-enabled / tools-visible / pointer-in-prompt
//                            skills.resolve() for one profile: is it visible to THAT profile
//   requires                 the playbook's own declaration {sections, tools}: every section is
//                            in skill-catalog, every tool is defined by some tools module
//   audience-map             optional: the id is the default for the asked audience
//
// With `requires` declared, exposure gates key on it (section-enabled / tools-visible are hard
// FAILs); without it they fall back to the section carrying the A1 pointer (a heuristic).
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

// tools/*.js dirs to scan (route C, requires.tools): core + every sibling checkout on disk.
// Entries are {dir, server}; a bare string (tests) is a dir of unknown server.
function defaultToolDirs(catalog, siblingRepoDir) {
  const dirs = [{ dir: path.join(REPO_ROOT, 'src', 'mcp-skills', 'tools'), server: LOCAL_SERVER }];
  for (const [serverId, s] of Object.entries(catalog.servers || {})) {
    if (s.kind !== 'sibling' || !s.repo) continue;
    let base = null;
    try { base = siblingRepoDir(s.repo); } catch { /* hh sibling lookup may throw off-host */ }
    const d = base ? path.join(base, 'src', 'mcp-skills', 'tools') : null;
    if (d && fs.existsSync(d)) dirs.push({ dir: d, server: serverId });
  }
  return dirs;
}

// Catalog module key of the file defining MCP tool `name` (`<name>: {` in a tools module).
function findToolModule(name, toolDirs) {
  const re = new RegExp(`^\\s*['"]?${escapeRe(name)}['"]?\\s*:\\s*\\{`, 'm');
  for (const { dir, server } of toolDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort(); } catch { continue; }
    for (const f of files) {
      if (re.test(fs.readFileSync(path.join(dir, f), 'utf8'))) {
        return { server, file: f, key: !server || server === LOCAL_SERVER ? f : `${server}/${f}` };
      }
    }
  }
  return null;
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
  // repoDir: a domain repo checked in its own CI, with core checked out inside it (.core).
  // Core's sibling lookup (<core>/../<repo>) misses that layout, so the repo under check is
  // read from its own checkout first: playbooks, prompt domains, tools.
  const repoDir = opts.repoDir ? path.resolve(opts.repoDir) : null;
  const store = opts.store || new PlaybookStore(repoDir ? { profileId, siblingRoots: [repoDir] } : { profileId });
  const catalog = opts.catalog || catalogLib.loadCatalog();
  const domains = opts.domains || (() => {
    const { loadDomains } = require('./prompt-domains');
    const own = repoDir && fs.existsSync(path.join(repoDir, 'src', 'prompt-domains'))
      ? loadDomains(path.join(repoDir, 'src', 'prompt-domains')) : [];
    const names = new Set(own.map(d => d.name));
    return [...own, ...loadDomains().filter(d => !names.has(d.name))];
  })();
  const audienceMap = opts.audienceMap
    || readJson(path.join(REPO_ROOT, 'config', 'audience-default-playbooks.json'), {}).playbooks || {};
  const devFamily = opts.devFamily || require('./dev-task-playbook-suggestion').ENGINEERING_FAMILY;
  const siblingRepos = opts.siblingRepos || DEFAULT_SIBLING_REPOS;
  const repoServer = repoDir && (Object.entries(catalog.servers || {})
    .find(([, s]) => s.repo === (REPO_ALIASES[path.basename(repoDir)] || path.basename(repoDir))) || [])[0];
  const toolDirs = (opts.toolDirs || [
    ...(repoDir ? [{ dir: path.join(repoDir, 'src', 'mcp-skills', 'tools'), server: repoServer || null }] : []),
    ...defaultToolDirs(catalog, catalogLib.siblingRepoDir),
  ]).map(t => (typeof t === 'string' ? { dir: t, server: null } : t));
  // Route F scans the owning repo's src/ (null → derived from the resolved file below).
  let launcherDir = opts.launcherDir !== undefined ? opts.launcherDir : null;

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
      // Declared inputs get probe values: reachability checks the route, not a run's vars.
      const vars = Object.fromEntries((pb.inputs || []).map(i => [i.name, `<${i.name}>`]));
      const plan = compilePlaybook(pb, { goal: 'reachability-probe', vars });
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
  for (const { dir } of toolDirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch { continue; }
    for (const f of files) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (txt.split('\n').some(l => l.includes(id) && nearPlaybook(l))) metaHits.push(f);
    }
  }
  if (launcherDir === null && pb && pb.source !== 'profile') {
    const repoRoot = path.dirname(path.dirname(pb.path)); // <repo>/playbooks/<id>.json
    launcherDir = path.join(repoRoot, 'src');
  }
  const launcherHits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'prompt-domains' && e.name !== 'tools') walk(full);
      } else if (/\.(c|m)?js$/.test(e.name) && idQuoted.test(fs.readFileSync(full, 'utf8'))) {
        launcherHits.push(path.relative(launcherDir, full));
      }
    }
  };
  if (launcherDir) walk(launcherDir);
  const weak = [
    mentionHits.size ? `A2 промпт-домены: ${[...mentionHits].join(', ')}` : null,
    audienceHits.length ? `B audience-map: ${audienceHits.join(', ')}` : null,
    devOffer ? 'E автооффер dev-задач (только при совпадении DEV_TASK_RE)' : null,
    metaHits.length ? `C tools: ${metaHits.join(', ')}` : null,
    launcherHits.length ? `F запуск из кода (кнопка/UI, не из чата): ${launcherHits.join(', ')}` : null,
  ].filter(Boolean);
  if (pointerHits.size) {
    add('dispatch', true, [`A1 playbook_run в промпт-доменах: ${[...pointerHits].join(', ')}`, ...weak].join('; '));
  } else if (weak.length) {
    // strict: the repo promises a chat route — only A1 counts (weak routes alone = FAIL).
    add('dispatch', !opts.strict, `${weak.join('; ')}; нет прямого playbook_run("${id}") в промпт-домене`
      + (opts.strict ? ' (--strict: нужен A1)' : ''), { warn: true });
  } else {
    add('dispatch', false, 'нет маршрута: ни playbook_run(<id>) в prompt-domains/*.md, ни audience-map, ни автооффера, ни упоминания в tools, ни запуска из кода репозитория — из обычной просьбы агент плейбук не предложит');
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

  // ── requires: the playbook's own declaration of what it needs ──────────────
  const req = pb && pb.requires ? pb.requires : null;
  const reqSections = (req && req.sections) || [];
  const reqTools = [];
  if (req) {
    const unknown = reqSections.filter(sid => !(catalog.sections || {})[sid]);
    for (const name of req.tools || []) reqTools.push({ name, mod: findToolModule(name, toolDirs) });
    const missing = reqTools.filter(t => !t.mod).map(t => t.name);
    const problems = [
      unknown.length ? `нет в skill-catalog секций: ${unknown.join(', ')}` : null,
      missing.length ? `ни один tools-модуль не определяет: ${missing.join(', ')}` : null,
    ].filter(Boolean);
    add('requires', problems.length === 0, problems.length ? problems.join('; ')
      : `секции: ${reqSections.join(', ') || '—'}; тулы: ${reqTools.map(t => `${t.name}←${t.mod.key}`).join(', ') || '—'}`);
  } else if (pb) {
    add('requires', true, 'не объявлено (секции и тулы угадываются по указателю) — объяви requires {sections, tools}', { warn: true });
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
  const declared = reqSections.length > 0;
  const hardGating = declared || pointerHits.size > 0;
  const carrier = owningSections.filter(s => s.promptDomains.some(d => pointerHits.has(d)));
  const gated = declared
    ? reqSections.filter(sid => (catalog.sections || {})[sid]).map(sid => ({
      sid, mods: (catalog.sections[sid].modules || []), promptDomains: catalog.sections[sid].promptDomains || [] }))
    : (pointerHits.size && carrier.length ? carrier : owningSections);

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
    // opts.resolved: what the live run actually resolved (workDir/.skills-resolved.json, real
    // probed readiness) — the in-agent playbook_health passes it; offline callers compute it.
    const r = opts.resolved || resolveSkills(catalog, profileSkills, readiness);

    const mounted = owningServer === LOCAL_SERVER || r.siblings.includes(owningServer);
    add('sibling-mounted', mounted, mounted
      ? (owningServer === LOCAL_SERVER ? 'core-сервер' : `монтируются: ${r.siblings.join(', ')}`)
      : `${owningServer} не смонтирован у ${profileId} (нет в .mcp.json)`);

    if (gated.length) {
      // declared sections must ALL be on; the heuristic needs any one carrier section.
      const on = gated.filter(s => r.sections.includes(s.sid));
      const off = gated.filter(s => !r.sections.includes(s.sid));
      const sectionsOk = declared ? off.length === 0 : on.length > 0;
      add('section-enabled', sectionsOk, sectionsOk
        ? `включены: ${on.map(s => s.sid).join(', ')}`
        : declared ? `у ${profileId} выключены объявленные секции: ${off.map(s => s.sid).join(', ')}`
        : `у ${profileId} выключены все секции-носители (${gated.map(s => s.sid).join('/')}); skills.json enabled: ${profileSkills ? (profileSkills.enabled || []).join(', ') : 'legacy'}`,
        { soft: !hardGating });

      // declared tools → exactly their modules; otherwise every module of the gated sections.
      const gatedMods = reqTools.length
        ? [...new Set(reqTools.filter(t => t.mod).map(t => t.mod.key))]
        : gated.flatMap(s => s.mods);
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
