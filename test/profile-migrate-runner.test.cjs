'use strict';
// Phase runner end-to-end (epic #1784 + red-team #1808 decisions):
//   · dry-run (the default) writes NOTHING — no lock, no flush, no ledger;
//   · --apply refuses when the profile maintenance lock is held;
//   · DELETE files move to quarantine, UNKNOWN/KEEP stay byte-identical;
//   · POST /internal/flush-profile runs BEFORE the first file is touched and a
//     failing flush aborts the run («flush → snapshot», Q1 / risk R2);
//   · --verify re-checks the post-state, --revert restores byte-exact;
//   · the ionice/nice prefix is detected per platform and degrades gracefully;
//   · EXCLUDE (secrets, #1923): counted as its own class in classSummary,
//     planned by no phase, untouched byte-for-byte by --apply.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'profile-migrate', 'cli.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-runner-'));
const USERS = path.join(TMP, 'users');
const DATA = path.join(TMP, 'data');
const TOKENS = path.join(TMP, 'tokens');
const LEDGER = profile => path.join(DATA, 'migration', profile, 'migration-ledger.jsonl');
const QUAR = profile => path.join(DATA, 'migration', 'quarantine', profile);

let deadFlushPort = 0;
const servers = [];

// A port that nothing listens on: bind, read the port, close. Ephemeral ports
// are not reused immediately, and the runner only needs ECONNREFUSED.
function freePort() {
  return new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    USERS_DIR: USERS,
    AGENT_DATA_DIR: DATA,
    AGENT_TOKENS_DIR: TOKENS,
    AGENT_SECRET: 'test-secret',
    // Dead endpoint by default: tests that care about the flush pass their own.
    AGENT_FLUSH_URL: `http://127.0.0.1:${deadFlushPort}`,
    // Deterministic: skip the ionice/nice re-exec (covered by its own test).
    PROFILE_MIGRATE_NICED: '1',
    ...extra,
  };
}

// Asynchronous on purpose: the flush tests run an HTTP server in THIS process,
// and a blocking spawnSync would starve it (the runner would time out waiting
// for a response the event loop can never deliver).
function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT, env: baseEnv(extraEnv),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli did not exit in 60s\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, json: () => JSON.parse(stdout) });
    });
  });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

// Recursive fingerprint of a tree: missing dir, dirs, file contents (hashed),
// symlinks. Anything the runner writes shows up as a diff.
function snapshot(dir) {
  const out = [];
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { out.push(`missing ${path.basename(d)}`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs);
      if (e.isDirectory()) { out.push(`d ${rel}`); walk(abs); }
      else if (e.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(abs)}`);
      else out.push(`f ${rel} ${sha(abs)}`);
    }
  };
  walk(dir);
  return out;
}

function buildProfile(name, files) {
  const root = path.join(USERS, name);
  for (const [rel, content] of Object.entries(files)) write(path.join(root, rel), content);
  return root;
}

const ALICE = {
  'node_modules/pkg/index.js': 'REGEN-CONTENT-12345',
  'logs/app.log': 'log line\nsecond line\n',
  'notes/todo.md': '# keep me',
  'keep.json': '{"keep":true}',
  'weird.bin': 'UNKNOWN-BYTES',
};

before(async () => {
  fs.mkdirSync(USERS, { recursive: true });
  // Pre-created so the profile lock (which mkdirs on acquire) cannot make an
  // "unchanged tree" assertion flinch.
  fs.mkdirSync(path.join(DATA, 'agent-locks'), { recursive: true });
  fs.mkdirSync(TOKENS, { recursive: true });
  deadFlushPort = await freePort();
});

after(() => {
  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('dry-run (the default mode) writes NOTHING — profile and SYSTEM_ROOT are byte-identical', async () => {
  buildProfile('alice', ALICE);
  const before = snapshot(TMP);

  const plain = await runCli(['delete', '--profile', 'alice']);
  assert.equal(plain.status, 0, plain.stderr);

  const withJson = await runCli(['delete', '--profile', 'alice', '--json']);
  assert.equal(withJson.status, 0, withJson.stderr);
  const summary = withJson.json();
  assert.equal(summary.mode, 'dry-run', 'no mode flag = dry-run');
  assert.equal(summary.ok, true);
  const p = summary.profiles[0];
  assert.equal(p.planned, 2, 'only the two DELETE-class files are planned');
  assert.equal(p.applied, 0);
  assert.equal(p.lock, null, 'a dry-run never takes the lock');
  assert.equal(p.flush, null, 'a dry-run never calls the flush endpoint');
  assert.equal(p.unknown.files, 1, 'UNKNOWN is counted, for the report');
  assert.ok(p.items.every(i => i.action === 'DELETE'), 'only DELETE-class items are handed to the phase');

  assert.deepEqual(snapshot(TMP), before, 'dry-run must not create, move or change a single byte');
  assert.equal(fs.existsSync(LEDGER('alice')), false, 'no ledger written');
  assert.equal(fs.existsSync(QUAR('alice')), false, 'no quarantine written');
});

test('--apply refuses when the profile lock is held: exit 3, nothing touched', async () => {
  const lockFile = path.join(DATA, 'agent-locks', 'alice.lock');
  // A live foreign holder (pid 1 always exists) — never stolen, waited out,
  // or worked around.
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: 1, acquiredAt: Date.now() - 1000, expiresAt: Date.now() + 600_000, reason: 'other-migrator',
  }), { mode: 0o600 });
  const before = snapshot(TMP);

  const r = await runCli(['delete', '--profile', 'alice', '--apply', '--lock-timeout', '300', '--drain-timeout', '0']);
  assert.equal(r.status, 3, `expected exit 3 (lock refused), got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /locked/i, 'the refusal names the lock');
  assert.deepEqual(snapshot(TMP), before, 'a refused apply changes nothing');
  assert.equal(fs.existsSync(LEDGER('alice')), false, 'no ledger record for a refused run');

  fs.rmSync(lockFile, { force: true });
});

test('--apply moves DELETE files to quarantine, leaves UNKNOWN/KEEP byte-identical, ledgers every action', async () => {
  const root = path.join(USERS, 'alice');
  const r = await runCli(['delete', '--profile', 'alice', '--apply', '--drain-timeout', '0']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false, 'DELETE tree gone (emptied dirs pruned)');
  assert.equal(fs.existsSync(path.join(root, 'logs')), false);
  assert.equal(fs.readFileSync(path.join(root, 'notes/todo.md'), 'utf8'), ALICE['notes/todo.md'], 'KEEP untouched');
  assert.equal(fs.readFileSync(path.join(root, 'keep.json'), 'utf8'), ALICE['keep.json'], 'KEEP untouched');
  assert.equal(fs.readFileSync(path.join(root, 'weird.bin'), 'utf8'), ALICE['weird.bin'],
    'epic principle 2: an UNKNOWN file is never touched');

  for (const [rel, content] of Object.entries(ALICE)) {
    const q = path.join(QUAR('alice'), rel);
    if (rel === 'notes/todo.md' || rel === 'keep.json' || rel === 'weird.bin') {
      assert.equal(fs.existsSync(q), false, `${rel} must not be quarantined`);
      continue;
    }
    assert.ok(fs.existsSync(q), `${rel} is quarantined`);
    assert.equal(sha(q), crypto.createHash('sha256').update(content).digest('hex'), `${rel} quarantined byte-identically`);
    assert.equal(fs.readFileSync(q, 'utf8'), content, 'quarantine copy is byte-identical');
  }

  const records = fs.readFileSync(LEDGER('alice'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2, 'one record per action');
  for (const rec of records) {
    assert.deepEqual(Object.keys(rec), ['ts', 'phase', 'profile', 'path', 'sha256', 'size', 'action', 'dest']);
    assert.equal(rec.phase, 'delete');
    assert.equal(rec.profile, 'alice');
    assert.equal(rec.action, 'DELETE');
    assert.equal(rec.sha256.length, 64);
    assert.equal(rec.size, ALICE[rec.path].length);
    assert.equal(rec.dest, rec.path);
  }
});

test('flush endpoint runs BEFORE the first file is touched («flush → snapshot», #1808 Q1)', async () => {
  buildProfile('bob', ALICE);
  const seen = [];
  const { url } = await startServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(body || '{}'),
        deleteFilesStillPresent: fs.existsSync(path.join(USERS, 'bob', 'node_modules', 'pkg', 'index.js')),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, flushed: 3, failed: 0 }));
    });
  });

  const r = await runCli(['delete', '--profile', 'bob', '--apply', '--drain-timeout', '0', '--flush-url', url]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(seen.length, 1, 'exactly one flush call');
  assert.equal(seen[0].url, '/internal/flush-profile');
  assert.equal(seen[0].auth, 'Bearer test-secret', 'AGENT_SECRET is sent as a Bearer token');
  assert.equal(seen[0].body.username, 'bob');
  assert.equal(seen[0].deleteFilesStillPresent, true, 'the flush happens before any file is moved');
  assert.equal(fs.existsSync(path.join(USERS, 'bob', 'node_modules')), false, 'and the apply still ran');
});

test('a failing flush (records still buffered) aborts the apply before touching files', async () => {
  buildProfile('carol', ALICE);
  const { url } = await startServer((req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, flushed: 0, failed: 5 }));
  });
  const before = snapshot(TMP);

  const r = await runCli(['delete', '--profile', 'carol', '--apply', '--drain-timeout', '0', '--flush-url', url]);
  assert.equal(r.status, 2, `flush failure must fail the run\n${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /flush/);
  assert.deepEqual(snapshot(TMP), before, 'nothing changes when the flush fails');
  assert.equal(fs.existsSync(LEDGER('carol')), false, 'no ledger record either');
});

test('--verify re-checks the post-state (ok / recreated / pending) — read-only', async () => {
  const r = await runCli(['delete', '--profile', 'alice', '--verify', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const p = r.json().profiles[0];
  assert.equal(p.verify.ok, 2, 'both applied records check out');
  assert.equal(p.verify.recreated, 0);
  assert.equal(p.verify.pendingCount, 0, 'nothing planned is missing a record');
  assert.equal(p.verify.failures.length, 0);
  assert.equal(p.lock, null, 'verify is read-only: no lock');

  // A run regenerated the dependency tree with identical bytes (npm ci with a
  // lockfile) — quarantine stays intact, verify reports it as `recreated`.
  const regenerated = path.join(USERS, 'alice', 'node_modules', 'pkg', 'index.js');
  write(regenerated, ALICE['node_modules/pkg/index.js']);
  const r2 = await runCli(['delete', '--profile', 'alice', '--verify', '--json']);
  assert.equal(r2.status, 0, r2.stderr);
  const p2 = r2.json().profiles[0];
  assert.equal(p2.verify.recreated, 1);
  assert.equal(p2.verify.ok, 1);
  assert.equal(p2.verify.failures.length, 0, 'a regenerated (identical-content) copy is not a failure');
  assert.equal(p2.verify.pendingCount, 0, 'the regenerated file has a record, so it is not pending');
});

test('--revert replays the ledger in reverse and restores byte-exact', async () => {
  const root = path.join(USERS, 'alice');
  // The expected bytes: what the profile had BEFORE the apply (logs/app.log is
  // in quarantine right now, node_modules/… was regenerated identically).
  const original = {
    node_modules: Buffer.from(ALICE['node_modules/pkg/index.js']),
    logs: Buffer.from(ALICE['logs/app.log']),
  };

  const r = await runCli(['delete', '--profile', 'alice', '--revert', '--drain-timeout', '0']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  assert.deepEqual(fs.readFileSync(path.join(root, 'node_modules/pkg/index.js')), original.node_modules, 'byte-exact');
  assert.deepEqual(fs.readFileSync(path.join(root, 'logs/app.log')), original.logs, 'byte-exact');
  assert.equal(fs.existsSync(path.join(QUAR('alice'), 'logs/app.log')), false, 'the restored copy is consumed from quarantine');
  assert.ok(fs.existsSync(path.join(QUAR('alice'), 'node_modules/pkg/index.js')),
    'an identical duplicate stays in quarantine — only the manual purge destroys, revert never does');

  const records = fs.readFileSync(LEDGER('alice'), 'utf8').trim().split('\n').map(JSON.parse);
  const restored = records.filter(r2 => r2.action === 'RESTORED');
  assert.equal(restored.length, 2, 'every restore is appended to the ledger');
  assert.deepEqual(restored.map(r2 => r2.path).sort(), ['logs/app.log', 'node_modules/pkg/index.js']);

  // Post-revert: fold state is `returned` — verify must be green again.
  const v = await runCli(['delete', '--profile', 'alice', '--verify', '--json']);
  assert.equal(v.status, 0, v.stderr);
  const p = v.json().profiles[0];
  assert.equal(p.verify.ok, 2);
  assert.equal(p.verify.failures.length, 0);

  // Re-applying after a revert works on the same profile (fresh records).
  const again = await runCli(['delete', '--profile', 'alice', '--apply', '--drain-timeout', '0']);
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

// ── EXCLUDE: secrets are counted, never planned (#1923, blocker B1) ────────
const DANA = {
  'playwright-storage-state.json': 'SECRET-STATE',
  '.agent-home/.codex/auth.json': '{"token":"SECRET"}',
  '.mcp.json': '{"mcpServers":{}}',
  '.webpasswd': 'SECRET-PW',
  'kinescope-creds': 'SECRET-CREDS',
  'notes/todo.md': '# keep me',
  'node_modules/pkg/index.js': 'REGEN-CONTENT-12345',
  'weird.bin': 'UNKNOWN-BYTES',
};

test('EXCLUDE: dry-run reports the class in classSummary and hands it to no phase', async () => {
  buildProfile('dana', DANA);

  const r = await runCli(['delete', '--profile', 'dana', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const p = r.json().profiles[0];
  assert.ok(p.stats.EXCLUDE, 'classSummary carries the EXCLUDE class');
  assert.equal(p.stats.EXCLUDE.files, 5, `expected 5 secrets, stats: ${JSON.stringify(p.stats)}`);
  assert.ok(p.stats.EXCLUDE.bytes > 0);
  assert.equal(p.items.filter(i => i.action === 'EXCLUDE').length, 0, 'no EXCLUDE item reaches a phase');
  assert.equal(p.planned, 1, 'only the DELETE-class file is planned');
  assert.ok(p.items.every(i => i.action === 'DELETE'), 'the plan is pure DELETE');

  const t = await runCli(['delete', '--profile', 'dana']);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /EXCLUDE\s+5 secret file\(s\)/, `text report names the class:\n${t.stdout}`);
  assert.match(t.stdout, /planned 1 file/, 'the report is still readable as a plan');
});

test('EXCLUDE: no phase owns the class — apply leaves every secret byte-identical', async () => {
  const phases = require('../scripts/profile-migrate/phases/index.cjs').loadPhases();
  for (const [name, ph] of Object.entries(phases)) {
    assert.ok(!(ph.actions || []).includes('EXCLUDE'), `phase "${name}" must not own EXCLUDE`);
  }

  const root = path.join(USERS, 'dana');
  const before = Object.fromEntries(Object.keys(DANA).map(rel => [rel, sha(path.join(root, rel))]));

  const r = await runCli(['delete', '--profile', 'dana', '--apply', '--drain-timeout', '0']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  for (const [rel, digest] of Object.entries(before)) {
    if (rel === 'node_modules/pkg/index.js') {
      assert.equal(fs.existsSync(path.join(root, rel)), false, 'the DELETE file went to quarantine');
      continue;
    }
    assert.equal(fs.existsSync(path.join(root, rel)), true, `${rel} stays on disk`);
    assert.equal(sha(path.join(root, rel)), digest, `${rel} is byte-identical`);
    assert.equal(fs.existsSync(path.join(QUAR('dana'), rel)), false, `${rel} is not quarantined`);
  }
  const records = fs.readFileSync(LEDGER('dana'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(records.map(x => x.path), ['node_modules/pkg/index.js'],
    'the ledger records the phase action only — never an EXCLUDE');

  const v = await runCli(['delete', '--profile', 'dana', '--verify', '--json']);
  assert.equal(v.status, 0, v.stderr);
  const vp = v.json().profiles[0];
  assert.equal(vp.verify.pendingCount, 0, 'no EXCLUDE file shows up as "planned but unrecorded"');
  assert.equal(vp.verify.failures.length, 0);
});

test('buildNicePrefix detects ionice/nice and degrades gracefully when they are missing', () => {
  const runner = require('../scripts/profile-migrate/runner.cjs');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-fake-bin-'));
  const makeBin = name => {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(p, 0o755);
  };

  try {
    assert.deepEqual(runner.buildNicePrefix({ env: { PATH: binDir } }), [], 'no tools → run unprefixed, never an error');
    makeBin('nice');
    assert.deepEqual(runner.buildNicePrefix({ env: { PATH: binDir } }), ['nice', '-n', '10'],
      'macOS-style box: nice only, no ionice');
    makeBin('ionice');
    assert.deepEqual(runner.buildNicePrefix({ env: { PATH: binDir } }), ['ionice', '-c', '3', '-n', '7', 'nice', '-n', '10'],
      'Linux: idle I/O class first, then nice');
    assert.equal(runner.buildNicePrefix({ env: { PATH: path.join(binDir, 'nope') } }).length, 0);
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
