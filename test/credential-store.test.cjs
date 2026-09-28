'use strict';

// Encrypted credential store — epic #1789 P0 C4.
// Covers: round-trip, legacy plaintext passthrough + re-encrypt on write, tamper
// detection (must throw, never return garbage), missing-key plaintext fallback
// with a warning, .index.json updates, mode 0600.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated token root — set BEFORE data-paths/credential-store are loaded.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-store-'));
process.env.AGENT_TOKENS_DIR = path.join(tmpRoot, 'agent-tokens');
process.env.AGENT_TOKENS_ROOT = process.env.AGENT_TOKENS_DIR;
const KEY = 'a'.repeat(64); // 64 hex chars → 32 bytes
process.env.CRED_ENCRYPTION_KEY = KEY;

const store = require('../src/credential-store.js');
const { tokensRoot } = require('../src/data-paths.js');

const ROOT = tokensRoot();
const PROFILE = 'alice';

function credPath(service) {
  return path.join(ROOT, PROFILE, service);
}

function statMode(p) {
  return fs.statSync(p).mode & 0o777;
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('encryptFile/decryptFile round-trip', () => {
  const plaintext = '{"access_token":"ghp_value","refresh_token":"r"}';
  const blob = store.encryptFile(plaintext);
  assert.ok(store.isEncrypted(blob), 'blob must be detected as a v2 envelope');
  assert.equal(store.decryptFile(blob), plaintext);
  // Same plaintext twice → different ciphertext (fresh random IV).
  assert.notEqual(store.encryptFile(plaintext), blob);
});

test('writeCredential stores an envelope and readCredential returns the original', () => {
  const value = 'ghp_supersecrettoken';
  const file = store.writeCredential(PROFILE, 'github', value);

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(store.isEncrypted(onDisk), 'on-disk content must be the encrypted envelope');
  assert.ok(!onDisk.includes(value), 'plaintext token must never appear on disk');

  assert.equal(store.readCredential(PROFILE, 'github'), value);
  // .meta sidecar exists and records the format version.
  const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf8'));
  assert.equal(meta.version, 2);
  assert.equal(meta.service, 'github');
});

test('legacy plaintext file stays readable and is re-encrypted on next write', () => {
  const file = path.join(ROOT, PROFILE, 'weeek');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'api_legacy_plain_token', { mode: 0o600 });

  // Read: transparent passthrough, no decryption attempted.
  assert.equal(store.readCredential(PROFILE, 'weeek'), 'api_legacy_plain_token');
  assert.equal(store.readCredentialFile(file), 'api_legacy_plain_token');

  // Write (same value, as a real reader/writer round-trip would) → now encrypted.
  store.writeCredential(PROFILE, 'weeek', 'api_legacy_plain_token');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(store.isEncrypted(onDisk));
  assert.equal(store.readCredential(PROFILE, 'weeek'), 'api_legacy_plain_token');
});

test('tampering with the ciphertext is detected, not returned as garbage', () => {
  const file = store.writeCredential(PROFILE, 'nalog', JSON.stringify({ auth_token: 't' }));
  const blob = fs.readFileSync(file, 'utf8');
  const buf = Buffer.from(blob, 'base64');

  // Flip a byte inside the ciphertext (after version + iv + auth tag).
  buf[buf.length - 1] ^= 0xff;
  const tampered = buf.toString('base64');

  // Primitive: always throws.
  assert.throws(() => store.decryptFile(tampered), /unable to authenticate|bad decrypt|Unsupported state/i);
  // Reader: the .meta sidecar says v2 → loud failure, never base64 garbage.
  fs.writeFileSync(file, tampered);
  assert.throws(() => store.readCredentialFile(file));

  // Corrupting the auth tag itself must throw too.
  const buf2 = Buffer.from(blob, 'base64');
  buf2[1 + 16] ^= 0xff;
  assert.throws(() => store.decryptFile(buf2.toString('base64')));

  // Leave the fixture clean for the tests that follow.
  fs.unlinkSync(file);
  fs.unlinkSync(file + '.meta');
});

test('without CRED_ENCRYPTION_KEY writes fall back to plaintext with a warning', () => {
  const savedKey = process.env.CRED_ENCRYPTION_KEY;
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    store.writeCredential(PROFILE, 'dadata', 'dadata-key-plain');
  } finally {
    console.warn = originalWarn;
    process.env.CRED_ENCRYPTION_KEY = savedKey;
    store._resetMasterKey();
  }

  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  const file = credPath('dadata');
  assert.equal(fs.readFileSync(file, 'utf8'), 'dadata-key-plain');
  assert.equal(store.readCredential(PROFILE, 'dadata'), 'dadata-key-plain');
  // No stale v2 sidecar left behind by a plaintext write.
  assert.ok(!fs.existsSync(file + '.meta'));
  assert.ok(store.hasMasterKey(), 'key restored for the remaining tests');
});

test('writeCredential updates the cross-user .index.json', () => {
  store.writeCredential(PROFILE, 'hh', 'hh-token');
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, '.index.json'), 'utf8'));
  assert.ok(Array.isArray(index[PROFILE]), 'profile entry must exist');
  assert.ok(index[PROFILE].includes('github'));
  assert.ok(index[PROFILE].includes('weeek'));
  assert.ok(index[PROFILE].includes('nalog'));
  assert.ok(index[PROFILE].includes('hh'));

  // Revocation drops the service from the index.
  assert.equal(store.deleteCredential(PROFILE, 'hh'), true);
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, '.index.json'), 'utf8'));
  assert.ok(!after[PROFILE].includes('hh'));
  assert.ok(!fs.existsSync(credPath('hh')));
  assert.ok(!fs.existsSync(credPath('hh') + '.meta'));
});

test('credential files, sidecars and the index are written mode 0600', () => {
  const file = store.writeCredential(PROFILE, 'tilda-creds', '{"email":"a@b.c","password":"p"}');
  assert.equal(statMode(file), 0o600, 'credential file');
  assert.equal(statMode(file + '.meta'), 0o600, 'meta sidecar');
  assert.equal(statMode(path.join(ROOT, '.index.json')), 0o600, 'index');
});

test('user-tokens reads encrypted credentials transparently and hides .meta from listings', () => {
  store.writeCredential(PROFILE, 'github', 'ghp_from_store');
  store.writeCredential(PROFILE, 'gdrive', JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' }));

  const tokens = require('../src/user-tokens.js');
  const extra = tokens.loadUserTokens(PROFILE);
  assert.equal(extra.GH_TOKEN, 'ghp_from_store');
  assert.equal(extra.GITHUB_TOKEN, 'ghp_from_store');

  const listed = (tokens.listConnectedServices(PROFILE) || []).map(s => s.file);
  assert.ok(listed.includes('github'));
  assert.ok(listed.includes('weeek'));
  assert.ok(!listed.some(f => f.endsWith('.meta')), `.meta sidecars must not be listed as services: ${listed.join(', ')}`);
});

test('appendMeta merges non-sensitive metadata without touching the ciphertext', () => {
  const file = store.writeCredential(PROFILE, 'nalog', '{"auth_token":"t"}', { expiresAt: '2026-09-03T14:00:00Z' });
  const before = fs.readFileSync(file, 'utf8');

  const meta = store.appendMeta(PROFILE, 'nalog', { last_used_at: '2026-09-03T13:30:00Z' });
  assert.equal(meta.expires_at, '2026-09-03T14:00:00Z', 'expires_at survives the merge');
  assert.equal(meta.last_used_at, '2026-09-03T13:30:00Z');
  assert.equal(meta.version, 2);
  assert.ok(meta.created_at, 'created_at is preserved/created');

  assert.equal(fs.readFileSync(file, 'utf8'), before, 'appendMeta must not rewrite the credential');
  assert.equal(store.readCredential(PROFILE, 'nalog'), '{"auth_token":"t"}');
});

test('readCredential returns null for a credential that does not exist', () => {
  assert.equal(store.readCredential(PROFILE, 'never-written'), null);
});
