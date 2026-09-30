// P4 (#1459): playbook hook compilation + boundary execution.
//
// Covers: compilePlaybook carrying task-level and per-item hooks (stage
// on_enter/on_exit ride the stage's first/last item), unknown hook type rejected
// at compile time and by the schema, a plan persisting its hooks, a notify hook
// firing exactly once at the right boundary through an injected delivery fake, an
// unapproved external-effect hook skipped+logged without touching the task, and
// task_done/task_failed firing when the plan settles.
//
// data-paths.js captures USERS_DIR/AGENT_DATA_DIR at load, so every loader clears
// the require cache (same pattern as playbook-run.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let root;
let prevUsers; let prevData; let prevTokensDir; let prevTokensRoot;

const PATHS = '../../src/data-paths.js';
const COMPILER = '../../src/playbook-compiler.js';
const STORE = '../../src/playbook-store.js';
const HOOKS = '../../src/playbook-hooks.js';
const GTD = '../../src/gtd-controller.js';
const DSTORE = '../../src/durable-task-store.js';
const MIG = '../../src/durable-task-migrations.js';

function fresh(...mods) {
  for (const m of mods) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

function freshGTD() {
  fresh(GTD, DSTORE, MIG, HOOKS, STORE, COMPILER, PATHS);
  return require(GTD);
}

const drain = (ms = 25) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  prevData = process.env.AGENT_DATA_DIR;
  prevTokensDir = process.env.AGENT_TOKENS_DIR;
  prevTokensRoot = process.env.AGENT_TOKENS_ROOT;
  root = mkdtempSync(join(tmpdir(), 'playbook-hooks-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'data');
  process.env.AGENT_TOKENS_DIR = join(root, 'tokens');
  process.env.AGENT_TOKENS_ROOT = join(root, 'tokens');
});

afterEach(() => {
  const restore = (key, val) => { if (val === undefined) delete process.env[key]; else process.env[key] = val; };
  restore('USERS_DIR', prevUsers);
  restore('AGENT_DATA_DIR', prevData);
  restore('AGENT_TOKENS_DIR', prevTokensDir);
  restore('AGENT_TOKENS_ROOT', prevTokensRoot);
  rmSync(root, { recursive: true, force: true });
});

const basePlaybook = () => ({
  id: 'sample', version: 1, scope: 'profile', title: 'Sample', goal_template: '{input}',
  stages: [{
    id: 's1', title: 'Stage',
    on_enter: [{ type: 'notify', to: 'owner', text: 'enter {stage}' }],
    on_exit: [{ type: 'notify', text: 'exit {stage}' }],
    steps: [
      { title: 'a', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { ok: true }, on_complete: [{ type: 'notify', text: '{goal} done' }] },
      { title: 'b', execution_kind: 'programmatic', validation: { ci_green: true }, on_fail: [{ type: 'notify', text: 'failed {error}' }] },
    ],
  }],
  hooks: {
    task_done: [{ type: 'notify', to: 'owner', text: 'task done {goal}' }],
    task_failed: [{ type: 'notify', text: 'task failed {goal}: {error}' }],
  },
});

describe('compilePlaybook — hooks', () => {
  it('carries task hooks and per-item step + stage boundary hooks', () => {
    fresh(COMPILER, HOOKS, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const out = compilePlaybook(basePlaybook(), { goal: 'ship it' });

    expect(out.hooks.task_done).toHaveLength(1);
    expect(out.hooks.task_done[0].text).toBe('task done {goal}');
    expect(out.hooks.task_failed).toHaveLength(1);

    expect(out.items[0].hooks.on_complete[0].text).toBe('{goal} done');
    expect(out.items[0].hooks.stage_enter[0].text).toBe('enter {stage}');
    expect(out.items[1].hooks.on_fail[0].text).toBe('failed {error}');
    expect(out.items[1].hooks.stage_exit[0].text).toBe('exit {stage}');
    // stage hooks ride only the first/last item of the stage
    expect(out.items[0].hooks.stage_exit).toBeUndefined();
    expect(out.items[1].hooks.stage_enter).toBeUndefined();
  });

  it('omits hooks when the playbook declares none', () => {
    fresh(COMPILER, HOOKS, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const pb = basePlaybook();
    delete pb.hooks;
    delete pb.stages[0].on_enter;
    delete pb.stages[0].on_exit;
    delete pb.stages[0].steps[0].on_complete;
    delete pb.stages[0].steps[1].on_fail;
    const out = compilePlaybook(pb, { goal: 'x' });
    expect(out.hooks).toBeNull();
    expect(out.items[0].hooks).toBeUndefined();
  });

  it('rejects an unknown hook type at compile time', () => {
    fresh(COMPILER, HOOKS, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const pb = basePlaybook();
    pb.hooks.task_done = [{ type: 'webhook', text: 'nope' }];
    expect(() => compilePlaybook(pb, { goal: 'x' })).toThrow(/COMPILE_INVALID/);

    const pb2 = basePlaybook();
    pb2.stages[0].steps[0].on_complete = [{ type: 'email' }];
    expect(() => compilePlaybook(pb2, { goal: 'x' })).toThrow(/COMPILE_INVALID/);
  });

  it('rejects an unknown hook type by schema validation too', () => {
    fresh(STORE, HOOKS, PATHS);
    const { validatePlaybook } = require(STORE);
    const pb = basePlaybook();
    pb.hooks.task_done = [{ type: 'webhook', text: 'nope' }];
    expect(() => validatePlaybook(pb)).toThrow(/INVALID_PLAYBOOK/);
  });
});

describe('DurableTaskStore — persists hooks', () => {
  it('stores task hooks and item hooks on the plan', () => {
    const G = freshGTD();
    const { compilePlaybook } = require(COMPILER);
    const compiled = compilePlaybook(basePlaybook(), { goal: 'persist' });
    const store = G.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: compiled.goal, user_value: compiled.user_value,
      acceptance_criteria: compiled.acceptance_criteria, items: compiled.items,
      hooks: compiled.hooks,
    });
    const task = store.getTask(r.task.id, 'u1');
    expect(JSON.parse(task.hooks_json).task_done[0].type).toBe('notify');
    const items = store.listTaskItems(r.task.id, 'u1');
    expect(JSON.parse(items[0].hooks_json).stage_enter[0].text).toBe('enter {stage}');
    expect(JSON.parse(items[1].hooks_json).stage_exit[0].text).toBe('exit {stage}');
  });
});

// A single-item contract plan (no declared validations, so finalization is not
// gated) whose item carries the given hooks.
function activeTask(G, { hooks = null, itemHooks = null, maxAttempts = 3, policy = null } = {}) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal: 'hook goal', user_value: 'uv',
    acceptance_criteria: [{ id: 'c', description: 'c' }],
    execution_policy: policy || { validation_mode: 'programmatic' },
    hooks,
    items: [{
      title: 'step one', stage: 's1', execution_kind: 'agent', executor_role: 'developer',
      minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' },
      max_attempts: maxAttempts, hooks: itemHooks || undefined,
    }],
  });
  store.updateTask(r.task.id, 'u1', { status: 'active' });
  return { store, taskId: r.task.id };
}

const okRun = async () => 'did it. DURABLE: done';

describe('runDueDurable — hook boundaries', () => {
  it('fires a step on_complete notify exactly once, rendered from task state', async () => {
    const G = freshGTD();
    const { store, taskId } = activeTask(G, {
      itemHooks: { on_complete: [{ type: 'notify', to: 'owner', text: 'step done: {goal} / {stage}' }] },
    });
    const delivered = [];
    const tick = () => G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, approveHooks: true,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } },
      runTask: okRun,
    });

    await tick();
    await drain();
    expect(delivered).toEqual(['step done: hook goal / s1']);
    const rows = store.listHookExecutions(taskId, 'u1');
    expect(rows.filter(r => r.event === 'on_complete' && r.status === 'fired')).toHaveLength(1);

    // A later tick has nothing to claim; the boundary is never re-delivered.
    await tick();
    await drain();
    expect(delivered).toHaveLength(1);
  });

  it('fires stage.on_enter once at the stage boundary', async () => {
    const G = freshGTD();
    const { store, taskId } = activeTask(G, {
      itemHooks: { stage_enter: [{ type: 'notify', text: 'entered {stage}' }] },
    });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, approveHooks: true,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } }, runTask: okRun,
    });
    await drain();
    expect(delivered).toEqual(['entered s1']);
    expect(store.listHookExecutions(taskId, 'u1').filter(r => r.event === 'stage_enter')).toHaveLength(1);
  });

  it('skips+logs an unapproved external-effect hook without failing the task', async () => {
    const G = freshGTD();
    const { store, taskId } = activeTask(G, {
      itemHooks: { on_complete: [{ type: 'notify', to: 'owner', text: 'should not send' }] },
    });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } }, runTask: okRun,
    });
    await drain();

    expect(delivered).toHaveLength(0);
    const rows = store.listHookExecutions(taskId, 'u1');
    const skipped = rows.find(r => r.status === 'skipped');
    expect(skipped).toBeTruthy();
    expect(skipped.event).toBe('on_complete');
    expect(skipped.detail).toMatch(/consent/);
    expect(store.getTask(taskId, 'u1').status).toBe('done');
  });

  it('fires task_done when the plan finalizes', async () => {
    const G = freshGTD();
    const { store, taskId } = activeTask(G, {
      hooks: { task_done: [{ type: 'notify', to: 'owner', text: 'DONE {goal}' }] },
    });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, approveHooks: true,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } }, runTask: okRun,
    });
    await drain();
    expect(delivered).toEqual(['DONE hook goal']);
    expect(store.getTask(taskId, 'u1').status).toBe('done');
    expect(store.listHookExecutions(taskId, 'u1').filter(r => r.event === 'task_done' && r.status === 'fired')).toHaveLength(1);
  });

  it('fires task_failed on terminal failure, task stays visible (not flipped done)', async () => {
    const G = freshGTD();
    const { store, taskId } = activeTask(G, {
      hooks: { task_failed: [{ type: 'notify', text: 'FAILED {goal}: {error}' }] },
      maxAttempts: 1,
    });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, approveHooks: true,
      classifier: () => ({ class: 'UNKNOWN', retryable: true, source: 'rule', confidence: 1 }),
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } },
      runTask: async () => 'nope. DURABLE: failed: exploded',
    });
    await drain(40);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/FAILED hook goal:/);
    const rows = store.listHookExecutions(taskId, 'u1');
    expect(rows.filter(r => r.event === 'task_failed' && r.status === 'fired')).toHaveLength(1);
    expect(store.getTask(taskId, 'u1').status).toBe('active');
  });

  it('honours consent from the plan policy (execution_policy.hooks_approved)', async () => {
    const G = freshGTD();
    activeTask(G, {
      itemHooks: { on_complete: [{ type: 'notify', text: 'approved by policy' }] },
      policy: { validation_mode: 'programmatic', hooks_approved: true },
    });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } }, runTask: okRun,
    });
    await drain();
    expect(delivered).toEqual(['approved by policy']);
  });
});

// #1909: consent channels the audit found missing — 52/63 notify hooks were skipped
// with «no explicit consent» because nobody ever passed approve_hooks.
describe('#1909 hook consent', () => {
  it('bg-notify opt-in on the profile IS consent for notify hooks (and only those)', async () => {
    const G = freshGTD();
    const { writeBgNotify } = require('../../src/bg-notify.js');
    writeBgNotify('u1', { enabled: true, chatId: 42 });
    try {
      const { taskId } = activeTask(G, {
        itemHooks: { on_complete: [
          { type: 'notify', text: 'plan event' },
          { type: 'create_issue', text: 'opens an issue' },
        ] },
      });
      const delivered = [];
      await G.runDueDurable({
        secrets: {}, now: Date.now(), isTaskRunning: () => false,
        hookSinks: {
          notify: async ({ text }) => { delivered.push(text); },
          create_issue: async ({ text }) => { delivered.push(`issue:${text}`); },
        },
        runTask: okRun,
      });
      await drain();
      expect(delivered).toEqual(['plan event']); // notify даёт consent, create_issue — нет
      const rows = G.durableStore().listHookExecutions(taskId, 'u1').filter(r => r.event === 'on_complete');
      expect(rows.find(r => r.hook_type === 'notify').status).toBe('fired');
      expect(rows.find(r => r.hook_type === 'create_issue').status).toBe('skipped');
    } finally {
      writeBgNotify('u1', { enabled: false });
    }
  });

  it('without any consent notify stays skipped (behaviour unchanged)', async () => {
    const G = freshGTD();
    const { taskId } = activeTask(G, { itemHooks: { on_complete: [{ type: 'notify', text: 'no consent' }] } });
    const delivered = [];
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false,
      hookSinks: { notify: async ({ text }) => { delivered.push(text); } }, runTask: okRun,
    });
    await drain();
    expect(delivered).toEqual([]);
    const row = G.durableStore().listHookExecutions(taskId, 'u1').find(r => r.hook_type === 'notify');
    expect(row.status).toBe('skipped');
  });

  it('operatorTarget: falls back to the operator chat, numeric id, default audience', () => {
    const G = freshGTD();
    expect(G._operatorTarget({})).toEqual({ chatId: 1714048, audience: 'default', threadId: null });
    expect(G._operatorTarget({ OPERATOR_CHAT_ID: '-100123' })).toEqual({ chatId: -100123, audience: 'default', threadId: null });
    expect(G._operatorTarget({ OPERATOR_CHAT_ID: 'not-a-number' })).toBeNull();
  });
});
