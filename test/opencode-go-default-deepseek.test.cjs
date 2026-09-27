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

function freshToggle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-ttl-'));
  process.env.OPENCODE_GO_MODE_FILE = path.join(dir, 'go-mode.json');
  process.env.OPENCODE_GO_KEYS_STATE_FILE = path.join(dir, 'go-keys-state.json');
  process.env.OPENCODE_GO_AUTH_FILE = path.join(dir, 'auth.json');
  process.env.OPENCODE_GO_API_KEYS = 'oc_a,oc_b';
  fs.writeFileSync(process.env.OPENCODE_GO_AUTH_FILE, JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_a' } }));
  for (const m of ['../src/opencode-go-toggle', '../src/opencode-go-keys']) delete require.cache[require.resolve(m)];
  return { mod: require('../src/opencode-go-toggle'), keys: require('../src/opencode-go-keys') };
}

test('a passing 503 parks the key for its own short TTL, and OpenRouter ends when the first key heals', () => {
  const { mod, keys } = freshToggle();
  const t0 = Date.now();
  mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'HTTP 503 temporarily overloaded');
  mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'HTTP 503 temporarily overloaded');
  assert.equal(mod.getMode(), 'openrouter');
  const exhausted = JSON.parse(fs.readFileSync(process.env.OPENCODE_GO_KEYS_STATE_FILE, 'utf8')).exhausted;
  for (const until of Object.values(exhausted)) assert.ok(until - t0 <= 5 * 60 * 1000 + 1000, 'parked ≤5min, not the full window');
  const state = JSON.parse(fs.readFileSync(process.env.OPENCODE_GO_MODE_FILE, 'utf8'));
  const revertIn = Date.parse(state.autoRevertAt) - t0;
  assert.ok(revertIn <= 5 * 60 * 1000 + 1000, `revert in ${revertIn}ms`);
  assert.ok(revertIn >= mod.MIN_OPENROUTER_MS - 1000);
  assert.ok(keys.nextUsableAt() > t0);
});
