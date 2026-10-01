// Structured step result end-to-end (#87 B1.3): the step posts its verdict via
// MCP `task_item_result` and the settle reads THAT — not a `DURABLE:` marker
// parsed out of the reply text (94% of OpenCode step failures were «no terminal
// marker» while the work was done, #1907 audit). The marker path itself is
// pinned as unchanged: engines that never call the tool behave exactly as before.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 80) => new Promise(r => setTimeout(r, ms));

const TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-result-tokens-'));
process.env.AGENT_TOKENS_DIR = TOKENS_DIR;

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-result-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  const tools = require('../src/mcp-skills/tools/101-durable-tasks.js').tools;
  return { G, tools, store: G.durableStore(), dir };
}

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'structured result smoke', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

const agentItem = (title, extra = {}) => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small', validation: { command_exit_zero: 'true' },
  ...extra,
});
const passAll = () => ({ status: 'pass', subject: {}, evidence: {} });

(async () => {
  // 1. Structured `done`, NO marker in the reply — the classic OpenCode failure.
  //    The step completes from the structure, the marker judge is never asked,
  //    and the validators see the structured result.
  {
    const { G, store, tools } = fresh('done');
    const taskId = activePlan(store, [agentItem('Открыть PR')]);
    let judgeCalls = 0;
    const seenPlanText = [];
    let promptAttempt = null;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: ctx => { seenPlanText.push(String(ctx.planText || '')); return passAll(); } },
      markerJudge: async () => { judgeCalls += 1; return { verdict: 'uncertain', reason: 'must-not-be-called' }; },
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        promptAttempt = Number(/Attempt: (\d+)/.exec(opts.task)[1]);
        const res = await tools.task_item_result.handler({
          item_id: itemId, attempt: promptAttempt, status: 'done',
          result: { pr_url: 'https://github.com/o/r/pull/7' }, note: 'PR #7 открыт',
        }, { userId: 'u1' });
        ok(res.ok === true, `task_item_result accepted (got ${JSON.stringify(res).slice(0, 200)})`);
        // no DURABLE marker at all — before this change this burned an attempt
        return 'ИТОГ ШАГА: открыл PR https://github.com/o/r/pull/7\nПроверил сборку, всё зелёное.';
      },
    });
    await drain();

    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `the structured result settles the step (got ${item.status})`);
    ok(judgeCalls === 0, `the marker judge is never consulted for a structured result (calls=${judgeCalls})`);
    ok(promptAttempt === 1, `the prompt carries "Attempt: 1" (got ${promptAttempt})`);
    ok(seenPlanText.some(t => /RESULT:.*pr_url/.test(t)), 'validators receive the structured result (no text parsing)');
    const ev = JSON.parse(item.evidence_json || '{}');
    ok(ev.step_result && ev.step_result.pr_url === 'https://github.com/o/r/pull/7', 'evidence carries step_result');
    ok(ev.step_note === 'PR #7 открыт', 'evidence carries step_note');
    ok(store.getExecution(item.last_execution_id).status === 'success', 'the execution closed as success');
  }

  // 2. Structured `failed` — the note becomes the step's failure reason.
  {
    const { G, store, tools } = fresh('failed');
    const taskId = activePlan(store, [agentItem('Сделать фикс', { max_attempts: 1 })]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: () => passAll() },
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        const res = await tools.task_item_result.handler({
          item_id: itemId, status: 'failed', note: 'нет доступа к репозиторию',
          result: { error: 'git auth' },
        }, { userId: 'u1' });
        ok(res.ok === true, `a structured failure is accepted (got ${JSON.stringify(res).slice(0, 160)})`);
        return 'Что-то пошло не так, подробности выше. Результат: git auth.';
      },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'failed', `the step fails from the structure (got ${item.status})`);
    ok(String(item.last_error || '').includes('нет доступа к репозиторию'),
      `the note is the failure reason (got ${item.last_error})`);
    const execs = store.db.prepare(`SELECT status, error_text FROM executions WHERE task_item_id = ?`).all(item.id);
    ok(execs.length === 1 && execs[0].status === 'failed', 'the execution closed as failed');
  }

  // 3. Structured `waiting` with a registered wait — parks exactly like the marker.
  {
    const { G, store, tools } = fresh('waiting');
    const taskId = activePlan(store, [agentItem('Ждём ответ')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: () => passAll() },
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 86400, reason: 'нужен ключ' }, { userId: 'u1' });
        await tools.task_item_result.handler({ item_id: itemId, status: 'waiting', note: 'спросил ключ' }, { userId: 'u1' });
        return 'Жду ключ от пользователя.';   // no marker
      },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'waiting', `the structured waiting parks the step (got ${item.status})`);
    ok(JSON.parse(item.wait_json).awaiting_user === true, 'the registered wait is what parks it');
    const exec = store.db.prepare(`SELECT status FROM executions WHERE task_item_id = ?`).get(item.id);
    ok(exec.status === 'waiting', `the execution closed as waiting (got ${exec.status})`);
    ok(item.attempt_count === 0, `waiting refunds the attempt (got ${item.attempt_count})`);
  }

  // 4. Structured `waiting` WITHOUT a registered wait — the same protocol error
  //    the marker path raises (bounded, not a silent stall).
  {
    const { G, store, tools } = fresh('wait-protocol');
    const taskId = activePlan(store, [agentItem('Ждать без wait', { max_attempts: 1 })]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: () => passAll() },
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_result.handler({ item_id: itemId, status: 'waiting' }, { userId: 'u1' });
        return 'Просто подожду.';
      },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'failed', `waiting without a registered wait fails the step (got ${item.status})`);
    ok(String(item.last_error || '').includes('task_item_result(status: "waiting")'),
      `the error names the structured call (got ${item.last_error})`);
  }

  // 5. Back-compat: the TEXT marker still decides when there is no structured
  //    result — prod semantics unchanged, judge not called.
  {
    const { G, store, tools } = fresh('marker');
    const taskId = activePlan(store, [agentItem('Обычный шаг')]);
    let judgeCalls = 0;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: () => passAll() },
      markerJudge: async () => { judgeCalls += 1; return { verdict: 'uncertain', reason: 'x' }; },
      runTask: async () => 'ИТОГ ШАГА: готово.\nDURABLE: done',
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `the text marker still settles the step (got ${item.status})`);
    ok(judgeCalls === 0, `no judge call on a marked reply (calls=${judgeCalls})`);
    ok(!JSON.parse(item.evidence_json || '{}').step_result, 'no step_result when the structure was not used');
    void tools;
  }

  // 6. Back-compat: markerless reply with NO structured result still goes through
  //    the marker judge (#1907) — that path is untouched.
  {
    const { G, store } = fresh('judge');
    const taskId = activePlan(store, [agentItem('Забыли маркер')]);
    let judgeCalls = 0;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      registry: { command_exit_zero: () => passAll() },
      markerJudge: async () => { judgeCalls += 1; return { verdict: 'done', reason: 'работа явно сделана' }; },
      runTask: async () => 'ИТОГ ШАГА: открыл PR https://github.com/o/r/pull/9\nВсё сделано, проверил.',
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `the judge still decides a markerless reply (got ${item.status})`);
    ok(judgeCalls === 1, `the judge is asked exactly when nothing structured is there (calls=${judgeCalls})`);
  }

  // 7. The resume path honours a result posted before the restart.
  {
    const { G, store, tools } = fresh('resume');
    const taskId = activePlan(store, [agentItem('Прерванный шаг')]);
    const item = store.claimNextRunnable();
    store.startExecution({ id: 'exec-A', task_id: taskId, task_item_id: item.id });
    const posted = await tools.task_item_result.handler(
      { item_id: item.id, attempt: 1, status: 'done', result: { ok: true }, note: 'сделано до рестарта' },
      { userId: 'u1' });
    ok(posted.ok === true, `the result survives until the restart (got ${JSON.stringify(posted).slice(0, 160)})`);
    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: item.id, executionId: 'exec-A', profileId: 'u1', claimGeneration: 1 },
      'Работа была прервана рестартом, но результат записан.',   // no marker
      { secrets: {}, registry: { command_exit_zero: () => passAll() } });
    await drain();
    ok(store.getTaskItem(item.id).status === 'done', `the resumed settle reads the structured result (got ${store.getTaskItem(item.id).status})`);
    ok(store.getExecution('exec-A').status === 'success', 'the resumed execution closed as success');
  }

  // 8. Tool-level guards: not running → refused; stale attempt → refused.
  {
    const { store, tools } = fresh('guards');
    const taskId = activePlan(store, [agentItem('Шаг')]);
    const pending = await tools.task_item_result.handler(
      { item_id: store.listTaskItems(taskId, 'u1')[0].id, status: 'done' }, { userId: 'u1' });
    ok(/running now/.test(pending.error || ''), `posting before the run is refused (got ${pending.error})`);
    const itemId = store.listTaskItems(taskId, 'u1')[0].id;
    store.claimNextRunnable();                       // attempt 1
    const stale = await tools.task_item_result.handler(
      { item_id: itemId, attempt: 7, status: 'done' }, { userId: 'u1' });
    ok(/stale attempt/.test(stale.error || ''), `a stale attempt is refused (got ${stale.error})`);
    const foreign = await tools.task_item_result.handler(
      { item_id: itemId, attempt: 1, status: 'done' }, { userId: 'intruder' });
    ok(/not found/.test(foreign.error || ''), `a foreign profile is refused (got ${foreign.error})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(TOKENS_DIR, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
