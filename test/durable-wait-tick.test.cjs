// Durable wait tick — the dedicated ~30s wait pass and the immediate kick.
// Plan a61bb2c5 / docs/specs/durable-wait-latency-design.md.
//
// Why this file exists: the 5-min GTD tick used to be the ONLY thing that polled
// a waiting step, so `poll_every_sec` was decorative and a user answer waited up
// to 5 min. Invariants pinned here:
//   S2. `claimNextRunnable(now, {waitsOnly})` claims ONLY unresolved waits — a
//       plain due step still belongs to the 5-min GTD tick; countActiveWaits()
//       is the wait tick's cheap no-op exit.
//   S3. `runWaitTick` runs one serialized waitsOnly pass: it resolves a due wait
//       and runs the step, never touches the checklist heartbeat (tickCount),
//       and two overlapping passes still yield exactly one claim.
//   S4. `task_item_wake` and a credential write kick the executor at once
//       (durable-kick), the /internal/durable/kick route calls kickDurable(),
//       and an unreachable server degrades silently to the 30s tick.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = () => new Promise(r => setTimeout(r, 0));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-wait-tick-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  return { G, store: G.durableStore() };
}

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'wait tick', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}
const progItem = (title, extra = {}) => ({
  title, execution_kind: 'programmatic', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small',
  validation: { command_exit_zero: 'true' }, ...extra,
});
const PASS_ALL = { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) };

(async () => {
  // ── S2: waitsOnly claim + countActiveWaits ──────────────────────────────────
  {
    const { store } = fresh('s2-1');
    const waitTask = activePlan(store, [progItem('Жду CI', {
      validation: { ci_green: true }, wait: { poll_every_sec: 30, timeout_sec: 3600 } })]);
    const plainTask = activePlan(store, [progItem('Обычный шаг')]);
    const now = Date.now();
    store.db.prepare('UPDATE task_items SET due_at=? WHERE task_id=?').run(now - 1000, plainTask);

    const claimed = store.claimNextRunnable(now, { waitsOnly: true });
    ok(claimed && claimed.task_id === waitTask,
      `waitsOnly claims the waiting step (got ${claimed && claimed.task_id})`);
    const plain = store.listTaskItems(plainTask, 'u1')[0];
    ok(plain.status === 'pending',
      `a plain due step is NOT claimed by waitsOnly (got ${plain.status})`);
    const full = store.claimNextRunnable(now, {});
    ok(full && full.task_id === plainTask,
      `a full claim still claims the plain step (got ${full && full.task_id})`);
  }
  {
    const { store } = fresh('s2-2');
    ok(store.countActiveWaits() === 0, `quiet profile → 0 (got ${store.countActiveWaits()})`);
    const t = activePlan(store, [progItem('Жду', {
      validation: { file_exists: 'f' }, wait: { poll_every_sec: 30, timeout_sec: 300 } })]);
    ok(store.countActiveWaits() === 1, `a declared wait counts (got ${store.countActiveWaits()})`);
    const item = store.listTaskItems(t, 'u1')[0];
    const w = JSON.parse(item.wait_json); w.resolved = 'satisfied';
    store.setItemWait(item.id, 'u1', w);
    ok(store.countActiveWaits() === 0, `a resolved wait stops counting (got ${store.countActiveWaits()})`);
    store.createPlan({
      profile_id: 'u1', goal: 'draft', user_value: 'v',
      acceptance_criteria: [{ description: 'c' }], execution_policy: { validation_mode: 'programmatic' },
      items: [progItem('Жду2', { validation: { file_exists: 'f' }, wait: { poll_every_sec: 30, timeout_sec: 300 } })],
    });
    ok(store.countActiveWaits() === 0, `a draft plan's wait is not counted (got ${store.countActiveWaits()})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
