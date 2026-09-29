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
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js', '../src/durable-kick.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  const tools = require('../src/mcp-skills/tools/101-durable-tasks.js').tools;
  return { G, store: G.durableStore(), tools };
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
const agentItem = (title) => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small',
  validation: { command_exit_zero: 'true' },
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

  // ── S3: runWaitTick — one serialized waitsOnly pass ─────────────────────────
  {
    const { G, store } = fresh('s3-1');
    ok(typeof G.runWaitTick === 'function', 'gtd-controller exports runWaitTick');
    const waitTask = activePlan(store, [progItem('Жду CI', {
      validation: { ci_green: true }, wait: { poll_every_sec: 30, timeout_sec: 3600 } })]);
    const plainTask = activePlan(store, [progItem('Обычный шаг')]);
    store.db.prepare('UPDATE task_items SET due_at=? WHERE task_id=?').run(Date.now() - 1000, plainTask);
    const registry = { ...PASS_ALL, ci_green: async () => ({ status: 'pass', subject: {}, evidence: {} }) };
    const before = G.tickHeartbeat().tickCount;
    const fired = await G.runWaitTick({ secrets: {}, runTask: async () => 'x', isTaskRunning: () => false, registry, freeSlots: () => 4 });
    ok(fired === 1, `the wait tick fires the resolved wait step once (got ${fired})`);
    ok(store.listTaskItems(waitTask, 'u1')[0].status === 'done', 'a satisfied wait runs and completes the step');
    ok(store.listTaskItems(plainTask, 'u1')[0].status === 'pending', 'the wait tick does not touch a plain due step');
    ok(G.tickHeartbeat().tickCount === before, 'the wait tick does not bump the checklist heartbeat (DW-03)');
  }
  {
    const { G, store } = fresh('s3-2');
    const plainTask = activePlan(store, [progItem('Обычный шаг')]);
    store.db.prepare('UPDATE task_items SET due_at=? WHERE task_id=?').run(Date.now() - 1000, plainTask);
    const fired = await G.runWaitTick({ secrets: {}, runTask: async () => 'x', isTaskRunning: () => false, registry: PASS_ALL, freeSlots: () => 4 });
    ok(fired === 0, `no active waits → the wait tick is a no-op (got ${fired})`);
    ok(store.listTaskItems(plainTask, 'u1')[0].status === 'pending', 'the quiet wait tick claims nothing');
  }
  {
    const { G, store } = fresh('s3-3');
    const waitTask = activePlan(store, [progItem('Жду CI', {
      validation: { ci_green: true }, wait: { poll_every_sec: 30, timeout_sec: 3600 } })]);
    const registry = { ...PASS_ALL, ci_green: async () => ({ status: 'pass', subject: {}, evidence: {} }) };
    const deps = { secrets: {}, runTask: async () => 'x', isTaskRunning: () => false, registry, freeSlots: () => 4 };
    const [a, b] = await Promise.all([G.runWaitTick(deps), G.runWaitTick(deps)]);
    ok(a + b === 1, `overlapping wait ticks yield one fire (got ${a}+${b})`);
    ok(store.listTaskItems(waitTask, 'u1')[0].status === 'done', 'the overlapped step completes exactly once');
  }

  // ── S4: immediate kick (durable-kick + route + wake + credential write) ─────
  {
    const { G, store } = fresh('s4-count');
    // In-process fast path: useInProcess registers the server-process kick.
    const kick = require('../src/durable-kick.js');
    let hit = 0;
    kick.useInProcess(() => { hit++; });
    ok(await kick.notify('wake') === true && hit === 1, 'in-process kick calls the registered fn directly');
    kick.useInProcess(null);
    // Unreachable server → silent false, never a throw (fallback = wait tick).
    process.env.AGENT_SECRET = 'test-secret';
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try { ok(await kick.notify('credential') === false, 'unreachable server → silent false'); }
    finally { global.fetch = realFetch; }
    // Kill-switch DURABLE_KICK=0.
    process.env.DURABLE_KICK = '0';
    try { ok(await kick.notify('wake') === false, 'DURABLE_KICK=0 disables the kick'); }
    finally { delete process.env.DURABLE_KICK; }
    void G; void store;
  }
  {
    const { G, store, tools } = fresh('s4-wake');
    process.env.AGENT_SECRET = 'test-secret';
    const taskId = activePlan(store, [agentItem('Ждём ответ')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 3 * 86400, reason: 'ответ' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
    try { await tools.task_item_wake.handler({ item_id: item.id, message: 'вот ответ' }, { userId: 'u1' }); }
    finally { global.fetch = realFetch; }
    ok(calls.some((u) => /\/internal\/durable\/kick/.test(u)),
      `task_item_wake kicks the executor (${calls.join(', ') || 'no fetch'})`);
  }
  {
    // The route itself calls kickDurable() — no need for a real server.
    const gtd = require('../src/gtd-controller.js');
    const real = gtd.kickDurable;
    let called = 0;
    gtd.kickDurable = () => { called++; return true; };
    try {
      const { handleInternal } = require('../src/handlers/internal.js');
      const res = { writeHead() {}, end() {} };
      const ctx = { json: (r, status, body) => ({ status, body }), readBody: async () => '', BASE_USERS_DIR: os.tmpdir(), getGtdTickNow: () => null };
      const ret = await handleInternal({ method: 'POST', headers: {} }, new URL('http://x/internal/durable/kick'), res, ctx);
      ok(called === 1 && ret && ret.body && ret.body.ok === true,
        `POST /internal/durable/kick calls kickDurable (called=${called})`);
    } finally { gtd.kickDurable = real; }
  }
  {
    // A credential write is a wait event too (until:{credential_present}).
    const kick = require('../src/durable-kick.js');
    const real = kick.notify;
    const reasons = [];
    kick.notify = async (r) => { reasons.push(r); return true; };
    try {
      const cred = require('../src/credential-store.js');
      const p = path.join(os.tmpdir(), `cred-kick-${Date.now()}`, 'github');
      cred.writeCredentialFile(p, 'ghp_x');
      ok(reasons.includes('credential'), `a credential write notifies the executor (${reasons.join(',')})`);
    } finally { kick.notify = real; }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
