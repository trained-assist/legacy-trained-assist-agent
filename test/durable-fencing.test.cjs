// Attempt fencing end-to-end (#87 B1.1) — the T6 scenario from the P-DB pilot
// (trained-agent-architecture pilots/p-db/prod-plans/t6-fencing.js, RESULTS.md
// «T6 fencing FAIL»): attempt A claims a step, the 45-min orphan grace re-queues
// the run while A is still alive, attempt B claims the same step — and A's late
// `DURABLE: done` used to be ACCEPTED (item=done, last_execution_id=exec-A, B
// still running). Now every attempt carries the claim generation it took, and a
// settle whose generation is no longer the row's current one refuses itself:
// no item write, no evidence, no hooks, no recovery — only its own execution row
// is closed as `stale`.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const settle = (ms = 120) => new Promise(r => setTimeout(r, ms));

const TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-fencing-tokens-'));
process.env.AGENT_TOKENS_DIR = TOKENS_DIR;

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-fencing-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  return { G, store: G.durableStore(), dir };
}

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'fencing smoke', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

const agentItem = title => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small', validation: { command_exit_zero: 'true' },
});
const passAll = { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) };
const execRow = (store, itemId) => store.db.prepare(
  `SELECT id, status FROM executions WHERE task_item_id = ? ORDER BY started_at DESC, rowid DESC`).all(itemId);

(async () => {
  // 1. The REAL fire path: A is mid-run when the grace re-queue + B's claim happen,
  //    then A's reply settles — it must be refused.
  {
    const { G, store } = fresh('t6-fire');
    const taskId = activePlan(store, [agentItem('Prepare'), agentItem('Run')]);
    let release;
    const run = new Promise(r => { release = r; });
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: passAll,
      runTask: () => run,
    });
    const a = store.listTaskItems(taskId, 'u1')[0];
    ok(a.status === 'running' && a.claim_generation === 1, `A claimed, generation 1 (got ${a.status}/gen ${a.claim_generation})`);
    const execA = execRow(store, a.id)[0];
    ok(!!execA && execA.status === 'running', `A's execution row is running (got ${execA && execA.status})`);

    // 46 min later the regular tick's orphan sweep re-queues the still-alive run…
    const later = Date.now() + 46 * 60 * 1000;
    G.reconcileOrphanedRunning(store, { now: later });
    const b = store.claimNextRunnable(later);
    ok(!!b && b.id === a.id && b.claim_generation === 2, `B claims the same step at generation 2 (got gen ${b && b.claim_generation})`);
    store.startExecution({ id: 'exec-B', task_id: taskId, task_item_id: b.id });
    const revisionAfterB = store.getTask(taskId, 'u1').revision;

    // …and A now reports done through the ordinary settle path.
    release('ИТОГ ШАГА: всё сделано.\nDURABLE: done');
    await settle();

    const after = store.getTaskItem(a.id);
    ok(after.status === 'running', `stale DURABLE: done is refused — B still owns the step (got ${after.status})`);
    ok(after.last_execution_id == null, `no stale execution id was recorded (got ${after.last_execution_id})`);
    ok(after.evidence_json == null, 'no evidence was written by the stale attempt');
    const execs = execRow(store, a.id);
    const stale = execs.find(e => e.id === execA.id);
    ok(stale && stale.status === 'stale', `A's own execution row is closed as stale (got ${stale && stale.status})`);
    ok(!!execs.find(e => e.id === 'exec-B' && e.status === 'running'), 'B is untouched and still running');
    ok(store.getTask(taskId, 'u1').revision === revisionAfterB, 'the refusal wrote nothing to the task');
    ok(after.claim_generation === 2, 'the generation B claimed is still on the row');
  }

  // 2. The restart-resume path: the sink carries the generation the ORIGINAL
  //    attempt claimed; a stale resume is refused, the current one lands.
  {
    const { G, store } = fresh('t6-resume');
    const taskId = activePlan(store, [agentItem('Prepare')]);
    const a = store.claimNextRunnable();
    store.startExecution({ id: 'exec-A', task_id: taskId, task_item_id: a.id });

    // requeue + B claims, exactly as above
    G.reconcileOrphanedRunning(store, { now: Date.now() + 46 * 60 * 1000 });
    const b = store.claimNextRunnable(Date.now() + 46 * 60 * 1000);
    store.startExecution({ id: 'exec-B', task_id: taskId, task_item_id: b.id });
    const revisionAfterB = store.getTask(taskId, 'u1').revision;

    // A's journal entry resumes after the restart (claimGeneration 1 in the sink)
    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: a.id, executionId: 'exec-A', profileId: 'u1', claimGeneration: a.claim_generation },
      'DURABLE: done', { secrets: {}, registry: passAll });
    await settle();

    let row = store.getTaskItem(a.id);
    ok(row.status === 'running', `stale resume is refused (got ${row.status})`);
    ok(store.getExecution('exec-A').status === 'stale', `stale execution closed as stale (got ${store.getExecution('exec-A').status})`);
    ok(store.getExecution('exec-B').status === 'running', 'exec-B still running');
    ok(store.getTask(taskId, 'u1').revision === revisionAfterB, 'refusal did not bump the task');

    // a crash of the same stale attempt must not fail the step B owns either
    await G.resumeDurableCrash(
      { kind: 'durable', taskId, itemId: a.id, executionId: 'exec-A', profileId: 'u1', claimGeneration: a.claim_generation },
      new Error('engine died'), { secrets: {}, registry: passAll });
    await settle();
    row = store.getTaskItem(a.id);
    ok(row.status === 'running', `stale crash is refused too (got ${row.status})`);
    ok(row.last_error == null, 'no failure was recorded for the step B owns');

    // the CURRENT attempt settles normally (positive control)
    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: b.id, executionId: 'exec-B', profileId: 'u1', claimGeneration: b.claim_generation },
      'DURABLE: done', { secrets: {}, registry: passAll });
    await settle();
    row = store.getTaskItem(b.id);
    ok(row.status === 'done', `the current attempt's done lands (got ${row.status})`);
    ok(store.getExecution('exec-B').status === 'success', 'exec-B closed as success');
  }

  // 3. Back-compat: a journal record written BEFORE this change has no
  //    claimGeneration in its sink — it settles against the row's current
  //    generation (no fencing, exactly the old behaviour).
  {
    const { G, store } = fresh('t6-legacy');
    const taskId = activePlan(store, [agentItem('Prepare')]);
    const a = store.claimNextRunnable();
    store.startExecution({ id: 'exec-A', task_id: taskId, task_item_id: a.id });
    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: a.id, executionId: 'exec-A', profileId: 'u1' },
      'DURABLE: done', { secrets: {}, registry: passAll });
    await settle();
    const row = store.getTaskItem(a.id);
    ok(row.status === 'done', `a legacy sink still settles (got ${row.status})`);
    ok(store.getExecution('exec-A').status === 'success', 'legacy execution closed as success');
  }

  // 4. The claim generation is put into the resume sink the fire path journals,
  //    so a restart can fence the resumed settle.
  {
    const { G, store } = fresh('t6-sink');
    const taskId = activePlan(store, [agentItem('Prepare')]);
    let sink = null;
    const fired = await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: passAll,
      runTask: (opts) => { sink = opts.resumeSink; return Promise.resolve('DURABLE: done'); },
    });
    ok(fired === 1, `the step fired (got ${fired})`);
    await settle();
    ok(!!sink && sink.kind === 'durable', 'the fire path journals a durable resume sink');
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(sink && sink.claimGeneration === item.claim_generation && sink.claimGeneration === 1,
      `the sink carries the claimed generation (got ${sink && sink.claimGeneration}, expected ${item.claim_generation})`);
    ok(store.getTaskItem(item.id).status === 'done', 'the matching generation settles the step');
  }

  // 5. A claim the scheduler gives BACK without starting an attempt (busy session,
  //    slot limit, fanout/stage hold, a re-claim of a step this same pass already
  //    fired) must not burn the generation: the attempt that IS running still
  //    settles. This is the "timer step" interaction — without the release the
  //    orphan sweep's bookkeeping would fence off a perfectly live attempt.
  {
    const { G, store } = fresh('t6-release');
    const taskId = activePlan(store, [agentItem('Prepare')]);
    const a = store.claimNextRunnable();                 // gen 1 — the real attempt
    store.startExecution({ id: 'exec-A', task_id: taskId, task_item_id: a.id });

    const later = Date.now() + 46 * 60 * 1000;
    G.reconcileOrphanedRunning(store, { now: later });    // re-queues the running step
    const b = store.claimNextRunnable(later);             // gen 2
    ok(b && b.claim_generation === 2, `the re-claim opens generation 2 (got ${b && b.claim_generation})`);
    // …but no attempt starts (session busy / no slot) → the claim is released
    store.updateTaskItem(b.id, { status: 'waiting', due_at: Date.now() }, 'u1', { releaseClaim: true });
    ok(store.getTaskItem(a.id).claim_generation === 1, `the release gives the generation back (got ${store.getTaskItem(a.id).claim_generation})`);

    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: a.id, executionId: 'exec-A', profileId: 'u1', claimGeneration: a.claim_generation },
      'DURABLE: done', { secrets: {}, registry: passAll });
    await settle();
    const row = store.getTaskItem(a.id);
    ok(row.status === 'done', `the live attempt's done lands after a release (got ${row.status})`);
    ok(store.getExecution('exec-A').status === 'success', 'exec-A closed as success');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(TOKENS_DIR, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
