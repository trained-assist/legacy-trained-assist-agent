// #2013 — what a step may do to the REST of its own plan.
// Two holes made superseded steps pile up in the tail of long plans:
//   1. the executor could not see past its own step, so it could not tell a stale
//      step from a still-needed one (futureStepsOutline);
//   2. replacing a step meant add + a separate skip — two calls, so a crash between
//      them left both steps in the plan (task_item_add replaces_item_id).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let dataDir;
let origEnv;

function tools() {
  delete require.cache[require.resolve('../../src/mcp-skills/tools/101-durable-tasks.js')];
  delete require.cache[require.resolve('../../src/data-paths.js')];
  delete require.cache[require.resolve('../../src/durable-task-store.js')];
  return require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
}

beforeEach(() => {
  origEnv = process.env.AGENT_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'plan-edit-authority-'));
  process.env.AGENT_DATA_DIR = dataDir;
});
afterEach(() => {
  if (origEnv === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = origEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const ctx = { userId: 'alice' };
const step = (title, validator = 'artifact') => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'master', context_budget: 'small',
  validation: { validator, criterion_id: 'edit', expected: 'pass' },
});

async function contractPlan(titles) {
  const { task_create, task_update } = tools();
  const { task } = await task_create.handler({
    goal: 'ship it', user_value: 'a working plan', acceptance_criteria: [{ id: 'edit', description: 'plan stays correct' }],
    items: titles.map(t => step(t)),
  }, ctx);
  await task_update.handler({ task_id: task.id, status: 'active' }, ctx);
  return task.id;
}

describe('replaces_item_id: one call, both halves', () => {
  it('adds the replacement and skips the superseded step, in one call', async () => {
    const { task_item_add, task_get } = tools();
    const taskId = await contractPlan(['Step one', 'Step two (obsolete)', 'Step three']);
    const before = await task_get.handler({ task_id: taskId }, ctx);
    const stale = before.items.find(i => i.title === 'Step two (obsolete)');
    const current = before.items[0];

    const res = await task_item_add.handler({
      task_id: taskId, after_item_id: current.id, replaces_item_id: stale.id,
      title: 'Step two (v2)', ...step('Step two (v2)'),
    }, ctx);

    expect(res.error).toBeUndefined();
    expect(res.replaced.status).toBe('skipped');
    expect(res.replaced.last_error).toMatch(/заменён шагом «Step two \(v2\)»/);
    const after = await task_get.handler({ task_id: taskId }, ctx);
    const staleAfter = after.items.find(i => i.id === stale.id);
    expect(staleAfter.status).toBe('skipped');
    expect(after.items.some(i => i.title === 'Step two (v2)' && i.status === 'pending')).toBe(true);
  });

  it('a refused replacement loses nothing: the new step survives with a warning', async () => {
    const { task_item_add, task_item_complete, task_get } = tools();
    const taskId = await contractPlan(['Step one', 'Step two']);
    const before = await task_get.handler({ task_id: taskId }, ctx);
    await task_item_complete.handler({ item_id: before.items[0].id }, ctx);
    const done = (await task_get.handler({ task_id: taskId }, ctx)).items[0];

    const res = await task_item_add.handler({
      task_id: taskId, replaces_item_id: done.id, title: 'Replacement', ...step('Replacement'),
    }, ctx);

    expect(res.error).toBeUndefined();
    expect(res.item.title).toBe('Replacement');
    expect(res.warning).toMatch(/уже выполняется или выполнен/);
  });

  it('a step of another plan is refused and NO step is created', async () => {
    const { task_item_add, task_get } = tools();
    const mine = await contractPlan(['Mine one']);
    const theirs = await contractPlan(['Theirs one']);
    const foreign = (await task_get.handler({ task_id: theirs }, ctx)).items[0];

    const res = await task_item_add.handler({
      task_id: mine, replaces_item_id: foreign.id, title: 'Should not exist', ...step('Should not exist'),
    }, ctx);

    expect(res.error).toMatch(/replaces_item_id is not a step of this plan/);
    const after = await task_get.handler({ task_id: mine }, ctx);
    expect(after.items.map(i => i.title)).toEqual(['Mine one']);
  });

  it('legacy (non-contract) plans get the same replacement', async () => {
    const { task_create, task_item_add, task_get } = tools();
    const { task } = await task_create.handler({ goal: 'legacy' }, ctx);
    await task_item_add.handler({ task_id: task.id, title: 'Old step' }, ctx);
    const stale = (await task_get.handler({ task_id: task.id }, ctx)).items[0];

    const res = await task_item_add.handler({
      task_id: task.id, replaces_item_id: stale.id, title: 'New step',
    }, ctx);

    expect(res.error).toBeUndefined();
    expect(res.replaced.status).toBe('skipped');
    const after = await task_get.handler({ task_id: task.id }, ctx);
    expect(after.items.filter(i => i.status !== 'skipped').map(i => i.title)).toEqual(['New step']);
  });
});

describe('the executor sees the rest of the plan (#2013)', () => {
  const { futureStepsOutline } = require('../../src/gtd-controller');

  const store = {
    listTaskItems: () => [
      { id: 'aaaaaaaa-1111', position: 0, title: 'Current', status: 'running' },
      { id: 'bbbbbbbb-2222', position: 1, title: 'Stale tail step', status: 'pending' },
      { id: 'cccccccc-3333', position: 2, title: 'Already done', status: 'done' },
      { id: 'dddddddd-4444', position: 3, title: 'Skipped one', status: 'skipped' },
      { id: 'eeeeeeee-5555', position: 4, title: 'Waiting step', status: 'waiting' },
    ],
  };
  const task = { id: 'plan-1', profile_id: 'alice' };

  it('lists the unfinished steps after the current one, with the ids the plan-edit tools need', () => {
    const out = futureStepsOutline(store, task, { position: 0 });
    expect(out).toContain('ОСТАТОК ПЛАНА');
    expect(out).toContain('2. Stale tail step [bbbbbbbb]');
    expect(out).toContain('5. Waiting step [eeeeeeee]');
    expect(out).not.toContain('Already done');
    expect(out).not.toContain('Skipped one');
    expect(out).not.toContain('Current');
  });

  it('says nothing when the plan ends here', () => {
    const out = futureStepsOutline(store, task, { position: 4 });
    expect(out).toBe('');
  });

  it('never grows without bound: long tails are truncated, not dropped silently', () => {
    const many = { listTaskItems: () => Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}`, position: i + 1, title: `Step ${i}`, status: 'pending' })) };
    const out = futureStepsOutline(many, task, { position: 0 });
    const lines = out.split('\n').filter(l => /^\d+\. Step/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(60);
    expect(out).toMatch(/ещё \d+ шаг\(ов\)/);
  });
});