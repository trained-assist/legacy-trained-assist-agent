'use strict';
// Owner 2026-10-01: durable steps run on OpenCode by default, Claude only on an explicit
// doctor level or quality escalation; every step gets at least the 40-min run cap.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('no-contract step resolves to OpenCode master, never Claude', () => {
  const { resolveStepExecution } = require('../src/playbook-executor');
  for (const item of [{}, { executor_role: 'developer' }, { minimum_model_level: 'master' }, { title: 'legacy' }]) {
    const r = resolveStepExecution(item);
    assert.equal(r.engine, 'opencode', JSON.stringify(item));
    assert.equal(r.ocProfile, 'service');
    assert.equal(r.reason, 'no-contract');
  }
  // explicit pin still honoured
  assert.equal(resolveStepExecution({}, { defaultEngine: 'claude' }).engine, 'claude');
  // doctor stays Claude
  assert.equal(resolveStepExecution({ executor_role: 'developer', minimum_model_level: 'doctor' }).engine, 'claude');
});

test('quality escalation to doctor is on by default, off only on explicit false', async () => {
  const { recoverDurableItem } = require('../src/durable-recovery');
  async function run(policy) {
    const item = { id: 'i1', task_id: 't1', status: 'failed', executor_role: 'developer', minimum_model_level: 'master', current_model_level: 'master', attempt_count: 2, max_attempts: 3 };
    const store = {
      getTaskItem: () => item, bumpModelLevel: () => {}, escalateItem: () => {},
      updateTaskItem: (id, patch) => Object.assign(item, patch),
      retryFailedItem: () => ({ retried: true }),
    };
    const task = { profile_id: 'p', acceptance_criteria_json: '{}', execution_policy_json: policy ? JSON.stringify(policy) : null };
    const r = await recoverDurableItem({ store, task, itemId: 'i1', errorText: 'DURABLE: failed: bad', classifier: () => ({ class: 'UNKNOWN' }), quality: true });
    return { level: item.current_model_level, r };
  }
  const def = await run(null);
  const off = await run({ quality_escalation_to_doctor: false });
  assert.equal(off.level, 'master', 'explicit opt-out stays on OpenCode');
  assert.equal(def.level, 'doctor', `default escalates the 3rd quality attempt to doctor (got ${def.level}, ${JSON.stringify(def.r)})`);
});

test('#1899 still holds: quota failure never bumps to doctor even by default', async () => {
  const { recoverDurableItem } = require('../src/durable-recovery');
  const item = { id: 'i1', task_id: 't1', executor_role: 'developer', minimum_model_level: 'master', current_model_level: 'master', attempt_count: 2, max_attempts: 3 };
  const store = { getTaskItem: () => item, bumpModelLevel: () => {}, escalateItem: () => {}, updateTaskItem: (id, p) => Object.assign(item, p) };
  await recoverDurableItem({ store, task: { profile_id: 'p', acceptance_criteria_json: '{}' }, itemId: 'i1', errorText: 'x', classifier: () => ({ class: 'QUOTA' }) });
  assert.equal(item.current_model_level, 'master');
});
