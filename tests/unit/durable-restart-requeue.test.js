// A deploy restart kills the engine child of a running durable step. The boot
// sweep (reconcileOrphanedRunning graceMs:0, called from resumePendingTasks)
// must re-queue it immediately; the regular tick keeps the 45-min grace.
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
  root = mkdtempSync(join(tmpdir(), 'durable-restart-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

function runningStep(G) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal: 'g', user_value: 'uv', acceptance_criteria: [{ id: 'c', description: 'c' }],
    items: [{ title: 's', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ok: true } }],
  });
  store.updateTask(r.task.id, 'u1', { status: 'active' });
  const item = G.claimNextDurableItem(store);
  store.startExecution({ id: 'exec-1', task_id: r.task.id, task_item_id: item.id });
  return { store, itemId: item.id };
}

describe('durable steps across a restart', () => {
  it('boot sweep re-queues a just-started running step and closes its execution', () => {
    const G = require('../../src/gtd-controller.js');
    const { store, itemId } = runningStep(G);
    expect(store.getTaskItem(itemId).status).toBe('running');
    expect(G.reconcileOrphanedRunning(store, { graceMs: 0 })).toBe(1);
    expect(store.getTaskItem(itemId).status).toBe('pending');
    const ex = store.db.prepare('SELECT status, error_text FROM executions WHERE id = ?').get('exec-1');
    expect(ex).toEqual({ status: 'interrupted', error_text: 'interrupted by server restart' });
  });

  it('the regular tick still leaves a fresh running step alone', () => {
    const G = require('../../src/gtd-controller.js');
    const { store, itemId } = runningStep(G);
    expect(G.reconcileOrphanedRunning(store)).toBe(0);
    expect(store.getTaskItem(itemId).status).toBe('running');
  });
});
