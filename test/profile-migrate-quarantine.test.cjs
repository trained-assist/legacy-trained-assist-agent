'use strict';
// Quarantine (epic #1784 «Ledger и откат»): DELETE-class files are MOVED, never
// unlinked; revert is byte-exact (sha256 before AND after the move); purging is
// a separate manual command that respects the grace period, verifies content
// against the ledger, and never destroys what it cannot verify.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-quar-data-'));
const USERS = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-quar-users-'));

const ledger = require('../scripts/profile-migrate/ledger.cjs');
const quarantine = require('../scripts/profile-migrate/quarantine.cjs');

const PROFILE = 'alice';
const CONTENT = 'regenerable bytes \u0000\u0001 payload';

function writeSource(rel, content = CONTENT) {
  const abs = path.join(USERS, PROFILE, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function recordFor(rel, sha256, size, over = {}) {
  return ledger.makeRecord({
    phase: 'delete', profile: PROFILE, path: rel, sha256, size,
    action: 'DELETE', dest: rel, ...over,
  });
}

test('quarantine roots resolve through SYSTEM_ROOT, mirroring the profile-relative path', () => {
  assert.equal(quarantine.quarantineRoot(PROFILE), path.join(process.env.AGENT_DATA_DIR, 'migration', 'quarantine', PROFILE));
  assert.equal(
    quarantine.quarantinePath(PROFILE, 'node_modules/a.js'),
    path.join(quarantine.quarantineRoot(PROFILE), 'node_modules', 'a.js'),
  );
  assert.throws(() => quarantine.quarantinePath(PROFILE, '../escape'), /unsafe/);
});

test('move → verify → revert is byte-exact (sha256 checked before AND after the move)', () => {
  const rel = 'node_modules/pkg/index.js';
  const src = writeSource(rel);
  const before = fs.readFileSync(src);
  const h = ledger.hashPath(src);

  const dest = quarantine.reserveDest(PROFILE, rel);
  assert.equal(dest, rel, 'first reservation keeps the original relative path');
  quarantine.moveInto(PROFILE, src, dest, h.sha256);

  assert.equal(fs.existsSync(src), false, 'the profile copy is gone (moved, not copied)');
  const qAbs = quarantine.quarantinePath(PROFILE, dest);
  assert.ok(fs.existsSync(qAbs));
  assert.equal(ledger.hashPath(qAbs).sha256, h.sha256, 'quarantine copy hashes identically');

  const restored = path.join(USERS, PROFILE, rel);
  quarantine.restoreFromQuarantine(PROFILE, dest, restored, h.sha256);
  assert.equal(fs.existsSync(qAbs), false, 'the quarantine copy is consumed by the restore');
  assert.deepEqual(fs.readFileSync(restored), before, 'byte-exact restore');
  assert.equal(ledger.hashPath(restored).sha256, h.sha256);
});

test('reserveDest never overwrites an existing quarantine copy (~N suffix)', () => {
  const rel = 'logs/app.log';
  const src = writeSource(rel, 'first');
  quarantine.moveInto(PROFILE, src, rel, ledger.hashPath(path.join(USERS, PROFILE, rel)).sha256);
  assert.equal(quarantine.reserveDest(PROFILE, rel), 'logs/app.log~1', 'a taken destination is suffixed');

  const src2 = writeSource(rel, 'second');
  const dest2 = quarantine.reserveDest(PROFILE, rel);
  quarantine.moveInto(PROFILE, src2, dest2, ledger.hashPath(src2).sha256);
  assert.equal(fs.readFileSync(quarantine.quarantinePath(PROFILE, rel), 'utf8'), 'first', 'the first copy is untouched');
  assert.equal(fs.readFileSync(quarantine.quarantinePath(PROFILE, dest2), 'utf8'), 'second');
});

test('restore refuses a tampered quarantine copy (sha256 mismatch, nothing written)', () => {
  const rel = 'tmp/tampered.bin';
  const src = writeSource(rel, 'original');
  const h = ledger.hashPath(src);
  quarantine.moveInto(PROFILE, src, rel, h.sha256);

  const qAbs = quarantine.quarantinePath(PROFILE, rel);
  fs.writeFileSync(qAbs, 'tampered!');
  const target = path.join(USERS, PROFILE, rel);
  assert.throws(() => quarantine.restoreFromQuarantine(PROFILE, rel, target, h.sha256), /sha256 mismatch/);
  assert.equal(fs.existsSync(target), false, 'a corrupt copy is never restored');
});

test('purge: report-only by default, grace period respected, --confirm destroys and appends PURGE', () => {
  const rel = 'node_modules/big/lib.js';
  const src = writeSource(rel, 'purge me');
  const h = ledger.hashPath(src);
  quarantine.moveInto(PROFILE, src, rel, h.sha256);

  const old = recordFor(rel, h.sha256, h.size);
  old.ts = new Date(Date.now() - 10 * 86_400_000).toISOString(); // quarantined 10 days ago
  ledger.appendRecord(PROFILE, old);

  const preview = quarantine.purge(PROFILE, { olderThanDays: 7, confirm: false });
  assert.equal(preview.wouldPurge.length, 1, 'older than the grace period → eligible');
  assert.equal(preview.purged.length, 0);
  assert.ok(fs.existsSync(quarantine.quarantinePath(PROFILE, rel)), 'report-only destroys nothing');

  const tooYoung = quarantine.purge(PROFILE, { olderThanDays: 30, confirm: true });
  assert.equal(tooYoung.purged.length, 0, 'younger than the grace period → kept');
  assert.ok(tooYoung.skipped.some(s => /grace period/.test(s.reason)), 'the reason names the grace period');
  assert.ok(fs.existsSync(quarantine.quarantinePath(PROFILE, rel)));

  const done = quarantine.purge(PROFILE, { olderThanDays: 7, confirm: true });
  assert.equal(done.purged.length, 1);
  assert.equal(fs.existsSync(quarantine.quarantinePath(PROFILE, rel)), false, 'confirmed purge destroys the copy');

  const { records } = ledger.readLedger(PROFILE);
  const last = records.at(-1);
  assert.equal(last.action, 'PURGE', 'the destruction is appended to the ledger, never edited in');
  assert.equal(last.path, rel);
  assert.equal(last.dest, rel);
  assert.equal(last.phase, 'delete', 'a PURGE keeps the phase of the record it destroys (fold stays coherent)');
  assert.equal(ledger.recordState(last.action), 'purged');
});

test('purge never destroys data it cannot verify: sha mismatch + unrecorded copies are kept', () => {
  const rel = 'tmp/mismatch.bin';
  const src = writeSource(rel, 'recorded content');
  const h = ledger.hashPath(src);
  quarantine.moveInto(PROFILE, src, rel, h.sha256);
  const rec = recordFor(rel, h.sha256, h.size);
  rec.ts = new Date(Date.now() - 30 * 86_400_000).toISOString();
  ledger.appendRecord(PROFILE, rec);
  fs.writeFileSync(quarantine.quarantinePath(PROFILE, rel), 'content nobody recorded');

  const orphan = quarantine.quarantinePath(PROFILE, 'orphan/file.bin');
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, 'never ledgered');

  const out = quarantine.purge(PROFILE, { olderThanDays: 1, confirm: true });
  assert.equal(out.purged.length, 0, 'nothing destroyed');
  assert.ok(fs.existsSync(quarantine.quarantinePath(PROFILE, rel)), 'sha mismatch kept');
  assert.ok(fs.existsSync(orphan), 'unrecorded copy kept');
  const reasons = out.skipped.map(s => s.reason).join(' | ');
  assert.match(reasons, /sha256 mismatch/);
  assert.match(reasons, /no ledger record/);
});

test('listQuarantine reports files with their recorded state', () => {
  const out = quarantine.listQuarantine(PROFILE);
  assert.ok(out.files.length >= 2, 'previous fixtures are still in quarantine');
  assert.ok(out.files.every(f => typeof f.dest === 'string' && Number.isFinite(f.size)));
  assert.ok(out.files.some(f => f.dest === 'tmp/mismatch.bin' && f.recorded === true));
  assert.ok(out.files.some(f => f.dest === 'logs/app.log~1' && f.recorded === false), 'copies without a ledger record are flagged');
});
