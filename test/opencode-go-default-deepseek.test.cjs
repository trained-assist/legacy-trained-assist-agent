const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Owner 2026-09-27: every chat runs on OpenCode Go deepseek-v4.1-flash by default; nothing
// silently lands on Claude or on a ladder that ends on paid OpenRouter.

test('unset profile → engine opencode, ocProfile deepseek; explicit claude still honoured', () => {
  const profiles = require('../src/profiles');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-default-'));
  assert.equal(profiles.getEngine(dir, 123), 'opencode');
  assert.equal(profiles.getOcProfile(dir), 'deepseek');
  profiles.setEngine(dir, 'claude', 123);
  assert.equal(profiles.getEngine(dir, 123), 'claude');
  assert.equal(profiles.getEngine(dir, 456), 'opencode');
});

test('playbook bachelor/master run on the deepseek (Go) profile, not value/max', () => {
  const { resolveStepExecution } = require('../src/playbook-executor');
  for (const level of ['bachelor', 'master']) {
    const r = resolveStepExecution({ executor_role: 'developer', minimum_model_level: level });
    assert.equal(r.engine, 'opencode');
    assert.equal(r.ocProfile, 'deepseek');
  }
});
