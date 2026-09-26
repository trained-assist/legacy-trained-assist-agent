const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated OPENCODE_GO_MODE_FILE per test run — same pattern as test/opencode-ladder.test.cjs —
// so this never touches the real ~/.config/opencode/go-mode.json. Also isolates the key-pool
// module's auth/state files and clears the pool env so the rotation path is opt-in per test.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-toggle-test-'));
  process.env.OPENCODE_GO_MODE_FILE = path.join(dir, 'go-mode.json');
  process.env.OPENCODE_GO_KEYS_STATE_FILE = path.join(dir, 'go-keys-state.json');
  process.env.OPENCODE_GO_AUTH_FILE = path.join(dir, 'auth.json');
  delete process.env.OPENCODE_GO_API_KEYS;
  delete process.env.OPENCODE_GO_API_KEY;
  delete require.cache[require.resolve('../src/opencode-go-toggle')];
  delete require.cache[require.resolve('../src/opencode-ladder')];
  delete require.cache[require.resolve('../src/opencode-go-keys')];
  return { mod: require('../src/opencode-go-toggle'), dir, keys: require('../src/opencode-go-keys') };
}

test('defaults to go mode with no state file', () => {
  const { mod } = freshModule();
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.resolveProfileName(), 'deepseek-go');
});

test('setMode flips resolveProfileName', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter');
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.resolveProfileName(), 'deepseek-openrouter');
  mod.setMode('go');
  assert.equal(mod.getMode(), 'go');
});

test('manual switch to openrouter never auto-reverts', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: false });
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  assert.equal(state.autoRevertAt, null);
  assert.equal(mod.getMode(), 'openrouter');
});

test('auto switch to openrouter reverts to go once AUTO_REVERT_MS has passed', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: true });
  // Simulate time passing by rewriting the state file with an already-past autoRevertAt.
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  state.autoRevertAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(mod.STATE_FILE, JSON.stringify(state));
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.resolveProfileName(), 'deepseek-go');
});

test('noteFailure ignores non-opencode-go models', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('openrouter/deepseek/deepseek-v4-flash-0731', 'usage limit exceeded');
  assert.equal(flipped, false);
  assert.equal(mod.getMode(), 'go');
});

test('noteFailure ignores non-quota errors on an opencode-go model', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'some unrelated engine crash');
  assert.equal(flipped, false);
  assert.equal(mod.getMode(), 'go');
});

test('noteFailure flips to openrouter on a Go quota/usage-limit error', () => {
  const { mod } = freshModule();
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');
  assert.equal(flipped, true);
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.resolveProfileName(), 'deepseek-openrouter');
});

test('noteFailure is a no-op once already on openrouter', () => {
  const { mod } = freshModule();
  mod.setMode('openrouter', { auto: true });
  const flipped = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');
  assert.equal(flipped, false);
});

test('forceFlip alternates unconditionally, no error text required (blind crash-retry alternation)', () => {
  const { mod } = freshModule();
  assert.equal(mod.getMode(), 'go');
  assert.equal(mod.forceFlip(), 'openrouter');
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.forceFlip(), 'go', 'and vice versa — a second forced flip goes back to go');
  assert.equal(mod.getMode(), 'go');
});

test('forceFlip marks the switch as auto (eligible for AUTO_REVERT_MS), not a sticky manual override', () => {
  const { mod } = freshModule();
  mod.forceFlip();
  const state = JSON.parse(fs.readFileSync(mod.STATE_FILE, 'utf8'));
  assert.equal(state.switchedBy, 'auto');
  assert.ok(state.autoRevertAt);
});

// --- Key-pool rotation (owner 2026-09-26: "два ключа, основной и резервный") ---

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

test('noteFailure rotates to the spare Go key and stays on Go (no gateway flip)', () => {
  const { mod, dir, keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary,oc_backup';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_primary' } }));

  const handled = mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'Go usage limit exceeded');

  assert.equal(handled, true);
  assert.equal(mod.getMode(), 'go', 'stays on the Go gateway');
  assert.equal(keys.writeActiveKey(), 'oc_backup', 'auth.json now holds the spare key');
  const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  assert.equal(auth['opencode-go'].key, 'oc_backup');
});

test('noteFailure flips to openrouter once every Go key is exhausted', () => {
  const { mod, dir, keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary,oc_backup';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_primary' } }));

  assert.equal(mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'usage limit'), true);
  assert.equal(keys.writeActiveKey(), 'oc_backup');
  // Second quota hit on the (now active) backup key: nothing left to rotate to → gateway flip.
  assert.equal(mod.noteFailure('opencode-go/deepseek-v4.1-flash', 'usage limit'), true);
  assert.equal(mod.getMode(), 'openrouter');
  assert.equal(mod.resolveProfileName(), 'deepseek-openrouter');
});

test('rotate marks the active key exhausted with a TTL and returns null when all keys are burned', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary,oc_backup';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_primary' } }));

  assert.deepEqual(keys.rotate(), { fromIndex: 0, toIndex: 1 });
  assert.equal(keys.rotate(), null, 'both keys burned → nothing to rotate to');
  const state = JSON.parse(fs.readFileSync(keys.STATE_FILE, 'utf8'));
  assert.ok(state.exhausted['0'] > Date.now() && state.exhausted['1'] > Date.now());
});

test('rotate is a no-op with a single key (legacy VM without a provisioned pool)', () => {
  const { keys, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_primary';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_primary' } }));
  assert.equal(keys.rotate(), null);
});

// 2026-09-26 incident: the primary Go key was revoked ("Upstream request failed: Invalid
// credential"). That error wasn't classified, so no rotation happened and every Go call on the VM
// failed; each deploy then rewrote auth.json back onto the dead primary.
test('noteFailure rotates off a REJECTED key (Invalid credential) and parks it for a day', () => {
  const { mod, dir, keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_dead,oc_live';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_dead' } }));

  assert.equal(mod.noteFailure('opencode-go/deepseek-v4-flash', 'Upstream request failed: Invalid credential'), true);
  assert.equal(mod.getMode(), 'go');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))['opencode-go'].key, 'oc_live');
  const state = JSON.parse(fs.readFileSync(keys.STATE_FILE, 'utf8'));
  assert.ok(state.exhausted['0'] > Date.now() + keys.EXHAUST_TTL_MS, 'dead key parked longer than a quota hit');
});

test('noteFailure still ignores unrelated errors (no rotation on a generic crash)', () => {
  const { mod, dir } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_a,oc_b';
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_a' } }));
  assert.equal(mod.noteFailure('opencode-go/deepseek-v4-flash', 'Bad Request: {model: x}'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))['opencode-go'].key, 'oc_a');
});

test('ensureUsableActiveKey moves a deploy-reset auth.json off a parked key; no-op otherwise', () => {
  const { dir, keys } = freshModule();
  process.env.OPENCODE_GO_API_KEYS = 'oc_dead,oc_live';
  const auth = path.join(dir, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_dead' } }));
  assert.equal(keys.ensureUsableActiveKey(), null, 'nothing parked → leave the primary alone');

  keys.rotate({ ttlMs: keys.DEAD_KEY_TTL_MS });
  // Simulate the deploy rewriting auth.json to the pool's first (dead) key.
  fs.writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'oc_dead' }, other: { type: 'api', key: 'x' } }));
  assert.deepEqual(keys.ensureUsableActiveKey(), { fromIndex: 0, toIndex: 1 });
  const after = JSON.parse(fs.readFileSync(auth, 'utf8'));
  assert.equal(after['opencode-go'].key, 'oc_live');
  assert.equal(after.other.key, 'x', 'other providers survive');
  assert.match(keys.activeKeyFingerprint(), /^key#1\/[0-9a-f]{8}$/);
});
