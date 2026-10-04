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
        doctor: { engine: 'opencode', ocProfile: 'service' }, master: { engine: 'opencode', ocProfile: 'free' } } },
      items: [
        { title: 'm', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ok: true } },
        { title: 'd', execution_kind: 'agent', executor_role: 'reviewer', minimum_model_level: 'doctor', context_budget: 'small', validation: { ok: true } },
      ],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const calls = [];
    const tick = () => G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async (o) => { calls.push({ engine: o.engine, ocProfile: o.ocProfile, ocRole: o.ocRole }); return 'ИТОГ ШАГА: ok\nDURABLE: done'; },
    });
    await tick(); await new Promise(res => setTimeout(res, 30));
    await tick(); await new Promise(res => setTimeout(res, 30));
    expect(calls).toEqual([
      { engine: 'opencode', ocProfile: 'free', ocRole: 'build' },
      { engine: 'opencode', ocProfile: 'service', ocRole: 'review' },
    ]);
    const ex = store.db.prepare('SELECT engine, profile, model_level, executor_role FROM executions WHERE task_id = ? ORDER BY started_at').all(r.task.id);
    expect(ex).toEqual([
      { engine: 'opencode', profile: 'free', model_level: 'master', executor_role: 'developer' },
      { engine: 'opencode', profile: 'service', model_level: 'doctor', executor_role: 'reviewer' },
    ]);
  });
});

describe('plan level_map vs role defaults', () => {
  it('a plan that pins its routing (useRoleMap:false) is not overridden by the researcher role default', async () => {
    const { resolveStepExecution } = await import('../../src/playbook-executor.js').then(m => m.default || m);
    const item = { executor_role: 'researcher', minimum_model_level: 'master', current_model_level: 'master' };
    const levelMap = { master: { engine: 'opencode', ocProfile: 'free' } };
    expect(resolveStepExecution(item, { levelMap, useRoleMap: false }).ocProfile).toBe('free');
    // researcher is no longer pinned to the Go `research` profile (2026-10-01) → the level map wins
    expect(resolveStepExecution(item, { levelMap }).ocProfile).toBe('free');
  });
});
