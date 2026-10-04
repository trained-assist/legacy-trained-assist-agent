// #143 rule 6 at the plan boundary — a plan whose workspace still holds modified
// tracked files or unpushed commits must NOT report `done`: local-only work is not a
// delivered result. Read-only check; the workspace is retained (release refuses dirty),
// so the recovery refs are real.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = (ms = 80) => new Promise(r => setTimeout(r, ms));

process.env.AGENT_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'save-incomplete-tokens-'));

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `save-incomplete-${tag}-`));
  process.env.AGENT_DATA_DIR = dir;
  process.env.USERS_DIR = path.join(dir, 'users');
  for (const m of ['../src/gtd-controller.js', '../src/durable-task-store.js', '../src/data-paths.js',
    '../src/playbook-material.js', '../src/playbook-validators.js', '../src/durable-task-plan.js',
    '../src/run-end-save-check.js']) {
    delete require.cache[require.resolve(m)];
  }
  const G = require('../src/gtd-controller.js');
  return { G, store: G.durableStore(), dir };
}

function plan(G, store) {
  const items = [{
    title: 'Реализация', execution_kind: 'agent', executor_role: 'developer',
    minimum_model_level: 'bachelor', context_budget: 'small',
    validation: { pr_opened: true }, max_attempts: 1,
  }];
  const validations = items.map(s => ({ stage: 'apply', step: s.title, validation: s.validation }));
  const r = store.createPlan({
    profile_id: 'u1', goal: 'save check', user_value: 'v',
    acceptance_criteria: [{ id: 'x-complete', description: 'c', validations }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}

function makeWorkspace(usersDir, taskId, { dirty }) {
  const profile = 'u1';
  const code = path.join(usersDir, profile, 'engineering-workspaces', profile, 'acme', 'ws-1', 'code');
  fs.mkdirSync(code, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', code, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(code, 'a.txt'), 'a\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  git('checkout', '-qb', `eng/${profile}-plan-${String(taskId).slice(0, 8)}`);
  if (dirty) fs.writeFileSync(path.join(code, 'a.txt'), 'uncommitted\n');
  return code;
}

const tick = (G, opts) => G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, ...opts });
const passRegistry = { pr_opened: async () => ({ status: 'pass', subject: {}, evidence: {} }) };

(async () => {
  // 1. Dirty plan workspace → the plan does NOT report done.
  {
    const { G, store, dir } = fresh('dirty');
    const taskId = plan(G, store);
    makeWorkspace(path.join(dir, 'users'), taskId, { dirty: true });
    await tick(G, { registry: passRegistry, runTask: async () => 'сделал\nDURABLE: done' });
    await drain();
    const task = store.getTask(taskId, 'u1');
    ok(task.status === 'blocked', `a dirty plan workspace blocks done (got ${task.status})`);
    ok(/не сохранена|local-only/.test(task.blocker_reason || ''), `the reason names the unsaved work (got ${JSON.stringify(task.blocker_reason)})`);
    const { readDefects } = require('../src/playbook-defects-log.js');
    const d = readDefects({ taskId, kind: 'save_incomplete' });
    ok(d.length > 0, 'a save_incomplete defect is logged');
  }

  // 2. Clean plan workspace → done, exactly as before.
  {
    const { G, store, dir } = fresh('clean');
    const taskId = plan(G, store);
    makeWorkspace(path.join(dir, 'users'), taskId, { dirty: false });
    await tick(G, { registry: passRegistry, runTask: async () => 'сделал\nDURABLE: done' });
    await drain();
    ok(store.getTask(taskId, 'u1').status === 'done', `a clean workspace completes the plan (got ${store.getTask(taskId, 'u1').status})`);
  }

  // 3. No workspace at all (plain chat-like plan) → done, no false block.
  {
    const { G, store } = fresh('noworkspace');
    const taskId = plan(G, store);
    await tick(G, { registry: passRegistry, runTask: async () => 'сделал\nDURABLE: done' });
    await drain();
    ok(store.getTask(taskId, 'u1').status === 'done', `no workspace → no false block (got ${store.getTask(taskId, 'u1').status})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
