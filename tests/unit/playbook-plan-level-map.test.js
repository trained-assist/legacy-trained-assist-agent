// Per-plan level map (execution_policy.level_map) + the executions row records
// which engine/profile/level actually ran a step — the basis of the playbook e2e.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MODS = ['../../src/gtd-controller.js', '../../src/durable-task-store.js', '../../src/durable-task-migrations.js', '../../src/playbook-executor.js', '../../src/data-paths.js'];
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'PLAYBOOK_LEVEL_MAP'];
let root; const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.PLAYBOOK_LEVEL_MAP;
  root = mkdtempSync(join(tmpdir(), 'plan-level-map-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe('planLevelMap', () => {
  it('overrides only the named levels and ignores junk', () => {
    const { planLevelMap, DEFAULT_LEVEL_MAP } = require('../../src/playbook-executor.js');
    const m = planLevelMap({ level_map: { master: { engine: 'opencode', ocProfile: 'free' }, doctor: { engine: 'bogus' } } });
    expect(m.master).toEqual({ engine: 'opencode', ocProfile: 'free' });
    expect(m.doctor).toEqual(DEFAULT_LEVEL_MAP.doctor);
    expect(planLevelMap(null)).toEqual(DEFAULT_LEVEL_MAP);
  });
});

describe('runDueDurable with a plan level map', () => {
  it('runs each level on the plan engine and records it on the execution', async () => {
    const G = require('../../src/gtd-controller.js');
    const store = G.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'g', user_value: 'uv', acceptance_criteria: [{ id: 'c', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic', level_map: {
        doctor: { engine: 'opencode', ocProfile: 'deepseek' }, master: { engine: 'opencode', ocProfile: 'free' } } },
      items: [
        { title: 'm', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ok: true } },
        { title: 'd', execution_kind: 'agent', executor_role: 'reviewer', minimum_model_level: 'doctor', context_budget: 'small', validation: { ok: true } },
      ],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const calls = [];
    const prompts = [];
    const tick = () => G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async (o) => { calls.push({ engine: o.engine, ocProfile: o.ocProfile, ocRole: o.ocRole }); prompts.push(o.task); return 'ИТОГ ШАГА: ok\nDURABLE: done'; },
    });
    await tick(); await new Promise(res => setTimeout(res, 30));
    await tick(); await new Promise(res => setTimeout(res, 30));
    expect(calls).toEqual([
      { engine: 'opencode', ocProfile: 'free', ocRole: 'build' },
      { engine: 'opencode', ocProfile: 'deepseek', ocRole: 'review' },
    ]);
    // every step of the plan is told to use the same engineering workspace
    const wsId = G.planWorkspaceId(store.getTask(r.task.id, 'u1'));
    expect(wsId).toBe(`plan-${r.task.id.slice(0, 8)}`);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain(`root_task_id: "${wsId}"`);
    const ex = store.db.prepare('SELECT engine, profile, model_level, executor_role FROM executions WHERE task_id = ? ORDER BY started_at').all(r.task.id);
    expect(ex).toEqual([
      { engine: 'opencode', profile: 'free', model_level: 'master', executor_role: 'developer' },
      { engine: 'opencode', profile: 'deepseek', model_level: 'doctor', executor_role: 'reviewer' },
    ]);
  });
});
