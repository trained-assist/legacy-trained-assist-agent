#!/usr/bin/env node
'use strict';
// quarantine.cjs — DELETE-class files are MOVED here, never unlinked
// (epic #1784 «Ledger и откат», principle 1; red-team #1808 Q1: an irreversible
// delete happens only after a grace period and a separate confirmation).
//
// Layout: SYSTEM_ROOT/migration/quarantine/<profile>/<profile-relative path>
// Mirroring the profile-relative path makes every quarantined file unique (no
// naming scheme to reverse-engineer) and makes revert a pure path restore. The
// quarantine root is derived through src/data-paths.js — never hardcoded.
//
// Purging is a SEPARATE, MANUAL command — no cron, no auto-purge, and the
// runner never calls it:
//   node scripts/profile-migrate/quarantine.cjs purge --profile <name> [--older-than-days 7] [--confirm]
// Without --confirm it only reports what would go. A copy is destroyed only if
//   (a) its ledger record is older than the grace period, and
//   (b) its sha256 still matches that record — data we cannot verify is never
//       destroyed. Each destruction appends a PURGE record (append-only audit).
//
// Everything here is byte-exact: move = rename on the same filesystem, or
// copy + fsync + sha256-verify + unlink across filesystems (EXDEV), and restore
// verifies the sha256 of both the quarantine copy and the restored copy.
const fs = require('fs');
const path = require('path');
const { SYSTEM_ROOT } = require('../../src/data-paths');
const {
  readLedger, appendRecord, makeRecord, hashPath, sha256String, assertProfileName, isSafeRelPath,
} = require('./ledger.cjs');

const DEFAULT_GRACE_DAYS = 7;

function quarantineRoot(profile) {
  return path.join(SYSTEM_ROOT, 'migration', 'quarantine', assertProfileName(profile));
}

function quarantinePath(profile, rel) {
  if (!isSafeRelPath(rel)) throw new Error(`unsafe quarantine path: ${JSON.stringify(rel)}`);
  return path.join(quarantineRoot(profile), ...rel.split('/'));
}

// Reserve a destination that does not exist yet (a previous apply that was only
// half reverted, or the same path re-applied). Suffixing keeps the original
// relative path readable and the ledger's `dest` authoritative for revert.
function reserveDest(profile, rel) {
  if (!isSafeRelPath(rel)) throw new Error(`unsafe quarantine destination: ${JSON.stringify(rel)}`);
  let dest = rel;
  for (let i = 1; fs.existsSync(quarantinePath(profile, dest)); i++) {
    if (i > 10_000) throw new Error(`cannot reserve a quarantine destination for ${rel} after 10000 collisions`);
    dest = `${rel}~${i}`;
  }
  return dest;
}

function fsyncPath(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    fs.fsyncSync(fd);
  } catch { /* best effort */ }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Cross-device fallback for rename(2). Order matters: copy → chmod → fsync →
// verify sha256 → ONLY THEN unlink the source, so a failed copy can never cost
// the original.
function copyThenUnlink(src, dest, expectedSha) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest);
  } else {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, st.mode & 0o777);
    fsyncPath(dest);
  }
  if (expectedSha) {
    const got = hashPath(dest);
    if (got.sha256 !== expectedSha) {
      try { fs.unlinkSync(dest); } catch { /* leave it for inspection */ }
      throw new Error(`cross-device copy failed the sha256 check: ${dest}`);
    }
  }
  fs.unlinkSync(src);
}

// Move absPath → SYSTEM_ROOT/migration/quarantine/<profile>/<destRel>.
// Never unlinks without a verified destination copy (EXDEV) and never follows
// a symlink — the link itself is the object being quarantined.
function moveInto(profile, absPath, destRel, expectedSha) {
  const dest = quarantinePath(profile, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(absPath, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyThenUnlink(absPath, dest, expectedSha);
  }
  if (expectedSha) {
    const got = hashPath(dest);
    if (got.sha256 !== expectedSha) throw new Error(`quarantine copy sha256 mismatch after move: ${destRel}`);
  }
  return dest;
}

// Restore quarantine/<destRel> → targetAbs, verifying the sha256 before AND
// after the move (byte-exact, epic acceptance «revert возвращает файлы
// байт-в-байт»). The caller has already decided the target is absent.
function restoreFromQuarantine(profile, destRel, targetAbs, expectedSha) {
  const src = quarantinePath(profile, destRel);
  let st;
  try { st = fs.lstatSync(src); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`quarantine copy missing: ${destRel}`);
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    if (expectedSha !== undefined && sha256String(target) !== expectedSha) {
      throw new Error(`quarantine symlink target sha256 mismatch: ${destRel}`);
    }
  } else if (expectedSha !== undefined && hashPath(src).sha256 !== expectedSha) {
    throw new Error(`quarantine copy sha256 mismatch, refusing to restore: ${destRel}`);
  }
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  try {
    fs.renameSync(src, targetAbs);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyThenUnlink(src, targetAbs, expectedSha);
  }
  if (expectedSha !== undefined) {
    const got = hashPath(targetAbs);
    if (got.sha256 !== expectedSha) throw new Error(`restored file sha256 mismatch: ${targetAbs}`);
  }
  // Keep the quarantine tree tidy: drop the directories this restore emptied.
  const rel = path.relative(quarantineRoot(profile), src);
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  if (parent) pruneEmptyDirs(quarantineRoot(profile), parent);
  return targetAbs;
}

// Remove `startRel` and then its ancestors, climbing while they are empty.
// `eligible` decides whether a given relative directory may be removed at all —
// on the profile side that is "classified DELETE" (epic principle 2: an UNKNOWN
// directory, even an emptied one, stays). The root itself is never removed.
function pruneEmptyDirs(rootAbs, startRel, eligible = () => true) {
  let rel = startRel;
  let removed = 0;
  while (rel && rel !== '.') {
    if (!eligible(rel)) break;
    try {
      fs.rmdirSync(path.join(rootAbs, ...rel.split('/')));
      removed++;
    } catch {
      break; // not empty / already gone / not permitted — stop climbing
    }
    rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  }
  return removed;
}

function walkFiles(absDir, onFile) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) walkFiles(abs, onFile);
    else onFile(abs);
  }
}

// ── purge (manual, separate, never automatic) ─────────────────────────────────
// Returns { wouldPurge, purged, skipped, scanned } — with `confirm` the copies
// in `purged` are unlinked and a PURGE record is appended for each.
function purge(profile, { olderThanDays = DEFAULT_GRACE_DAYS, confirm = false } = {}) {
  assertProfileName(profile);
  const root = quarantineRoot(profile);
  const { records, skipped: badLines } = readLedger(profile);
  const cutoff = Date.now() - Math.max(0, Number(olderThanDays)) * 86_400_000;

  // Latest record per destination decides the copy's state, content hash and
  // age (the record that put it there, or a later RESTORED/PURGE for the same
  // dest). First-wins would purge a freshly re-quarantined file by the age of
  // the previous generation.
  const byDest = new Map();
  for (const r of records) {
    if (r && typeof r.dest === 'string' && r.dest) byDest.set(r.dest, r);
  }

  const out = {
    profile, olderThanDays, confirm, cutoff,
    scanned: 0, wouldPurge: [], purged: [], skipped: [], skippedLines: badLines,
  };

  const present = [];
  walkFiles(root, abs => { out.scanned++; present.push(abs); });

  for (const abs of present) {
    const dest = path.relative(root, abs).split(path.sep).join('/');
    const rec = byDest.get(dest);
    const entry = { dest, path: rec && typeof rec.path === 'string' ? rec.path : null };

    if (!rec) {
      out.skipped.push({ ...entry, reason: 'no ledger record for this quarantine copy — never destroyed automatically' });
      continue;
    }
    entry.path = rec.path;
    entry.sha256 = rec.sha256;
    const ts = Date.parse(rec.ts);
    if (!Number.isFinite(ts)) {
      out.skipped.push({ ...entry, reason: `unreadable ts in ledger record: ${JSON.stringify(rec.ts)}` });
      continue;
    }
    if (ts > cutoff) {
      out.skipped.push({ ...entry, reason: `within the ${olderThanDays}-day grace period (quarantined ${rec.ts})` });
      continue;
    }
    let got;
    try { got = hashPath(abs); } catch (e) {
      out.skipped.push({ ...entry, reason: `cannot read quarantine copy: ${e.message}` });
      continue;
    }
    if (rec.sha256 && got.sha256 !== rec.sha256) {
      out.skipped.push({ ...entry, reason: `sha256 mismatch vs ledger (${got.sha256} ≠ ${rec.sha256}) — refusing to destroy` });
      continue;
    }
    if (!confirm) {
      out.wouldPurge.push({ ...entry, size: got.size, quarantinedAt: rec.ts });
      continue;
    }
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      out.skipped.push({ ...entry, reason: `unlink failed: ${e.message}` });
      continue;
    }
    appendRecord(profile, makeRecord({
      phase: rec.phase, profile, path: rec.path, sha256: got.sha256, size: got.size, action: 'PURGE', dest,
    }));
    out.purged.push({ ...entry, size: got.size, quarantinedAt: rec.ts });
  }

  if (confirm && out.purged.length) {
    // Tidy the directories the purge emptied (everything under the quarantine
    // root is ours — no eligibility filter needed).
    const dirs = [];
    const walk = (d) => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) if (e.isDirectory()) { dirs.push(path.relative(root, path.join(d, e.name))); walk(path.join(d, e.name)); }
    };
    walk(root);
    dirs.sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of dirs) pruneEmptyDirs(root, rel);
  }

  return out;
}

function listQuarantine(profile) {
  assertProfileName(profile);
  const root = quarantineRoot(profile);
  const out = { profile, root, files: [], bytes: 0, unrecorded: 0 };
  const { records } = readLedger(profile);
  const known = new Set(records.filter(r => r && typeof r.dest === 'string' && r.dest).map(r => r.dest));
  walkFiles(root, abs => {
    const dest = path.relative(root, abs).split(path.sep).join('/');
    let size = 0;
    try { size = fs.lstatSync(abs).size; } catch { /* ignore */ }
    out.bytes += size;
    if (!known.has(dest)) out.unrecorded++;
    out.files.push({ dest, size, recorded: known.has(dest) });
  });
  out.files.sort((a, b) => a.dest.localeCompare(b.dest));
  return out;
}

// ── CLI (the purge is deliberately its own entry point) ───────────────────────
function usage() {
  return [
    'Usage:',
    '  node scripts/profile-migrate/quarantine.cjs purge --profile <name> [--older-than-days <n>] [--confirm] [--json]',
    '  node scripts/profile-migrate/quarantine.cjs list  --profile <name> [--json]',
    '',
    'purge — destroy quarantined copies whose ledger record is older than the',
    '        grace period (default 7 days) and whose sha256 still matches.',
    '        Without --confirm nothing is destroyed (report only).',
    '        MANUAL ONLY: never scheduled, never called by the phase runner.',
    'list  — show what is in quarantine right now.',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = { command: null, profile: null, olderThanDays: DEFAULT_GRACE_DAYS, confirm: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (!opts.command && !a.startsWith('-')) { opts.command = a; continue; }
    switch (a) {
      case '--profile': opts.profile = next(); break;
      case '--older-than-days': opts.olderThanDays = Number(next()); break;
      case '--confirm': opts.confirm = true; break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays < 0) throw new Error('--older-than-days must be a non-negative number');
  return opts;
}

function main(argv) {
  let opts;
  try { opts = parseArgv(argv); } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${usage()}\n`);
    return 1;
  }
  if (opts.help || !opts.command) {
    process.stdout.write(`${usage()}\n`);
    return opts.help ? 0 : 1;
  }
  if (!opts.profile) {
    process.stderr.write(`error: --profile <name> is required\n\n${usage()}\n`);
    return 1;
  }

  let out;
  try {
    if (opts.command === 'purge') out = purge(opts.profile, { olderThanDays: opts.olderThanDays, confirm: opts.confirm });
    else if (opts.command === 'list') out = listQuarantine(opts.profile);
    else {
      process.stderr.write(`error: unknown command "${opts.command}"\n\n${usage()}\n`);
      return 1;
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (opts.command === 'list') {
    process.stdout.write(`quarantine ${out.profile}: ${out.files.length} file(s), ${out.bytes} bytes${out.unrecorded ? `, ${out.unrecorded} unrecorded` : ''}\n`);
    for (const f of out.files.slice(0, 50)) process.stdout.write(`  ${f.recorded ? ' ' : '?'} ${f.dest} (${f.size} B)\n`);
    if (out.files.length > 50) process.stdout.write(`  … ${out.files.length - 50} more\n`);
  } else {
    const verb = opts.confirm ? 'purged' : 'would purge';
    process.stdout.write(`quarantine ${out.profile}: ${verb} ${opts.confirm ? out.purged.length : out.wouldPurge.length} file(s) · ${out.skipped.length} skipped · scanned ${out.scanned}\n`);
    for (const e of (opts.confirm ? out.purged : out.wouldPurge).slice(0, 20)) {
      process.stdout.write(`  ${opts.confirm ? '' : '~ '}${e.dest} (${e.size} B, quarantined ${e.quarantinedAt})\n`);
    }
    for (const s of out.skipped.slice(0, 20)) process.stdout.write(`  ! ${s.dest}: ${s.reason}\n`);
    if (!opts.confirm && out.wouldPurge.length) {
      process.stdout.write('re-run with --confirm to destroy the copies above\n');
    }
  }
  return 0;
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  quarantineRoot,
  quarantinePath,
  reserveDest,
  moveInto,
  restoreFromQuarantine,
  pruneEmptyDirs,
  purge,
  listQuarantine,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
