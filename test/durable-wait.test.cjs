// Durable wait ("wait-until") — src/durable-wait.js wired through
// src/gtd-controller.js runDueDurable + MCP task_item_wait / task_item_wake.
//
// A plan step must be able to sleep until something external happens (CI green,
// deploy live, credentials connected, an error in the logs, another plan done,
// a user answer, a plain timer) and wake up — without burning attempts, without
// a model per poll, and across days. Invariants pinned here:
//   1. playbook wait: a programmatic step polls its own validation, parks between
//      polls (no execution row, no attempt), completes when it passes;
//   2. playbook wait timeout → the step fails through the normal failure path;
//   3. agent wait on a condition: task_item_wait + `DURABLE: waiting` parks the
//      step, refunds the attempt, polls deterministically, re-runs the SAME step
//      with a resume note once the condition holds;
//   4. agent wait on a user answer: not polled, surfaced in the chat notice,
//      woken by task_item_wake with the answer handed to the resumed run;
//   5. a plain timer re-runs the step at its deadline;
//   6. `DURABLE: waiting` without a registered wait is a bounded failure;
//   7. compile-time typing: wait only on programmatic steps with known keys;
//   8. the new validators + PR lookup across the plan's earlier evidence.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = () => new Promise(r => setTimeout(r, 0));

const TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-wait-tokens-'));
process.env.AGENT_TOKENS_DIR = TOKENS_DIR;

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-wait-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  const tools = require('../src/mcp-skills/tools/101-durable-tasks.js').tools;
  return { G, store: G.durableStore(), tools };
}

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'wait smoke', user_value: 'v',
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

(async () => {
  // 1. playbook wait: poll → park → pass → done, no attempts spent while waiting
  {
    const { G, store } = fresh('1');
    const taskId = activePlan(store, [{
      title: 'Wait for CI', execution_kind: 'programmatic', validation: { ci_green: true },
      wait: { poll_every_sec: 60, timeout_sec: 3600 },
    }]);
    let green = false;
    let calls = 0;
    const registry = { ci_green: async () => { calls++; return { status: green ? 'pass' : 'fail', subject: {}, evidence: {} }; } };
    const t0 = Date.now();
    const fired = await G.runDueDurable({ secrets: {}, now: t0, isTaskRunning: () => false, registry, runTask: async () => 'x' });
    let item = store.listTaskItems(taskId, 'u1')[0];
    ok(fired === 0, `wait poll is not a fire (got ${fired})`);
    ok(item.status === 'waiting', `red CI parks the step (got ${item.status})`);
    ok(item.attempt_count === 0, `a poll spends no attempt (got ${item.attempt_count})`);
    ok(item.due_at >= t0 + 59_000 && item.due_at <= t0 + 61_000, `next poll after poll_every_sec (due in ${item.due_at - t0}ms)`);
    ok(store.db.prepare('SELECT COUNT(*) n FROM executions').get().n === 0, 'a poll creates no execution row');
    const w = JSON.parse(item.wait_json);
    ok(w.deadline_at === w.started_at + 3600_000 && w.then === 'complete', 'the wait is armed on first poll with its deadline');

    await G.runDueDurable({ secrets: {}, now: t0 + 30_000, isTaskRunning: () => false, registry, runTask: async () => 'x' });
    ok(calls === 1, `not polled before due (calls=${calls})`);

    green = true;
    await G.runDueDurable({ secrets: {}, now: t0 + 61_000, isTaskRunning: () => false, registry, runTask: async () => 'x' });
    item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `green CI completes the step (got ${item.status})`);
    ok(store.getTask(taskId, 'u1').status === 'done', 'plan finalizes after the wait');
  }

  // 2. playbook wait timeout → normal failure path, wait marked resolved=timeout
  {
    const { G, store } = fresh('2');
    const taskId = activePlan(store, [{
      title: 'Wait for merge', execution_kind: 'programmatic', validation: { merged: true },
      wait: { poll_every_sec: 60, timeout_sec: 120 }, max_attempts: 1,
    }]);
    const registry = { merged: async () => ({ status: 'fail', subject: {}, evidence: {} }) };
    const t0 = Date.now();
    await G.runDueDurable({ secrets: {}, now: t0, isTaskRunning: () => false, registry, runTask: async () => 'x' });
    await G.runDueDurable({ secrets: {}, now: t0 + 121_000, isTaskRunning: () => false, registry, runTask: async () => 'x' });
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(JSON.parse(item.wait_json).resolved === 'timeout', 'deadline resolves the wait as timeout');
    ok(item.status === 'failed', `timed-out wait fails the step once its budget is spent (got ${item.status})`);
  }

  // 3. agent wait on a condition: park, refund, poll without a model, re-run with resume note
  {
    const { G, store, tools } = fresh('3');
    const taskId = activePlan(store, [agentItem('Verify deploy'), agentItem('Next step')]);
    const prompts = [];
    let credential = false;
    const registry = { ...passAll, credential_present: async () => ({ status: credential ? 'pass' : 'fail', subject: {}, evidence: { credential } }) };
    const runWaiting = async (opts) => {
      prompts.push(opts.task);
      const itemId = /Step id: (\S+)/.exec(opts.task)[1];
      const res = await tools.task_item_wait.handler({
        item_id: itemId, until: { credential_present: 'github' }, poll_every_sec: 300, timeout_sec: 3 * 86400,
        reason: 'пользователь подключит GitHub',
      }, { userId: 'u1' });
      ok(res.ok === true, `task_item_wait accepted (${JSON.stringify(res).slice(0, 200)})`);
      return 'Жду GitHub.\nDURABLE: waiting';
    };
    const t0 = Date.now();
    await G.runDueDurable({ secrets: {}, now: t0, isTaskRunning: () => false, registry, runTask: runWaiting });
    await drain(); await drain();
    let [item, next] = store.listTaskItems(taskId, 'u1');
    ok(item.status === 'waiting', `agent wait parks the step (got ${item.status})`);
    ok(item.attempt_count === 0, `the waiting run's attempt is refunded (got ${item.attempt_count})`);
    ok(next.status === 'pending', 'later steps stay blocked behind the waiting step');
    const exec = store.db.prepare('SELECT status FROM executions').all();
    ok(exec.length === 1 && exec[0].status === 'waiting', `the run is recorded as waiting (got ${JSON.stringify(exec)})`);

    let runs = 0;
    const runDone = async (opts) => { runs++; prompts.push(opts.task); return 'готово. DURABLE: done'; };
    await G.runDueDurable({ secrets: {}, now: Date.now() + 301_000, isTaskRunning: () => false, registry, runTask: runDone });
    await drain();
    ok(runs === 0, 'unmet condition is polled without starting the agent');
    ok(store.listTaskItems(taskId, 'u1')[0].status === 'waiting', 'still waiting after a failed poll');

    credential = true;
    await G.runDueDurable({ secrets: {}, now: Date.now() + 602_000, isTaskRunning: () => false, registry, runTask: runDone, maxFires: 1 });
    await drain(); await drain();
    [item] = store.listTaskItems(taskId, 'u1');
    const resumedPrompt = prompts[prompts.length - 1];
    ok(runs === 1, `met condition re-runs the same step (runs=${runs})`);
    ok(/ПРОБУЖДЕНИЕ/.test(resumedPrompt) && /Условие выполнено/.test(resumedPrompt) && /GitHub/.test(resumedPrompt),
      'the resumed run is told what it waited for and that it happened');
    ok(item.status === 'done', `resumed step completes (got ${item.status})`);
  }

  // 4. agent wait on a user answer: not polled, surfaced in chat notice, woken with the answer
  {
    const { G, store, tools } = fresh('4');
    const taskId = activePlan(store, [agentItem('Ask for API key')]);
    const prompts = [];
    const t0 = Date.now();
    await G.runDueDurable({
      secrets: {}, now: t0, isTaskRunning: () => false, registry: passAll,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 3 * 86400, reason: 'ключ Deepgram' }, { userId: 'u1' });
        return 'Спросил ключ. DURABLE: waiting';
      },
    });
    await drain(); await drain();
    let item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'waiting' && item.due_at >= t0 + 3 * 86400_000 - 5_000, 'a user wait sleeps until its deadline (nothing to poll)');

    const { buildAwaitingUserNotice } = require('../src/durable-wait.js');
    const notice = buildAwaitingUserNotice('u1', { store });
    ok(notice.includes(item.id) && /ключ Deepgram/.test(notice) && /task_item_wake/.test(notice), 'chat notice lists the waiting step');
    ok(buildAwaitingUserNotice('someone-else', { store }) === '', 'notice is profile-scoped');

    let runs = 0;
    const runDone = async (opts) => { runs++; prompts.push(opts.task); return 'DURABLE: done'; };
    await G.runDueDurable({ secrets: {}, now: t0 + 3600_000, isTaskRunning: () => false, registry: passAll, runTask: runDone });
    ok(runs === 0, 'not re-run before an answer or the deadline');

    const woke = await tools.task_item_wake.handler({ item_id: item.id, message: 'вот ключ: dg_123' }, { userId: 'u1' });
    ok(woke.item && woke.item.status === 'waiting', 'wake accepted');
    const foreign = await tools.task_item_wake.handler({ item_id: item.id, message: 'x' }, { userId: 'intruder' });
    ok(!!foreign.error, 'another profile cannot wake the step');
    await G.runDueDurable({ secrets: {}, now: Date.now() + 1000, isTaskRunning: () => false, registry: passAll, runTask: runDone });
    await drain(); await drain();
    item = store.listTaskItems(taskId, 'u1')[0];
    ok(runs === 1 && /dg_123/.test(prompts[0]) && /разбудил/.test(prompts[0]), 'woken run receives the user answer');
    ok(item.status === 'done', `answered step completes (got ${item.status})`);
    ok(buildAwaitingUserNotice('u1', { store }) === '', 'notice clears once nothing waits');
  }

  // 5. plain timer: re-run at the deadline with a timer note
  {
    const { G, store, tools } = fresh('5');
    const taskId = activePlan(store, [agentItem('Observe logs for a day')]);
    const t0 = Date.now();
    await G.runDueDurable({
      secrets: {}, now: t0, isTaskRunning: () => false, registry: passAll,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, sleep_sec: 3600, reason: 'наблюдаем ошибку в логах' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain(); await drain();
    let runs = 0; let prompt = '';
    const runDone = async (opts) => { runs++; prompt = opts.task; return 'DURABLE: done'; };
    await G.runDueDurable({ secrets: {}, now: t0 + 1800_000, isTaskRunning: () => false, registry: passAll, runTask: runDone });
    ok(runs === 0, 'timer not fired early');
    // maxFires: time-travelling `now` an hour ahead makes the just-fired (running)
    // step look orphaned to the same pass — cap the pass at the one fire we assert.
    await G.runDueDurable({ secrets: {}, now: Date.now() + 3601_000, isTaskRunning: () => false, registry: passAll, runTask: runDone, maxFires: 1 });
    await drain(); await drain();
    ok(runs === 1 && /Таймер сработал/.test(prompt), 'timer re-runs the step with a timer note');
    ok(store.listTaskItems(taskId, 'u1')[0].status === 'done', 'timer step completes');
  }

  // 5b. a final fail (CI finished red) wakes the agent now instead of polling to timeout
  {
    const { G, store, tools } = fresh('5b');
    const taskId = activePlan(store, [agentItem('CI green (repair if red)')]);
    const registry = { ...passAll, ci_green: async () => ({ status: 'fail', subject: {}, evidence: { failing: ['test'], final: true } }) };
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, until: { ci_green: 'https://github.com/o/r/pull/9' }, timeout_sec: 7200, reason: 'CI' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain(); await drain();
    let prompt = '';
    await G.runDueDurable({ secrets: {}, now: Date.now() + 301_000, isTaskRunning: () => false, registry, maxFires: 1,
      runTask: async (opts) => { prompt = opts.task; return 'DURABLE: done'; } });
    await drain(); await drain();
    ok(/окончательно НЕ выполнилось/.test(prompt) && /failing/.test(prompt), 'red CI wakes the step with the failing evidence');
    ok(store.listTaskItems(taskId, 'u1')[0].status === 'done', 'woken step can repair and finish');
  }

  // 5c. continuity: a step sees the ИТОГ ШАГА of the steps before it
  {
    const { G, store } = fresh('5c');
    const taskId = activePlan(store, [agentItem('Define use case'), agentItem('Open PR')]);
    const prompts = [];
    const run = async (opts) => {
      prompts.push(opts.task);
      return prompts.length === 1
        ? 'долгий разбор...\nИТОГ ШАГА\n- issue: https://github.com/o/r/issues/5\n- решение: без новых ролей\nDURABLE: done'
        : 'DURABLE: done';
    };
    await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: passAll, runTask: run, maxFires: 1 });
    await drain(); await drain();
    await G.runDueDurable({ secrets: {}, now: Date.now() + 1000, isTaskRunning: () => false, registry: passAll, runTask: run, maxFires: 1 });
    await drain(); await drain();
    ok(!/ИТОГИ ПРЕДЫДУЩИХ/.test(prompts[0]) && /Plan id: /.test(prompts[0]), 'the first step has no digest but knows its plan id');
    ok(/ИТОГИ ПРЕДЫДУЩИХ ШАГОВ/.test(prompts[1]) && /issues\/5/.test(prompts[1]) && /без новых ролей/.test(prompts[1]),
      'the next step receives the previous step summary');
    ok(!/долгий разбор/.test(prompts[1]) && !/DURABLE: done/.test(prompts[1].split('[ИТОГИ')[1].split('Step (')[0]),
      'the digest keeps only the summary block, not the whole reply or its marker');
    ok(store.getTask(taskId, 'u1').status === 'done', 'plan finishes');
  }

  // 6. DURABLE: waiting without task_item_wait → bounded failure, not a silent park
  {
    const { G, store } = fresh('6');
    const taskId = activePlan(store, [agentItem('Forgetful')]);
    await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: passAll, runTask: async () => 'DURABLE: waiting' });
    await drain(); await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status !== 'waiting' && /without task_item_wait/.test(item.last_error || ''),
      `waiting without a registered wait is a failure (status=${item.status}, err=${item.last_error})`);
  }

  // 6b. task_item_wait rejects bad requests
  {
    const { store, tools } = fresh('6b');
    const taskId = activePlan(store, [agentItem('x')]);
    const item = store.listTaskItems(taskId, 'u1')[0];
    const notRunning = await tools.task_item_wait.handler({ item_id: item.id, sleep_sec: 600 }, { userId: 'u1' });
    ok(/running/.test(notRunning.error || ''), 'only the running step can be parked');
    store.db.prepare("UPDATE task_items SET status='running' WHERE id=?").run(item.id);
    const unknown = await tools.task_item_wait.handler({ item_id: item.id, until: { vibes_ok: true } }, { userId: 'u1' });
    ok(/unknown validator/.test(unknown.error || ''), 'an until with an unknown validator is rejected up front');
    const empty = await tools.task_item_wait.handler({ item_id: item.id }, { userId: 'u1' });
    ok(/at least one/.test(empty.error || ''), 'a wait needs a condition, a user answer or a timer');
  }

  // 7. compile-time typing of playbook waits
  {
    const { compilePlaybook } = require('../src/playbook-compiler.js');
    const base = st => ({ id: 'w', version: 1, scope: 'system', title: 'W', goal_template: '{goal}', stages: [{ id: 's', title: 'S', steps: [st] }] });
    const compiled = compilePlaybook(base({ title: 'CI', execution_kind: 'programmatic', validation: { ci_green: true }, wait: { poll_every_sec: 300, timeout_sec: 7200 } }), { goal: 'g' });
    ok(compiled.items[0].wait && compiled.items[0].wait.timeout_sec === 7200, 'a programmatic wait compiles onto the item');
    let err = null;
    try { compilePlaybook(base({ title: 'x', execution_kind: 'programmatic', validation: { made_up: true }, wait: { poll_every_sec: 300, timeout_sec: 600 } }), { goal: 'g' }); } catch (e) { err = e; }
    ok(err && err.code === 'COMPILE_INVALID', 'a wait on an unknown validator is a compile error');
    err = null;
    try {
      compilePlaybook(base({ title: 'x', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ci_green: true }, wait: { poll_every_sec: 300, timeout_sec: 600 } }), { goal: 'g' });
    } catch (e) { err = e; }
    ok(err && err.code === 'COMPILE_INVALID', 'a declared wait on an agent step is a compile error');
    const { validatePlaybook } = require('../src/playbook-store.js');
    ok(validatePlaybook({ ...base({ title: 'x', step_type: 'sandbox', execution_kind: 'programmatic', validation: { ci_green: true } }) }) === true,
      'schema accepts step_type');
  }

  // 8. validators + PR lookup across the plan
  {
    const V = require('../src/playbook-validators.js');
    fs.mkdirSync(path.join(TOKENS_DIR, 'u1'), { recursive: true });
    fs.writeFileSync(path.join(TOKENS_DIR, 'u1', 'github'), 'ghp_x');
    ok((await V.credentialPresent({ profileId: 'u1', validation: 'github' })).status === 'pass', 'credential_present: stored token passes');
    ok((await V.credentialPresent({ profileId: 'u1', validation: 'deepgram' })).status === 'fail', 'credential_present: missing token fails');
    ok((await V.credentialPresent({ profileId: 'u1', validation: '../u2/github' })).status === 'inconclusive', 'credential_present: traversal rejected');

    const fetchOk = async () => ({ ok: true, status: 200, text: async () => '{"commit":"abc123"}' });
    const httpOk = V.makeHttpOkValidator({ fetchImpl: fetchOk });
    ok((await httpOk({ validation: { url: 'https://h/health', contains: 'abc123' } })).status === 'pass', 'http_ok: 2xx + contains passes');
    ok((await httpOk({ validation: { url: 'https://h/health', contains: 'def456' } })).status === 'fail', 'http_ok: missing text fails (old deploy)');
    const httpDown = V.makeHttpOkValidator({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    ok((await httpDown({ validation: 'https://h/health' })).status === 'inconclusive', 'http_ok: network error is inconclusive');

    const taskDone = V.makeTaskDoneValidator({ getTask: id => (id === 't1' ? { status: 'done' } : id === 't2' ? { status: 'active' } : null) });
    ok((await taskDone({ profileId: 'u1', validation: 't1' })).status === 'pass', 'task_done: done plan passes');
    ok((await taskDone({ profileId: 'u1', validation: 't2' })).status === 'fail', 'task_done: active plan fails');

    const planText = 'opened https://github.com/o/r/pull/1\n{"reply":"PR: https://github.com/o/r/pull/7"}';
    ok(V.extractPrRef({ item: {}, planText }).number === '7', 'PR lookup: the latest PR in earlier steps wins');
    ok(V.extractPrRef({ item: {}, planText, validation: 'https://github.com/x/y/pull/3' }).number === '3', 'PR lookup: explicit value wins');
  }

  // 9. poll floor is 30s: poll_every_sec:30 accepted end-to-end, next poll within
  //    30s (DW-02, durable-wait-latency plan a61bb2c5). The old clamp tests above
  //    use poll_every_sec:60 and stay green — the floor dropped, nothing else moved.
  {
    const { G, store } = fresh('9');
    const waitLib = require('../src/durable-wait.js');
    ok(waitLib.MIN_POLL_SEC === 30, `MIN_POLL_SEC is 30 (got ${waitLib.MIN_POLL_SEC})`);
    const now = Date.now();
    const { wait, error } = waitLib.normalizeAgentWait(
      { item_id: 'x', until: { ci_green: 'https://github.com/o/r/pull/1' }, poll_every_sec: 30, timeout_sec: 600, reason: 'CI' },
      { now, registryKeys: ['ci_green'] });
    ok(!error && wait && wait.poll_every_sec === 30,
      `poll_every_sec:30 is accepted (${error || (wait && wait.poll_every_sec)})`);
    ok(waitLib.nextDueAt(wait, now) <= now + 30_000,
      `next poll due within 30s (in ${waitLib.nextDueAt(wait, now) - now}ms)`);
    // The playbook compiler schema shares the same contract (validateItem).
    const r = store.createPlan({
      profile_id: 'u1', goal: 'floor 30', user_value: 'v',
      acceptance_criteria: [{ description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'Fast wait', execution_kind: 'programmatic', executor_role: 'developer',
        minimum_model_level: 'bachelor', context_budget: 'small',
        validation: { file_exists: 'flag' }, wait: { poll_every_sec: 30, timeout_sec: 300 } }],
    });
    ok(!!r.task.id, 'a declared wait with poll_every_sec:30 compiles into a plan');
    ok(JSON.parse(store.listTaskItems(r.task.id, 'u1')[0].wait_json).then === 'complete',
      'the 30s wait is stored as a declared wait');
    void G;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
