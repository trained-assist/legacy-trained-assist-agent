// already_done — the fast skip of work that already holds, 0 model runs.
//
// The engine already evaluates `already_done` at claim time (#1959), but the
// step AUTHOR (an agent inserting a continuation with task_item_add) could not
// declare it: the MCP surface dropped the field, so a "продолжение"/"остаток"
// step re-derived work that was already merged — exactly what stalled the
// architecture epic (child step on its 12th execution re-running settled work,
// epic waiting on task_done).
//
// This suite pins the whole path: author declares it → claim-time pre-check →
// step closed with an audit row and NO model run; a pre-check that does not
// pass falls through to the normal run; an unknown key is refused at authoring.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 60) => new Promise(r => setTimeout(r, ms));

process.env.AGENT_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'already-done-tokens-'));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `already-done-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/mcp-skills/tools/101-durable-tasks.js', '../src/durable-wait.js', '../src/playbook-validators.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  const tools = require('../src/mcp-skills/tools/101-durable-tasks.js').tools;
  const def = require('../src/playbook-validators.js').getDefaultRegistry();
  return { G, tools, store: G.durableStore(), dir, def };
}

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'already_done smoke', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

const agentItem = (title, extra = {}) => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small',
  validation: { command_exit_zero: 'true' }, ...extra,
});
const passAll = { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) };

(async () => {
  // 1. A declared already_done that holds → the step closes with an audit row and
  //    ZERO model runs; the plan moves on.
  {
    const { G, store, dir, def } = fresh('hold');
    const marker = path.join(dir, 'merged-pr.txt');
    fs.writeFileSync(marker, 'x');
    const taskId = activePlan(store, [
      agentItem('Уже слитый остаток', { already_done: { file_exists: marker } }),
    ]);
    let runs = 0;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: { ...passAll, file_exists: def.file_exists },
      runTask: async () => { runs++; return 'DURABLE: done'; },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    ok(item.status === 'done', `the step is closed without a model run (got ${item.status})`);
    ok(runs === 0, `no model run was spent re-deriving settled work (got ${runs})`);
    ok(/already_done/.test(item.evidence_json || ''), `the audit row says already_done (got ${item.evidence_json})`);
    const rows = store.db.prepare('SELECT validator, status FROM task_validation_results WHERE task_item_id=?').all(item.id);
    ok(rows.length === 1 && rows[0].status === 'pass', `the pre-check is recorded as a validation (got ${JSON.stringify(rows)})`);
  }

  // 2. A pre-check that does NOT hold → the step runs normally (the agent does the
  //    work). The fast skip never swallows real work.
  {
    const { G, store, dir, def } = fresh('nothold');
    const missing = path.join(dir, 'never-created.txt');
    const taskId = activePlan(store, [
      agentItem('Остаток ещё не слит', { already_done: { file_exists: missing } }),
    ]);
    let runs = 0;
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: { ...passAll, file_exists: def.file_exists },
      runTask: async () => { runs++; return 'DURABLE: done'; },
    });
    await drain();
    ok(runs === 1, `an unsatisfied pre-check still runs the step (got ${runs})`);
    ok(store.listTaskItems(taskId, 'u1')[0].status === 'done', 'the step completes normally');
  }

  // 3. The authoring surface: task_item_add carries already_done through to the
  //    stored step, and refuses a key that has no deterministic validator.
  {
    const { tools, store, dir } = fresh('author');
    const marker = path.join(dir, 'table-committed.md');
    fs.writeFileSync(marker, 'x');
    const taskId = activePlan(store, [agentItem('Первый шаг')]);
    const first = store.listTaskItems(taskId, 'u1')[0];

    const added = await tools.task_item_add.handler({
      task_id: taskId, title: 'Продолжение: остаток уже слит',
      after_item_id: first.id, execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'bachelor', context_budget: 'small',
      validation: { command_exit_zero: 'true' }, already_done: { file_exists: marker },
      instructions: 'остаток уже закрыт',
    }, { userId: 'u1' });
    ok(!added.error, `task_item_add accepts already_done (got ${JSON.stringify(added).slice(0, 160)})`);
    const stored = store.getTaskItem(added.item.id);
    ok(stored.already_done_json === JSON.stringify({ file_exists: marker }),
      `the field is persisted (got ${stored.already_done_json})`);

    const bad = await tools.task_item_add.handler({
      task_id: taskId, title: 'Плохой ключ',
      validation: { command_exit_zero: 'true' }, already_done: { model_says_done: 'yes' },
    }, { userId: 'u1' });
    ok(/deterministic validators/.test(bad.error || ''), `an unknown key is refused at authoring (got ${JSON.stringify(bad).slice(0, 200)})`);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
