// #1861 (red regression): a durable plan must have ONE artifact root.
// The agent step is told to spawn a git workspace and commits artifacts there,
// while deterministic checks (file_exists / command_exit_zero) resolve relative
// paths from the plan's project dir → the next step reads a file that is not
// there and the plan dies. A failing deterministic check on an agent step is
// also swallowed (the item is completed anyway), and a terminally failed step
// cannot be restarted. Each of these must become green.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODS = [
  '../../src/gtd-controller.js', '../../src/durable-task-store.js', '../../src/durable-task-migrations.js',
  '../../src/data-paths.js', '../../src/playbook-validators.js', '../../src/mcp-skills/tools/101-durable-tasks.js',
];
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT'];
const PROFILE = 'u1';
const PROJECT = 'generic-opять';
let root; const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'artifact-root-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  // the plan is bound to this project folder — the root deterministic checks use
  mkdirSync(join(root, 'u', PROFILE, 'projects', PROJECT), { recursive: true });
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const tick = (G, opts) => G.runDueDurable({
  secrets: {}, now: Date.now(), isTaskRunning: () => false,
  engineHealth: () => ({ status: 'ok' }), ...opts,
});
const settle = (ms = 60) => new Promise(res => setTimeout(res, ms));
const step = (over = {}) => ({
  title: 'prod-check: release.md', execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'master', context_budget: 'small',
  validation: { file_exists: 'prod-check/release.md' }, max_attempts: 1, ...over,
});

function plan(G, over = {}) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: PROFILE, project_id: PROJECT, goal: 'fix #1861',
    user_value: 'the plan finishes', acceptance_criteria: [{ id: 'c', description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' }, items: [step()], ...over,
  });
  store.updateTask(r.task.id, PROFILE, { status: 'active' });
  return { store, task: r.task, item: r.items[0] };
}

describe('#1861 artifact root', () => {
  it('the agent step is told the ABSOLUTE plan artifact folder (not only a workspace label)', async () => {
    const G = require('../../src/gtd-controller.js');
    const { task } = plan(G);
    const prompts = [];
    await tick(G, { runTask: async ({ task: prompt }) => { prompts.push(prompt); return 'ИТОГ ШАГА: ok\nDURABLE: done'; } });
    await settle();
    const artifactRoot = join(root, 'u', PROFILE, 'projects', PROJECT);
    expect(task.project_id).toBe(PROJECT);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(artifactRoot);
  });

  it('a failing deterministic check on an agent step does not silently complete it', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G);
    await tick(G, { runTask: async () => 'ИТОГ ШАГА: ok\nDURABLE: done' });
    await settle();
    const after = store.getTaskItem(item.id);
    expect(after.status).not.toBe('done');
    expect(String(after.last_error || '')).toMatch(/prod-check\/release\.md|file_exists|validation/i);
  });

  it('a terminally failed step can be restarted (retry) after the cause is fixed', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, item } = plan(G);
    store.failItem(item.id, PROFILE, { error: "sed: can't read prod-check/release.md: No such file or directory" });
    const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
    // Only ONE of task_item_retry / task_item_wake needs to revive a failed item.
    const restart = tools.task_item_retry
      ? () => tools.task_item_retry.handler({ item_id: item.id, reason: 'artifact moved to the project folder' }, { userId: PROFILE })
      : () => tools.task_item_wake.handler({ item_id: item.id, message: 'cause fixed' }, { userId: PROFILE });
    const res = await restart();
    expect(res.error).toBeUndefined();
    const after = store.getTaskItem(item.id);
    expect(['pending', 'running', 'waiting']).toContain(after.status);
  });
});
