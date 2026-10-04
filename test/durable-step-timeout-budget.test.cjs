// R3 (#106) — the three timeout causes are separated and each is handled by its own rule:
//
//   inactivity (provider/engine silence) → class INFRA: the attempt is REFUNDED and a
//       separate bounded infra budget is spent (see test/durable-infra-retry-no-attempt);
//   hard timeout (the step ran out of its wall-clock budget) → class TIMEOUT: the attempt
//       IS spent (a real step signal) but the retry gets a LARGER budget, so it is not the
//       same run three times;
//   validation failure → unchanged, gated by the declared checks.
//
// And the declared budget itself: no silent global floor any more (the 2026-10-01 floor
// equalled the engine cap, so every step got 2400s and a short step could not be declared
// short). `DURABLE_STEP_MIN_TIMEOUT_SEC` stays as an explicit operator override.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

process.env.AGENT_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-timeout-tokens-'));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r3-timeout-${tag}-`));
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

function plan(store, timeoutSec) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'r3 timeout smoke', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items: [{
      title: 'Долгий шаг', execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'master', context_budget: 'large',
      validation: { command_exit_zero: 'true' }, max_attempts: 3,
      execution_timeout_seconds: timeoutSec,
    }],
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return { taskId: r.task.id, itemId: store.listTaskItems(r.task.id, 'u1')[0].id };
}

(async () => {
  // 1. The declared budget reaches the runner as written (no silent floor).
  {
    const { G, store } = fresh('declared');
    const { taskId } = plan(store, 600);
    let firedOpts = null;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { firedOpts = opts; return 'ok\nDURABLE: done'; },
    });
    await new Promise(r => setTimeout(r, 60));
    ok(firedOpts && firedOpts.stepTimeoutMs === 600 * 1000,
      `a declared 600s step runs with a 600s budget (got ${firedOpts && firedOpts.stepTimeoutMs})`);
  }

  // 2. A hard timeout escalates the budget for the retry (and the attempt is spent).
  {
    const { rec, store } = fresh('escalate');
    const { taskId, itemId } = plan(store, 600);
    store.db.prepare("UPDATE task_items SET status='running', attempt_count=1 WHERE id=?").run(itemId);
    const r = await rec.recoverDurableItem({
      store, task: store.getTask(taskId, 'u1'), itemId,
      errorText: 'step timeout: 600s budget exhausted',
    });
    const it = store.getTaskItem(itemId);
    ok(r.recovered && r.failureClass === 'TIMEOUT', `hard timeout keeps the TIMEOUT class (${r.failureClass}/${r.recovered})`);
    ok(r.budgetSec === 1200, `the retry budget doubles (got ${r.budgetSec})`);
    ok(it.execution_timeout_seconds === 1200, `the stored budget grew for the next attempt (${it.execution_timeout_seconds})`);
    ok(it.attempt_count === 1, 'the attempt itself is still spent — a timeout is a step signal');
  }

  // 3. Escalation is capped at the engine hard cap (no runaway 80-minute steps).
  {
    const { rec, store } = fresh('cap');
    const { taskId, itemId } = plan(store, 1800);
    store.db.prepare("UPDATE task_items SET status='running', attempt_count=1 WHERE id=?").run(itemId);
    const r = await rec.recoverDurableItem({
      store, task: store.getTask(taskId, 'u1'), itemId,
      errorText: 'step timeout: 1800s budget exhausted',
    });
    ok(r.budgetSec === rec.ENGINE_HARD_CAP_SEC, `escalation stops at the engine cap (got ${r.budgetSec}, cap ${rec.ENGINE_HARD_CAP_SEC})`);
  }

  // 4. A second escalation from the cap does not grow further.
  {
    const { rec, store } = fresh('cap2');
    const { taskId, itemId } = plan(store, rec.ENGINE_HARD_CAP_SEC);
    store.db.prepare("UPDATE task_items SET status='running', attempt_count=1 WHERE id=?").run(itemId);
    await rec.recoverDurableItem({ store, task: store.getTask(taskId, 'u1'), itemId, errorText: 'step timeout: 2400s budget exhausted' });
    ok(store.getTaskItem(itemId).execution_timeout_seconds === rec.ENGINE_HARD_CAP_SEC, 'the cap holds');
  }

  // 5. Silence does NOT escalate the budget — it is the infra path (refund, #122).
  {
    const { rec, store } = fresh('infra-no-escalation');
    const { taskId, itemId } = plan(store, 600);
    store.db.prepare("UPDATE task_items SET status='running', attempt_count=1 WHERE id=?").run(itemId);
    const r = await rec.recoverDurableItem({
      store, task: store.getTask(taskId, 'u1'), itemId,
      errorText: 'inactivity timeout: no output for 5min',
    });
    const it = store.getTaskItem(itemId);
    ok(r.failureClass === 'INFRA' && r.action === 'infra_retry', `silence stays on the infra path (${r.failureClass}/${r.action})`);
    ok(it.execution_timeout_seconds === 600, `silence never touches the budget (${it.execution_timeout_seconds})`);
    ok(it.attempt_count === 0, 'and the attempt is refunded');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
