// Every step of a plan must reuse ONE engineering workspace: the durable prompt
// names the shared root_task_id derived from the plan id.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODS = ['../../src/gtd-controller.js', '../../src/durable-task-store.js', '../../src/durable-task-migrations.js', '../../src/data-paths.js'];
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT'];
let root; const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'plan-ws-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe('one workspace per plan', () => {
  it('every step prompt carries the same plan workspace label', async () => {
    const G = require('../../src/gtd-controller.js');
    const store = G.durableStore();
    const step = t => ({ title: t, execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ok: true } });
    const r = store.createPlan({
      profile_id: 'u1', goal: 'g', user_value: 'uv', acceptance_criteria: [{ id: 'c', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' }, items: [step('a'), step('b')],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const prompts = [];
    const tick = () => G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async ({ task }) => { prompts.push(task); return 'ИТОГ ШАГА: ok\nDURABLE: done'; },
    });
    await tick(); await new Promise(res => setTimeout(res, 30));
    await tick(); await new Promise(res => setTimeout(res, 30));
    const label = G.planWorkspaceLabel(store.getTask(r.task.id, 'u1'));
    expect(label).toBe(`plan-${r.task.id.slice(0, 8)}`);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain(`root_task_id: "${label}"`);
  });
});
