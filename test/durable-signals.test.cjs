// Incoming signals end-to-end (#87 B1.2) — the prod-plans pilot's T4/T5 against
// the real fire/settle path (trained-agent-architecture pilots/p-db/prod-plans):
//
//   T4 (FAIL): task_item_wake BEFORE the step parked → «item is not waiting», the
//              event was lost — the step only continued after the sender repeated
//              the signal.
//   T5 (PASS with оговорка): a second wake overwrote wake_message/woken_at — the
//              last writer won, there was no dedup.
//
// Identity of a signal = userTaskId + step (task_signals), an unconsumed row is
// applied by parkItem the moment the step reaches its wait.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 60) => new Promise(r => setTimeout(r, ms));

const TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-signals-tokens-'));
process.env.AGENT_TOKENS_DIR = TOKENS_DIR;

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-signals-${tag}-`));
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
    profile_id: 'u1', goal: 'signals smoke', user_value: 'v',
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
  // 1. T4 — the answer arrives while the step is still running: buffered, applied
  //    at park, handed to the resumed run, and the step completes without the
  //    sender repeating the signal.
  {
    const { G, store, tools } = fresh('t4');
    const taskId = activePlan(store, [agentItem('Ждём ответ')]);
    const prompts = [];
    let earlyWake = null;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: passAll,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        // the user answers BEFORE the step reaches its wait
        earlyWake = await tools.task_item_wake.handler({ item_id: itemId, message: 'вот ключ: dg_123' }, { userId: 'u1' });
        ok(earlyWake.error === undefined, `an early wake is not an error (got ${earlyWake.error})`);
        ok(earlyWake.buffered === true, `an early wake is buffered (got ${JSON.stringify(earlyWake)})`);
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 86400, reason: 'нужен ключ' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();

    let item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'waiting', `the step parked (got ${item.status})`);
    const w = JSON.parse(item.wait_json);
    ok(!!w.woken_at, 'the parked step starts ALREADY woken — the early answer was not lost');
    ok(w.wake_message === 'вот ключ: dg_123', `wake_message carries the answer (got ${w.wake_message})`);
    const sig = store.getSignal(taskId, item.id);
    ok(!!sig && !!sig.consumed_at, 'the signal is marked consumed by the park');
    const { buildAwaitingUserNotice } = require('../src/durable-wait.js');
    const n = buildAwaitingUserNotice('u1', { store });
    ok(!n.includes(item.id), 'a woken step is no longer listed as waiting for the user');

    // the wait tick now resumes the SAME step with the answer in the prompt
    const runs = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now() + 1000, isTaskRunning: () => false, registry: passAll,
      runTask: async (opts) => { runs.push(opts.task); return 'DURABLE: done'; },
    });
    await drain();
    ok(runs.length === 1, `the step re-runs once the signal is applied (got ${runs.length})`);
    ok(/Сообщение: вот ключ: dg_123/.test(runs[0] || ''), 'the resumed run receives the answer');
    item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `the step completes (got ${item.status})`);
    ok(!!store.getSignal(taskId, item.id), 'the consumed signal stays as history on a completed step');
  }

  // 2. T5 — the first answer wins: a second wake does not overwrite it, and the
  //    signal identity stays one row per step.
  {
    const { G, store, tools } = fresh('t5');
    const taskId = activePlan(store, [agentItem('Спрошенный шаг')]);
    const itemId = store.listTaskItems(taskId, 'u1')[0].id;
    store.updateTaskItem(itemId, { status: 'waiting' }, 'u1');
    store.setItemWait(itemId, 'u1', { then: 'rerun', awaiting_user: true, reason: 'ответ' });

    const first = await tools.task_item_wake.handler({ item_id: itemId, message: 'ответ первый' }, { userId: 'u1' });
    ok(first.error === undefined && !!first.item, `the first wake lands (got ${JSON.stringify(first).slice(0, 120)})`);
    const second = await tools.task_item_wake.handler({ item_id: itemId, message: 'ответ второй' }, { userId: 'u1' });
    ok(second.error === undefined, `a duplicate wake is not an error (got ${second.error})`);
    ok(second.already_woken === true || second.duplicate === true, `the duplicate is reported (got ${JSON.stringify(second).slice(0, 160)})`);
    ok(JSON.parse(store.getTaskItem(itemId).wait_json).wake_message === 'ответ первый',
      `the FIRST answer is kept (got ${JSON.parse(store.getTaskItem(itemId).wait_json).wake_message})`);
    ok(store.listSignals(taskId, 'u1').length === 1, 'signal identity = plan + step: one row');
    void G;
  }

  // 3. A wake on a step that is not waiting at all still refuses for a finished
  //    step (T5) and buffers for a step that has not reached its wait (T4) — the
  //    MCP surface reports both without an error storm.
  {
    const { store, tools } = fresh('t3');
    const taskId = activePlan(store, [agentItem('Один'), agentItem('Два')]);
    const items = store.listTaskItems(taskId, 'u1');
    const pending = await tools.task_item_wake.handler({ item_id: items[1].id, message: 'ранний' }, { userId: 'u1' });
    ok(pending.buffered === true, 'a wake on a pending step is buffered');
    store.updateTaskItem(items[0].id, { status: 'done' }, 'u1');
    const done = await tools.task_item_wake.handler({ item_id: items[0].id, message: 'поздний' }, { userId: 'u1' });
    ok(/item is not waiting/.test(done.error || ''), `a finished step still refuses (got ${done.error})`);
    ok(store.getSignal(taskId, items[0].id) === null, 'no signal row for a finished step');
    ok(store.listSignals(taskId, 'u1').length === 1, 'exactly one buffered signal');
  }

  // 4. Ownership: a foreign profile can neither wake nor buffer.
  {
    const { store, tools } = fresh('own');
    const taskId = activePlan(store, [agentItem('Шаг')]);
    const itemId = store.listTaskItems(taskId, 'u1')[0].id;
    const foreign = await tools.task_item_wake.handler({ item_id: itemId, message: 'x' }, { userId: 'intruder' });
    ok(/not found/.test(foreign.error || ''), `foreign profile refused (got ${foreign.error})`);
    ok(store.listSignals(taskId, 'u1').length === 0, 'the refused wake wrote no signal');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(TOKENS_DIR, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
