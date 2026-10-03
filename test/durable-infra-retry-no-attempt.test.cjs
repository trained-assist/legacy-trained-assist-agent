// #122 — infra silence and judge `uncertain` must not burn the step's attempt budget.
//
// Case 9a6854e4: the sandbox step burned 3/3 attempts and went terminal on
// "движок молчал 5 мин (провайдер не отвечает)" — the provider never answered, the
// model never had a say, yet three full runs were spent. Same for a marker-judge
// `uncertain` verdict ("too-short"): the attempt was spent as a model failure.
//
// Pinned here: provider silence (class INFRA) and an explicit refund (judge
// `uncertain`) give the attempt back and spend a SEPARATE bounded budget
// (INFRA_MAX_RETRIES); budget exhaustion (TIMEOUT) still consumes the attempt.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

process.env.AGENT_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-retry-tokens-'));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `infra-retry-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/durable-recovery.js', '../src/failure-classifier.js', '../src/recovery-policy.js',
    '../src/failure-taxonomy.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  const rec = require('../src/durable-recovery.js');
  return { G, rec, store: G.durableStore(), dir };
}

function plan(store) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'infra retry smoke', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items: [{
      title: 'Песочница', execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'master', context_budget: 'large',
      validation: { sandbox_loop_runs_and_fails_for_the_right_reason: true }, max_attempts: 3,
    }],
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return { taskId: r.task.id, itemId: store.listTaskItems(r.task.id, 'u1')[0].id };
}

function armAttempt(store, itemId) {
  // attempt_count == max_attempts (3): the infra refund must fire BEFORE the
  // "attempts-exhausted" terminal — otherwise the fix would only work while
  // attempts remain, i.e. never in the real 3rd-attempt case.
  store.db.prepare("UPDATE task_items SET status='running', attempt_count=3 WHERE id=?").run(itemId);
}

(async () => {
  // 1. Provider silence → INFRA → attempt refunded, bounded infra budget spent.
  {
    const { rec, store } = fresh('silence');
    const { taskId, itemId } = plan(store);
    armAttempt(store, itemId);
    const task = store.getTask(taskId, 'u1');
    const r = await rec.recoverDurableItem({ store, task, itemId, errorText: 'inactivity timeout: no output for 5min' });
    const it = store.getTaskItem(itemId);
    ok(r.recovered && r.failureClass === 'INFRA' && r.action === 'infra_retry', `provider silence is an infra refund (got ${JSON.stringify({ c: r.failureClass, a: r.action, rec: r.recovered })})`);
    ok(it.attempt_count === 2, `the attempt is given back, even at the cap (attempt_count=${it.attempt_count})`);
    ok(it.infra_retries === 1, `the infra budget is spent instead (infra_retries=${it.infra_retries})`);
    ok(it.status === 'pending', `the step is re-pended (status=${it.status})`);
    ok(it.last_recovery_action === 'infra_retry', `the move is recorded (${it.last_recovery_action})`);
  }

  // 2. Bounded: after INFRA_MAX_RETRIES free retries the step goes terminal — a
  //    broken provider is not an infinite free retry.
  {
    const { rec, store } = fresh('bounded');
    const { taskId, itemId } = plan(store);
    const task = () => store.getTask(taskId, 'u1');
    let last;
    for (let i = 0; i < rec.INFRA_MAX_RETRIES; i++) {
      armAttempt(store, itemId);
      last = await rec.recoverDurableItem({ store, task: task(), itemId, errorText: 'Движок молчал 5 мин' });
      ok(last.recovered, `free infra retry ${i + 1}/${rec.INFRA_MAX_RETRIES} recovered`);
    }
    armAttempt(store, itemId);
    last = await rec.recoverDurableItem({ store, task: task(), itemId, errorText: 'Движок молчал 5 мин' });
    const it = store.getTaskItem(itemId);
    ok(!last.recovered && last.reason === 'infra-retries-exhausted', `the infra budget is bounded (got ${last.reason})`);
    ok(it.last_recovery_action === 'terminal', `the step is terminal (${it.last_recovery_action})`);
  }

  // 3. Explicit refund (marker judge `uncertain`) → same free-retry path.
  {
    const { rec, store } = fresh('uncertain');
    const { taskId, itemId } = plan(store);
    armAttempt(store, itemId);
    const task = store.getTask(taskId, 'u1');
    const r = await rec.recoverDurableItem({
      store, task, itemId,
      errorText: 'no DURABLE marker (judge: uncertain, too-short): I will start by…',
      refundAttempt: true,
    });
    const it = store.getTaskItem(itemId);
    ok(r.recovered && r.action === 'infra_retry', `judge uncertain refunds the attempt (got ${r.action})`);
    ok(it.attempt_count === 2 && it.infra_retries === 1, `attempt given back, infra budget spent (a=${it.attempt_count}, i=${it.infra_retries})`);
  }

  // 4. Regression: a genuine budget timeout (TIMEOUT) still consumes the attempt —
  //    a step that ran out of time IS a step signal, not infra.
  {
    const { rec, store } = fresh('timeout');
    const { taskId, itemId } = plan(store);
    store.db.prepare("UPDATE task_items SET status='running', attempt_count=1 WHERE id=?").run(itemId);
    const task = store.getTask(taskId, 'u1');
    const r = await rec.recoverDurableItem({ store, task, itemId, errorText: 'step timeout: 2400s budget exhausted' });
    const it = store.getTaskItem(itemId);
    ok(r.recovered && r.failureClass === 'TIMEOUT', `budget timeout keeps its class (got ${r.failureClass}/${r.recovered})`);
    ok(it.attempt_count === 1 && it.infra_retries === 0, `budget timeout does NOT refund the attempt (a=${it.attempt_count}, i=${it.infra_retries})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
