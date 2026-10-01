'use strict';
// Issue #1916 PR-B — the archive-sessions phase, end to end (epic #1784 M2).
//
// Pattern of test/profile-migrate-runner.test.cjs: the CLI runs as a child
// process with USERS_DIR / AGENT_DATA_DIR / AGENT_TOKENS_DIR on a temp dir,
// PROFILE_MIGRATE_NICED=1 (no ionice re-exec) and --drain-timeout 0. The bucket
// is NOT GCS: GCS_FAKE_DIR points the blob store at a local directory (the
// file-backed backend in src/session-blob-store.js), which is exactly how the
// fake has to be injected — the runner spawns the CLI, so no module seam reaches
// into the child. No live GCS, no ADC, no network.
//
// The profile mixes every ARCHIVE-class file the clean list hands this phase:
//   planned  → 2 session bodies + 1 transcript
//   declined → current-session pointers, a digest cache, junk in sessions/, a
//              symlink, and a git working copy (M3) — none of them may move
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
const CLI = path.join(ROOT, 'scripts', 'profile-migrate', 'cli.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-archive-'));
const USERS = path.join(TMP, 'users');
const DATA = path.join(TMP, 'data');
const TOKENS = path.join(TMP, 'tokens');
const GCS = path.join(TMP, 'gcs');
const LEDGER = (profile) => path.join(DATA, 'migration', profile, 'migration-ledger.jsonl');
const QUAR = (profile) => path.join(DATA, 'migration', 'quarantine', profile);

const CWD = '/home/vova/users/alice/projects/web';
const BODY_1 = JSON.stringify({ id: 's-111-222', topic: 'первая сессия', messages: [{ role: 'user', content: 'привет' }] }, null, 2);
const BODY_2 = JSON.stringify({ id: 's-333-444', topic: 'вторая сессия' }, null, 2);
const TRANSCRIPT = [
  '{"type":"last-prompt","leafUuid":"d","sessionId":"aaa-bbb-ccc"}',
  '{"type":"mode","mode":"normal","sessionId":"aaa-bbb-ccc"}',
  JSON.stringify({ type: 'user', cwd: CWD, sessionId: 'aaa-bbb-ccc', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', cwd: CWD, sessionId: 'aaa-bbb-ccc', message: { role: 'assistant', content: 'ok' } }),
].join('\n');

const TRANSCRIPT_REL = '.agent-home/.claude/projects/-home-vova-users-alice-projects-web/aaa-bbb-ccc.jsonl';
const TRANSCRIPT_KEY = 'profiles/alice/transcripts/home-vova-users-alice-projects-web/aaa-bbb-ccc.jsonl.gz';

const EXPECTED_PLANNED = [
  TRANSCRIPT_REL,
  'sessions/s-111-222.json',
  'sessions/s-333-444.json',
];

let deadFlushPort = 0;
const servers = [];

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    USERS_DIR: USERS,
    AGENT_DATA_DIR: DATA,
    AGENT_TOKENS_DIR: TOKENS,
    AGENT_SECRET: 'test-secret',
    NODE_ENV: 'test',
    AGENT_FLUSH_URL: `http://127.0.0.1:${deadFlushPort}`,
    PROFILE_MIGRATE_NICED: '1',
    GCS_FAKE_DIR: GCS,
    ...extra,
  };
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: baseEnv(extraEnv) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli did not exit in 60s\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function shaFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readLedger(profile) {
  if (!fs.existsSync(LEDGER(profile))) return [];
  return fs.readFileSync(LEDGER(profile), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function walkFiles(dir) {
  const out = [];
  const go = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) go(abs);
      else out.push(path.relative(dir, abs));
    }
  };
  go(dir);
  return out.sort();
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { out.push(`missing ${path.basename(d)}`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs);
      if (e.isDirectory()) { out.push(`d ${rel}`); walk(abs); }
      else if (e.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(abs)}`);
      else out.push(`f ${rel} ${shaFile(abs)}`);
    }
  };
  walk(dir);
  return out;
}

const ALICE = path.join(USERS, 'alice');

function buildAlice() {
  write(path.join(ALICE, 'sessions.json'), `${JSON.stringify([
    { id: 's-111-222', topic: 'первая сессия', lastAt: 100 },
    { id: 's-333-444', topic: 'вторая сессия', lastAt: 200 },
    { id: 's-orphan-no-body', topic: 'тела нет', lastAt: 50 },
  ], null, 2)}\n`);
  write(path.join(ALICE, 'sessions', 's-111-222.json'), BODY_1);
  write(path.join(ALICE, 'sessions', 's-333-444.json'), BODY_2);
  write(path.join(ALICE, 'sessions', 's-111-222.digest.json'), '{"gist":"regenerable cache"}');
  write(path.join(ALICE, 'sessions', 'current-session.json'), '{"id":"s-111-222"}');
  write(path.join(ALICE, 'sessions', 'current-session--1003.json'), '{"id":"s-333-444"}');
  write(path.join(ALICE, 'sessions', 'notes.txt'), 'junk in sessions/');
  fs.symlinkSync('s-111-222.json', path.join(ALICE, 'sessions', 's-link.json'));
  write(path.join(ALICE, TRANSCRIPT_REL), TRANSCRIPT);
  write(path.join(ALICE, 'logs', 'app.log'), 'log line\n');
  write(path.join(ALICE, 'notes', 'keep.md'), '# keep');
  write(path.join(ALICE, 'workspace', 'repo', '.git', 'config'), '[core]');
  write(path.join(ALICE, 'workspace', 'repo', 'file.txt'), 'inside a git working copy');
}

before(async () => {
  fs.mkdirSync(USERS, { recursive: true });
  // Pre-created so the lock (which mkdirs on acquire) cannot make a "nothing
  // was written" assertion flinch.
  fs.mkdirSync(path.join(DATA, 'agent-locks'), { recursive: true });
  fs.mkdirSync(TOKENS, { recursive: true });
  deadFlushPort = await freePort();
  buildAlice();
});

after(() => {
  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('dry-run writes NOTHING and plans only the payload (pointers/digest/junk/symlink/git declined)', async () => {
  const before = snapshot(TMP);
  const r = await runCli(['archive-sessions', '--profile', 'alice', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const p = r.json().profiles[0];
  assert.equal(r.json().mode, 'dry-run');
  assert.equal(p.ok, true);
  assert.equal(p.planned, 3, 'two session bodies + one transcript');
  assert.deepEqual(p.items.map((i) => i.path), EXPECTED_PLANNED, 'sorted plan');
  assert.equal(p.filtered, 7, '2 pointers + digest + junk.txt + symlink + 2 git files declined');
  assert.equal(p.applied, 0);
  assert.equal(p.lock, null, 'a dry-run never takes the lock');
  assert.equal(p.flush, null, 'a dry-run never calls the flush endpoint');

  assert.deepEqual(snapshot(TMP), before, 'dry-run must not create, move or change a single byte');
  assert.equal(fs.existsSync(LEDGER('alice')), false, 'no ledger written');
  assert.equal(fs.existsSync(QUAR('alice')), false, 'no quarantine written');
  assert.deepEqual(walkFiles(GCS), [], 'no object uploaded');
});

test('--apply archives the payload into the blob store and leaves everything else byte-identical', async () => {
  const r = await runCli(['archive-sessions', '--profile', 'alice', '--apply', '--drain-timeout', '0', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.applied, 3);
  assert.equal(p.failed, 0);
  assert.equal(p.filtered, 7, 'the filter still declines the same 7 on apply');
  assert.equal(p.quarantineRoot, null, 'this phase never uses quarantine');

  // payload gone from the VM
  assert.equal(fs.existsSync(path.join(ALICE, 'sessions', 's-111-222.json')), false, 'body archived');
  assert.equal(fs.existsSync(path.join(ALICE, 'sessions', 's-333-444.json')), false, 'body archived');
  assert.equal(fs.existsSync(path.join(ALICE, TRANSCRIPT_REL)), false, 'transcript archived');

  // everything else untouched
  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 'current-session.json'), 'utf8'), '{"id":"s-111-222"}', 'the pointer stays');
  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 'current-session--1003.json'), 'utf8'), '{"id":"s-333-444"}');
  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 's-111-222.digest.json'), 'utf8'), '{"gist":"regenerable cache"}', 'digest cache stays');
  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 'notes.txt'), 'utf8'), 'junk in sessions/');
  assert.equal(fs.readlinkSync(path.join(ALICE, 'sessions', 's-link.json')), 's-111-222.json', 'symlink untouched');
  assert.equal(fs.readFileSync(path.join(ALICE, 'logs', 'app.log'), 'utf8'), 'log line\n', 'DELETE-class untouched');
  assert.equal(fs.readFileSync(path.join(ALICE, 'notes', 'keep.md'), 'utf8'), '# keep');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'repo', 'file.txt'), 'utf8'), 'inside a git working copy', 'git worktree is M3');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'repo', '.git', 'config'), 'utf8'), '[core]');

  // the objects are real gzips of the original bytes
  const stored = {
    'profiles/alice/sessions/s-111-222.json.gz': BODY_1,
    'profiles/alice/sessions/s-333-444.json.gz': BODY_2,
    [TRANSCRIPT_KEY]: TRANSCRIPT,
  };
  assert.deepEqual(walkFiles(GCS), Object.keys(stored).sort(), 'exactly three objects, at the documented keys');
  for (const [key, content] of Object.entries(stored)) {
    const bytes = fs.readFileSync(path.join(GCS, key));
    assert.equal(zlib.gunzipSync(bytes).toString('utf8'), content, `${key} is byte-exact`);
  }

  // the index marker
  const index = JSON.parse(fs.readFileSync(path.join(ALICE, 'sessions.json'), 'utf8'));
  for (const [id, key] of [['s-111-222', 'profiles/alice/sessions/s-111-222.json.gz'], ['s-333-444', 'profiles/alice/sessions/s-333-444.json.gz']]) {
    const rec = index.find((x) => x.id === id);
    assert.equal(rec.archived.key, key, `${id} marker key`);
    assert.equal(rec.archived.sha256, shaFile(path.join(GCS, key)), 'marker sha256 = the stored object');
    assert.equal(rec.archived.size, fs.statSync(path.join(GCS, key)).size, 'marker size = the stored object');
    assert.ok(Number.isFinite(Date.parse(rec.archived.at)), 'marker timestamp');
  }
  assert.equal(index.find((x) => x.id === 's-orphan-no-body').archived, undefined, 'a record without a body is untouched');
  assert.equal(index.length, 3, 'the index keeps every record');

  // the ledger: origin hash in, blob key as dest
  const records = readLedger('alice');
  assert.equal(records.length, 3, 'one record per archived file');
  for (const rec of records) {
    assert.equal(rec.phase, 'archive-sessions');
    assert.equal(rec.action, 'ARCHIVE');
    assert.equal(rec.profile, 'alice');
    assert.equal(rec.sha256.length, 64);
    assert.ok(rec.dest.startsWith('profiles/alice/'), `dest is a blob key: ${rec.dest}`);
  }
  const byPath = Object.fromEntries(records.map((x) => [x.path, x]));
  assert.equal(byPath['sessions/s-111-222.json'].sha256, sha(BODY_1), 'ledger sha is the LOCAL file, not the gzip');
  assert.equal(byPath['sessions/s-111-222.json'].size, Buffer.byteLength(BODY_1));
  assert.equal(byPath['sessions/s-111-222.json'].dest, 'profiles/alice/sessions/s-111-222.json.gz');
  assert.equal(byPath[TRANSCRIPT_REL].dest, TRANSCRIPT_KEY);
});

test('--verify is green: local gone + blob intact for every record', async () => {
  const r = await runCli(['archive-sessions', '--profile', 'alice', '--verify', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.verify.ok, 3);
  assert.equal(p.verify.recreated, 0);
  assert.equal(p.verify.pendingArchived.length, 0, 'nothing is half-archived');
  assert.equal(p.verify.failures.length, 0);
  assert.equal(p.verify.pendingCount, 0, 'nothing planned is missing a record');
  assert.equal(p.lock, null, 'verify is read-only: no lock');
});

test('--verify reports both copies as `pending`, not as a failure (the PR-D sweep finishes it)', async () => {
  write(path.join(ALICE, 'sessions', 's-111-222.json'), BODY_1); // materialized again
  const r = await runCli(['archive-sessions', '--profile', 'alice', '--verify', '--json']);
  assert.equal(r.status, 0, `both copies must not fail verify\n${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.verify.pendingArchived.length, 1);
  assert.equal(p.verify.pendingArchived[0].path, 'sessions/s-111-222.json');
  assert.match(p.verify.pendingArchived[0].message, /both copies/);
  assert.equal(p.verify.ok, 2);
  assert.equal(p.verify.failures.length, 0);
  fs.rmSync(path.join(ALICE, 'sessions', 's-111-222.json'));
});

test('--revert restores every archived file byte-exact from the blob store', async () => {
  const r = await runCli(['archive-sessions', '--profile', 'alice', '--revert', '--drain-timeout', '0', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.revert.restored, 3);
  assert.equal(p.revert.already, 0);
  assert.equal(p.revert.failures.length, 0);

  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 's-111-222.json'), 'utf8'), BODY_1, 'byte-exact');
  assert.equal(fs.readFileSync(path.join(ALICE, 'sessions', 's-333-444.json'), 'utf8'), BODY_2, 'byte-exact');
  assert.equal(fs.readFileSync(path.join(ALICE, TRANSCRIPT_REL), 'utf8'), TRANSCRIPT, 'byte-exact');
  assert.equal(fs.statSync(path.join(ALICE, 'sessions', 's-111-222.json')).mode & 0o777, 0o600, 'session bodies come back 0600');
  assert.equal(fs.statSync(path.join(ALICE, TRANSCRIPT_REL)).mode & 0o777, 0o644, 'transcripts come back readable by the engine');

  const restored = readLedger('alice').filter((x) => x.action === 'RESTORED');
  assert.equal(restored.length, 3, 'every restore is ledgered');
  assert.deepEqual(restored.map((x) => x.path).sort(), [TRANSCRIPT_REL, 'sessions/s-111-222.json', 'sessions/s-333-444.json'].sort());

  // the objects survive a revert (revert restores, it never destroys) and the
  // marker still describes them — the next run re-archives over them.
  assert.deepEqual(walkFiles(GCS).length, 3, 'blobs are still there');

  const v = await runCli(['archive-sessions', '--profile', 'alice', '--verify', '--json']);
  assert.equal(v.status, 0, v.stderr);
  const vp = v.json().profiles[0];
  assert.equal(vp.verify.ok, 3, 'post-revert: every record is `returned` with its local copy present');
  assert.equal(vp.verify.failures.length, 0);
});

test('an upload failure deletes nothing, ledgers ARCHIVE_FAILED and fails the run (exit 2)', async () => {
  const bob = path.join(USERS, 'bob');
  write(path.join(bob, 'sessions.json'), JSON.stringify([{ id: 's-777' }]));
  write(path.join(bob, 'sessions', 's-777.json'), BODY_1);

  const r = await runCli(
    ['archive-sessions', '--profile', 'bob', '--apply', '--drain-timeout', '0', '--json'],
    { GCS_FAKE_FAIL: 'save' },
  );
  assert.equal(r.status, 2, `a failed upload must fail the run\n${r.stdout}\n${r.stderr}`);

  assert.equal(fs.existsSync(path.join(bob, 'sessions', 's-777.json')), true, 'the body never left the VM');
  assert.deepEqual(walkFiles(GCS).filter((k) => k.includes('/bob/')), [], 'and nothing was stored');
  assert.equal(JSON.parse(fs.readFileSync(path.join(bob, 'sessions.json'), 'utf8'))[0].archived, undefined, 'no marker without an upload');

  const records = readLedger('bob');
  assert.deepEqual(records.map((x) => x.action), ['ARCHIVE', 'ARCHIVE_FAILED'],
    'record-before-action, then the compensating record: the fold says `returned`');
  assert.equal(records[1].dest, records[0].dest, 'the compensating record keeps the reserved key');

  // verify: state `returned` + the file present = healthy (the next run retries)
  const v = await runCli(['archive-sessions', '--profile', 'bob', '--verify', '--json']);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.json().profiles[0].verify.ok, 1);
  assert.equal(v.json().profiles[0].verify.failures.length, 0);
});

test('--verify fails (exit 2) when the blob is gone or corrupt while the local copy is too', async () => {
  const carol = path.join(USERS, 'carol');
  write(path.join(carol, 'sessions.json'), JSON.stringify([{ id: 's-888' }]));
  write(path.join(carol, 'sessions', 's-888.json'), BODY_1);

  const ok = await runCli(['archive-sessions', '--profile', 'carol', '--apply', '--drain-timeout', '0', '--json']);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);

  // tamper: replace the stored object with garbage
  const key = 'profiles/carol/sessions/s-888.json.gz';
  fs.writeFileSync(path.join(GCS, key), Buffer.from('not a gzip at all'));

  const v = await runCli(['archive-sessions', '--profile', 'carol', '--verify', '--json']);
  assert.equal(v.status, 2, 'a corrupt archive must fail verify');
  const vp = v.json().profiles[0];
  assert.equal(vp.verify.failures.length, 1);
  assert.equal(vp.verify.failures[0].status, 'corrupt');
  assert.equal(vp.verify.failures[0].state, 'at-dest');
  assert.equal(vp.verify.ok, 0);
});
