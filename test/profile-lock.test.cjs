'use strict';
// Per-profile maintenance lock (epic #1784, G1) — the file-based mutex that lets
// the profile migrator (a SEPARATE process) quiesce a profile while the agent
// server keeps running. Covers: exclusive acquire, conflict → fail fast, stale
// reclaim (TTL expiry + dead holder pid), release semantics, and the admission
// wait the runner parks on before it journals a run (G2).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Isolated SYSTEM_ROOT — never the live agent-data (same convention as
// auth-flag.test.cjs / execution-history.test.cjs).
process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-lock-data-'));
const { profileLockPath, SYSTEM_ROOT } = require('../src/data-paths');
const {
  acquireProfileLock, releaseProfileLock, isProfileLocked, waitForProfileUnlocked,
  DEFAULT_TTL_MS, DEFAULT_ACQUIRE_TIMEOUT_MS,
} = require('../src/profile-lock');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lockFile = u => profileLockPath(u);
const readLock = u => JSON.parse(fs.readFileSync(lockFile(u), 'utf8'));

// A pid that is alive but not ours: pid 1 always exists in any test container.
const FOREIGN_LIVE_PID = 1;

test('lock file lives under SYSTEM_ROOT/agent-locks and records pid/acquiredAt/expiresAt/reason', async () => {
  const u = 'lock-basic';
  assert.equal(lockFile(u), path.join(SYSTEM_ROOT, 'agent-locks', 'lock-basic.lock'));
  assert.equal(isProfileLocked(u), false);
  const rec = await acquireProfileLock(u, { reason: 'migrate', ttlMs: 60_000 });
  try {
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.reason, 'migrate');
    assert.ok(Number.isFinite(rec.acquiredAt) && Number.isFinite(rec.expiresAt));
    assert.equal(rec.expiresAt - rec.acquiredAt, 60_000);
    assert.ok(isProfileLocked(u), 'held after acquire');
    const onDisk = readLock(u);
    assert.deepEqual(onDisk, rec);
    assert.equal(fs.statSync(lockFile(u)).mode & 0o777, 0o600, 'lock file is owner-only');
    assert.ok(DEFAULT_TTL_MS >= 5 * 60_000, 'default TTL is minutes, not seconds');
    assert.ok(DEFAULT_ACQUIRE_TIMEOUT_MS <= 30_000, 'a second acquirer fails fast (epic: ~30s)');
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
  assert.equal(isProfileLocked(u), false, 'released');
  assert.equal(fs.existsSync(lockFile(u)), false);
});

test('conflict: a live foreign lock is never stolen and the acquirer fails fast', async () => {
  const u = 'lock-conflict';
  fs.mkdirSync(path.dirname(lockFile(u)), { recursive: true });
  const foreign = { pid: FOREIGN_LIVE_PID, acquiredAt: Date.now() - 1000, expiresAt: Date.now() + 600_000, reason: 'other-migrator' };
  fs.writeFileSync(lockFile(u), JSON.stringify(foreign), { mode: 0o600 });
  const t0 = Date.now();
  await assert.rejects(
    () => acquireProfileLock(u, { timeoutMs: 300 }),
    err => err.code === 'PROFILE_LOCKED' && /other-migrator/.test(err.message) && err.holder.pid === FOREIGN_LIVE_PID,
    'times out with a PROFILE_LOCKED error naming the holder',
  );
  assert.ok(Date.now() - t0 >= 300, 'waited the whole timeout before giving up');
  assert.deepEqual(readLock(u), foreign, 'the live lock was not stolen');
  // release must not cut somebody else's critical section either
  assert.equal(releaseProfileLock(u), false, 'foreign live lock refused release');
  assert.deepEqual(readLock(u), foreign);
  fs.unlinkSync(lockFile(u));
});

test('conflict: a second acquirer in the SAME process also fails (no accidental self-renew)', async () => {
  const u = 'lock-self-conflict';
  await acquireProfileLock(u, { ttlMs: 60_000, reason: 'first' });
  try {
    await assert.rejects(() => acquireProfileLock(u, { timeoutMs: 200 }), err => err.code === 'PROFILE_LOCKED');
    assert.equal(readLock(u).reason, 'first', 'the existing record is untouched');
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
});

test('stale-TTL reclaim: an expired lock never blocks — reclaimer takes it over immediately', async () => {
  const u = 'lock-ttl';
  const first = await acquireProfileLock(u, { ttlMs: 60, reason: 'short-lived' });
  await sleep(120); // past expiresAt, holder pid still alive
  assert.equal(isProfileLocked(u), false, 'expired → not held');
  const t0 = Date.now();
  const second = await acquireProfileLock(u, { ttlMs: 60_000, reason: 'next' });
  try {
    assert.ok(Date.now() - t0 < 2000, 'reclaim is immediate, no full timeout wait');
    assert.equal(second.pid, process.pid);
    assert.ok(second.expiresAt > first.expiresAt);
    assert.equal(readLock(u).reason, 'next');
    assert.ok(isProfileLocked(u));
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
});

test('stale-pid reclaim: a crashed holder (dead pid) is reclaimable before the TTL', async () => {
  const u = 'lock-dead-pid';
  const dead = spawnSync(process.execPath, ['-e', '']).pid; // spawned + reaped → gone
  assert.throws(() => process.kill(dead, 0), err => err.code === 'ESRCH', 'the fixture pid is really dead');
  fs.mkdirSync(path.dirname(lockFile(u)), { recursive: true });
  fs.writeFileSync(lockFile(u), JSON.stringify({ pid: dead, acquiredAt: Date.now(), expiresAt: Date.now() + DEFAULT_TTL_MS, reason: 'crashed' }), { mode: 0o600 });
  assert.equal(isProfileLocked(u), false, 'dead holder → stale, not held');
  const rec = await acquireProfileLock(u, { ttlMs: 60_000, reason: 'takeover' });
  try {
    assert.equal(rec.pid, process.pid);
    assert.equal(readLock(u).reason, 'takeover');
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
});

test('renew: the TTL is renewable by the holder (long migration never expires under itself)', async () => {
  const u = 'lock-renew';
  const first = await acquireProfileLock(u, { ttlMs: 60_000, reason: 'migrate' });
  const renewed = await acquireProfileLock(u, { renew: true, ttlMs: 120_000 });
  assert.ok(renewed.expiresAt > first.expiresAt, 'expiry pushed forward');
  assert.equal(renewed.reason, 'migrate', 'reason kept across a renewal');
  // renewal also works after the TTL lapsed: ours expired → reclaim + re-acquire
  const short = await acquireProfileLock('lock-renew-lapsed', { ttlMs: 50 });
  assert.equal(short.pid, process.pid);
  await sleep(100);
  const back = await acquireProfileLock('lock-renew-lapsed', { renew: true, ttlMs: 60_000 });
  assert.ok(isProfileLocked('lock-renew-lapsed'));
  assert.equal(back.pid, process.pid);
  releaseProfileLock(u);
  releaseProfileLock('lock-renew-lapsed');
});

test('release: idempotent for us, false when nothing was held', async () => {
  const u = 'lock-release';
  await acquireProfileLock(u, { ttlMs: 60_000 });
  assert.equal(releaseProfileLock(u), true);
  assert.equal(releaseProfileLock(u), false, 'second release finds no file');
  assert.equal(isProfileLocked(u), false);
});

test('invalid usernames: never lock, never throw on the read side', async () => {
  await assert.rejects(() => acquireProfileLock('../etc', { timeoutMs: 10 }), TypeError);
  await assert.rejects(() => acquireProfileLock('', { timeoutMs: 10 }), TypeError);
  for (const bad of ['../etc', '', 'a/b', 'a b', null, undefined, 7]) {
    assert.equal(isProfileLocked(bad), false, `isProfileLocked(${JSON.stringify(bad)}) → false`);
  }
  assert.deepEqual(await waitForProfileUnlocked('../etc'), { waited: false, waitedMs: 0 });
});

// ── The admission wait (G2): what the runner parks on before it journals ──────
test('admission wait: blocked while held, proceeds after release (and onWait fires once)', async () => {
  const u = 'lock-wait-release';
  await acquireProfileLock(u, { ttlMs: 60_000, reason: 'migrate' });
  let onWaitCalls = 0;
  const waiting = waitForProfileUnlocked(u, { pollMs: 20, onWait: rec => { onWaitCalls++; assert.equal(rec.reason, 'migrate'); } });
  const outcome = await Promise.race([waiting.then(() => 'released'), sleep(200).then(() => 'still-waiting')]);
  assert.equal(outcome, 'still-waiting', 'the run does not start while the profile is locked');
  assert.equal(onWaitCalls, 1, 'the chat is told exactly once');
  assert.ok(releaseProfileLock(u));
  const res = await waiting;
  assert.equal(res.waited, true, 'reported that it actually waited');
  assert.ok(res.waitedMs >= 200);
  assert.equal(onWaitCalls, 1, 'no repeat announcement');
});

test('admission wait: if the lock goes stale while waiting (holder crashed / TTL), the run proceeds', async () => {
  const u = 'lock-wait-stale';
  await acquireProfileLock(u, { ttlMs: 150, reason: 'about-to-die' });
  const res = await waitForProfileUnlocked(u, { pollMs: 30 }); // nobody releases it
  assert.equal(res.waited, true, 'it did wait');
  assert.equal(isProfileLocked(u), false, 'expired holder no longer holds anything');
  // dead-pid variant: the holder vanishes mid-wait
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(path.dirname(lockFile(u)), { recursive: true });
  fs.writeFileSync(lockFile(u), JSON.stringify({ pid: dead, acquiredAt: Date.now(), expiresAt: Date.now() + DEFAULT_TTL_MS, reason: 'crashed' }), { mode: 0o600 });
  const res2 = await waitForProfileUnlocked(u, { pollMs: 30 });
  assert.equal(res2.waited, false, 'already stale on the first read → never waits');
});

test('admission wait: an explicit timeout rejects instead of hanging forever', async () => {
  const u = 'lock-wait-timeout';
  await acquireProfileLock(u, { ttlMs: 60_000, reason: 'long-migration' });
  try {
    await assert.rejects(() => waitForProfileUnlocked(u, { timeoutMs: 150, pollMs: 30 }), /still under a maintenance lock after 150ms/);
    assert.ok(isProfileLocked(u), 'the holder is untouched by a give-up waiter');
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
});

test('admission wait: an unlocked profile resolves immediately without waiting', async () => {
  const res = await waitForProfileUnlocked('lock-wait-free');
  assert.equal(res.waited, false);
  assert.equal(res.waitedMs, 0);
});

// The module header promises this: a file a reader cannot trust never WEDGES a
// profile — fresh → held (better to wait than to start a run under the
// migrator's feet), older than the TTL → reclaimable.
test('unreadable or fieldless lock content: held while fresh, reclaimable by mtime', async () => {
  const u = 'lock-corrupt';
  fs.mkdirSync(path.dirname(lockFile(u)), { recursive: true });
  fs.writeFileSync(lockFile(u), '{"pid": 123,', { mode: 0o600 }); // half-written
  assert.equal(isProfileLocked(u), true, 'fresh but unparseable → treated as HELD');
  await assert.rejects(() => acquireProfileLock(u, { timeoutMs: 200 }), err => err.code === 'PROFILE_LOCKED');
  const old = new Date(Date.now() - DEFAULT_TTL_MS - 5000);
  fs.utimesSync(lockFile(u), old, old);
  assert.equal(isProfileLocked(u), false, 'older than the TTL → no longer held');
  const rec = await acquireProfileLock(u, { ttlMs: 60_000, reason: 'takeover' });
  try {
    assert.equal(rec.pid, process.pid, 'reclaimed after the TTL');
    // parseable but unverifiable ({ no pid, no expiry }) gets the same fallback
    fs.writeFileSync(lockFile(u), '{}', { mode: 0o600 });
    assert.equal(isProfileLocked(u), true, 'fresh unverifiable record still counts as held');
    fs.utimesSync(lockFile(u), old, old);
    assert.equal(isProfileLocked(u), false, 'no pid and no expiry → TTL by mtime, never a permanent wedge');
  } finally {
    assert.equal(releaseProfileLock(u), true);
  }
});
