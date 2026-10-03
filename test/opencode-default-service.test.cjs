const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Owner 2026-09-27: every chat runs on the standard service ladder by default; nothing
// silently lands on Claude or on a ladder that ends on paid OpenRouter. Profiles are named
// after the llm-ladder ladder (llm-ladder #49/#101) — the old `deepseek` profile name is
// gone, and the agent holds no provider keys (the llm-ladder owns the pools).

test('unset profile → engine opencode, ocProfile service; explicit claude still honoured', () => {
  const profiles = require('../src/profiles');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-default-'));
  assert.equal(profiles.getEngine(dir, 123), 'opencode');
  assert.equal(profiles.getOcProfile(dir), 'service');
  profiles.setEngine(dir, 'claude', 123);
  assert.equal(profiles.getEngine(dir, 123), 'claude');
  assert.equal(profiles.getEngine(dir, 456), 'opencode');
});

test('playbook bachelor/master run on the service ladder, not a retired value/max profile', () => {
  const { resolveStepExecution } = require('../src/playbook-executor');
  for (const level of ['bachelor', 'master']) {
    const r = resolveStepExecution({ executor_role: 'developer', minimum_model_level: level });
    assert.equal(r.engine, 'opencode');
    assert.equal(r.ocProfile, 'service');
  }
});

test('playbook doctor: claude → codex → opencode `doctor` ladder, not the cheapest service tier (#1689)', () => {
  const { resolveStepExecution } = require('../src/playbook-executor');
  const r = resolveStepExecution({ executor_role: 'developer', minimum_model_level: 'doctor' });
  assert.equal(r.engine, 'claude');
  assert.deepEqual(r.fallbacks.map(fb => [fb.engine, fb.ocProfile]), [['codex', null], ['opencode', 'doctor']]);
});
