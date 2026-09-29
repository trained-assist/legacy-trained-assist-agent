#!/usr/bin/env node
'use strict';
// ledger.cjs — append-only migration ledger (epic #1784 «Ledger и откат»).
//
// File: SYSTEM_ROOT/migration/<profile>/migration-ledger.jsonl — resolved
// through src/data-paths.js, never hardcoded (identity ≠ location: the ledger
// stores profile-relative paths and derives every root at read time).
//
// Record — exactly the eight fields the epic names:
//   { ts, phase, profile, path, sha256, size, action, dest }
//   ts      ISO-8601 UTC (ms precision) — when the action happened
//   phase   phase-module name (delete, archive, move, dedup, …) — a PURGE record
//           keeps the phase of the record it destroys so the fold stays coherent
//   profile profile name (redundant with the file location; the epic asks for it)
//   path    profile-relative POSIX path — NEVER absolute
//   sha256  content hash; for a symlink the hash of its target string
//   size    bytes (lstat size; for a symlink = length of the target string)
//   action  DELETE | DELETE_FAILED | RESTORED | PURGE (free-form, see recordState)
//   dest    where the file went: quarantine-relative path, kept even on RESTORED
//           (a duplicate may survive there until a manual purge), null only when
//           there is nowhere to look
//
// Crash safety (append with fsync + torn-line tolerance):
//   * an append is ONE O_APPEND write of a whole line followed by fsync of the
//     file (and a best-effort fsync of the directory) — a record is either
//     fully on disk or not there at all;
//   * a process killed mid-write can leave a TORN LAST LINE. readLedger() skips
//     it (and any other unparseable line) instead of throwing, so a torn tail
//     never breaks reads;
//   * the next append reads the last byte: a missing trailing newline is repaired
//     first, so a torn tail can never merge with the record that follows it.
//
// Ordering contract (red-team #1808 Q1, «flush → snapshot»): the runner appends
// the record BEFORE it moves the file. The failure mode of that order is the
// safe one — a record without the move leaves the file intact at its original
// path (verify reports it as `missing-dest`), while move-first would leave an
// unreferenced copy in quarantine that revert could never find.
//
// Fold semantics (used by runner --verify / --revert): the last record for a
// given (phase, path) wins, and its state is derived from the action alone:
//   at-dest   ← the file lives in quarantine (DELETE, MOVE, ARCHIVE, …)
//   returned  ← the file is (back) in the profile (RESTORED, *_FAILED)
//   purged    ← the quarantine copy was destroyed (PURGE); the profile copy is
//               not touched by a purge and may exist or not
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SYSTEM_ROOT } = require('../../src/data-paths');

const LEDGER_FILE = 'migration-ledger.jsonl';
const PROFILE_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PHASE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REQUIRED_FIELDS = ['ts', 'phase', 'profile', 'path', 'sha256', 'size', 'action', 'dest'];
const READ_CHUNK = 1 << 20;

function assertProfileName(name) {
  if (typeof name !== 'string' || !PROFILE_RE.test(name)) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)} (expected ${PROFILE_RE})`);
  }
  return name;
}

// A durable record must be re-resolvable from the profile root alone: relative,
// no absolute paths, no ".." of any kind (also blocks "\\"-separated tricks).
function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || path.isAbsolute(p)) return false;
  const segs = p.split(/[\\/]+/);
  return segs.some(s => s !== '' && s !== '.') && segs.every(s => s !== '..');
}

function assertRelPath(p, field = 'path') {
  if (!isSafeRelPath(p)) throw new Error(`ledger ${field} must be a safe relative path, got ${JSON.stringify(p)}`);
  return p;
}

// SYSTEM_ROOT/migration/<profile>/ — the per-profile migration state directory.
function migrationDir(profile) {
  return path.join(SYSTEM_ROOT, 'migration', assertProfileName(profile));
}

function ledgerPath(profile) {
  return path.join(migrationDir(profile), LEDGER_FILE);
}

function makeRecord(fields) {
  return {
    ts: new Date().toISOString(),
    phase: fields.phase,
    profile: fields.profile,
    path: fields.path,
    sha256: fields.sha256 ?? null,
    size: fields.size ?? 0,
    action: fields.action,
    dest: fields.dest ?? null,
  };
}

function validateRecord(rec, expectedProfile) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('ledger record must be a JSON object');
  for (const f of REQUIRED_FIELDS) {
    if (!Object.hasOwn(rec, f)) throw new Error(`ledger record missing required field "${f}": ${JSON.stringify(rec)}`);
  }
  if (typeof rec.ts !== 'string' || !Number.isFinite(Date.parse(rec.ts))) throw new Error(`ledger record has an invalid ts: ${JSON.stringify(rec.ts)}`);
  if (typeof rec.phase !== 'string' || !PHASE_RE.test(rec.phase)) throw new Error(`ledger record has an invalid phase: ${JSON.stringify(rec.phase)}`);
  if (typeof rec.profile !== 'string' || !PROFILE_RE.test(rec.profile)) throw new Error(`ledger record has an invalid profile: ${JSON.stringify(rec.profile)}`);
  if (expectedProfile !== undefined && rec.profile !== expectedProfile) {
    throw new Error(`ledger record profile ${JSON.stringify(rec.profile)} does not match ${JSON.stringify(expectedProfile)}`);
  }
  assertRelPath(rec.path);
  if (rec.sha256 !== null && (typeof rec.sha256 !== 'string' || !SHA_RE.test(rec.sha256))) {
    throw new Error(`ledger record has an invalid sha256: ${JSON.stringify(rec.sha256)}`);
  }
  if (!Number.isInteger(rec.size) || rec.size < 0) throw new Error(`ledger record has an invalid size: ${JSON.stringify(rec.size)}`);
  if (typeof rec.action !== 'string' || !rec.action.trim()) throw new Error(`ledger record has an invalid action: ${JSON.stringify(rec.action)}`);
  if (rec.dest !== null) assertRelPath(rec.dest, 'dest');
  return rec;
}

// Best effort: fsync of the directory makes the FILE creation itself durable on
// the filesystems that support it. A failure is not fatal — the line inside the
// file is already fsynced, which is what protects the record.
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* not supported on every OS/filesystem (e.g. macOS dirs) */ }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function appendRecord(profile, record) {
  assertProfileName(profile);
  validateRecord(record, profile);
  const file = ledgerPath(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(record)}\n`;

  // Repair a torn tail BEFORE it can merge with this record. Read it through a
  // separate read-only fd: pread() on an O_APPEND fd is EBADF on macOS (and
  // undefined by POSIX), so the append fd itself must never be read from.
  let prefix = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const rfd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        const n = fs.readSync(rfd, last, 0, 1, st.size - 1);
        if (n === 1 && last[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(rfd);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, prefix + line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(path.dirname(file));
  return record;
}

// Tolerant read: every unparseable line is skipped and counted, so a torn last
// line (or a repaired tail from an earlier crash) never breaks parsing of the
// records around it. `missing: true` = no ledger yet (never throws ENOENT —
// reading an untouched profile is a normal dry-run/verify case and must not
// create the directory).
function readLedger(profile) {
  assertProfileName(profile);
  const file = ledgerPath(profile);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { file, records: [], skipped: 0, missing: true };
    throw e;
  }
  const records = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
      else skipped++;
    } catch { skipped++; }
  }
  return { file, records, skipped, missing: false };
}

// Where the quarantined copy of a path is after one record (see header).
function recordState(action) {
  if (action === 'PURGE') return 'purged';
  if (action === 'RESTORED' || /_FAILED$/.test(action)) return 'returned';
  return 'at-dest';
}

// ── content hashing ──────────────────────────────────────────────────────────
function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256String(s) {
  return sha256Buffer(Buffer.from(String(s), 'utf8'));
}

// Chunked, synchronous read — profiles contain multi-GB trees, so nothing is
// ever loaded whole into memory.
function sha256File(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

// Identity of a path for the ledger. A symlink is hashed by its TARGET STRING,
// not by what it points at: the link itself is what quarantine moves, its
// target may live outside the profile (or be dangling), and hashing the target
// would make the record depend on content we never intend to migrate.
function hashPath(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return { sha256: sha256String(fs.readlinkSync(abs)), size: st.size, isSymlink: true };
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
  return { sha256: sha256File(abs), size: st.size, isSymlink: false };
}

module.exports = {
  LEDGER_FILE,
  PROFILE_RE,
  REQUIRED_FIELDS,
  assertProfileName,
  assertRelPath,
  isSafeRelPath,
  migrationDir,
  ledgerPath,
  makeRecord,
  validateRecord,
  appendRecord,
  readLedger,
  recordState,
  sha256Buffer,
  sha256String,
  sha256File,
  hashPath,
};

if (require.main === module) {
  // Diagnostics only: `node ledger.cjs <profile>` prints the ledger path and a
  // line count. Mutating commands live in quarantine.cjs / runner.cjs / cli.mjs.
  try {
    const profile = process.argv[2];
    if (!profile) throw new Error('usage: node ledger.cjs <profile>');
    const out = readLedger(profile);
    process.stdout.write(`${out.file}\nrecords=${out.records.length} skipped=${out.skipped} missing=${out.missing}\n`);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 1;
  }
}
