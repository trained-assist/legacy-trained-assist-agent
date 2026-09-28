'use strict';
// Per-profile MAINTENANCE lock (epic #1784, safety precondition G1) — lets a
// SEPARATE process (the profile migrator, a systemd job) quiesce one profile
// while this server keeps running tasks for every OTHER profile.
//
// Why a file and not an admission scope (src/core/admission.js): scopes are
// process-local — exactly one execution-owner process owns agent-data — while
// the migrator never runs inside this process and can only share state through
// the filesystem. The lock therefore lives under SYSTEM_ROOT (agent-locks/),
// which both processes resolve through src/data-paths.js.
//
// API
//   acquireProfileLock(u, {timeoutMs, ttlMs, reason, renew})  EXCLUSIVE. Creates
//     the lock file with O_EXCL (never truncates a live holder). A live holder
//     makes the caller wait and, after timeoutMs (default 30s, epic: fail fast),
//     THROW `code: 'PROFILE_LOCKED'` — it never steals a live lock. `renew: true`
//     refreshes a lock this SAME process already holds: the TTL (default 10 min)
//     is renewable, so a long migration never expires under its own feet.
//   releaseProfileLock(u)  Drops OUR lock. Refuses (returns false) to cut a live
//     lock owned by another process — e.g. our TTL expired mid-work and someone
//     else legitimately reclaimed it.
//   isProfileLocked(u)  A live (non-stale) holder exists. A stale lock never
//     counts as held.
//   waitForProfileUnlocked(u, {timeoutMs, pollMs, onWait})  The admission-side
//     wait used by the runner: a new run parks here while the profile is under
//     maintenance, logging once (then every 15s) and calling onWait so the chat
//     can show a status. The holder going STALE while we wait (crashed migrator
//     or TTL expiry) ENDS the wait — the run proceeds, so a wedged lock can
//     never block a profile forever.
//
// Stale ⇔ holder pid is dead OR expiresAt has passed. A crashed holder wedges
// its profile for at most the TTL (immediately if the pid is gone), which is the
// whole point of the TTL: no lock file may ever outlive its owner.
//
// Read/write races: the file is created with O_EXCL, so it is either absent or
// ours; a reader that sees content it cannot parse treats it as HELD while the
// file is fresh (the safe direction — better to wait than to start a run under
// the migrator's feet) and reclaimable once it is older than the TTL. Reclaim
// renames the stale file away first: of two concurrent reclaimers only one can
// rename, so the loser always re-reads instead of deleting the winner's fresh
// lock.
const fs = require('fs');
const path = require('path');
const { profileLockPath } = require('./data-paths');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const POLL_MS = 200;
const RELOG_MS = 15_000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A username that cannot be a lock filename cannot be locked either — callers
// get "not locked" instead of a throw (the runner must never fail a task
// because a profile name looked odd).
function isProfileName(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // alive, just another user's
}

function isStale(record, now = Date.now()) {
  if (Number.isFinite(record.expiresAt) && record.expiresAt <= now) return true;
  if (Number.isInteger(record.pid)) return !pidAlive(record.pid);
  return false;
}

// { exists, record, stale }. record === null with exists === true means the
// content could not be parsed (partial foreign write): fresh → held, older than
// the TTL → reclaimable.
function readLock(username) {
  const empty = { exists: false, record: null, stale: false };
  if (!isProfileName(username)) return empty;
  const file = profileLockPath(username);
  let stat;
  try { stat = fs.statSync(file); } catch { return empty; }
  let record = null;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { record = null; }
  if (!record || typeof record !== 'object') {
    return { exists: true, record: null, stale: Date.now() - stat.mtimeMs > DEFAULT_TTL_MS };
  }
  return { exists: true, record, stale: isStale(record) };
}

function isProfileLocked(username) {
  const state = readLock(username);
  return state.exists && !state.stale;
}

function lockRecord({ ttlMs, reason }) {
  const now = Date.now();
  return { pid: process.pid, acquiredAt: now, expiresAt: now + ttlMs, reason: reason || null };
}

function writeLock(username, record) {
  fs.writeFileSync(profileLockPath(username), JSON.stringify(record, null, 2), { mode: 0o600 });
}

// Atomic exclusive create: O_EXCL → either the file is absent or somebody else
// won the race. The content lands in the same single write, so a reader never
// observes our own half-written JSON as a valid lock.
function createExclusive(username, record) {
  try {
    fs.writeFileSync(profileLockPath(username), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function reclaimStale(username) {
  const file = profileLockPath(username);
  const trash = `${file}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // rename, not unlink: unlink would also succeed against a FRESH lock another
  // reclaimer just created in the gap between our read and our delete. rename is
  // atomic — of two reclaimers exactly one removes the file; the other gets
  // ENOENT, re-reads and finds the winner's fresh lock.
  try { fs.renameSync(file, trash); } catch { return false; }
  try { fs.unlinkSync(trash); } catch { /* best-effort trash cleanup */ }
  console.log('[profile-lock] reclaimed stale lock profile=%s', username);
  return true;
}

async function acquireProfileLock(username, { timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS, ttlMs = DEFAULT_TTL_MS, reason = null, renew = false } = {}) {
  if (!isProfileName(username)) throw new TypeError(`invalid profile username: ${JSON.stringify(username)}`);
  const file = profileLockPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const state = readLock(username);
    if (!state.exists) {
      const record = lockRecord({ ttlMs, reason });
      if (createExclusive(username, record)) {
        console.log('[profile-lock] acquired profile=%s pid=%s ttlMs=%d reason=%s', username, record.pid, ttlMs, reason || '-');
        return record;
      }
      continue; // lost the race — re-read immediately
    }
    const ours = state.record && state.record.pid === process.pid;
    if (renew && ours) {
      const record = lockRecord({ ttlMs, reason: state.record.reason ?? reason });
      writeLock(username, record);
      console.log('[profile-lock] renewed profile=%s pid=%s expiresAt=%s', username, record.pid, new Date(record.expiresAt).toISOString());
      return record;
    }
    if (state.stale) {
      // Ours but expired (renew was not requested) or a dead/foreign holder —
      // either way nobody live holds it.
      if (!reclaimStale(username)) await sleep(POLL_MS); // rename lost/failed: back off, never hot-spin
      continue;
    }
    if (Date.now() >= deadline) {
      const holder = readLock(username).record || {};
      const err = new Error(
        `profile "${username}" is locked`
        + (holder.pid ? ` by pid ${holder.pid}` : '')
        + (holder.reason ? ` (${holder.reason})` : '')
        + ` — gave up after ${timeoutMs}ms`,
      );
      err.code = 'PROFILE_LOCKED';
      err.holder = holder;
      throw err;
    }
    await sleep(POLL_MS);
  }
}

function releaseProfileLock(username) {
  if (!isProfileName(username)) return false;
  const state = readLock(username);
  if (!state.exists) return false;
  const record = state.record;
  // Refuse to cut somebody else's LIVE critical section: our TTL expired while
  // we worked and a second migrator legitimately reclaimed the lock. A lock with
  // no readable pid is unowned garbage — clear it.
  const foreignLive = record && Number.isInteger(record.pid) && record.pid !== process.pid && !state.stale;
  if (foreignLive) {
    console.log('[profile-lock] release refused profile=%s holder_pid=%s', username, record.pid);
    return false;
  }
  try { fs.unlinkSync(profileLockPath(username)); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  console.log('[profile-lock] released profile=%s', username);
  return true;
}

async function waitForProfileUnlocked(username, { timeoutMs = null, pollMs = POLL_MS, onWait = null } = {}) {
  if (!isProfileName(username)) return { waited: false, waitedMs: 0 };
  const startedAt = Date.now();
  let announced = false;
  let lastLog = 0;
  for (;;) {
    const state = readLock(username);
    if (!state.exists || state.stale) {
      // Released, or the holder went stale while we waited (crashed migrator /
      // TTL expiry) — either way the profile is free and the run proceeds.
      if (announced) console.log('[profile-lock] profile=%s lock gone after %dms — proceeding', username, Date.now() - startedAt);
      return { waited: announced, waitedMs: Date.now() - startedAt };
    }
    const now = Date.now();
    if (!announced) {
      announced = true;
      lastLog = now;
      const holder = state.record || {};
      console.log(
        '[profile-lock] profile=%s under maintenance lock (pid=%s reason=%s expiresAt=%s) — waiting before start',
        username, holder.pid ?? '?', holder.reason ?? '-',
        Number.isFinite(holder.expiresAt) ? new Date(holder.expiresAt).toISOString() : '-',
      );
      if (onWait) {
        try { onWait(state.record); } catch (e) { console.warn('[profile-lock] onWait hook failed:', e.message); }
      }
    } else if (now - lastLog >= RELOG_MS) {
      lastLog = now;
      console.log('[profile-lock] profile=%s still under maintenance lock — waiting %dms', username, now - startedAt);
    }
    if (timeoutMs != null && now - startedAt >= timeoutMs) {
      throw new Error(`profile "${username}" is still under a maintenance lock after ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

module.exports = {
  acquireProfileLock,
  releaseProfileLock,
  isProfileLocked,
  waitForProfileUnlocked,
  DEFAULT_TTL_MS,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
};
