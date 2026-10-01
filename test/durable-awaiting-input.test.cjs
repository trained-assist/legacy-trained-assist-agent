// awaiting_input + the event journal end-to-end (#87 B1.4): a plan parked on the
// owner says so in the STATUS column, and the transitions that wait_json used to
// overwrite (parked → woken → resolved) are kept in append-only task_events,
// written in the same transaction as the change itself.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 80) => new Promise(r => setTimeout(r, ms));

const TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-await-tokens-'));
process.env.AGENT_TOKENS_DIR = TOKENS_DIR;

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `durable-await-${tag}-`));
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
    profile_id: 'u1', goal: 'awaiting input smoke', user_value: 'v',
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
const passAll = () => ({ status: 'pass', subject: {}, evidence: {} });
const types = (store, taskId) => store.listTaskEvents(taskId, 'u1').map(e => e.type);

(async () => {
  // 1. Parked on the owner → the PLAN is awaiting_input, visible in the notice,
  //    in task_get (status column + events), and in the task_list filter.
  {
    const { G, store, tools } = fresh('park');
    const taskId = activePlan(store, [agentItem('Спрошенный шаг')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: { command_exit_zero: () => passAll() },
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 86400, reason: 'нужен ключ' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();

    const task = store.getTask(taskId, 'u1');
    ok(task.status === 'awaiting_input', `the plan says awaiting_input (got ${task.status})`);
    const item = store.listTaskItems(taskId, 'u1')[0];
    const { buildAwaitingUserNotice } = require('../src/durable-wait.js');
    const notice = buildAwaitingUserNotice('u1', { store });
    ok(notice.includes(item.id), 'the chat notice still lists the parked step');
    ok(/\[ПЛАНЫ ЖДУТ ОТВЕТА ПОЛЬЗОВАТЕЛЯ\]/.test(notice), 'the notice header is there while the plan is awaiting_input');

    const got = await tools.task_get.handler({ task_id: taskId }, { userId: 'u1' });
    ok(got.task.status === 'awaiting_input', `task_get reports the status (got ${got.task.status})`);
    const t = types(store, taskId);
    ok(t.includes('item_parked'), `journal has item_parked (got ${t.join(',')})`);
    ok(t.includes('task_status'), 'journal has the task_status transition');
    const park = store.listTaskEvents(taskId, 'u1').find(e => e.type === 'item_parked');
    ok(JSON.parse(park.payload_json).awaiting_user === true, 'the parked event carries awaiting_user');
    const list = await tools.task_list.handler({ status: 'awaiting_input' }, { userId: 'u1' });
    ok(list.tasks.some(x => x.id === taskId), 'task_list(status=awaiting_input) finds it');
    const listActive = await tools.task_list.handler({ status: 'active' }, { userId: 'u1' });
    ok(!listActive.tasks.some(x => x.id === taskId), '…and status=active does not');

    // 2. The owner answers → the plan runs again and finishes; the journal keeps
    //    the whole story (wake → resolve → done → status changes).
    const prompts = [];
    const wake = await tools.task_item_wake.handler({ item_id: item.id, message: 'вот ключ: dg_123' }, { userId: 'u1' });
    ok(!wake.error, `the wake lands (got ${wake.error})`);
    ok(store.getTask(taskId, 'u1').status === 'active', 'answering flips the plan back to active');

    await G.runDueDurable({
      secrets: {}, now: Date.now() + 1000, isTaskRunning: () => false, registry: { command_exit_zero: () => passAll() },
      runTask: async (opts) => { prompts.push(opts.task); return 'DURABLE: done'; },
    });
    await drain();
    ok(prompts.length === 1 && /Сообщение: вот ключ: dg_123/.test(prompts[0]), 'the resumed run gets the answer');
    ok(store.listTaskItems(taskId, 'u1')[0].status === 'done', 'the step completes');
    ok(store.getTask(taskId, 'u1').status === 'done', 'the plan completes');

    const after = types(store, taskId);
    for (const ev of ['task_created', 'item_parked', 'item_woken', 'wait_resolved', 'item_done']) {
      ok(after.includes(ev), `journal keeps ${ev} (got ${after.join(',')})`);
    }
    const statuses = store.listTaskEvents(taskId, 'u1').filter(e => e.type === 'task_status')
      .map(e => JSON.parse(e.payload_json).to);
    ok(statuses.includes('awaiting_input') && statuses.includes('done'),
      `the status history is in the journal (got ${statuses.join('→')})`);
    // append-only: the first row is still the creation
    const rows = store.listTaskEvents(taskId, 'u1', { limit: 100 });
    ok(rows[rows.length - 1].type === 'task_created', 'the journal is append-only (creation still last)');
  }

  // 3. A refused stale settle is journaled — an operator can see WHY the answer
  //    never landed (#87 B1.1 fencing, observed through #87 B1.4's journal).
  {
    const { G, store } = fresh('fence');
    const taskId = activePlan(store, [agentItem('Шаг')]);
    const a = store.claimNextRunnable();
    store.startExecution({ id: 'exec-A', task_id: taskId, task_item_id: a.id });
    G.reconcileOrphanedRunning(store, { now: Date.now() + 46 * 60 * 1000 });
    const b = store.claimNextRunnable(Date.now() + 46 * 60 * 1000);
    store.startExecution({ id: 'exec-B', task_id: taskId, task_item_id: b.id });
    await G.resumeDurableReply(
      { kind: 'durable', taskId, itemId: a.id, executionId: 'exec-A', profileId: 'u1', claimGeneration: a.claim_generation },
      'DURABLE: done', { secrets: {}, registry: { command_exit_zero: () => passAll() } });
    await drain();
    const fence = store.listTaskEvents(taskId, 'u1').find(e => e.type === 'fence_refused');
    ok(!!fence, 'a refused settle is in the journal');
    if (fence) {
      const p = JSON.parse(fence.payload_json);
      ok(p.attempt === 1 && p.current === 2 && p.where === 'reply',
        `the event carries attempt/current/where (got ${JSON.stringify(p)})`);
    }
    ok(store.getTaskItem(a.id).status === 'running', 'and the refusal itself still holds');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(process.env.AGENT_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(TOKENS_DIR, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
