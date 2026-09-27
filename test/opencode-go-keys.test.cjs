const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// OpenCode Go key pool: rotation between the two keys on a KEY-level fault (quota / rejected key).
// There is no VM-wide go/openrouter toggle any more (removed 2026-09-27) — when every key is parked
// noteFailure reports retryAt and the runner skips the Go rungs of the ladder until then.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-keys-test-'));
  process.env.OPENCODE_GO_KEYS_STATE_FILE = path.join(dir, 'go-keys-state.json');
  process.env.OPENCODE_GO_AUTH_FILE = path.join(dir, 'auth.json');
  delete process.env.OPENCODE_GO_API_KEYS;
  delete process.env.OPENCODE_GO_API_KEY;
  delete require.cache[require.resolve('../src/opencode-go-keys')];
  return { keys: require('../src/opencode-go-keys'), dir };
}
const setAuth = (dir, key) => fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key } }));
const activeKey = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))['opencode-go'].key;

test('key pool: readPool splits comma/whitespace values and falls back to the single key', () => {
  const { keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_a, oc_b oc_c';
  assert.deepEqual(keys.readPool(), ['oc_a', 'oc_b', 'oc_c']);
  delete process.env.OPENCODE_GO_API_KEYS;
  process.env.OPENCODE_GO_API_KEY = 'oc_only';
  assert.deepEqual(keys.readPool(), ['oc_only']);
  delete process.env.OPENCODE_GO_API_KEY;
  assert.deepEqual(keys.readPool(), []);
});

test('noteFailure ignores non-Go models and non-key errors (503, Bad Request, crash)', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_a,oc_b';
  setAuth(dir, 'oc_a');
  assert.equal(keys.noteFailure('openrouter/deepseek/deepseek-v4-flash-0731', 'usage limit'), null);
  for (const err of ['HTTP 503 temporarily overloaded', 'Unexpected server error', 'Bad Request: {model: x}', 'model not found']) {
    assert.equal(keys.noteFailure('opencode-go/deepseek-v4.1-flash', err), null, err);
  }
  assert.equal(activeKey(dir), 'oc_a', 'no rotation');
});

test('full cycle: key#0 quota → key#1 → both parked (retryAt) → after the window key#0 is usable again', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary,oc_backup';
  setAuth(dir, 'oc_primary');
  const t0 = Date.now();

  const r1 = keys.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');
  assert.equal(r1.rotated, true);
  assert.equal(activeKey(dir), 'oc_backup');

  const r2 = keys.noteFailure('opencode-go/deepseek-v4.1-flash', '429 Too Many Requests');
  assert.equal(r2.rotated, false, 'nothing left to rotate to');
  assert.ok(r2.retryAt > t0 && r2.retryAt <= t0 + keys.EXHAUST_TTL_MS + 1000, 'Go comes back within the short window');
  assert.equal(keys.nextUsableAt(), r2.retryAt);

  const st = JSON.parse(fs.readFileSync(keys.STATE_FILE, 'utf8'));
  for (const k of Object.keys(st.exhausted)) st.exhausted[k] = Date.now() - 1000;
  fs.writeFileSync(keys.STATE_FILE, JSON.stringify(st));
  assert.equal(keys.nextUsableAt(), 0, 'a key is usable again');
  assert.equal(keys.noteFailure('opencode-go/deepseek-v4.1-flash', 'usage limit').rotated, true, 'rotation works again');
});

test('the quota window is short (fast return to Go), a rejected key is parked longer', () => {
  const { keys } = freshModule();
  assert.ok(keys.EXHAUST_TTL_MS <= 30 * 60 * 1000, `EXHAUST_TTL_MS=${keys.EXHAUST_TTL_MS}`);
  assert.ok(keys.DEAD_KEY_TTL_MS > keys.EXHAUST_TTL_MS && keys.DEAD_KEY_TTL_MS <= 60 * 60 * 1000);
});

// 2026-09-26 incident: the primary Go key was revoked ("Upstream request failed: Invalid credential").
test('noteFailure rotates off a REJECTED key (Invalid credential) and parks it longer than a quota hit', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_dead,oc_live';
  setAuth(dir, 'oc_dead');
  const r = keys.noteFailure('opencode-go/deepseek-v4-flash', 'Upstream request failed: Invalid credential');
  assert.equal(r.rotated, true);
  assert.equal(r.dead, true);
  assert.equal(activeKey(dir), 'oc_live');
  const state = JSON.parse(fs.readFileSync(keys.STATE_FILE, 'utf8'));
  assert.ok(state.exhausted['0'] > Date.now() + keys.EXHAUST_TTL_MS, 'dead key parked longer than a quota hit');
});

test('rotate marks the active key exhausted with a TTL and returns null when all keys are burned', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary,oc_backup';
  setAuth(dir, 'oc_primary');
  assert.deepEqual(keys.rotate(), { fromIndex: 0, toIndex: 1 });
  assert.equal(keys.rotate(), null, 'both keys burned → nothing to rotate to');
  const state = JSON.parse(fs.readFileSync(keys.STATE_FILE, 'utf8'));
  assert.ok(state.exhausted['0'] > Date.now() && state.exhausted['1'] > Date.now());
});

test('single-key pool: rotate is a no-op, noteFailure still reports a retryAt', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary';
  setAuth(dir, 'oc_primary');
  assert.equal(keys.rotate(), null);
  const r = keys.noteFailure('opencode-go/deepseek-v4.1-flash', 'usage limit');
  assert.equal(r.rotated, false);
  assert.ok(r.retryAt > Date.now());
});

test('ensureUsableActiveKey moves a deploy-reset auth.json off a parked key; no-op otherwise', () => {
  const { dir, keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_dead,oc_live';
  const auth = path.join(dir, 'auth.json');
  setAuth(dir, 'oc_dead');
  assert.equal(keys.ensureUsableActiveKey(), null, 'nothing parked → leave the primary alone');
  keys.rotate({ ttlMs: keys.DEAD_KEY_TTL_MS });
  fs.writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_dead' }, other: { type: 'api', key: 'x' } }));
  assert.deepEqual(keys.ensureUsableActiveKey(), { fromIndex: 0, toIndex: 1 });
  const after = JSON.parse(fs.readFileSync(auth, 'utf8'));
  assert.equal(after['opencode-go'].key, 'oc_live');
  assert.equal(after.other.key, 'x', 'other providers survive');
  assert.match(keys.activeKeyFingerprint(), /^key#1\/[0-9a-f]{8}$/);
});
