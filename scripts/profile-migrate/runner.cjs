#!/usr/bin/env node
'use strict';
// runner.cjs — the phase framework of the profile migration (epic #1784 M0–M5
// engine; red-team decisions from #1808 are baked into the order of operations).
//
// For one (phase, profile) the runner supports four modes:
//   --dry-run  (DEFAULT)  report what the phase WOULD do — writes NOTHING: no
//                         lock, no flush, no ledger, no quarantine directory
//   --apply               lock → drain → flush → plan → act → ledger
//   --verify              read-only: re-check the post-state against the ledger
//                         (and re-plan to report files that appeared since)
//   --revert --phase X    lock → drain → flush → replay the ledger in reverse
//
// The mutating path, in order (this order is the contract):
//   1. acquireProfileLock — a held lock is never stolen; --apply REFUSES after
//      the timeout (PROFILE_LOCKED) instead of proceeding;
//   2. DRAIN in-flight runs of this profile — the admission gate in
//      src/runner/index.js stops NEW runs the moment we hold the lock, and
//      pending-tasks journal records identify the ones already running; the
//      lock is renewed while we wait (a long drain never lets the TTL lapse);
//   3. POST /internal/flush-profile — the live server must drop its buffered
//      JSONL BEFORE the first file is touched (#1808 Q1: flush → snapshot);
//      only an unreachable endpoint is tolerated (no process = no buffer), a
//      non-200 / ok:false answer aborts the run (risk R2);
//   4. plan via classifier.cjs's own walk (`onEntry`), so a plan can never
//      drift from the classification — and only items whose class is owned by
//      the phase are ever handed to it (epic principle 2: UNKNOWN is report-only);
//   5. per item: hash + reserve destination (read-only) → append the ledger
//      record with fsync → perform the action. Record-before-action means a
//      crash leaves the file intact at its origin (verify reports it), never an
//      unreferenced copy in quarantine;
//   6. prune the DELETE-class directories the phase emptied — an UNKNOWN
//      ancestor, even when empty, is never removed.
//
// Phases are small self-registering modules (see phases/index.cjs). The first
// concrete one is `delete` (M1 clean-list DELETE actions); ARCHIVE/MOVE/DEDUP
// wire in later PRs by dropping a module into phases/.
//
// Exit-code mapping lives in cli.mjs: 0 ok · 1 usage · 2 operational failure ·
// 3 lock refused.
const fs = require('fs');
const path = require('path');
const classifier = require('./classifier.cjs');
const ledger = require('./ledger.cjs');
const quarantine = require('./quarantine.cjs');
const { loadPhases } = require('./phases/index.cjs');
const { acquireProfileLock, releaseProfileLock, DEFAULT_ACQUIRE_TIMEOUT_MS } = require('../../src/profile-lock');
const { pendingTaskPath } = require('../../src/data-paths');

const SCHEMA = 'profile-migrate/runner@1';
const MODES = ['dry-run', 'apply', 'verify', 'revert'];
const MUTATING_MODES = new Set(['apply', 'revert']);
const DEFAULT_LOCK_TIMEOUT_MS = DEFAULT_ACQUIRE_TIMEOUT_MS; // 30s — epic: fail fast
const LOCK_TTL_MS = 60 * 60 * 1000;                        // long apply never expires under itself
const RENEW_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;
const DRAIN_POLL_MS = 1_000;
const DRAIN_RENEW_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_ERRORS = 50;

class UsageError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function defaultLog(msg) {
  process.stderr.write(`[phase-runner] ${msg}\n`);
}

function safeExists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function pushError(result, msg) {
  result.errorCount = (result.errorCount || 0) + 1;
  if (result.errors.length < MAX_ERRORS) result.errors.push(msg);
}

// ── planning ─────────────────────────────────────────────────────────────────
// One walk of the profile through classifier.cjs itself (opts.onEntry): the
// plan IS the classification, there is no second glob implementation to drift.
function scanProfile(profileRoot, rules, actions) {
  const items = [];
  const dirs = new Set();
  const special = [];
  const stats = classifier.classifyProfile(profileRoot, {
    rules,
    onEntry(e) {
      if (e.kind === 'dir') {
        if (actions.includes(e.action)) dirs.add(e.rel);
        return;
      }
      if (!actions.includes(e.action)) return;
      // fifo/socket/device: counted by the classifier, never hashable → report only.
      if (!e.isFile && !e.isSymlink) {
        special.push({ path: e.rel, action: e.action, size: e.size });
        return;
      }
      items.push({
        path: e.rel,
        action: e.action,
        size: e.size,
        isSymlink: !!e.isSymlink,
        ruleIdx: e.ruleIdx,
        reason: e.ruleIdx >= 0 && rules[e.ruleIdx] ? rules[e.ruleIdx].reason : null,
      });
    },
  });
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, dirs, special, stats };
}

function classSummary(stats) {
  const out = {};
  for (const c of stats.classes) out[c.action] = { files: c.files, bytes: c.bytes, pctBytes: c.pctBytes };
  return out;
}

// Last record per (phase, path) wins — see ledger.recordState for the states.
function foldPhaseRecords(records, phaseName) {
  const byPath = new Map();
  records.forEach((rec, index) => {
    if (!rec || rec.phase !== phaseName || typeof rec.path !== 'string') return;
    byPath.set(rec.path, {
      path: rec.path,
      sha256: rec.sha256 ?? null,
      size: rec.size ?? 0,
      dest: rec.dest ?? null,
      action: rec.action,
      state: ledger.recordState(rec.action),
      ts: rec.ts,
      index,
    });
  });
  return [...byPath.values()].sort((a, b) => a.index - b.index);
}

// ── drain ────────────────────────────────────────────────────────────────────
// In-flight runs of ONE profile = its pending-tasks journal records still in a
// live phase. Records are deleted when a run finishes; `error`/`interrupted`
// mean no engine is running (they await resume, not completion).
function listInflightTasks(profile, pendingDir) {
  let names;
  try { names = fs.readdirSync(pendingDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(pendingDir, n), 'utf8')); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const mine = rec.username === profile || rec.profile === profile || n.startsWith(`${profile}-`);
    if (!mine) continue;
    if (rec.phase === 'running' || rec.phase === 'queued' || rec.phase === undefined) out.push(n.replace(/\.json$/, ''));
  }
  return out;
}

// timeoutMs <= 0 disables the drain (tests / offline one-shots).
async function waitForProfileIdle(profile, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, renewFn = null, log = defaultLog, pollMs = DRAIN_POLL_MS } = {}) {
  if (timeoutMs <= 0) return { idle: true, waitedMs: 0, tasks: [], skipped: true };
  const pendingDir = path.dirname(pendingTaskPath('drain-probe'));
  const started = Date.now();
  let lastRenew = started;
  let announced = false;
  for (;;) {
    const inflight = listInflightTasks(profile, pendingDir);
    if (!inflight.length) return { idle: true, waitedMs: announced ? Date.now() - started : 0, tasks: [] };
    if (!announced) {
      announced = true;
      log(`drain: ${profile} has ${inflight.length} in-flight task(s) (${inflight.slice(0, 5).join(', ')}${inflight.length > 5 ? ', …' : ''}) — waiting before touching files`);
    }
    if (Date.now() - started >= timeoutMs) {
      return { idle: false, waitedMs: Date.now() - started, tasks: inflight };
    }
    await sleep(pollMs);
    // The lock TTL must outlive a long drain, or a new run could start between
    // "drain finished" and "first file touched".
    if (renewFn && Date.now() - lastRenew >= DRAIN_RENEW_MS) {
      try { await renewFn(); lastRenew = Date.now(); } catch (e) { log(`drain: lock renew failed: ${e.message}`); }
    }
  }
}

// ── flush ────────────────────────────────────────────────────────────────────
// POST /internal/flush-profile (auth: AGENT_SECRET Bearer). Only an UNREACHABLE
// endpoint is tolerated — if nothing listens, no process holds a buffer; every
// other answer (401/500/ok:false/timeout) aborts before the first file is
// touched (#1808 Q1, risk R2).
function isConnectionError(e) {
  const codes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN']);
  let cur = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code && codes.has(cur.code)) return true;
    if (Array.isArray(cur.errors) && cur.errors.some(x => x && codes.has(x.code))) return true;
    cur = cur.cause;
  }
  return false;
}

function flushUrl(env = process.env) {
  if (env.AGENT_FLUSH_URL) return String(env.AGENT_FLUSH_URL).replace(/\/$/, '');
  return `http://127.0.0.1:${env.PORT || 3000}`;
}

async function callFlush(profile, { url = null, secret = null, timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS, fetchImpl = fetch, log = defaultLog } = {}) {
  const endpoint = `${url || flushUrl()}/internal/flush-profile`;
  const bearer = secret ?? process.env.AGENT_SECRET ?? null;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ username: profile }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body || body.ok !== true) {
      return {
        ok: false, attempted: true, endpoint, status: res.status,
        error: `flush endpoint answered ${res.status} ${body ? JSON.stringify(body) : ''} — records may still be buffered, refusing to touch the profile`,
      };
    }
    return { ok: true, attempted: true, endpoint, status: res.status, flushed: body.flushed ?? 0, failed: body.failed ?? 0 };
  } catch (e) {
    if (isConnectionError(e)) {
      log(`flush: nothing listening at ${endpoint} (${e.code || e.message}) — no process holds buffered records, continuing`);
      return { ok: true, attempted: true, endpoint, skipped: `unreachable: ${e.code || e.message}` };
    }
    return { ok: false, attempted: true, endpoint, error: `flush request failed: ${e.message}` };
  }
}

// ── politeness (ionice / nice) ───────────────────────────────────────────────
// Linux: ionice -c3 -n7 (idle I/O class) + nice. macOS dev boxes have no
// ionice → only nice; neither available → run unprefixed (graceful degrade).
function which(bin, pathEnv) {
  const isExecutable = (file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  };
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function buildNicePrefix({ env = process.env } = {}) {
  const prefix = [];
  if (which('ionice', env.PATH)) prefix.push('ionice', '-c', '3', '-n', '7');
  if (which('nice', env.PATH)) prefix.push('nice', '-n', '10');
  return prefix;
}

function pruneDeleteDirs(profileRoot, dirs) {
  // Deepest first, so a directory that only held other DELETE directories is
  // empty by the time we reach it. rmdir fails on anything non-empty → kept.
  const sorted = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  let removed = 0;
  for (const rel of sorted) {
    try { fs.rmdirSync(path.join(profileRoot, ...rel.split('/'))); removed++; } catch { /* not empty / gone */ }
  }
  return removed;
}

// ── one (phase, profile, mode) ───────────────────────────────────────────────
async function runPhase(o) {
  const phaseObj = o.phaseObj;
  const { profile, mode, log = defaultLog } = o;
  const result = {
    profile,
    phase: phaseObj.name,
    mode,
    ok: false,
    root: path.join(o.usersRoot, profile),
    ledgerFile: ledger.ledgerPath(profile),
    quarantineRoot: quarantine.quarantineRoot(profile),
    lock: null,
    flush: null,
    drain: null,
    stats: null,
    unknown: null,
    planned: 0,
    plannedBytes: 0,
    applied: 0,
    appliedBytes: 0,
    failed: 0,
    errorCount: 0,
    errors: [],
    items: [],
    specialSkipped: 0,
    scanErrors: 0,
    verify: null,
    revert: null,
    prunedDirs: 0,
  };

  const profileRoot = result.root;
  if (!safeExists(profileRoot) || !fs.statSync(profileRoot).isDirectory()) {
    pushError(result, `profile not found: ${profileRoot}`);
    return result;
  }

  const ctx = { profile, profileRoot, quarantineRoot: result.quarantineRoot, rules: o.rules, mode, log };

  if (phaseObj.inventory && (mode === 'dry-run' || mode === 'verify')) {
    doInventory(ctx, result, o);
    result.ok = result.errorCount === 0;
    return result;
  }
  if (mode === 'dry-run') {
    doDryRun(ctx, result, o);
    result.ok = result.errorCount === 0;
    return result;
  }
  if (mode === 'verify') {
    doVerify(ctx, result, o);
    result.ok = result.errorCount === 0;
    return result;
  }

  // ── mutating: apply | revert ──
  let lockRec;
  try {
    lockRec = await acquireProfileLock(profile, {
      timeoutMs: o.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      ttlMs: LOCK_TTL_MS,
      reason: `profile-migrate:${phaseObj.name}`,
    });
  } catch (e) {
    if (e.code === 'PROFILE_LOCKED') {
      result.lock = { acquired: false, refused: true, holder: e.holder || null, waitedMs: o.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS };
      log(`refusing ${mode} on ${profile}: ${e.message}`);
      return result;
    }
    pushError(result, `lock: ${e.message}`);
    return result;
  }
  result.lock = { acquired: true, pid: lockRec.pid };
  const renewFn = () => acquireProfileLock(profile, { renew: true, ttlMs: LOCK_TTL_MS, timeoutMs: 10_000, reason: `profile-migrate:${phaseObj.name}` });

  try {
    const drain = await waitForProfileIdle(profile, { timeoutMs: o.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS, renewFn, log });
    result.drain = drain;
    if (!drain.idle) {
      pushError(result, `drain: ${drain.tasks.length} in-flight task(s) still running after ${drain.waitedMs}ms (${drain.tasks.slice(0, 5).join(', ')}) — refusing to touch the profile`);
      return result;
    }

    const flush = await callFlush(profile, { url: o.flushUrl, timeoutMs: o.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS, log });
    result.flush = flush;
    if (!flush.ok) {
      pushError(result, `flush: ${flush.error}`);
      return result;
    }

    if (phaseObj.inventory) doInventory(ctx, result, o);
    else if (mode === 'apply') await doApply(ctx, result, o, renewFn);
    else await doRevert(ctx, result, o, renewFn);
  } finally {
    releaseProfileLock(profile);
  }

  result.ok = result.errorCount === 0;
  return result;
}

function applyScanFields(result, scan) {
  result.stats = classSummary(scan.stats);
  result.unknown = result.stats.UNKNOWN || { files: 0, bytes: 0, pctBytes: 0 };
  result.scanErrors = scan.stats.errors.length;
  result.specialSkipped = scan.special.length;
  result.planned = scan.items.length;
  result.plannedBytes = scan.items.reduce((s, i) => s + i.size, 0);
  if (scan.stats.errors.length) {
    for (const e of scan.stats.errors.slice(0, 5)) pushError(result, `scan: ${e.path}: ${e.code || e.message}`);
  }
}

function doDryRun(ctx, result, o) {
  const scan = scanProfile(ctx.profileRoot, o.rules, o.phaseObj.actions);
  applyScanFields(result, scan);
  result.items = scan.items;
}

async function doApply(ctx, result, o, renewFn) {
  const phaseObj = o.phaseObj;
  const { log = defaultLog } = o;
  const scan = scanProfile(ctx.profileRoot, o.rules, phaseObj.actions);
  applyScanFields(result, scan);
  result.items = scan.items.map(i => ({ path: i.path, size: i.size, status: 'planned', reason: i.reason }));
  if (!scan.items.length) {
    if (scan.special.length) log(`apply ${ctx.profile}: ${scan.special.length} non-regular file(s) in the plan — report only`);
    return;
  }

  // Fail fast on an unwritable quarantine root BEFORE the first record: a
  // record for an action we cannot perform is noise for verify.
  fs.mkdirSync(ctx.quarantineRoot, { recursive: true, mode: 0o700 });

  let consecutive = 0;
  let lastRenew = Date.now();
  for (let i = 0; i < scan.items.length; i++) {
    const item = scan.items[i];
    if (Date.now() - lastRenew >= RENEW_INTERVAL_MS) {
      try { await renewFn(); lastRenew = Date.now(); } catch (e) { pushError(result, `lock renew: ${e.message}`); return; }
    }
    const abs = path.join(ctx.profileRoot, item.path);
    let prepared = null;
    let recorded = false;
    try {
      prepared = phaseObj.prepare(ctx, item);
      ledger.appendRecord(ctx.profile, ledger.makeRecord({
        phase: phaseObj.name,
        profile: ctx.profile,
        path: item.path,
        sha256: prepared.sha256,
        size: prepared.size,
        action: phaseObj.action,
        dest: prepared.dest,
      }));
      recorded = true;
      phaseObj.apply(ctx, item, prepared);
      result.applied++;
      result.appliedBytes += prepared.size;
      result.items[i] = { path: item.path, size: prepared.size, sha256: prepared.sha256, dest: prepared.dest, status: 'applied' };
      consecutive = 0;
    } catch (e) {
      result.failed++;
      consecutive++;
      const stillAtOrigin = safeExists(abs);
      // Compensating record ONLY when the file is still at its origin — if the
      // move happened but verification failed, the DELETE record stays (state
      // at-dest) and verify reports the hash mismatch truthfully.
      if (recorded && stillAtOrigin) {
        try {
          ledger.appendRecord(ctx.profile, ledger.makeRecord({
            phase: phaseObj.name,
            profile: ctx.profile,
            path: item.path,
            sha256: prepared ? prepared.sha256 : null,
            size: prepared ? prepared.size : item.size,
            action: phaseObj.failureAction || `${phaseObj.action}_FAILED`,
            dest: prepared ? prepared.dest : null,
          }));
        } catch (e2) {
          pushError(result, `ledger compensating record for ${item.path}: ${e2.message}`);
        }
      }
      pushError(result, `apply ${item.path}: ${e.message}`);
      result.items[i] = { path: item.path, size: item.size, status: 'failed', error: e.message };
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        pushError(result, `${consecutive} consecutive failures — aborting, ${scan.items.length - i - 1} planned item(s) untouched`);
        break;
      }
    }
  }
  result.prunedDirs = pruneDeleteDirs(ctx.profileRoot, scan.dirs);
  log(`apply ${ctx.profile}: ${result.applied}/${scan.items.length} applied (${result.appliedBytes} B), ${result.failed} failed, ${result.prunedDirs} emptied dir(s) pruned`);
}

async function doRevert(ctx, result, o, renewFn) {
  const phaseObj = o.phaseObj;
  const { log = defaultLog } = o;
  const { records, skipped } = ledger.readLedger(ctx.profile);
  const folded = foldPhaseRecords(records, phaseObj.name).reverse(); // replay newest → oldest
  const rev = { records: folded.length, skippedLines: skipped, restored: 0, already: 0, skipped: 0, failures: [] };
  result.revert = rev;
  let lastRenew = Date.now();

  for (const st of folded) {
    if (Date.now() - lastRenew >= RENEW_INTERVAL_MS) {
      try { await renewFn(); lastRenew = Date.now(); } catch (e) { pushError(result, `lock renew: ${e.message}`); return; }
    }
    let r;
    try { r = phaseObj.revert(ctx, st); } catch (e) { r = { status: 'error', reason: e.message }; }
    if (r.status === 'restored' || r.status === 'already') {
      try {
        ledger.appendRecord(ctx.profile, ledger.makeRecord({
          phase: phaseObj.name,
          profile: ctx.profile,
          path: st.path,
          sha256: st.sha256,
          size: st.size,
          action: phaseObj.restoredAction || 'RESTORED',
          dest: st.dest,
        }));
      } catch (e) {
        pushError(result, `ledger RESTORED record for ${st.path}: ${e.message}`);
        rev.failures.push({ path: st.path, status: 'ledger', reason: e.message });
        continue;
      }
      if (r.status === 'restored') rev.restored++;
      else rev.already++;
    } else if (r.status === 'skip') {
      rev.skipped++;
    } else {
      rev.failures.push({ path: st.path, status: r.status, reason: r.reason || '' });
      pushError(result, `revert ${st.path}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
    }
  }
  log(`revert ${ctx.profile}: ${rev.restored} restored, ${rev.already} already in place, ${rev.skipped} skipped, ${rev.failures.length} failed`);
}

function doVerify(ctx, result, o) {
  const phaseObj = o.phaseObj;
  const { log = defaultLog } = o;
  const { records, skipped, missing } = ledger.readLedger(ctx.profile);
  const folded = foldPhaseRecords(records, phaseObj.name);
  const scan = scanProfile(ctx.profileRoot, o.rules, phaseObj.actions);
  applyScanFields(result, scan);

  const v = {
    records: folded.length,
    ledgerMissing: missing,
    skippedLines: skipped,
    ok: 0,
    recreated: 0,
    failures: [],
    pendingCount: 0,
    pending: [],
  };
  const seen = new Set();
  for (const st of folded) {
    seen.add(st.path);
    let r;
    try { r = phaseObj.verify(ctx, st); } catch (e) { r = { status: 'error', message: e.message }; }
    if (r.status === 'ok') v.ok++;
    else if (r.status === 'recreated') v.recreated++;
    else v.failures.push({ path: st.path, state: st.state, status: r.status, message: r.message || '' });
  }
  // Planned right now but never recorded for this phase: files that appeared
  // after apply (npm ci re-created node_modules) or an apply that never ran.
  // Informational — verify's hard failures are the integrity ones above.
  const pending = scan.items.filter(i => !seen.has(i.path));
  v.pendingCount = pending.length;
  v.pending = pending.slice(0, 50);
  result.verify = v;

  if (v.failures.length) pushError(result, `${v.failures.length} verification failure(s) for phase "${phaseObj.name}"`);
  log(`verify ${ctx.profile}: ok=${v.ok} recreated=${v.recreated} pending=${v.pendingCount} failures=${v.failures.length}${skipped ? ` torn-lines=${skipped}` : ''}`);
}

// Inventory phases (phases/index.cjs): scan → report; apply = ledger the scan
// as the baseline; verify = scan again and let the phase judge it against the
// folded baseline; revert = nothing to restore.
function doInventory(ctx, result, o) {
  const phaseObj = o.phaseObj;
  const { log = defaultLog } = o;
  if (ctx.mode === 'revert') {
    result.revert = { records: 0, skippedLines: 0, restored: 0, already: 0, skipped: 0, failures: [] };
    log(`revert ${ctx.profile}: phase "${phaseObj.name}" is read-only — nothing to revert`);
    return;
  }
  const items = phaseObj.scan(ctx);
  result.items = items;
  result.planned = items.length;
  if (phaseObj.resultKey) result[phaseObj.resultKey] = items;
  if (ctx.mode === 'apply') {
    phaseObj.record(ctx, items);
    result.applied = items.length;
    log(`apply ${ctx.profile}: ${items.length} ${phaseObj.name} record(s) ledgered`);
    return;
  }
  if (ctx.mode !== 'verify') return;
  const { records, skipped, missing } = ledger.readLedger(ctx.profile);
  const folded = foldPhaseRecords(records, phaseObj.name);
  const failures = folded.length ? phaseObj.check(ctx, items, folded) : [];
  result.verify = {
    records: folded.length, ledgerMissing: missing, skippedLines: skipped,
    ok: folded.length - failures.length, recreated: 0, failures, pendingCount: 0, pending: [],
  };
  if (!folded.length) pushError(result, `no "${phaseObj.name}" baseline in the ledger — run --apply before the migration`);
  if (failures.length) pushError(result, `${failures.length} verification failure(s) for phase "${phaseObj.name}": ${failures.map(f => f.path).join(', ')}`);
  log(`verify ${ctx.profile}: ${phaseObj.name} baseline=${folded.length} failures=${failures.length}`);
}

// ── batch entry ──────────────────────────────────────────────────────────────
async function runBatch(o) {
  const phases = loadPhases();
  const phaseObj = phases[o.phase];
  if (!phaseObj) {
    throw new UsageError(`unknown phase "${o.phase}" — available: ${Object.keys(phases).join(', ')}`);
  }
  if (!MODES.includes(o.mode)) throw new UsageError(`unknown mode "${o.mode}" — expected one of: ${MODES.join(', ')}`);
  if (!Array.isArray(o.profiles) || !o.profiles.length) throw new UsageError('no profiles selected (--profile <name> or --all)');
  for (const p of o.profiles) ledger.assertProfileName(p);

  let loaded;
  try {
    loaded = classifier.loadRules(o.cleanList || classifier.DEFAULT_CLEAN_LIST);
  } catch (e) {
    throw new UsageError(e.message);
  }

  const results = [];
  for (const profile of o.profiles) {
    results.push(await runPhase({ ...o, profile, phaseObj, rules: loaded.rules, log: o.log || defaultLog }));
  }

  const summary = {
    schema: SCHEMA,
    phase: phaseObj.name,
    mode: o.mode,
    generatedAt: new Date().toISOString(),
    usersRoot: o.usersRoot,
    cleanList: { file: loaded.file, version: loaded.version, rules: loaded.rules.length },
    profiles: results,
    errorCount: results.reduce((s, r) => s + (r.errorCount || 0), 0),
    lockRefused: results.filter(r => r.lock && r.lock.refused).length,
  };
  summary.ok = summary.errorCount === 0 && summary.lockRefused === 0;
  return summary;
}

module.exports = {
  SCHEMA,
  MODES,
  MUTATING_MODES,
  UsageError,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_FLUSH_TIMEOUT_MS,
  LOCK_TTL_MS,
  loadPhases,
  scanProfile,
  foldPhaseRecords,
  listInflightTasks,
  waitForProfileIdle,
  callFlush,
  flushUrl,
  isConnectionError,
  buildNicePrefix,
  which,
  pruneDeleteDirs,
  runPhase,
  runBatch,
  classSummary,
  defaultUsersRoot: classifier.defaultUsersRoot,
  DEFAULT_CLEAN_LIST: classifier.DEFAULT_CLEAN_LIST,
};
