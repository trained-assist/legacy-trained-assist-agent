// R2 — material result criteria (#106, owner: «мягкое по формату, твёрдо по результату»).
//
// The hole this closes: plan acceptance criteria are derived from every step's
// `validation`, but only keys in the VALIDATOR REGISTRY blocked finalization. The
// semantic keys — the ones that actually say whether the change is LIVE, the docs
// landed and the user scenario works — ended as `unconfirmed` defects while the plan
// still reported `done`. Concretely: pr_opened + ci_green + merged all pass and
// nothing proves delivery.
//
// Pinned here:
//   1. a material key with no `pass` blocks the plan (and says so in its own words);
//   2. a NON-material semantic key still never blocks (the frame/propose chain and
//      the sandbox stay advisory — #121 lets the sandbox be woven into implement);
//   3. registry keys keep blocking exactly as before;
//   4. a material key that DID pass is not re-litigated;
//   5. `outstandingMaterial` (what the step prompt shows, so the acceptance step can
//      still catch what an earlier submit did not provide) agrees with the gate.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 80) => new Promise(r => setTimeout(r, ms));

process.env.AGENT_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'material-tokens-'));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `material-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/playbook-material.js', '../src/playbook-validators.js', '../src/durable-task-plan.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  return { G, store: G.durableStore(), dir };
}

const agentItem = (title, validation) => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small', validation, max_attempts: 2,
});

const MATERIAL = 'user_scenario_verified_in_real_environment'; // verify-real
const ARCHIVE = 'living_docs_updated_and_plan_closed';          // archive
const SEMANTIC = 'use_case_value_and_steps_written';            // frame — stays advisory

function activePlan(store, items) {
  // Acceptance criteria are derived from the steps' `validation` exactly as
  // playbook-compiler.js deriveAcceptanceCriteria does — a caller-supplied criterion
  // without a `validations` array declares nothing machine-checkable and the whole
  // finalization gate is vacuous (durable-task-plan.js:93).
  const validations = [];
  for (const step of items) validations.push({ stage: 's', step: step.title, validation: step.validation });
  const r = store.createPlan({
    profile_id: 'u1', goal: 'material gate', user_value: 'v',
    acceptance_criteria: [{ id: 'test-complete', description: 'c', source: 'playbook:test@1', validations }],
    execution_policy: { validation_mode: 'programmatic+llm' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

const tick = (G, opts) => G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, ...opts });

(async () => {
  // 1. A material key with no `pass` blocks the plan — the delivered result is not proven.
  {
    const { G, store } = fresh('block');
    const taskId = activePlan(store, [
      agentItem('Открыть PR', { pr_opened: true }),
      agentItem('Проверить в реальности', { [MATERIAL]: true }),
    ]);
    const registry = {
      pr_opened: async () => ({ status: 'pass', subject: {}, evidence: { pr: 1 } }),
      [MATERIAL]: async () => ({ status: 'inconclusive', subject: null, evidence: { reason: 'no-live-check' } }),
    };
    // The judge is unavailable, so the material key stays inconclusive — exactly the
    // production shape where a plan used to report `done` with nothing delivered.
    const llmValidate = async () => ({ status: 'inconclusive', reason: 'no-llm-key' });
    for (let i = 0; i < 2; i++) {
      await tick(G, { registry, llmValidate, runTask: async () => 'сделал\nDURABLE: done' });
      await drain();
    }
    const task = store.getTask(taskId, 'u1');
    const items = store.listTaskItems(taskId, 'u1');
    ok(items.every(it => it.status === 'done'), `both steps finished (${items.map(i => i.status).join(',')})`);
    ok(task.status === 'blocked', `the plan is NOT done while the material result is unproven (got ${task.status})`);
    ok(/материальный результат не подтверждён/.test(task.blocker_reason || ''),
      `and the reason names the material gap (got ${JSON.stringify(task.blocker_reason)})`);
    ok((task.blocker_reason || '').includes(MATERIAL), `naming the criterion itself (${task.blocker_reason})`);
  }

  // 2. Regression: a NON-material semantic key never blocks. The frame chain and the
  //    standalone sandbox stay advisory on purpose (#121).
  {
    const { G, store } = fresh('advisory');
    const taskId = activePlan(store, [
      agentItem('Сценарий', { [SEMANTIC]: true }),
      agentItem('Открыть PR', { pr_opened: true }),
    ]);
    const registry = {
      pr_opened: async () => ({ status: 'pass', subject: {}, evidence: { pr: 1 } }),
    };
    const llmValidate = async () => ({ status: 'inconclusive', reason: 'no-llm-key' });
    for (let i = 0; i < 2; i++) {
      await tick(G, { registry, llmValidate, runTask: async () => 'сделал\nDURABLE: done' });
      await drain();
    }
    const task = store.getTask(taskId, 'u1');
    ok(task.status === 'done', `an advisory semantic key does not block the plan (got ${task.status})`);
  }

  // 3. A material key that DID pass is not re-litigated: same plan, judged pass.
  {
    const { G, store } = fresh('pass');
    const taskId = activePlan(store, [
      agentItem('Проверить в реальности', { [MATERIAL]: true }),
      agentItem('Архивация', { [ARCHIVE]: true }),
    ]);
    const llmValidate = async () => ({ status: 'pass', reason: 'проверено вживую' });
    for (let i = 0; i < 2; i++) {
      await tick(G, { registry: {}, llmValidate, runTask: async () => 'сделал\nDURABLE: done' });
      await drain();
    }
    ok(store.getTask(taskId, 'u1').status === 'done',
      `a judged material pass closes the plan (got ${store.getTask(taskId, 'u1').status})`);
  }

  // 4. outstandingMaterial agrees with the gate: it lists what is still missing, and
  //    goes quiet once the criterion passed — that list is what the step prompt shows.
  {
    const { G, store } = fresh('outstanding');
    const taskId = activePlan(store, [
      agentItem('Проверить в реальности', { [MATERIAL]: true }),
      agentItem('Архивация', { [ARCHIVE]: true }),
    ]);
    const before = G.outstandingMaterial(store, store.getTask(taskId, 'u1'));
    ok(before.includes(MATERIAL) && before.includes(ARCHIVE),
      `before any run both material criteria are outstanding (got ${JSON.stringify(before)})`);
    await tick(G, {
      registry: {}, llmValidate: async () => ({ status: 'pass' }),
      runTask: async () => 'сделал\nDURABLE: done',
    });
    await drain();
    const after = G.outstandingMaterial(store, store.getTask(taskId, 'u1'));
    ok(!after.includes(MATERIAL) && after.includes(ARCHIVE),
      `after the first step only the archive criterion is left (got ${JSON.stringify(after)})`);
    await tick(G, { registry: {}, llmValidate: async () => ({ status: 'pass' }), runTask: async () => 'сделал\nDURABLE: done' });
    await drain();
    const done = G.outstandingMaterial(store, store.getTask(taskId, 'u1'));
    ok(done.length === 0, `nothing outstanding once every material criterion passed (got ${JSON.stringify(done)})`);
  }

  // 5. The step prompt carries the outstanding material criteria — this is how the
  //    acceptance step can still catch what an earlier submit did not provide.
  {
    const { G, store } = fresh('prompt');
    activePlan(store, [
      agentItem('Проверить в реальности', { [MATERIAL]: true }),
      agentItem('Архивация', { [ARCHIVE]: true }),
    ]);
    let prompted = '';
    await tick(G, {
      registry: {}, llmValidate: async () => ({ status: 'pass' }),
      runTask: async (opts) => { prompted = opts.task; return 'сделал\nDURABLE: done'; },
    });
    await drain();
    ok(/Материальные критерии плана/.test(prompted), 'the prompt states the outstanding material criteria');
    ok(prompted.includes(ARCHIVE), `including the one this step cannot close (${ARCHIVE})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
