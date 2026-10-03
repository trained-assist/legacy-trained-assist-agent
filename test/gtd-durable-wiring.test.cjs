// Slice A wiring (issue #1201): GTD tick executes DurableTaskStore runnable
// items. Covers the four invariants the store-level unit tests do NOT cover,
// because they live in the wiring layer (src/gtd-controller.js):
//   1. fire pipeline: claim → runTask → completeItem → task done
//   2. failure escalation: failed item → tier+1 → re-pending → retried
//   3. crash recovery: orphaned 'running' item past grace is re-claimable,
//      fresh 'running' is never stolen
//   4. re-entrancy: item of a session with a live run goes waiting, not fired
const G = require('../src/gtd-controller.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
// A completed agent step records its validation rows + evidence before flipping
// the item to done, inside runTask's async completion callback. `runDueDurable`
// itself stays fire-and-forget, so drain pending callbacks before asserting.
const drain = () => new Promise(r => setTimeout(r, 0));

function freshStore(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gtd-durable-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  delete require.cache[require.resolve('../src/durable-task-store.js')];
  delete require.cache[require.resolve('../src/data-paths.js')];
  return require('../src/gtd-controller.js');
}

function activeContractTask(G, { goal, items, sessionId, executionPolicy }) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal, user_value: 'user value', session_id: sessionId || null,
    acceptance_criteria: [{ description: 'c' }],
    // Deterministic mode by default: these wiring cases assert the registry path,
    // not the P3d-1b LLM layer (which is covered by cases 12/13 + unit tests).
    execution_policy: executionPolicy || { validation_mode: 'programmatic' },
    items: items.map(t => ({
      title: t, execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'bachelor', context_budget: 'small',
      validation: { command: 'true' },
    })),
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  // #1886: createPlan no longer attaches session_id (it is the owner chat now);
  // the re-entrancy guard still covers a session explicitly attached to the task.
  if (sessionId) store.attachSession(r.task.id, sessionId, 'u1');
  return r.task.id;
}

(async () => {
  // 1. fire pipeline: claim → run → done → task completes
  {
    const G1 = freshStore('1');
    const taskId = activeContractTask(G1, { goal: 'wire smoke', items: ['step one'] });
    let prompted = '';
    let firedOpts = null;
    const fired = await G1.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { prompted = opts.task; firedOpts = opts; return 'ok. DURABLE: done'; },
    });
    await drain();
    const store = G1.durableStore();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(fired === 1, `durable: one item fired (got ${fired})`);
    ok(/step one/.test(prompted) && /DURABLE: done/.test(prompted), 'durable: prompt carries step + completion marker');
    ok(firedOpts.stepTimeoutMs === 2400 * 1000, `durable: a 600s step is floored at the 40-min run cap (got ${firedOpts && firedOpts.stepTimeoutMs})`);
    ok(firedOpts.engine === 'opencode' && firedOpts.ocProfile === 'service',
      `durable: bachelor contract item resolves to opencode/deepseek (got ${firedOpts && firedOpts.engine}/${firedOpts && firedOpts.ocProfile})`);
    ok(firedOpts.user && /users[/\\]u1$/.test(firedOpts.user.workDir),
      `durable: step carries the profile workspace, not null (got ${firedOpts.user && firedOpts.user.workDir})`);
    ok(item.status === 'done', `durable: item completed (got ${item.status})`);
    ok(store.getTask(taskId, 'u1').status === 'done', 'durable: task completes when all items done');
    ok(store.claimNextRunnable() === null, 'durable: drained task is not claimable');
  }

  // 2. failure → escalation → retry at higher tier
  {
    const G2 = freshStore('2');
    const taskId = activeContractTask(G2, { goal: 'escalation smoke', items: ['flaky'] });
    const store = G2.durableStore();
    await G2.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'nope. DURABLE: failed: exploded' });
    await drain();
    let item = store.listTaskItems(taskId, 'u1')[0];
    // Contract plan, quality failure: attempt 2 runs at the SAME level with the failure
    // reasons in its input (level escalation is attempt 3 — see playbooks-offline-e2e).
    ok(item.status === 'pending' && item.last_recovery_action === 'retry_same_with_reasons',
      `durable: quality failure re-pends at the same level with reasons (got ${item.status}/${item.last_recovery_action})`);
    await G2.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'fixed. DURABLE: done' });
    await drain();
    item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', 'durable: retried item completes');
  }

  // 3. crash recovery: stale running item re-claimable, fresh running untouched
  {
    const G3 = freshStore('3');
    const taskId = activeContractTask(G3, { goal: 'crash smoke', items: ['crashed'] });
    const store = G3.durableStore();
    const item = store.listTaskItems(taskId, 'u1')[0];
    store.updateTaskItem(item.id, { status: 'running' }, 'u1');
    store.db.prepare('UPDATE task_items SET updated_at=? WHERE id=?').run(Date.now() - 50 * 60 * 1000, item.id);
    const c = G3.claimNextDurableItem(store, { now: Date.now() });
    ok(c && c.id === item.id, 'durable: orphaned running item (past grace) is re-claimable after crash');

    const taskId2 = activeContractTask(G3, { goal: 'live smoke', items: ['live'] });
    const it2 = store.listTaskItems(taskId2, 'u1')[0];
    store.updateTaskItem(it2.id, { status: 'running' }, 'u1'); // updated_at = now
    const c2 = G3.claimNextDurableItem(store, { now: Date.now() });
    ok(!c2 || c2.id !== it2.id, 'durable: fresh running item is never stolen by reconcile');
  }

  // 4. re-entrancy: live session → item goes waiting (not fired, not lost)
  {
    const G4 = freshStore('4');
    const taskId = activeContractTask(G4, { goal: 'busy smoke', items: ['busy'], sessionId: 'sess-9' });
    let fired = 0;
    await G4.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: (u, sid) => sid === 'sess-9',
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    const item = G4.durableStore().listTaskItems(taskId, 'u1')[0];
    ok(fired === 0 && item.status === 'waiting' && item.due_at !== null,
      `durable: live session defers item to waiting (got fired=${fired}, ${item.status})`);
  }

  // 5. contract plans stay unclaimable while draft — activation is explicit (P3a)
  {
    const G5 = freshStore('5');
    const store = G5.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'draft plan', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'draft step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } }] });
    let fired = 0;
    await G5.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    ok(fired === 0 && store.claimNextRunnable() === null, 'durable: draft contract plans are not executed until activated');
    // explicit activation (P3a) makes the same plan claimable
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    ok(store.claimNextRunnable() !== null, 'durable: activated contract plan becomes claimable');
  }

  // 6. max_attempts is a hard budget: after it is spent the item stays failed and
  // is never re-fired (no "pend forever").
  {
    const G6 = freshStore('6');
    const store = G6.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'budget smoke', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'flaky', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor',
        context_budget: 'small', validation: { command: 'true' }, max_attempts: 2 }] });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const failRun = () => G6.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => 'nope. DURABLE: failed: exploded' });

    await failRun(); await drain();
    let item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'pending' && item.attempt_count === 1,
      `durable: first failure re-pends within budget (got ${item.status}/attempts=${item.attempt_count})`);
    await failRun(); await drain();
    item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'failed' && item.attempt_count === 2,
      `durable: exhausted budget leaves item failed (got ${item.status}/attempts=${item.attempt_count})`);

    let extraFires = 0;
    await G6.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { extraFires++; return 'DURABLE: done'; } });
    item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(extraFires === 0 && item.status === 'failed', 'durable: exhausted item is not re-fired on later ticks');
    ok(store.getTask(r.task.id, 'u1').status === 'active', 'durable: task stays active (failed step is visible, not silently done)');
  }

  // 7. an expired waiter is failed before claim, so it is never handed out again
  {
    const G7 = freshStore('7');
    const store = G7.durableStore();
    const r = store.createPlan({ profile_id: 'u1', goal: 'waiter smoke', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      items: [{ title: 'waiter', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor',
        context_budget: 'small', validation: { command: 'true' } }] });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    store.updateTaskItem(item.id, { status: 'waiting', wait_deadline_at: Date.now() - 1000 }, 'u1');
    let fired = 0;
    await G7.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async () => { fired++; return 'DURABLE: done'; } });
    const after = store.listTaskItems(r.task.id, 'u1')[0];
    ok(fired === 0 && after.status === 'failed' && /deadline expired/.test(after.last_error || ''),
      `durable: expired waiter fails instead of being re-run (got fired=${fired}, status=${after.status})`);
  }

  // 8. legacy (non-contract) durable items keep the pre-P3b default engine
  {
    const G8 = freshStore('8');
    const store = G8.durableStore();
    store.createTask({ id: 'legacy-8', profile_id: 'u1', goal: 'legacy durable' });
    store.createTaskItem({ id: 'legacy-item-8', task_id: 'legacy-8', title: 'legacy step' });
    let firedOpts = null;
    await G8.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      runTask: async (opts) => { firedOpts = opts; return 'DURABLE: done'; } });
    // Owner 2026-10-01: a legacy (contract-less) item defaults to OpenCode master, not Claude.
    ok(firedOpts && firedOpts.engine === 'opencode' && firedOpts.ocProfile === 'service',
      `durable: legacy item runs on opencode/deepseek by default (got ${firedOpts && firedOpts.engine}/${firedOpts && firedOpts.ocProfile})`);
  }

  // 9. programmatic item executes deterministically: NO runTask, verdicts recorded (P3d-1)
  {
    const G9 = freshStore('9');
    const store = G9.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'programmatic smoke', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'deterministic check', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    const registry = {
      command_exit_zero: async () => ({ status: 'pass', subject: { command: 'true' }, evidence: { exit_code: 0 } }),
    };
    const n = await G9.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry,
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(n === 1 && fired === 0, `programmatic: one item handled with no engine run (fired=${n}, runTask=${fired})`);
    ok(item.status === 'done', `programmatic: item completed (got ${item.status})`);
    ok(validations.length === 1 && validations[0].validator === 'command_exit_zero'
      && validations[0].status === 'pass' && validations[0].criterion_id === 'crit',
      `programmatic: validation row recorded (got ${JSON.stringify(validations.map(v => [v.validator, v.status, v.criterion_id]))})`);
    ok(item.evidence_json && /command_exit_zero/.test(item.evidence_json) && item.completed_at > 0,
      `programmatic: evidence + completed_at attached (got ${item.evidence_json})`);
    ok(store.getTask(r.task.id, 'u1').status === 'done', 'programmatic: task completes when all items done');
  }

  // 10. an unregistered validation key is inconclusive and does NOT pass the step (P3d-1)
  {
    const G10 = freshStore('10');
    const store = G10.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'inconclusive smoke', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'self reported', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    await G10.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0, `inconclusive: no engine run for programmatic step (runTask=${fired})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive'
      && validations[0].evidence_json && /no-validator/.test(validations[0].evidence_json),
      `inconclusive: unregistered key recorded as inconclusive (got ${validations[0] && validations[0].status})`);
    ok(item.status === 'pending' && item.attempt_count === 1,
      `inconclusive: step does not pass and retries within budget (got ${item.status}/attempts=${item.attempt_count})`);
    ok(store.getTask(r.task.id, 'u1').status === 'active', 'inconclusive: task is not marked done');
  }

  // 11. agent item records its validations + reply evidence on DURABLE: done (P3d-1)
  {
    const G11 = freshStore('11');
    const taskId = activeContractTask(G11, { goal: 'agent evidence', items: ['self report'] });
    const store = G11.durableStore();
    await G11.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async () => 'made the change. DURABLE: done',
    });
    // Validation recording for a completed agent step is async (the tick is
    // fire-and-forget); drain microtasks before asserting the persisted rows.
    await new Promise(r => setTimeout(r, 0));
    const item = store.listTaskItems(taskId, 'u1')[0];
    const validations = store.listValidations(taskId, 'u1');
    ok(item.status === 'done', `agent: item completes on DURABLE done (got ${item.status})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive',
      `agent: self-reported validation recorded inconclusive (got ${JSON.stringify(validations.map(v => [v.validator, v.status]))})`);
    ok(item.evidence_json && /made the change/.test(item.evidence_json) && item.completed_at > 0,
      `agent: reply evidence attached (got ${item.evidence_json})`);
  }

  // 12. programmatic+llm: an unregistered key is decided by the injected LLM and
  // completes the step when the LLM passes it (P3d-1b)
  {
    const G12 = freshStore('12');
    const store = G12.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'llm validation', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic+llm' },
      items: [{ title: 'write the user scenario', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    const llmCalls = [];
    await G12.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async (ctx) => { llmCalls.push(ctx.key); return { status: 'pass', reason: 'scenario doc has value + 2 ordered steps' }; },
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0 && llmCalls.length === 1 && llmCalls[0] === 'user_value_written',
      `programmatic+llm: no engine, llm consulted once for the unknown key (llm=${JSON.stringify(llmCalls)})`);
    ok(item.status === 'done', `programmatic+llm: step completes on the llm pass (got ${item.status})`);
    ok(validations.length === 1 && validations[0].status === 'pass'
      && /"source":"llm"/.test(validations[0].evidence_json || ''),
      `programmatic+llm: llm verdict recorded (got ${validations[0] && validations[0].status}/${validations[0] && validations[0].evidence_json})`);
    ok(store.getTask(r.task.id, 'u1').status === 'done', 'programmatic+llm: task completes when the step passes');
  }

  // 13. programmatic mode ignores the LLM entirely: same step stays inconclusive
  {
    const G13 = freshStore('13');
    const store = G13.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'deterministic only', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'write the user scenario', execution_kind: 'programmatic', validation: { user_value_written: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fired = 0;
    let llmCalls = 0;
    await G13.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async () => { llmCalls++; return { status: 'pass', reason: 'should not be consulted' }; },
      runTask: async () => { fired++; return 'DURABLE: done'; },
    });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(fired === 0 && llmCalls === 0, `programmatic: llm never consulted (runTask=${fired}, llm=${llmCalls})`);
    ok(validations.length === 1 && validations[0].status === 'inconclusive'
      && /no-validator/.test(validations[0].evidence_json || ''),
      `programmatic: unregistered key stays inconclusive (got ${validations[0] && validations[0].status})`);
    ok(item.status === 'pending', `programmatic: step does not pass (got ${item.status})`);
  }

  // 14. fast-pass escape (P3d-1c): under programmatic+llm-fastpass an agent step
  // may skip its validation with a final `VALIDATION: fastpass-skip: <reason>`
  // line. The skip is recorded (status pass + evidence {skipped,reason,mode}) and
  // neither the deterministic registry nor the LLM is consulted — never silent.
  {
    const G14 = freshStore('14');
    const store = G14.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'fastpass skip smoke', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic+llm-fastpass' },
      items: [{ title: 'urgent fix', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { ci_green: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let llmCalls = 0;
    let registryCalls = 0;
    await G14.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { ci_green: async () => { registryCalls++; return { status: 'fail', subject: null, evidence: { reason: 'red' } }; } },
      llmValidate: async () => { llmCalls++; return { status: 'pass', reason: 'should not run' }; },
      runTask: async () => 'patched prod.\nVALIDATION: fastpass-skip: CI too heavy, urgent prod fix\nDURABLE: done',
    });
    await drain();
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(item.status === 'done' && validations.length === 1 && validations[0].status === 'pass',
      `fastpass: step completes via a recorded skip (got status=${item.status}, rows=${validations.length})`);
    const ev = JSON.parse(validations[0].evidence_json || '{}');
    ok(ev.skipped === true && /urgent prod fix/.test(ev.reason || '') && ev.mode === 'programmatic+llm-fastpass',
      `fastpass: skip evidence carries reason + mode (got ${validations[0].evidence_json})`);
    ok(registryCalls === 0 && llmCalls === 0,
      `fastpass: skip bypasses registry + LLM (registry=${registryCalls}, llm=${llmCalls})`);
  }

  // 15. per-step mode beats plan/env (P3d-1c): the agent sets a looser per-step
  // mode mid-run; the completion callback re-reads the item and honours it, so a
  // skip marker is accepted even though the plan default is stricter.
  {
    const G15 = freshStore('15');
    const store = G15.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'per-step override', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'override step', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { ci_green: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    let llmCalls = 0;
    await G15.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async () => { llmCalls++; return { status: 'pass', reason: 'ok' }; },
      runTask: async () => {
        store.updateTaskItem(item.id, { validation_mode: 'programmatic+llm-fastpass' }, 'u1');
        return 'did it.\nVALIDATION: fastpass-skip: too heavy right now\nDURABLE: done';
      },
    });
    await drain();
    const after = store.listTaskItems(r.task.id, 'u1')[0];
    const validations = store.listValidations(r.task.id, 'u1');
    ok(after.validation_mode === 'programmatic+llm-fastpass',
      `override: per-step column updated by the agent (got ${after.validation_mode})`);
    ok(after.status === 'done' && validations.length === 1 && /"skipped":true/.test(validations[0].evidence_json || ''),
      `override: per-step fastpass beats the stricter plan mode (got status=${after.status}, ${validations[0] && validations[0].evidence_json})`);
    ok(llmCalls === 0, `override: no LLM for a recorded skip (llm=${llmCalls})`);
  }

  // 16. normal verdicts are unaffected (P3d-1c): without the skip marker the
  // mode-aware pipeline still records deterministic + LLM verdicts, and fastpass
  // alone is NOT an auto-skip — it only permits the explicit escape.
  {
    const G16 = freshStore('16');
    const store = G16.durableStore();
    const normalPlan = mode => store.createPlan({
      profile_id: 'u1', goal: `normal ${mode}`, user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: mode },
      items: [{ title: 'normal', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small',
        validation: { ci_green: true, user_value_written: true } }],
    });
    const r = normalPlan('programmatic+llm');
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const llmCalls = [];
    await G16.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { ci_green: async () => ({ status: 'pass', subject: null, evidence: { checks: [] } }) },
      llmValidate: async (ctx) => { llmCalls.push(ctx.key); return { status: 'inconclusive', reason: 'cannot tell' }; },
      runTask: async () => 'did the work. DURABLE: done',
    });
    await drain();
    const validations = store.listValidations(r.task.id, 'u1');
    const byKey = Object.fromEntries(validations.map(v => [v.validator, v]));
    ok(validations.length === 2 && byKey.ci_green.status === 'pass' && byKey.user_value_written.status === 'inconclusive',
      `normal: deterministic pass + LLM inconclusive recorded as before (got ${JSON.stringify(validations.map(v => [v.validator, v.status]))})`);
    ok(llmCalls.length === 1 && llmCalls[0] === 'user_value_written',
      `normal: LLM consulted once for the unregistered key (llm=${JSON.stringify(llmCalls)})`);
    ok(!JSON.stringify(byKey).includes('"skipped":true'), 'normal: no skip recorded without the marker');

    // fastpass mode, marker absent → LLM judge runs (forgiving), still no skip
    const r2 = store.createPlan({
      profile_id: 'u1', goal: 'fastpass no marker', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic+llm-fastpass' },
      items: [{ title: 'fastpass normal', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { user_value_written: true } }],
    });
    store.updateTask(r2.task.id, 'u1', { status: 'active' });
    let fastpassLlm = 0;
    await G16.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      llmValidate: async () => { fastpassLlm++; return { status: 'pass', reason: 'looks fine' }; },
      runTask: async () => 'done, no escape used. DURABLE: done',
    });
    await drain();
    const v2 = store.listValidations(r2.task.id, 'u1');
    ok(fastpassLlm === 1 && v2.length === 1 && v2[0].status === 'pass'
      && /"source":"llm"/.test(v2[0].evidence_json || '') && !/"skipped":true/.test(v2[0].evidence_json || ''),
      `fastpass: mode alone is not an auto-skip — LLM judge still decides (llm=${fastpassLlm}, ${v2[0] && v2[0].evidence_json})`);
  }

  // 17. finalization gate (P3d-2): runDueDurable closes a contract plan only via
  // finalizePlan. All items done + every declared validation pass → done; all
  // items done but a declared validation has no pass row → task stays active.
  {
    const G17 = freshStore('17');
    const store = G17.durableStore();
    const passPlan = store.createPlan({
      profile_id: 'u1', goal: 'gate pass', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit', description: 'c', validations: [{ step: 'checks', validation: { command_exit_zero: 'true' } }] }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'checks', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
    });
    store.updateTask(passPlan.task.id, 'u1', { status: 'active' });
    await G17.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) },
      runTask: async () => { throw new Error('programmatic step must not run an engine'); },
    });
    ok(store.getTask(passPlan.task.id, 'u1').status === 'done',
      'gate: task finalized when every declared validation passes');

    const blockedPlan = store.createPlan({
      profile_id: 'u1', goal: 'gate blocked', user_value: 'uv',
      acceptance_criteria: [{ id: 'crit2', description: 'c', validations: [
        { step: 'checks', validation: { command_exit_zero: 'true' } },
        { step: 'merge', validation: { merged: true } },
      ] }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'checks', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
    });
    store.updateTask(blockedPlan.task.id, 'u1', { status: 'active' });
    await G17.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) },
      runTask: async () => { throw new Error('programmatic step must not run an engine'); },
    });
    const blocked = store.getTask(blockedPlan.task.id, 'u1');
    const item = store.listTaskItems(blockedPlan.task.id, 'u1')[0];
    // Soft finalization (2026-09-28): an unmet deterministic check after every step
    // finished is never a silent stall — the plan goes 'blocked' with the reason.
    ok(item.status === 'done' && blocked.status === 'blocked' && /unmet checks/.test(blocked.blocker_reason || ''),
      `gate: items done but unmet validation blocks the task with a reason (item=${item.status}, task=${blocked.status})`);
  }

  // 18. P3d follow-up (#1449): the REAL development playbook's 4 programmatic
  // steps name the registered deterministic vocabulary, and the whole plan
  // finalizes under `programmatic` with a fake GitHub + fake command and NO LLM.
  {
    const G18 = freshStore('18');
    const store = G18.durableStore();
    // The development playbook now lives in the trained-assist-engineering
    // domain repo, not the Control Plane. This test only needs the artifact's
    // shape, so it reads the checked-in fixture (same content).
    const playbook = require('../tests/fixtures/development.json');
    const { compilePlaybook } = require('../src/playbook-compiler');
    const prUrl = 'https://github.com/acme/widgets/pull/777';
    const compiled = compilePlaybook(playbook, { goal: `finish #1449 — PR ${prUrl}` });

    const programmatic = compiled.items.filter(i => i.execution_kind === 'programmatic');
    const programKeys = programmatic.flatMap(i => Object.keys(i.validation));
    ok(programmatic.length === 4
      && programKeys.sort().join(',') === 'ci_green,command_exit_zero,merged,pr_opened',
      `p3d: development programmatic steps use the registered vocabulary (got ${JSON.stringify(programmatic.map(i => i.validation))})`);

    const r = store.createPlan({
      profile_id: 'u1', goal: compiled.goal, user_value: compiled.user_value,
      acceptance_criteria: compiled.acceptance_criteria,
      execution_policy: { validation_mode: 'programmatic' },
      items: compiled.items,
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });

    const { createDefaultRegistry } = require('../src/playbook-validators');
    const ghFetch = async (url) => {
      if (/\/pulls\/777$/.test(url)) {
        return { state: 'closed', merged: true, merged_at: '2026-09-26T00:00:00Z',
          merge_commit_sha: 'deadbeef', head: { sha: 'abc123', ref: 'fix/x' } };
      }
      if (url.endsWith('/commits/abc123/check-runs')) {
        return { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] };
      }
      return null;
    };
    const registry = createDefaultRegistry({
      ghToken: () => 'fake-token', ghFetch,
      gitInfo: () => ({ repo: 'acme/widgets', branch: 'fix/x' }),
    });
    // The shell executor itself is unit-tested; here we isolate the orchestration
    // path with a fake (the built command is asserted by the playbook snapshot).
    registry.command_exit_zero = async () => ({ status: 'pass', subject: {}, evidence: { exit_code: 0 } });
    // The 12 agent steps' self-reported keys are the LLM-judge domain (other cases
    // cover them); this case isolates the programmatic half with no LLM at all.
    for (const it of compiled.items) {
      if (it.execution_kind === 'programmatic') continue;
      for (const key of Object.keys(it.validation)) registry[key] = async () => ({ status: 'pass', subject: {}, evidence: {} });
    }

    let llmCalls = 0;
    let engineFires = 0;
    for (let i = 0; i < 40; i++) {
      await G18.runDueDurable({
        secrets: {}, now: Date.now(), isTaskRunning: () => false, registry,
        llmValidate: async () => { llmCalls++; return { status: 'inconclusive', reason: 'must not be used' }; },
        runTask: async () => { engineFires++; return 'worked on it.\nDURABLE: done'; },
        maxFires: 50,
      });
      await new Promise(res => setTimeout(res, 5));
      if (store.getTask(r.task.id, 'u1').status !== 'active') break;
      // Only the delay_after_sec=600 waiter remains: fast-forward it (claimNextRunnable
      // reads real Date.now(), so an injected `now` cannot move it).
      const w = store.db.prepare(
        `SELECT id FROM task_items WHERE task_id=? AND status='waiting' ORDER BY due_at LIMIT 1`).get(r.task.id);
      if (w) store.updateTaskItem(w.id, { due_at: Date.now() - 1, wait_deadline_at: Date.now() + 3600000 }, 'u1');
    }
    const task = store.getTask(r.task.id, 'u1');
    const vals = store.listValidations(r.task.id, 'u1');
    const progVals = vals.filter(v => ['command_exit_zero', 'pr_opened', 'ci_green', 'merged'].includes(v.validator));
    ok(task.status === 'done', `p3d: development plan finalizes under programmatic (got ${task.status})`);
    ok(progVals.length === 4 && progVals.every(v => v.status === 'pass'),
      `p3d: every programmatic validator passes deterministically (got ${JSON.stringify(progVals.map(v => [v.validator, v.status]))})`);
    ok(engineFires === 12, `p3d: the 4 programmatic steps fired no engine (engine fires=${engineFires})`);
    ok(llmCalls === 0, `p3d: no LLM call in programmatic mode (llm=${llmCalls})`);
  }

  // 19. P3b role wiring (#1449): the resolver's ocRole reaches runTask and selects
  // the ladder role; forceClaude is engine-scoped (false for opencode, true for claude).
  {
    const G19 = freshStore('19');
    const store = G19.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'role wiring', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      // Deterministic mode: under strict positional ordering the next step only
      // becomes claimable after this step's completion callback runs, so the
      // callback must not block on the default cheap-LLM judge (case 18 already
      // covers validation; this case isolates role wiring).
      execution_policy: { validation_mode: 'programmatic' },
      items: [
        { title: 'research', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
        { title: 'review', execution_kind: 'agent', executor_role: 'reviewer', minimum_model_level: 'master', context_budget: 'medium', validation: { command: 'true' } },
        { title: 'finalize', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'doctor', context_budget: 'medium', validation: { command: 'true' } },
        // reviewer@doctor = independent review on another model family (owner 2026-09-30): codex, not claude.
        { title: 'independent review', execution_kind: 'agent', executor_role: 'reviewer', minimum_model_level: 'doctor', context_budget: 'medium', validation: { command: 'true' } },
      ],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const opts = [];
    for (let i = 0; i < 4; i++) {
      await G19.runDueDurable({
        secrets: {}, now: Date.now(), isTaskRunning: () => false,
        runTask: async (o) => { opts.push(o); return 'DURABLE: done'; },
        maxFires: 1,
      });
      await drain();
    }
    ok(opts.length === 4, `role: four agent steps fired (got ${opts.length})`);
    const shape = o => o && { engine: o.engine, ocProfile: o.ocProfile, ocRole: o.ocRole, forceClaude: o.forceClaude };
    ok(opts[0] && opts[0].engine === 'opencode' && opts[0].ocRole === 'explore' && opts[0].forceClaude === false,
      `role: researcher→opencode/explore, forceClaude=false (got ${JSON.stringify(shape(opts[0]))})`);
    ok(opts[1] && opts[1].engine === 'opencode' && opts[1].ocRole === 'review' && opts[1].forceClaude === false,
      `role: reviewer→opencode/review, forceClaude=false (got ${JSON.stringify(shape(opts[1]))})`);
    ok(opts[2] && opts[2].engine === 'claude' && !opts[2].ocRole && opts[2].forceClaude === true,
      `role: doctor→claude, forceClaude=true (got ${JSON.stringify(shape(opts[2]))})`);
    ok(opts[3] && opts[3].engine === 'codex' && !opts[3].ocRole && opts[3].forceClaude === false,
      `role: reviewer@doctor→codex, forceClaude=false (got ${JSON.stringify(shape(opts[3]))})`);
  }

  // 20. strict positional ordering (#1450): a 3-item plan with a delay-gated step
  // fires strictly 1→2→3 through runDueDurable. The delayed step also proves the
  // injected `now` drives due_at selection — the tick is advanced to the waiter's
  // own due_at, not the wall clock, so the case is deterministic.
  {
    const G20 = freshStore('20');
    const store = G20.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'positional smoke', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [
        { title: 'one', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
        { title: 'two', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, delay_after_sec: 600 },
        { title: 'three', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
      ],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const order = [];
    const tick = (now) => G20.runDueDurable({
      secrets: {}, now, isTaskRunning: () => false, maxFires: 5,
      runTask: async (o) => { order.push(o.task.match(/Step \(\d+\/\d+\): (\w+)/)[1]); return 'DURABLE: done'; },
    });

    await tick(Date.now());
    await drain();
    let items = store.listTaskItems(r.task.id, 'u1');
    ok(order.join(',') === 'one',
      `positional: only step 1 fires before the delay gate (got ${order.join(',')})`);
    ok(items[0].status === 'done' && items[1].status === 'waiting' && items[2].status === 'pending',
      `positional: after step 1 — done/waiting/pending (got ${items.map(i => i.status).join('/')})`);

    // Not-yet-due waiter blocks step 3 even though step 3 has no delay.
    const due = items[1].due_at;
    await tick(due - 1);
    await drain();
    ok(order.join(',') === 'one',
      `positional: a not-yet-due predecessor blocks the successor (got ${order.join(',')})`);

    await tick(due);
    await drain();
    ok(order.join(',') === 'one,two',
      `positional: waiter fires once now reaches its due_at (got ${order.join(',')})`);

    await tick(due);
    await drain();
    ok(order.join(',') === 'one,two,three',
      `positional: step 3 fires only after step 2 is done (got ${order.join(',')})`);
    ok(store.getTask(r.task.id, 'u1').status === 'done', 'positional: plan finalizes after strict 1→2→3');
  }

  // 21. P3c recovery: a QUOTA-classified failure bumps the model level
  // (bachelor→master, still OpenCode here) and re-pends, recording class+action. Rung
  // failover inside a level is the llm-ladder worker's (#1687) — nothing advanced here.
  {
    const G21 = freshStore('21');
    const store = G21.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'quota recovery', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'agent step', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 3 }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    await G21.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      classifier: () => ({ class: 'QUOTA', retryable: true, source: 'rule', confidence: 1 }),
      runTask: async () => 'boom. DURABLE: failed: quota exceeded',
    });
    await drain(); await drain();
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'pending' && item.current_model_level === 'master',
      `p3c: QUOTA advances model level bachelor→master and re-pends (got ${item.status}/${item.current_model_level})`);
    ok(item.last_failure_class === 'QUOTA' && item.last_recovery_action === 'next_model_or_provider',
      `p3c: failure class + action recorded on the item (got ${item.last_failure_class}/${item.last_recovery_action})`);
  }

  // 22. P3c recovery: a terminal action leaves the item failed (alternative
  // provider already spent → AUTH's second rung is terminal).
  {
    const G22 = freshStore('22');
    const store = G22.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'terminal recovery', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      // Pinned level without a fallback engine: default bachelor falls back to the free ladder
      // (#1899), which would turn this AUTH into fallback_rung — covered by 22b.
      execution_policy: { validation_mode: 'programmatic', level_map: { bachelor: { engine: 'opencode', ocProfile: 'service' } } },
      items: [{ title: 'auth step', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 5 }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const it = store.listTaskItems(r.task.id, 'u1')[0];
    // Pretend one recovery move was already spent: startExecution will bump this
    // to 2 → spent=1 → AUTH actions[1] === 'terminal' → null.
    store.db.prepare('UPDATE task_items SET attempt_count=1 WHERE id=?').run(it.id);
    await G22.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      classifier: () => ({ class: 'AUTH', retryable: false, source: 'rule', confidence: 1 }),
      runTask: async () => 'nope. DURABLE: failed: not logged in',
    });
    await drain();
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'failed' && item.last_recovery_action === 'terminal',
      `p3c: terminal class leaves the item failed (got ${item.status}/${item.last_recovery_action})`);
  }

  // 22b. Exhausted llm-ladder (2026-09-29: Go weekly limit + OpenRouter credits at zero) on a
  // default bachelor step: "every rung failed" is CONFIG → fallback_rung, and the next run of the
  // step goes to the FREE ladder (opencode/free) — never Claude (owner requirement #1899).
  {
    const G22b = freshStore('22b');
    const store = G22b.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'ladder exhausted', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'cheap step', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 5 }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const engines = [];
    const run = (now) => G22b.runDueDurable({
      secrets: {}, now, isTaskRunning: () => false,
      runTask: async (opts) => {
        engines.push(`${opts.engine}/${opts.ocProfile}`);
        return opts.ocProfile === 'service' ? '⚠️ OpenCode завершился с ошибкой: every rung failed' : 'ok. DURABLE: done';
      },
    });
    await run(Date.now()); await drain();
    let item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'pending' && item.last_recovery_action === 'fallback_rung' && item.last_failure_class === 'CONFIG',
      `ladder exhausted: CONFIG → fallback_rung (got ${item.status}/${item.last_failure_class}/${item.last_recovery_action})`);
    store.db.prepare('UPDATE task_items SET due_at=NULL WHERE id=?').run(item.id);
    await run(Date.now() + 24 * 3600 * 1000); await drain();
    item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(engines.join(',') === 'opencode/service,opencode/free' && item.status === 'done',
      `ladder exhausted: next run goes to the free ladder (not claude) and completes (got ${engines.join(',')}/${item.status})`);
  }

  // 23. P3c recovery is bounded by DEFAULT_RECOVERY_BUDGET: even with attempt
  // budget to spare, a spent recovery budget is terminal. Direct module call with
  // an injected budget keeps the assertion deterministic.
  {
    const G23 = freshStore('23');
    const store = G23.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'budget recovery', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'never ends', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 50 }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const it = store.listTaskItems(r.task.id, 'u1')[0];
    store.db.prepare('UPDATE task_items SET attempt_count=3 WHERE id=?').run(it.id); // spent = 2
    const { recoverDurableItem } = require('../src/durable-recovery');
    const rec = await recoverDurableItem({
      store, task: store.getTask(r.task.id, 'u1'), itemId: it.id, errorText: 'anything',
      classifier: () => ({ class: 'UNKNOWN', retryable: true, source: 'rule', confidence: 1 }),
      budget: 2,
    });
    ok(rec.recovered === false && rec.reason === 'terminal' && rec.action === null,
      `p3c: recovery stops at the spent budget (got ${JSON.stringify(rec)})`);
  }

  // 24. P3c recovery never re-pends infinitely: a class whose action ladder ends
  // at 'terminal' stops even with a huge max_attempts. UNKNOWN is
  // conservative_retry → fallback → terminal, so it fails on the 3rd attempt.
  {
    const G24 = freshStore('24');
    const store = G24.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'bounded recovery', user_value: 'uv',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'endless?', execution_kind: 'agent', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 50 }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let fires = 0;
    const failRun = () => G24.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      classifier: () => ({ class: 'UNKNOWN', retryable: true, source: 'rule', confidence: 1 }),
      runTask: async () => { fires++; return 'boom. DURABLE: failed: exploded'; },
    });
    for (let i = 0; i < 6; i++) { await failRun(); await drain(); }
    const item = store.listTaskItems(r.task.id, 'u1')[0];
    ok(item.status === 'failed' && fires === 3,
      `p3c: bounded re-pend stops after the action ladder (fires=${fires}, status=${item.status}, attempts=${item.attempt_count})`);
    let extra = 0;
    await G24.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
      classifier: () => ({ class: 'UNKNOWN' }), runTask: async () => { extra++; return 'DURABLE: done'; } });
    ok(extra === 0, `p3c: exhausted item is never re-fired (extra=${extra})`);
  }

  // 25. P3c recovery: a provider-switch action for the deepseek profile is a plain bounded
  // re-pend — switching provider/rung is the llm-ladder worker's job (#1687); the item
  // re-pends with the action recorded.
  {
    const G25 = freshStore('25');
    const store = G25.durableStore();
    process.env.PLAYBOOK_LEVEL_MAP = JSON.stringify({ bachelor: { engine: 'opencode', ocProfile: 'service' } });
    try {
      const r = store.createPlan({
        profile_id: 'u1', goal: 'provider recovery', user_value: 'uv',
        acceptance_criteria: [{ description: 'c' }],
        execution_policy: { validation_mode: 'programmatic' },
        items: [{ title: 'deepseek step', execution_kind: 'agent', executor_role: 'developer',
          minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' }, max_attempts: 5 }],
      });
      store.updateTask(r.task.id, 'u1', { status: 'active' });
      await G25.runDueDurable({
        secrets: {}, now: Date.now(), isTaskRunning: () => false,
        classifier: () => ({ class: 'AUTH', retryable: false, source: 'rule', confidence: 1 }),
        runTask: async () => 'nope. DURABLE: failed: not logged in',
      });
      await drain();
      const item = store.listTaskItems(r.task.id, 'u1')[0];
      ok(item.status === 'pending' && item.last_recovery_action === 'alternate_provider',
        `p3c: deepseek provider switch re-pends (got ${item.status}, ${item.last_recovery_action})`);
    } finally {
      delete process.env.PLAYBOOK_LEVEL_MAP;
    }
  }

  // 26. legacy (non-contract) item still works through recovery: no model level
  // to bump, so a failure takes the bounded re-pend path and stays claimable.
  {
    const G26 = freshStore('26');
    const store = G26.durableStore();
    store.createTask({ id: 'legacy-26', profile_id: 'u1', goal: 'legacy recovery' });
    store.createTaskItem({ id: 'legacy-item-26', task_id: 'legacy-26', title: 'legacy step' });
    await G26.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      classifier: () => ({ class: 'MODEL_ERROR', retryable: true, source: 'rule', confidence: 1 }),
      runTask: async () => 'nope. DURABLE: failed: internal server error',
    });
    await drain();
    const item = store.getTaskItem('legacy-item-26');
    ok(item.status === 'pending' && !item.current_model_level && item.last_recovery_action,
      `p3c: legacy item re-pends through recovery without a model level (got ${item.status}/${item.current_model_level}/${item.last_recovery_action})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
