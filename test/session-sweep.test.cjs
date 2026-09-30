'use strict';
// Issue #1916 PR-D — the post-run session sweep (epic #1784 M2, the owner's
// main requirement: «после рана сессия уезжает в GCS и удаляется с VM»).
//
// What this file owns:
//   · the happy path — run → sweep → NO body and NO transcript left on the VM,
//     `archived:{key,sha256,size}` in the index, byte-exact gzip in the bucket;
//   · the safety contract — an in-flight run pins its session (skip), a held
//     maintenance lock skips the whole sweep, a failed upload deletes NOTHING;
//   · the deferral — scheduling the sweep does no work synchronously and never
//     delays the run that scheduled it (the runner trigger is checked through
//     the real runTask, same stop-gate harness as test/stop-trace.test.cjs);
//   · the ledger contract — sweep records are `phase: archive-sessions`, so the
//     migrate CLI --verify/--revert treat them exactly like its own;
//   · the ⚡ side session — archived without an index marker and brought back by
//     PR-C's marker-less admission probe.
//
// No live GCS: GCS_FAKE_DIR points the blob store at a temp directory (the
// file-backed backend of src/session-blob-store.js), GCS_FAKE_FAIL injects an
// outage. NODE_ENV must not be `production` — that is where the fake is
// refused. Everything below is set BEFORE the first src/ require: data-paths
// resolves USERS_DIR / AGENT_DATA_DIR at require time.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sweep-'));
const USERS = path.join(TMP, 'users');
const DATA = path.join(TMP, 'data');
const GCS = path.join(TMP, 'gcs');

process.env.NODE_ENV = 'test';
process.env.GCS_FAKE_DIR = GCS;
process.env.USERS_DIR = USERS;
process.env.AGENT_DATA_DIR = DATA;
process.env.AGENT_TOKENS_DIR = path.join(TMP, 'tokens');
process.env.AGENT_SECRET = 'test-secret';
// Runner bits the stop-gate harness needs (mirrors test/stop-trace.test.cjs).
process.env.MIN_FREE_RAM_MB = '0';
process.env.TELEGRAM_API_URL = 'http://127.0.0.1:9';
// The runner trigger is DEFERRED: keep a margin so «the run resolved while the
// body was still local» is an observation, not a race.
process.env.POST_RUN_SWEEP_DELAY_MS = '400';

const sweep = require('../src/session-sweep');
const materialize = require('../src/session-materialize');
const runner = require('../src/runner');
const { appendBuffered, bufferedRecords } = require('../src/jsonl-batched-flush');

const CLI = path.join(ROOT, 'scripts', 'profile-migrate', 'cli.mjs');
const LEDGER = (p) => path.join(DATA, 'migration', p, 'migration-ledger.jsonl');
const LOCK = (p) => path.join(DATA, 'agent-locks', `${p}.lock`);
const PENDING = path.join(DATA, 'pending-tasks');

const CWD = '/home/vova/users/alice/projects/web';
const CLAUDE_DIR = '-home-vova-users-alice-projects-web'; // claudeProjectSlug(CWD)
const TRANSCRIPT_REL = `.agent-home/.claude/projects/${CLAUDE_DIR}/u-1.jsonl`;
const TRANSCRIPT = [
  '{"type":"last-prompt","leafUuid":"d","sessionId":"u-1"}',
  JSON.stringify({ type: 'user', cwd: CWD, sessionId: 'u-1', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', cwd: CWD, sessionId: 'u-1', message: { role: 'assistant', content: 'ok' } }),
].join('\n');

const bodyOf = (id, extra = {}) => JSON.stringify({
  id, topic: `сессия ${id}`, messageCount: 2, lastAt: 100,
  messages: [{ role: 'user', content: 'hi', at: 1 }, { role: 'assistant', content: 'ok', at: 2 }],
  ...extra,
}, null, 2);

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const readLedger = (profile) => {
  if (!fs.existsSync(LEDGER(profile))) return [];
  return fs.readFileSync(LEDGER(profile), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const index = (profile) => JSON.parse(fs.readFileSync(path.join(USERS, profile, 'sessions.json'), 'utf8'));
const bodyPath = (profile, id) => path.join(USERS, profile, 'sessions', `${id}.json`);

/** A profile with one body, its transcript, and every NON-payload neighbour the
 *  phase filter must decline (pointer, digest cache, junk, symlink). */
function makeProfile(profile, { id = 's-111', withTranscript = true, extraIndex = [] } = {}) {
  const root = path.join(USERS, profile);
  const body = bodyOf(id, { engineSessions: { claude: 'u-1', opencode: 'oc-1' } });
  write(path.join(root, 'sessions.json'), `${JSON.stringify([
    { id, topic: `сессия ${id}`, lastAt: 100, messageCount: 2 },
    ...extraIndex,
  ], null, 2)}\n`);
  write(path.join(root, 'sessions', `${id}.json`), body);
  write(path.join(root, 'sessions', 'current-session-4242.json'), `{"id":"${id}"}`);
  write(path.join(root, 'sessions', `${id}.digest.json`), '{"gist":"regenerable cache"}');
  write(path.join(root, 'sessions', 'notes.txt'), 'junk in sessions/');
  write(path.join(root, 'notes', 'keep.md'), '# keep');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  try { fs.symlinkSync(`${id}.json`, path.join(root, 'sessions', 's-link.json')); } catch { /* exists */ }
  if (withTranscript) write(path.join(root, TRANSCRIPT_REL), TRANSCRIPT);
  return { root, body };
}

before(() => {
  fs.mkdirSync(USERS, { recursive: true });
  // Pre-created so a lock/check assertion cannot flinch on the directory itself.
  fs.mkdirSync(path.join(DATA, 'agent-locks'), { recursive: true });
  fs.mkdirSync(PENDING, { recursive: true });
});
after(() => {
  delete process.env.GCS_FAKE_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── 1. the contract: nothing but the index and pointers is left on the VM ─────

test('sweep: body + transcript leave the VM, the marker stands, the neighbours do not move', async () => {
  const profile = 'alice';
  const { root, body } = makeProfile(profile);
  // Per-run residue the light cleanup owns, plus files it must NOT touch.
  write(path.join(root, '.tmp', 'scratch.txt'), 'temp');
  write(path.join(root, 'app.log'), 'log line\n');
  write(path.join(root, 'sub', 'deep.log'), 'nested — the any-depth rule is the janitor\'s\n');
  write(path.join(root, '.run-inputs', 'alice-1.txt'), 'the input of the answer on screen');

  const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-111', taskId: 'alice-1' });
  assert.equal(r.skipped, null, JSON.stringify(r));
  assert.deepEqual(r.archived.slice().sort(), ['sessions/s-111.json', TRANSCRIPT_REL].slice().sort(),
    'exactly the body and its transcript');
  assert.equal(r.failed.length, 0);

  // the payload is gone
  assert.equal(fs.existsSync(bodyPath(profile, 's-111')), false, 'no session body on the VM');
  assert.equal(fs.existsSync(path.join(root, TRANSCRIPT_REL)), false, 'no engine transcript on the VM');
  // opencode transcripts live in SQLite — no file, no failure
  assert.equal(r.archived.some((p) => p.includes('oc-1')), false);

  // the neighbours are byte-identical (declared by the phase filter, kept by the sweep)
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 'current-session-4242.json'), 'utf8'), '{"id":"s-111"}', 'the pointer stays');
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 's-111.digest.json'), 'utf8'), '{"gist":"regenerable cache"}', 'the digest cache stays');
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 'notes.txt'), 'utf8'), 'junk in sessions/');
  assert.equal(fs.readlinkSync(path.join(root, 'sessions', 's-link.json')), 's-111.json', 'a symlink is never payload');
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'keep.md'), 'utf8'), '# keep');

  // the light cleanup — O(1) list, and `.run-inputs` deliberately NOT swept
  assert.equal(fs.existsSync(path.join(root, '.tmp')), false, '.tmp is swept whole');
  assert.equal(fs.existsSync(path.join(root, 'app.log')), false, 'root *.log is swept');
  assert.equal(fs.existsSync(path.join(root, 'sub', 'deep.log')), true, 'any-depth *.log needs the janitor walk (#1839)');
  assert.equal(fs.existsSync(path.join(root, '.run-inputs', 'alice-1.txt')), true,
    '.run-inputs keeps the snapshot behind the «Посмотреть input» button (self-pruning store)');

  // the index marker
  const rec = index(profile).find((x) => x.id === 's-111');
  assert.equal(rec.archived.key, 'profiles/alice/sessions/s-111.json.gz');
  assert.equal(rec.archived.sha256, sha(fs.readFileSync(path.join(GCS, rec.archived.key))), 'marker sha = the stored object');
  assert.equal(rec.archived.size, fs.statSync(path.join(GCS, rec.archived.key)).size);
  assert.ok(Number.isFinite(Date.parse(rec.archived.at)));
  assert.equal(index(profile).length, 1, 'the index keeps every record');

  // the stored objects are byte-exact gzips of the originals
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(GCS, rec.archived.key))).toString('utf8'), body);
  const tkey = `profiles/alice/transcripts/home-vova-users-alice-projects-web/u-1.jsonl.gz`;
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(GCS, tkey))).toString('utf8'), TRANSCRIPT);

  // the ledger: the SAME phase/module the CLI writes
  const records = readLedger(profile);
  assert.equal(records.length, 2);
  for (const rec2 of records) {
    assert.equal(rec2.phase, 'archive-sessions', 'phase name is the CLI phase — --verify/--revert fold them together');
    assert.equal(rec2.action, 'ARCHIVE');
    assert.equal(rec2.profile, profile);
    assert.ok(rec2.dest.startsWith('profiles/alice/'), `blob key as dest: ${rec2.dest}`);
    assert.equal(rec2.sha256.length, 64);
  }
  const byPath = Object.fromEntries(records.map((x) => [x.path, x]));
  assert.equal(byPath['sessions/s-111.json'].sha256, sha(body), 'ledger sha is the LOCAL file, not the gzip');
  assert.equal(byPath[TRANSCRIPT_REL].dest, tkey);

  // the lock is released
  assert.equal(fs.existsSync(LOCK(profile)), false, 'the maintenance lock never outlives the sweep');
});

// ── 2. in-flight runs pin their own session ───────────────────────────────────

test('sweep: a session with an in-flight run is skipped, everything else still sweeps', async () => {
  const profile = 'bob';
  const { root } = makeProfile(profile, { id: 's-live' });
  write(path.join(root, 'sessions', 's-idle.json'), bodyOf('s-idle'));
  write(path.join(PENDING, 'bob-1.json'), JSON.stringify({
    taskId: 'bob-1', username: profile, phase: 'running', sessionId: 's-live', activitySessionId: 's-live',
  }));

  try {
    const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-live' });
    assert.equal(r.skipped, null);
    assert.deepEqual(r.skippedSessions, ['s-live'], 'the run in flight owns its body');
    assert.equal(fs.existsSync(bodyPath(profile, 's-live')), true, 'never touch a body being written');
    assert.equal(r.archived.includes('sessions/s-idle.json'), true, 'the idle sibling still leaves');
    assert.equal(fs.existsSync(bodyPath(profile, 's-idle')), false);
    assert.equal(readLedger(profile).some((x) => x.path === 'sessions/s-live.json'), false, 'no ledger record for a skip');

    // A journal record in a terminal phase pins nothing (the engine is gone).
    fs.writeFileSync(path.join(PENDING, 'bob-1.json'), JSON.stringify({
      taskId: 'bob-1', username: profile, phase: 'error', sessionId: 's-live',
    }));
    const r2 = await sweep.runSessionSweep({ profile, workDir: root });
    assert.deepEqual(r2.skippedSessions, [], 'error/interrupted await resume, they are not a live writer');
    assert.equal(fs.existsSync(bodyPath(profile, 's-live')), false);
  } finally {
    fs.rmSync(path.join(PENDING, 'bob-1.json'), { force: true });
  }
});

// ── 3. a failed upload deletes nothing ────────────────────────────────────────

test('sweep: upload failure keeps every file locally and ledgers ARCHIVE_FAILED', async () => {
  const profile = 'carol';
  const { root } = makeProfile(profile, { id: 's-777' });
  process.env.GCS_FAKE_FAIL = 'save';
  try {
    const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-777' });
    assert.equal(r.archived.length, 0);
    assert.equal(r.failed.length, 1, 'the body failed');
    assert.match(r.failed[0].error, /GCS_FAKE_FAIL/);

    assert.equal(fs.existsSync(bodyPath(profile, 's-777')), true, 'the body never left the VM');
    assert.equal(fs.existsSync(path.join(root, TRANSCRIPT_REL)), true,
      '«ничего не удаляем»: the body failed, so its transcript was not attempted either');
    assert.equal(index(profile)[0].archived, undefined, 'no marker without an upload');

    const records = readLedger(profile);
    assert.deepEqual(records.map((x) => x.action), ['ARCHIVE', 'ARCHIVE_FAILED'],
      'record-before-action, then the compensating record: the fold says `returned`');
    assert.equal(records[1].dest, records[0].dest, 'the compensating record keeps the reserved key');
    assert.equal(fs.existsSync(LOCK(profile)), false, 'the lock is released even on failure');
  } finally {
    delete process.env.GCS_FAKE_FAIL;
  }
});

// ── 4. a held maintenance lock skips the sweep ────────────────────────────────

test('sweep: a held profile lock skips (never waits, never steals)', async () => {
  const profile = 'dave';
  const { root } = makeProfile(profile, { id: 's-888', withTranscript: false });
  // A live holder: our own pid is alive, the expiry is in the future.
  write(LOCK(profile), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), expiresAt: Date.now() + 600_000, reason: 'profile-migrate:delete' }, null, 2));
  try {
    const t0 = Date.now();
    const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-888' });
    assert.equal(r.skipped, 'lock');
    assert.ok(Date.now() - t0 < 1000, 'timeoutMs 0 — a busy lock is a skip, never a wait');
    assert.equal(fs.existsSync(bodyPath(profile, 's-888')), true, 'the body waits for the maintenance to finish');
    assert.equal(readLedger(profile).length, 0, 'a skipped sweep writes no records');
    assert.equal(r.holder.reason, 'profile-migrate:delete', 'the holder is reported for the log');
  } finally {
    fs.rmSync(LOCK(profile), { force: true });
  }
});

// ── 5. deferred: scheduling does no work ──────────────────────────────────────

test('sweep: the deadline bounds the maintenance window — the rest waits for the next run', async () => {
  const profile = 'ivy';
  const { root } = makeProfile(profile, { id: 's-303' });
  write(path.join(root, 'sessions', 's-304.json'), bodyOf('s-304'));

  // deadlineMs 0 = «stop at once»: nothing is archived, nothing is deleted, the
  // lock is released — the property that keeps a big first sweep from parking
  // the profile (SWEEP_DEADLINE_MS in production).
  const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-303', deadlineMs: 0 });
  assert.equal(r.aborted, 'deadline');
  assert.equal(r.archived.length, 0);
  assert.equal(fs.existsSync(bodyPath(profile, 's-303')), true, 'a deadline never deletes');
  assert.equal(fs.existsSync(path.join(root, TRANSCRIPT_REL)), true);
  assert.equal(readLedger(profile).length, 0, 'and never records');
  assert.equal(fs.existsSync(LOCK(profile)), false, 'the gate is released');

  // …and the very next sweep finishes the job.
  const r2 = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-303' });
  assert.equal(r2.aborted, undefined);
  assert.equal(fs.existsSync(bodyPath(profile, 's-303')), false);
  assert.equal(fs.existsSync(bodyPath(profile, 's-304')), false);
});

test('schedulePostRunSweep arms a timer only — the run that scheduled it is never held up', async () => {
  const profile = 'erin';
  const { root } = makeProfile(profile, { id: 's-999', withTranscript: false });

  const p = sweep.schedulePostRunSweep({ profile, workDir: root, sessionId: 's-999', delayMs: 100 });
  assert.equal(readLedger(profile).length, 0, 'nothing ran synchronously — no lock, no flush, no upload');
  assert.equal(fs.existsSync(bodyPath(profile, 's-999')), true);
  assert.equal(fs.existsSync(LOCK(profile)), false);

  // The sweep timer is unref'd on purpose (a pending sweep must never keep a process alive), so
  // an idle event loop would drain before it fires — hold a ref'd handle for the two awaits.
  const keepAlive = setInterval(() => {}, 25);
  try {
    const r = await p;
    assert.equal(r.skipped, null, JSON.stringify(r));
    assert.equal(fs.existsSync(bodyPath(profile, 's-999')), false, 'the deferred sweep ran');
    assert.equal(fs.existsSync(LOCK(profile)), false);

    // Scheduling must never reject: the runner calls it fire-and-forget.
    const bad = await sweep.schedulePostRunSweep({ profile: 'no-such', workDir: path.join(TMP, 'gone'), delayMs: 0 });
    assert.equal(bad.skipped, 'no-workdir');
  } finally {
    clearInterval(keepAlive);
  }
});

// ── 6. flush before touch ─────────────────────────────────────────────────────

test('sweep: the batched JSONL buffer is flushed before a single file is touched', async () => {
  const profile = 'frank';
  const { root } = makeProfile(profile, { id: 's-101', withTranscript: false });
  const buffered = path.join(root, 'artifacts', 'artifacts.jsonl');
  fs.mkdirSync(path.dirname(buffered), { recursive: true });
  appendBuffered(buffered, { kind: 'test' });
  assert.equal(fs.existsSync(buffered), false, 'the record is in memory only');
  assert.ok(bufferedRecords(buffered).length > 0);

  const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-101' });
  assert.equal(r.skipped, null);
  assert.ok(r.flushed > 0, 'flushAll ran inside the sweep');
  assert.equal(fs.existsSync(buffered), true, 'buffered records reached disk before the archive');
  assert.equal(bufferedRecords(buffered).length, 0);
  assert.equal(fs.existsSync(bodyPath(profile, 's-101')), false, 'and the archive still happened');
});

// ── 7. ⚡ side sessions: no index record, still archived, still reachable ─────

test('sweep: a ⚡ side session (no index record) is archived marker-less and comes back via the admission probe', async () => {
  const profile = 'grace';
  const root = path.join(USERS, profile);
  const side = bodyOf('qa-abcdef0123456789');
  write(path.join(root, 'sessions.json'), '[]\n'); // deliberately NO record for it
  write(path.join(root, 'sessions', 'qa-abcdef0123456789.json'), side);

  const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 'qa-abcdef0123456789' });
  assert.deepEqual(r.archived, ['sessions/qa-abcdef0123456789.json']);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'qa-abcdef0123456789.json')), false);
  assert.equal(index(profile).length, 0, 'a side session is never added to the index');
  assert.equal(readLedger(profile)[0].dest, 'profiles/grace/sessions/qa-abcdef0123456789.json.gz',
    'the key is derivable without a marker — that is what the probe recomputes');

  // PR-C admission hook: marker-less probe brings it back, byte-exact.
  const mat = await materialize.materializeRunSessions({ workDir: root, profile, sessionId: 'qa-abcdef0123456789' });
  assert.deepEqual(mat.materialized, ['qa-abcdef0123456789']);
  assert.equal(fs.readFileSync(path.join(root, 'sessions', 'qa-abcdef0123456789.json'), 'utf8'), side);

  // …and a probe for an id that was never archived is a no-op, not an error.
  const miss = await materialize.materializeRunSessions({ workDir: root, profile, sessionId: 'qa-never-existed' });
  assert.deepEqual(miss.materialized, []);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'qa-never-existed.json')), false);
});

// ── 8. the runner trigger: a run that settles schedules the sweep ─────────────

test('runTask: the run resolves while the body is still local, the sweep lands right after', async () => {
  const profile = 'alice2';
  const root = path.join(USERS, profile);
  const { body } = makeProfile(profile, { id: 's-run', withTranscript: false });

  // Stop-gate harness (test/stop-trace.test.cjs): the run journals, enters
  // admission and stops BEFORE the engine spawns — so no Claude is needed, but
  // everything after admission.run (the finally that arms the sweep) is the real
  // production path.
  runner._queuedByOwner.set(runner._ownerKey(profile, 's-run'), 1);
  runner.stopSessionTask(profile, 's-run');
  try {
    const p = runner.runTask({
      taskId: 'alice2-run-1',
      user: { id: 4242, name: profile, username: profile, workDir: root },
      task: 'привет', context: null, sessionId: 's-run',
      initiatedAt: Date.now() - 60_000,
      secrets: {}, initialMsgId: null,
    });
    assert.ok(runner.getPendingTasks().some((x) => x.taskId === 'alice2-run-1'), 'the run is journaled');
    const out = await p;
    assert.equal(typeof out, 'string', 'the run settled');

    // The run's own journal entry is cleared BEFORE the sweep is armed, so the
    // in-flight guard never pins this session to itself.
    assert.equal(runner.getPendingTasks().some((x) => x.taskId === 'alice2-run-1'), false);

    // Deferred: POST_RUN_SWEEP_DELAY_MS (400ms) has not elapsed yet — the answer
    // never waited for an upload.
    assert.equal(fs.existsSync(bodyPath(profile, 's-run')), true, 'the sweep has not run yet');
    assert.equal(readLedger(profile).length, 0, 'nothing archived synchronously with the run');

    const gone = await waitFor(() => !fs.existsSync(bodyPath(profile, 's-run')), 5000);
    assert.ok(gone, 'the post-run sweep archived the body after the run settled');
    const rec = index(profile).find((x) => x.id === 's-run');
    assert.ok(rec.archived && rec.archived.key, 'marker written by the deferred sweep');
    assert.equal(fs.existsSync(LOCK(profile)), false, 'lock released');
  } finally {
    runner._queuedByOwner.clear();
    fs.rmSync(path.join(PENDING, 'alice2-run-1.json'), { force: true });
  }
});

// ── 9. the sweep's records are first-class migrate records ────────────────────

test('sweep records verify and revert through the migrate CLI', async () => {
  const profile = 'henry';
  const { root, body } = makeProfile(profile, { id: 's-202' });

  const r = await sweep.runSessionSweep({ profile, workDir: root, sessionId: 's-202' });
  assert.deepEqual(r.archived.slice().sort(), ['sessions/s-202.json', TRANSCRIPT_REL].slice().sort());

  const v = await runCli(['archive-sessions', '--profile', profile, '--verify', '--json']);
  assert.equal(v.status, 0, `${v.stdout}\n${v.stderr}`);
  const vp = v.json().profiles[0];
  assert.equal(vp.verify.ok, 2, 'sweep records verify green: local gone + blob intact');
  assert.equal(vp.verify.failures.length, 0);
  assert.equal(vp.verify.pendingArchived.length, 0);

  const rev = await runCli(['archive-sessions', '--profile', profile, '--revert', '--drain-timeout', '0', '--json']);
  assert.equal(rev.status, 0, `${rev.stdout}\n${rev.stderr}`);
  const rp = rev.json().profiles[0];
  assert.equal(rp.revert.restored, 2, 'revert replays the sweep records');
  assert.equal(fs.readFileSync(bodyPath(profile, 's-202'), 'utf8'), body, 'byte-exact');
  assert.equal(fs.readFileSync(path.join(root, TRANSCRIPT_REL), 'utf8'), TRANSCRIPT, 'byte-exact');
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// The CLI runs as a child process (test/profile-migrate-archive-sessions.test.cjs
// pattern) so --verify/--revert see exactly what a production operator would.
async function runCli(args) {
  const deadFlushPort = await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        USERS_DIR: USERS,
        AGENT_DATA_DIR: DATA,
        AGENT_TOKENS_DIR: path.join(TMP, 'tokens'),
        AGENT_FLUSH_URL: `http://127.0.0.1:${deadFlushPort}`,
        PROFILE_MIGRATE_NICED: '1',
        GCS_FAKE_DIR: GCS,
        NODE_ENV: 'test',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cli did not exit in 60s\n${stdout}\n${stderr}`)); }, 60_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}
