'use strict';
// session-sweep.js — PR-D of epic #1784 M2 (issue #1916): the POST-RUN SWEEP.
//
// The owner's contract is two halves, and this is the second one:
//   «Во время рана — всё локально в изолированном workspace. ПОСЛЕ рана —
//    тело сессии + транскрипты → gzip в GCS → verify sha → УДАЛИТЬ с VM →
//    в индексе archived: {key, sha256, size}.»
// PR-A (blob store), PR-B (the archive operations + the `archive-sessions`
// phase) and PR-C (the read side) are already in main; this module is what
// makes «на VM нет ни тела сессии, ни транскрипта» actually happen after every
// run — and it is therefore the reason PR-C finds nothing on disk between runs.
//
// TRIGGER (runner/index.js): when a run settles — the engine path AND the
// quick-answer path, because a quick answer writes a session too (the pre-queue
// ⚡ answer writes one of its own). Scheduling is DEFERRED: schedulePostRunSweep
// only arms a timer and returns a promise nobody in the runner awaits, so the
// user's final answer never waits for an upload. The timer is armed inside the
// run's own `finally`, AFTER the journal entry is cleared — so the in-flight
// guard below never sees the run that started this sweep.
//
// ONE SWEEP, in this order (the order is the contract, same as the phase
// runner scripts/profile-migrate/runner.cjs, minus the drain — see step 3):
//   1. acquireProfileLock(timeoutMs: 0) — a busy profile means maintenance is
//      already running (or another sweep won the race): SKIP and let the next
//      run sweep. Never wait, never steal the lock;
//   2. flush the batched JSONL buffer — the brief's POST /internal/flush-profile
//      is the MIGRATOR's cross-process form of this exact step (the handler
//      calls flushAll()). The sweep runs inside the process that owns the
//      buffer, so it calls the same function directly: same code, no loopback,
//      no AGENT_SECRET, no dependency on the HTTP listener. `failed > 0` → SKIP
//      (a record still buffered could re-create an archived file — risk R2);
//   3. in-flight guard — every pending-tasks record of this profile still in
//      phase running|queued pins ITS session: that body is being written right
//      now, so it is skipped («догонит следующий ран»). This is the brief's
//      «на ТУ ЖЕ сессию» rule applied to every candidate, not only the run's own
//      — the migrator's drain would be wrong here (it waits for every run of the
//      profile; a post-run sweep must never wait at all);
//   4. archive — per session body: prepare (hashPath + blob key) → ledger record
//      → apply (gzip → upload → download-back + sha → index marker → unlink).
//      That is the SAME phase module and the SAME ledger records as
//      `profile-migrate archive-sessions --apply`, so `--verify` / `--revert`
//      work on sweep records unchanged. The transcripts of a swept body follow
//      it (engineSessions ids → the local `.jsonl`), and a body whose upload
//      failed takes its transcripts down with it (see step «ничего не удаляем»).
//      The whole archiving phase is bounded by SWEEP_DEADLINE_MS so the profile
//      gate can never park a profile for long — leftovers wait for the next run;
//   5. light cleanup — a hard-coded O(1) list, NO walk of the profile (the walk
//      is the janitor's, issue #1839);
//   6. releaseProfileLock.
//
// NOTHING IS DELETED WITHOUT A CONFIRMED UPLOAD. A failed upload/verify throws
// inside the phase's apply; the compensating ARCHIVE_FAILED record keeps the
// ledger fold at `returned` and the file stays on disk — the next run retries.
// That degraded state (files still local while GCS is down) is the documented
// one: it costs VM disk, never data.
//
// SCOPE of one sweep: every local body under `sessions/` that passes the phase's
// own filter (pointers, digest caches, junk and symlinks are declined by
// archiveRelKind), minus the sessions pinned by an in-flight run. Bodies that
// were never archived and never ran live in legacy profiles are swept here too —
// the M2 contract is «ни одного тела», and the sweep is what keeps that true
// run after run (the CLI phase is the one-shot migration of the same files).
// ⚡ side sessions (recordQuickExchange, `sideSession:true`, no index record) are
// archived like everything else — exactly as the CLI phase already does to them;
// PR-C's marker-less admission probe (materializeRunSessions) is what makes them
// reachable again afterwards.
const fs = require('fs');
const path = require('path');
const ledger = require('../scripts/profile-migrate/ledger.cjs');
const phase = require('../scripts/profile-migrate/phases/archive-sessions.cjs');
const archive = require('./session-archive');
const { acquireProfileLock, releaseProfileLock } = require('./profile-lock');
const { pendingTaskPath } = require('./data-paths');
const { flushAll } = require('./jsonl-batched-flush');

// The ledger phase name — must stay identical to phase.name or `--verify` /
// `--revert` would fold the sweep's records into a different bucket than the
// CLI's (asserted in test/session-sweep.test.cjs).
const PHASE_NAME = phase.name;
const LOCK_TTL_MS = 10 * 60 * 1000; // far above SWEEP_DEADLINE_MS — a sweep never needs to renew
// Deferred, not blocking: how long after the run settles the sweep starts. The
// runner's answer is already delivered by then; the delay only lets trailing
// in-process writes (gtd hooks, summaries, tg edits) settle first. Overridable
// so tests do not have to sleep.
const DEFAULT_DELAY_MS = 1000;
// One sweep never holds the maintenance lock longer than this (+ one bounded
// upload): a run arriving meanwhile parks on the profile gate, and while every
// other profile keeps working, THIS one must not be able to park for minutes —
// each blob call has its own 60s deadline, but N of them add up (a never-
// migrated profile has N bodies). Whatever is left at the deadline stays local
// and is swept by the next run, exactly like a failed upload. Also what makes
// lock renewal unnecessary: 60s + one upload is well inside LOCK_TTL_MS.
const SWEEP_DEADLINE_MS = 60_000;

const activeSweeps = new Set(); // profile → a sweep is running (in this process)

function defaultDelayMs() {
  const raw = Number(process.env.POST_RUN_SWEEP_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELAY_MS;
}

/**
 * Deferred entry point (runner). Arms a timer and returns a promise that
 * RESOLVES with the sweep result — never rejects, so a fire-and-forget caller
 * cannot produce an unhandled rejection. Nothing before the timer runs.
 *
 * @param {{profile, workDir, sessionId?, taskId?, delayMs?}} opts
 *   `sessionId` is a HINT (the run's own session, for ordering and logs) — the
 *   candidate set comes from the directory, so a hint of null still sweeps.
 */
function schedulePostRunSweep(opts = {}) {
  const delay = Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : defaultDelayMs();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => runSessionSweep(opts))
        .then(resolve, (e) => {
          console.warn('[session-sweep] %s: %s', opts.profile || '?', (e && e.message) || e);
          resolve({ profile: opts.profile || null, error: (e && e.message) || String(e) });
        });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * One sweep. See the ordering contract in the module header.
 * @param {{profile, workDir, sessionId?, taskId?, deadlineMs?, log?}} [opts]
 *   `deadlineMs` overrides SWEEP_DEADLINE_MS (0 = stop before the first body —
 *   the test seam for «the gate is bounded»).
 * @returns {Promise<object>} `{profile, skipped?, aborted?, archived[], failed[],
 *   skippedSessions[], cleaned, flushed, lock}` — `skipped` is one of `lock` |
 *   `flush` | `concurrent` | `no-profile` | `no-workdir` | `bad-profile`;
 *   `aborted` is `deadline` when the bounded window closed mid-sweep.
 */
async function runSessionSweep({ profile, workDir, sessionId = null, taskId = null, deadlineMs = null, log = console } = {}) {
  const out = {
    profile: profile || null,
    skipped: null, archived: [], failed: [], skippedSessions: [],
    flushed: 0, cleaned: 0, lock: null,
  };
  if (!profile || !workDir) { out.skipped = 'no-profile'; return out; }
  try { ledger.assertProfileName(profile); }
  catch { out.skipped = 'bad-profile'; return out; }
  if (!fs.existsSync(workDir)) { out.skipped = 'no-workdir'; return out; }
  // One sweep per profile at a time: a second run finishing during a sweep must
  // not queue up behind the lock (it would take PROFILE_LOCKED anyway) — and
  // must not run the cleanup twice.
  if (activeSweeps.has(profile)) { out.skipped = 'concurrent'; return out; }
  activeSweeps.add(profile);

  try {
    // ── 1. profile maintenance lock (fail fast: timeoutMs 0) ──────────────────
    let lock;
    try {
      lock = await acquireProfileLock(profile, {
        timeoutMs: 0, ttlMs: LOCK_TTL_MS, reason: 'post-run-sweep',
      });
    } catch (e) {
      if (e && e.code === 'PROFILE_LOCKED') {
        out.skipped = 'lock';
        out.holder = e.holder || null;
        log.warn('[session-sweep] %s: profile under maintenance (%s) — skipped, the next run sweeps', profile, (e.holder && e.holder.reason) || 'lock held');
        return out;
      }
      throw e;
    }
    out.lock = { acquired: true, pid: lock.pid };

    try {
      // ── 2. flush the batched JSONL buffer (same function the HTTP endpoint
      //      /internal/flush-profile runs) ─────────────────────────────────────
      const { flushed, failed } = flushAll();
      out.flushed = flushed;
      if (failed > 0) {
        out.skipped = 'flush';
        log.warn('[session-sweep] %s: %d buffered record(s) could not be flushed — not touching the profile', profile, failed);
        return out;
      }

      // ── 3. in-flight guard ──────────────────────────────────────────────────
      const inflight = listInflightSessionIds(profile);

      // ── 4. archive ──────────────────────────────────────────────────────────
      const ctx = { profile, profileRoot: workDir, rules: null, mode: 'apply', log: (m) => log.log(`[session-sweep] ${m}`) };
      const bodies = listLocalBodies(workDir, sessionId);
      const transcripts = indexLocalTranscripts(workDir);
      const deadline = Date.now() + (Number.isFinite(deadlineMs) ? deadlineMs : SWEEP_DEADLINE_MS);
      for (const rel of bodies) {
        // Never hold the profile gate past the sweep deadline (see
        // SWEEP_DEADLINE_MS): the rest waits for the next run.
        if (Date.now() >= deadline) {
          log.warn('[session-sweep] %s: deadline reached with %d body/bodies left — the next run finishes them', profile, bodies.length - out.archived.length);
          out.aborted = 'deadline';
          break;
        }
        const id = archive.sessionRelId(rel);
        if (inflight.has(id)) {
          out.skippedSessions.push(id);
          continue;
        }
        // Read the engine session ids BEFORE the body can disappear: they name
        // the transcript files that belong to this session (claude's live under
        // .agent-home/.claude/projects/; opencode's are in SQLite and simply do
        // not match a file here).
        const engineIds = readEngineSessionIds(path.join(workDir, rel));
        const transcriptRels = engineIds.map((eid) => transcripts.get(eid)).filter(Boolean);

        try {
          await archiveOne(ctx, rel);
          out.archived.push(rel);
        } catch (e) {
          // «Ничего не удаляем»: the body's upload/verify failed, so its
          // transcripts are not attempted either — they stay local with it and
          // the whole session is retried by the next run. The compensating
          // ledger record (if one was needed) is archiveOne's, exactly like
          // runner.cjs doApply — a prepare failure appends nothing at all.
          out.failed.push({ path: rel, error: e.message });
          log.warn('[session-sweep] %s: %s — kept locally, the next run retries', rel, e.message);
          continue;
        }
        for (const trel of transcriptRels) {
          try {
            await archiveOne(ctx, trel);
            out.archived.push(trel);
          } catch (e) {
            // The body is already confirmed and gone; only the transcript failed.
            // It stays local, the compensating record keeps verify green, the next
            // run (which materializes the body again) retries it.
            out.failed.push({ path: trel, error: e.message });
            log.warn('[session-sweep] %s: %s — kept locally, the next run retries', trel, e.message);
          }
        }
      }

      // ── 5. light cleanup ────────────────────────────────────────────────────
      out.cleaned = lightCleanup(workDir);
    } finally {
      // ── 6. release (only ours — releaseProfileLock never drops a foreign one)
      releaseProfileLock(profile);
    }
    if (out.archived.length || out.skippedSessions.length || out.cleaned || out.failed.length) {
      log.log('[session-sweep] %s (task %s): archived=%d failed=%d in-flight-skipped=%d cleaned=%d',
        profile, taskId || '-', out.archived.length, out.failed.length, out.skippedSessions.length, out.cleaned);
    }
    return out;
  } finally {
    activeSweeps.delete(profile);
  }
}

// ── ledger + phase (the record-before-action pair of runner.cjs doApply) ──────
// One file, exactly the two records the CLI writes for the same action, so the
// fold (last record per (phase, path) wins) and every phase mode behave
// identically for a sweep record and a CLI record.
async function archiveOne(ctx, rel) {
  const item = { path: rel, action: 'ARCHIVE' };
  const prepared = await phase.prepare(ctx, item);
  ledger.appendRecord(ctx.profile, ledger.makeRecord({
    phase: PHASE_NAME,
    profile: ctx.profile,
    path: rel,
    sha256: prepared.sha256,
    size: prepared.size,
    action: 'ARCHIVE',
    dest: prepared.dest,
  }));
  try {
    await phase.apply(ctx, item, prepared);
  } catch (e) {
    recordFailure(ctx, rel, prepared);
    throw e;
  }
}

// Compensating record, mirroring runner.cjs doApply: written ONLY while the file
// is still at its origin (if the action happened but confirmation failed, the
// ARCHIVE record stays and verify reports the state truthfully).
function recordFailure(ctx, rel, prepared = null) {
  if (!fs.existsSync(path.join(ctx.profileRoot, rel))) return;
  try {
    ledger.appendRecord(ctx.profile, ledger.makeRecord({
      phase: PHASE_NAME,
      profile: ctx.profile,
      path: rel,
      sha256: prepared ? prepared.sha256 : null,
      size: prepared ? prepared.size : 0,
      action: 'ARCHIVE_FAILED',
      dest: prepared ? prepared.dest : null,
    }));
  } catch (e2) {
    ctx.log(`ledger compensating record for ${rel}: ${e2.message}`);
  }
}

// ── in-flight guard ───────────────────────────────────────────────────────────
// Session ids pinned by a live journal record of THIS profile. Profile match
// mirrors scripts/profile-migrate/runner.cjs listInflightTasks (username /
// profile / `<profile>-` taskId prefix), phases mirror it too: `running`,
// `queued` and a legacy record with no phase at all. `error`/`interrupted`
// mean no engine is running — they await resume, not completion.
function listInflightSessionIds(profile) {
  const dir = path.dirname(pendingTaskPath('sweep-probe'));
  const out = new Set();
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const mine = rec.username === profile || rec.profile === profile || n.startsWith(`${profile}-`);
    if (!mine) continue;
    if (rec.phase !== 'running' && rec.phase !== 'queued' && rec.phase !== undefined) continue;
    if (typeof rec.sessionId === 'string' && rec.sessionId) out.add(rec.sessionId);
    if (typeof rec.activitySessionId === 'string' && rec.activitySessionId) out.add(rec.activitySessionId);
  }
  return out;
}

// ── candidates ────────────────────────────────────────────────────────────────
// ONE readdir of sessions/ (bounded by the index cap plus a few ⚡ side
// sessions) — never a walk of the profile. The phase's own filter is the
// contract for what may be archived: pointers (`current-session*`) and digest
// caches are declined, symlinks are declined, only `sessions/<id>.json` remains.
function listLocalBodies(workDir, firstSessionId = null) {
  const dir = path.join(workDir, archive.SESSIONS_DIR);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const rels = [];
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink()) continue;
    const rel = `${archive.SESSIONS_DIR}/${e.name}`;
    if (archive.archiveRelKind(rel) !== 'session') continue;
    if (!archive.sessionRelId(rel)) continue;
    rels.push(rel);
  }
  rels.sort();
  // The run's own session first: it is the file the caller just wrote, and if a
  // later upload fails the files we care most about are the ones already handled.
  if (firstSessionId) {
    const first = `${archive.SESSIONS_DIR}/${firstSessionId}.json`;
    const i = rels.indexOf(first);
    if (i > 0) { rels.splice(i, 1); rels.unshift(first); }
  }
  return rels;
}

// engineSessionId → rel path, from ONE pass over .agent-home/.claude/projects/.
// Keyed by the file's own id (the last path segment), which is exactly what
// session-store.engineSessions records.
function indexLocalTranscripts(workDir) {
  const map = new Map();
  const root = path.join(workDir, archive.TRANSCRIPTS_DIR);
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return map; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || f.isSymbolicLink()) continue;
      const rel = `${archive.TRANSCRIPTS_DIR}/${d.name}/${f.name}`;
      if (archive.archiveRelKind(rel) !== 'transcript') continue;
      const id = archive.transcriptRelId(rel);
      if (id && !map.has(id)) map.set(id, rel);
    }
  }
  return map;
}

function readEngineSessionIds(abs) {
  let body;
  try { body = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return []; }
  const es = body && body.engineSessions;
  if (!es || typeof es !== 'object') return [];
  return [...new Set(Object.values(es).filter((v) => typeof v === 'string' && v))];
}

// ── light cleanup (step 5) ────────────────────────────────────────────────────
// A HARD-CODED list of per-run regenerable residue — no walk of the profile
// (the full DELETE-class walk belongs to the janitor, issue #1839). Cross-checked
// against config/profile-clean-list.yaml; each entry below carries the rule it
// comes from and the reason it is bounded this way.
//
// Every removal is a PLAIN unlink, deliberately NOT a ledger record: these are
// not phase items. A DELETE record promises a quarantine copy that never existed,
// so `--verify` would fail on every one of them; the ledger stays the record of
// bytes that moved somewhere (blob key / quarantine).
function lightCleanup(workDir) {
  let removed = 0;

  // `.tmp` — clean list `[M1] temp dir`: a temp directory is disposable whole.
  const tmp = path.join(workDir, '.tmp');
  try {
    const n = fs.readdirSync(tmp).length;
    fs.rmSync(tmp, { recursive: true, force: true });
    removed += n;
  } catch { /* not there */ }

  // `*.log` — clean list `[M1] logs — regenerable, any depth`. Only the PROFILE
  // ROOT here: the any-depth half of that rule needs the directory walk the
  // janitor does. (The server logs to stdout/journalctl — these are leftovers
  // from older eras and from agent-created logs.)
  let root;
  try { root = fs.readdirSync(workDir, { withFileTypes: true }); } catch { root = []; }
  for (const e of root) {
    if (!e.isFile() || e.isSymbolicLink() || !e.name.endsWith('.log')) continue;
    try { fs.unlinkSync(path.join(workDir, e.name)); removed++; } catch { /* raced */ }
  }

  // Crash leftovers of the atomic-write primitive (`<file>.<pid>.<uuid>.tmp`,
  // src/atomic-json.js) inside sessions/ — the same category as the `.tmp` rule
  // above, bounded to the one directory the sweep already readdirs (finding
  // every `*.tmp` in the profile WOULD be a walk). A temp file there can only be
  // a crash remnant: the primitive writes and renames synchronously, so one
  // never survives a turn of the event loop.
  let sess;
  try { sess = fs.readdirSync(path.join(workDir, archive.SESSIONS_DIR), { withFileTypes: true }); } catch { sess = []; }
  for (const e of sess) {
    if (!e.isFile() || e.isSymbolicLink() || !e.name.endsWith('.tmp')) continue;
    try { fs.unlinkSync(path.join(workDir, archive.SESSIONS_DIR, e.name)); removed++; } catch { /* raced */ }
  }

  // `.run-inputs/*` from the brief is deliberately NOT swept here — see the note
  // in the PR: src/run-input-store.js already prunes it to its own KEEP=30 on
  // every write, and deleting it right after a run would 404 the «Посмотреть
  // input» button of answers already on screen (previous runs' snapshots are the
  // whole point of that store). The janitor applies the clean-list DELETE rule
  // with a walk when it lands (#1839).

  return removed;
}

module.exports = {
  schedulePostRunSweep,
  runSessionSweep,
  listInflightSessionIds,
  listLocalBodies,
  lightCleanup,
  PHASE_NAME,
  DEFAULT_DELAY_MS,
};
