#!/usr/bin/env node
'use strict';

// End-to-end harness for the engineering playbooks (feature / debugging / new-software).
//
// Runs against the REAL durable executor: this script only compiles a playbook into a
// plan (same path as the playbook_run MCP tool), activates it and reports; the server's
// GTD tick (every 5 min) executes the steps with real engines. Run it on the VM that
// hosts the server (same AGENT_DATA_DIR / USERS_DIR / AGENT_TOKENS_DIR).
//
// The plan carries execution_policy.level_map, so its levels run on the engines under
// test without touching the prod-wide PLAYBOOK_LEVEL_MAP. Default for e2e:
//   doctor → opencode "deepseek" (standard), master/bachelor → opencode "free".
//
//   node scripts/e2e/playbooks-e2e.js start  --playbook new-software --goal "…" [--profile playbooks-e2e] [--level-map '{…}']
//   node scripts/e2e/playbooks-e2e.js status <taskId> [--profile …]
//   node scripts/e2e/playbooks-e2e.js report <taskId> [--profile …] [--json]
//   node scripts/e2e/playbooks-e2e.js list [--profile …]
//   node scripts/e2e/playbooks-e2e.js cancel <taskId> [--profile …]
//   node scripts/e2e/playbooks-e2e.js kick                      — run one server tick now
//   node scripts/e2e/playbooks-e2e.js run <taskId> [--every 20] [--stall-min 15]
//        drive the plan: kick the tick in a loop, make this plan's waiting steps poll
//        now (their condition is still checked for real), print step transitions,
//        stop on done / failed / stall, then print the report.
//
// Quality of what the agents build is NOT the point — the point is that the process
// runs end to end and every failure is visible in the report.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { durableStore } = require(path.join(ROOT, 'src', 'gtd-controller'));
const { PlaybookStore } = require(path.join(ROOT, 'src', 'playbook-store'));
const { compilePlaybook } = require(path.join(ROOT, 'src', 'playbook-compiler'));
const { planLevelMap, resolveStepExecution } = require(path.join(ROOT, 'src', 'playbook-executor'));

const DEFAULT_PROFILE = 'playbooks-e2e';
const DEFAULT_LEVEL_MAP = {
  doctor: { engine: 'opencode', ocProfile: 'deepseek' },
  master: { engine: 'opencode', ocProfile: 'free' },
  bachelor: { engine: 'opencode', ocProfile: 'free' },
};
const E2E_PREAMBLE = 'Это автоматический e2e-тест процесса. Пользователь недоступен: НЕ спрашивай его и НЕ уходи в awaiting_user — '
  + 'принимай разумные допущения и записывай их в итог шага. ';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function findTask(store, taskId, profile) {
  const task = store.getTask(taskId, profile);
  if (task) return task;
  // accept a short id prefix
  const row = store.db.prepare('SELECT * FROM durable_tasks WHERE profile_id = ? AND id LIKE ?').get(profile, `${taskId}%`);
  if (!row) throw new Error(`plan ${taskId} not found for profile ${profile}`);
  return row;
}

function start(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const playbookId = args.playbook;
  const goal = args.goal;
  if (!playbookId || !goal) throw new Error('start needs --playbook and --goal');
  const levelMap = args['level-map'] ? JSON.parse(args['level-map']) : DEFAULT_LEVEL_MAP;

  const playbook = new PlaybookStore({ profileId: profile }).get(playbookId);
  if (!playbook) throw new Error(`playbook ${playbookId} not found (sibling repo checked out next to the agent?)`);
  const compiled = compilePlaybook(playbook, { goal: E2E_PREAMBLE + goal });
  const store = durableStore();
  const { task, items } = store.createPlan({
    profile_id: profile,
    goal: compiled.goal,
    user_value: compiled.user_value,
    acceptance_criteria: compiled.acceptance_criteria,
    items: compiled.items,
    hooks: compiled.hooks,
    playbook_id: playbook.id,
    playbook_version: playbook.version,
    execution_policy: { level_map: levelMap, e2e: true },
  });
  store.updateTask(task.id, profile, { status: 'active' });

  // Show how each step will be routed under this plan's level map.
  const map = planLevelMap({ level_map: levelMap });
  console.log(`plan ${task.id} (${playbook.id}@${playbook.version}) active for profile ${profile}`);
  for (const it of items) {
    const r = resolveStepExecution(it, { levelMap: map });
    console.log(`  ${String(it.position + 1).padStart(2)}. ${it.title}  →  ${r.executionKind === 'programmatic' ? 'programmatic' : `${r.engine}/${r.ocProfile || '-'} (${r.modelLevel}, ${r.ocRole || '-'})`}`);
  }
  console.log('\nThe server tick picks it up within ~5 min. Watch with: status / report');
}

function collect(store, task) {
  const items = store.listTaskItems(task.id, task.profile_id);
  const execs = store.db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at').all(task.id);
  const byItem = new Map();
  for (const e of execs) {
    if (!byItem.has(e.task_item_id)) byItem.set(e.task_item_id, []);
    byItem.get(e.task_item_id).push(e);
  }
  return items.map(it => {
    const ex = byItem.get(it.id) || [];
    const engines = [...new Set(ex.map(e => `${e.engine || '?'}/${e.profile || '-'}${e.model_level ? `@${e.model_level}` : ''}`))];
    const first = ex[0]; const last = ex[ex.length - 1];
    let wait = null;
    try { wait = it.wait_json ? JSON.parse(it.wait_json) : null; } catch { /* ignore */ }
    return {
      n: it.position + 1, stage: it.stage, title: it.title, status: it.status, kind: it.execution_kind,
      level: it.minimum_model_level, current_level: it.current_model_level, attempts: it.attempt_count,
      executions: ex.length, engines,
      duration_ms: first ? ((last.finished_at || Date.now()) - first.started_at) : null,
      last_error: it.last_error || (last && last.error_text) || null,
      failure_class: it.last_failure_class || null, recovery: it.last_recovery_action || null,
      wait,
      summary: stepSummary(it.evidence_json),
    };
  });
}

// The step's own «ИТОГ ШАГА» block (what later steps see), from its recorded reply.
function stepSummary(evidenceJson) {
  if (!evidenceJson) return null;
  let text = evidenceJson;
  try { const ev = JSON.parse(evidenceJson); text = ev.reply || JSON.stringify(ev); } catch { /* raw */ }
  const i = text.lastIndexOf('ИТОГ ШАГА');
  return (i >= 0 ? text.slice(i) : text).replace(/DURABLE:[^\n]*/g, '').trim().slice(0, 600) || null;
}

function status(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const store = durableStore();
  const task = findTask(store, args._[1], profile);
  const rows = collect(store, task);
  const counts = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const cur = rows.find(r => !['done', 'skipped'].includes(r.status));
  console.log(`${task.id.slice(0, 8)} ${task.playbook_id} ${task.status} | ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  if (cur) console.log(`current: ${cur.n}. ${cur.title} [${cur.status}] ${cur.engines.join(', ')}${cur.last_error ? ` — ${String(cur.last_error).slice(0, 160)}` : ''}`);
}

function report(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const store = durableStore();
  const task = findTask(store, args._[1], profile);
  const rows = collect(store, task);
  if (args.json) { console.log(JSON.stringify({ task, steps: rows }, null, 2)); return; }
  console.log(`# e2e report — ${task.playbook_id} ${task.id}`);
  console.log(`status: ${task.status} | created ${new Date(task.created_at).toISOString()}\n`);
  console.log('| # | stage | step | status | level | ran on | runs | time | error |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const lvl = r.kind === 'programmatic' ? 'prog' : `${r.level}${r.current_level && r.current_level !== r.level ? `→${r.current_level}` : ''}`;
    const err = r.last_error ? String(r.last_error).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 140) : '';
    console.log(`| ${r.n} | ${r.stage} | ${r.title} | ${r.status}${r.wait ? ' ⏳' : ''} | ${lvl} | ${r.engines.join(', ') || '—'} | ${r.executions} | ${fmtDur(r.duration_ms)} | ${err} |`);
  }
  const engineSet = new Set(rows.flatMap(r => r.engines));
  console.log(`\nengines used: ${[...engineSet].join(', ') || '—'}`);
  if (args.verbose) {
    for (const r of rows.filter(x => x.summary)) console.log(`\n## ${r.n}. ${r.title}\n${r.summary}`);
  }
}

function list(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const store = durableStore();
  for (const t of store.listTasks(profile)) {
    console.log(`${t.id}  ${t.playbook_id || '-'}  ${t.status}  ${new Date(t.created_at).toISOString()}  ${String(t.goal).replace(E2E_PREAMBLE, '').slice(0, 70)}`);
  }
}

function cancel(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const store = durableStore();
  const task = findTask(store, args._[1], profile);
  store.updateTask(task.id, profile, { status: 'cancelled' });
  console.log(`cancelled ${task.id}`);
}

function agentSecret() {
  if (process.env.AGENT_SECRET) return process.env.AGENT_SECRET;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), 'secrets.env'), 'utf8').match(/^AGENT_SECRET=(.*)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch { return null; }
}

async function kickOnce() {
  const port = process.env.PORT || 8080;
  const secret = agentSecret();
  if (!secret) throw new Error('AGENT_SECRET not in env or ~/secrets.env');
  const res = await fetch(`http://127.0.0.1:${port}/internal/gtd/tick`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`tick HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function kick() {
  const r = await kickOnce();
  console.log(`tick ok, last finish ${r.heartbeat && r.heartbeat.lastFinishAt ? new Date(r.heartbeat.lastFinishAt).toISOString() : '—'}`);
}

function snapshot(rows) {
  return rows.map(r => `${r.n}:${r.status}`).join(' ');
}

async function run(args) {
  const profile = args.profile || DEFAULT_PROFILE;
  const every = Number(args.every || 20) * 1000;
  const stallMs = Number(args['stall-min'] || 15) * 60 * 1000;
  const store = durableStore();
  const task = findTask(store, args._[1], profile);
  let last = ''; let lastChange = Date.now();
  const started = Date.now();
  for (;;) {
    // e2e acceleration: this plan's parked steps poll on the next tick instead of in
    // poll_every_sec. Their wait condition is still evaluated for real.
    store.db.prepare(`UPDATE task_items SET due_at = ? WHERE task_id = ? AND status = 'waiting'`).run(Date.now(), task.id);
    try { await kickOnce(); } catch (e) { console.log(`kick failed: ${e.message}`); }
    const t = store.getTask(task.id, profile);
    const rows = collect(store, t);
    const snap = snapshot(rows);
    if (snap !== last) {
      const cur = rows.find(r => !['done', 'skipped'].includes(r.status));
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[+${mins}m] ${t.status} | ${cur ? `${cur.n}. ${cur.title} [${cur.status}] ${cur.engines.join(', ')}${cur.last_error ? ` — ${String(cur.last_error).slice(0, 140)}` : ''}` : 'all steps finished'}`);
      last = snap; lastChange = Date.now();
    }
    if (['done', 'failed', 'cancelled'].includes(t.status)) break;
    if (rows.some(r => r.status === 'failed')) { console.log('a step failed'); break; }
    if (Date.now() - lastChange > stallMs) { console.log(`stalled ${args['stall-min'] || 15} min`); break; }
    await new Promise(res => setTimeout(res, every));
  }
  report({ ...args, verbose: true });
}

const COMMANDS = { start, status, report, list, cancel, kick, run };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = COMMANDS[args._[0]];
  if (!cmd) {
    console.error('usage: playbooks-e2e.js start|status|report|list|cancel … (see header)');
    process.exit(2);
  }
  Promise.resolve().then(() => cmd(args)).then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
}

module.exports = { DEFAULT_LEVEL_MAP, E2E_PREAMBLE, collect };
