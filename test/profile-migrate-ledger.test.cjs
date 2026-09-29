'use strict';
// Append-only migration ledger (epic #1784 «Ledger и откат»): location under
// SYSTEM_ROOT, the eight record fields, fsync-per-append, and — the property a
// crash actually exercises — a TORN LAST LINE must never break reads, nor
// merge with the record appended after it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated SYSTEM_ROOT — never the live agent-data (convention of
// profile-lock.test.cjs / execution-history.test.cjs). Must be set BEFORE the
// first require that resolves src/data-paths.js.
process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ledger-data-'));

const { SYSTEM_ROOT } = require('../src/data-paths');
const ledger = require('../scripts/profile-migrate/ledger.cjs');

const PROFILE = 'alice';
const FILE = path.join(os.tmpdir(), `mig-ledger-src-${process.pid}.txt`);

function rec(over = {}) {
  return ledger.makeRecord({
    phase: 'delete',
    profile: PROFILE,
    path: 'node_modules/pkg/index.js',
    sha256: 'a'.repeat(64),
    size: 42,
    action: 'DELETE',
    dest: 'node_modules/pkg/index.js',
    ...over,
  });
}

test('ledger file lives at SYSTEM_ROOT/migration/<profile>/migration-ledger.jsonl', () => {
  const p = ledger.ledgerPath(PROFILE);
  assert.equal(p, path.join(SYSTEM_ROOT, 'migration', PROFILE, 'migration-ledger.jsonl'));
  assert.equal(ledger.migrationDir(PROFILE), path.join(SYSTEM_ROOT, 'migration', PROFILE));
  assert.equal(ledger.LEDGER_FILE, 'migration-ledger.jsonl');
});

test('appendRecord writes the eight epic fields as ONE fsynced JSON line, mode 0600', () => {
  const record = rec();
  assert.deepEqual(Object.keys(record), ['ts', 'phase', 'profile', 'path', 'sha256', 'size', 'action', 'dest'],
    'exactly {ts, phase, profile, path, sha256, size, action, dest}, in the epic\'s order');
  ledger.appendRecord(PROFILE, record);

  const file = ledger.ledgerPath(PROFILE);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'line terminated');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'ledger is owner-only');

  const parsed = ledger.readLedger(PROFILE);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.missing, false);
  assert.equal(Number.isFinite(Date.parse(parsed.records[0].ts)), true, 'ts is ISO-8601');
});

test('readLedger parses records in order and skips a torn last line', () => {
  const file = ledger.ledgerPath(PROFILE);
  // Simulate a process killed mid-append: a partial line, no trailing newline.
  fs.appendFileSync(file, '{"ts":"2026-09-29T00:00:00.000Z","phase":"del');

  const parsed = ledger.readLedger(PROFILE);
  assert.equal(parsed.records.length, 1, 'the intact records are still readable');
  assert.equal(parsed.skipped, 1, 'the torn line is skipped, not thrown on');
  assert.equal(parsed.records[0].path, 'node_modules/pkg/index.js');
});

test('an append after a torn tail repairs the newline — the records never merge', () => {
  const file = ledger.ledgerPath(PROFILE);
  const before = ledger.readLedger(PROFILE).records.length;
  ledger.appendRecord(PROFILE, rec({ path: 'logs/app.log', dest: 'logs/app.log', size: 9, sha256: 'b'.repeat(64) }));

  const parsed = ledger.readLedger(PROFILE);
  assert.equal(parsed.records.length, before + 1, 'the new record is a separate line');
  assert.equal(parsed.skipped, 1, 'the torn line is still skipped, never merged into a valid one');
  assert.equal(parsed.records.at(-1).path, 'logs/app.log');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('\n{"ts"'), 'a newline was inserted before the new record');
});

test('a missing ledger reads as empty without creating anything', () => {
  const parsed = ledger.readLedger('no-such-profile');
  assert.deepEqual(parsed.records, []);
  assert.equal(parsed.missing, true);
  assert.equal(fs.existsSync(ledger.ledgerPath('no-such-profile')), false, 'reads never create the directory');
});

test('unsafe paths, profile names and malformed records are rejected at append time', () => {
  assert.throws(() => ledger.appendRecord(PROFILE, rec({ path: '/etc/passwd' })), /relative/);
  assert.throws(() => ledger.appendRecord(PROFILE, rec({ path: '../../etc/passwd' })), /relative/);
  assert.throws(() => ledger.appendRecord(PROFILE, rec({ path: 'a/../b' })), /relative/);
  assert.throws(() => ledger.appendRecord(PROFILE, rec({ dest: '../outside' })), /dest/);
  assert.throws(() => ledger.appendRecord('../evil', rec()), /invalid profile/);
  assert.throws(() => ledger.appendRecord(PROFILE, rec({ profile: '../evil' })), /profile/);
  assert.throws(() => ledger.appendRecord(PROFILE, { ...rec(), sha256: 'nope' }), /sha256/);
  assert.throws(() => ledger.appendRecord(PROFILE, { ...rec(), size: -1 }), /size/);
  assert.throws(() => ledger.appendRecord(PROFILE, { ...rec(), ts: 'not-a-date' }), /ts/);
  const missingField = rec();
  delete missingField.dest;
  assert.throws(() => ledger.appendRecord(PROFILE, missingField), /dest/);
  assert.throws(() => ledger.ledgerPath('../evil'), /invalid profile/, 'the ledger path itself refuses traversal');
  assert.equal(fs.existsSync(path.join(SYSTEM_ROOT, 'migration', 'evil')), false, 'no ledger outside the migration tree');
});

test('recordState folds actions into at-dest / returned / purged', () => {
  assert.equal(ledger.recordState('DELETE'), 'at-dest');
  assert.equal(ledger.recordState('MOVE'), 'at-dest');
  assert.equal(ledger.recordState('ARCHIVE'), 'at-dest');
  assert.equal(ledger.recordState('RESTORED'), 'returned');
  assert.equal(ledger.recordState('DELETE_FAILED'), 'returned');
  assert.equal(ledger.recordState('PURGE'), 'purged');
});

test('hashPath: regular file by content, symlink by its target string', () => {
  fs.writeFileSync(FILE, 'hello migrate');
  const h = ledger.hashPath(FILE);
  assert.equal(h.sha256, ledger.sha256String('hello migrate'));
  assert.equal(h.size, 'hello migrate'.length);
  assert.equal(h.isSymlink, false);
  // Same content, different name → same hash; different content → different hash.
  assert.equal(ledger.sha256File(FILE), h.sha256);
  assert.notEqual(ledger.sha256String('other'), h.sha256);

  const link = `${FILE}.link`;
  try { fs.unlinkSync(link); } catch { /* first run */ }
  fs.symlinkSync('/nonexistent/target/path', link);
  const lh = ledger.hashPath(link);
  assert.equal(lh.isSymlink, true);
  assert.equal(lh.sha256, ledger.sha256String('/nonexistent/target/path'), 'a symlink is hashed by its target string');
  assert.equal(lh.size, fs.lstatSync(link).size);
  fs.rmSync(link, { force: true });
  fs.rmSync(FILE, { force: true });
});
