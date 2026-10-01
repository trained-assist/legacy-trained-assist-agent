'use strict';
// Issue #87 D1 / epic #1784 M3 — the worktree phase, end to end.
//
// Pattern of test/profile-migrate-archive-sessions.test.cjs: the CLI runs as a
// child process with USERS_DIR / AGENT_DATA_DIR / AGENT_TOKENS_DIR on a temp
// dir, PROFILE_MIGRATE_NICED=1 (no ionice re-exec), --drain-timeout 0 and
// GCS_FAKE_DIR (the file-backed bucket of src/session-blob-store.js — no ADC,
// no network, no real bucket). git is real: the whole phase is a judgement
// about git state, so the fixtures are real repositories with a real local
// remote (isolated from the developer's global config via GIT_CONFIG_GLOBAL).
//
// Fixture profile `alice` — one copy per branch of M3's decision:
//   workspace/clean-repo/      committed + pushed, clean      → quarantine (DELETE)
//   workspace/dirty-repo/      modified + untracked + ignored → bundle archive
//   workspace/unpushed-repo/   clean but 1 commit not pushed  → bundle archive
//   workspace/unborn-dirty/    staged file, never committed   → bundle archive
//   workspace/fake-repo/       .git that git refuses          → DECLINED
// Foreign classes inside the copies (node_modules DELETE, auth.json EXCLUDE,
// sessions/ M2-ARCHIVE) must come through every step byte-identical — the
// phase owns only the `when: git-repo` class.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'profile-migrate', 'cli.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-worktree-'));
const USERS = path.join(TMP, 'users');
const DATA = path.join(TMP, 'data');
const TOKENS = path.join(TMP, 'tokens');
const GCS = path.join(TMP, 'gcs');
const LEDGER = (profile) => path.join(DATA, 'migration', profile, 'migration-ledger.jsonl');
const QUAR = (profile) => path.join(DATA, 'migration', 'quarantine', profile);
const KEY = (profile, root) => `profiles/${profile}/worktrees/${root}.tar.gz`;

// Isolated git: the developer's/global config must not decide what "clean"
// means (status.showUntrackedFiles, core.autocrlf, …) and commits need an
// identity without touching ~/.gitconfig.
const GIT_CONFIG_GLOBAL = path.join(TMP, 'gitconfig-global');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: os.devnull,
  GIT_AUTHOR_NAME: 'worktree-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'worktree-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

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
    ...GIT_ENV,
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

// Recursive fingerprint of a tree: dirs, file contents (hashed), symlinks —
// everything a phase could move, remove or rewrite shows up as a diff.
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

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout;
}

// A committed, pushed copy: local repo + local bare remote, everything on both.
function makePushedRepo(dir) {
  const bare = `${dir}-remote.git`;
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', bare], TMP);
  git(['init', '-q', '-b', 'main'], dir);
  git(['remote', 'add', 'origin', bare], dir);
}

// Real copies gitignore their foreign junk (node_modules, secrets, session
// bodies) — without that git sees `?? node_modules/` and the copy is legitimately
// «dirty» by #1784's definition (any uncommitted state). The fixtures model
// what real working copies look like; foreign classes stay on disk either way.
function writeGitIgnore(dir, extra = []) {
  write(path.join(dir, '.gitignore'), ['node_modules/', 'auth.json', 'sessions/', ...extra, ''].join('\n'));
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
}

const ALICE = path.join(USERS, 'alice');

function buildAlice() {
  // --- clean-repo: committed + pushed, nothing dirty ------------------------
  const clean = path.join(ALICE, 'workspace', 'clean-repo');
  makePushedRepo(clean);
  writeGitIgnore(clean);
  write(path.join(clean, 'README.md'), '# clean copy\n');
  write(path.join(clean, 'src', 'app.js'), 'console.log(1)\n');
  write(path.join(clean, 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(clean, 'run.sh'), 0o755);
  commitAll(clean, 'init');
  git(['push', '-q', 'origin', 'main'], clean);
  // foreign classes inside the copy — never the worktree phase's to touch:
  write(path.join(clean, 'node_modules', 'pkg', 'index.js'), 'REGEN-CONTENT');
  write(path.join(clean, 'auth.json'), '{"token":"secret-1"}');
  write(path.join(clean, 'sessions', 's-1.json'), '{"id":"s-1"}');

  // --- dirty-repo: pushed, then modified + untracked + gitignored ------------
  const dirty = path.join(ALICE, 'workspace', 'dirty-repo');
  makePushedRepo(dirty);
  write(path.join(dirty, 'src', 'main.js'), 'v1\n');
  write(path.join(dirty, '.gitignore'), '*.secret\n');
  write(path.join(dirty, 'tracked.txt'), 'tracked\n');
  commitAll(dirty, 'init');
  git(['push', '-q', 'origin', 'main'], dirty);
  write(path.join(dirty, 'src', 'main.js'), 'v2 with uncommitted work\n'); // modified
  write(path.join(dirty, 'untracked.txt'), 'never added\n');               // untracked
  write(path.join(dirty, 'creds.secret'), 'gitignored-but-owned\n');       // ignored → payload
  write(path.join(dirty, 'auth.json'), '{"token":"secret-2"}');            // EXCLUDE → stays

  // --- unpushed-repo: clean tree, one commit the remote never saw ------------
  const unpushed = path.join(ALICE, 'workspace', 'unpushed-repo');
  makePushedRepo(unpushed);
  write(path.join(unpushed, 'a.txt'), 'one\n');
  commitAll(unpushed, 'init');
  git(['push', '-q', 'origin', 'main'], unpushed);
  write(path.join(unpushed, 'b.txt'), 'two — local only\n');
  commitAll(unpushed, 'local-only commit'); // pushed state stays behind

  // --- unborn-dirty: staged file, no commits at all --------------------------
  const unborn = path.join(ALICE, 'workspace', 'unborn-dirty');
  fs.mkdirSync(unborn, { recursive: true });
  git(['init', '-q', '-b', 'main'], unborn);
  write(path.join(unborn, 'new.txt'), 'staged but never committed\n');
  git(['add', 'new.txt'], unborn);

  // --- fake-repo: a .git that git refuses to look at -------------------------
  write(path.join(ALICE, 'workspace', 'fake-repo', '.git', 'config'), '[core]\n');
  write(path.join(ALICE, 'workspace', 'fake-repo', 'file.txt'), 'not a repository\n');

  // --- outside any copy ------------------------------------------------------
  write(path.join(ALICE, 'notes', 'keep.md'), '# keep me\n');
}

// Baselines taken before the first apply, compared after every later step.
let baseline = null;

before(async () => {
  fs.mkdirSync(USERS, { recursive: true });
  // Pre-created so the profile lock (which mkdirs on acquire) cannot make a
  // "nothing was written" assertion flinch.
  fs.mkdirSync(path.join(DATA, 'agent-locks'), { recursive: true });
  fs.mkdirSync(TOKENS, { recursive: true });
  fs.writeFileSync(GIT_CONFIG_GLOBAL, '');
  deadFlushPort = await freePort();
  buildAlice();
});

after(() => {
  for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the CLI discovers the phase but defaults to a read-only dry-run', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\bworktree\b/, 'loadPhases() discovers phases/worktree.cjs');

  const cleanDir = path.join(ALICE, 'workspace', 'clean-repo');
  baseline = {
    tree: snapshot(TMP),
    // filled from the DRY-RUN PLAN below — the plan IS the phase's owned set:
    cleanOwned: null,
    dirty: snapshot(path.join(ALICE, 'workspace', 'dirty-repo')),
    unpushed: snapshot(path.join(ALICE, 'workspace', 'unpushed-repo')),
    unborn: snapshot(path.join(ALICE, 'workspace', 'unborn-dirty')),
    fake: snapshot(path.join(ALICE, 'workspace', 'fake-repo')),
  };

  const r = await runCli(['worktree', '--profile', 'alice', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(r.json().mode, 'dry-run');
  assert.equal(p.ok, true);
  assert.equal(p.lock, null, 'a dry-run never takes the lock');
  assert.equal(p.flush, null, 'a dry-run never calls the flush endpoint');

  // clean copy → one DELETE item per owned file, grouped by its copy
  const cleanItems = p.items.filter((i) => i.path.startsWith('workspace/clean-repo/'));
  assert.ok(cleanItems.length >= 4, `clean copy planned per file, got ${cleanItems.length}`);
  assert.ok(cleanItems.every((i) => i.action === 'DELETE' && i.kind === 'file'), 'a clean copy plans quarantine moves');
  assert.ok(cleanItems.some((i) => i.path === 'workspace/clean-repo/src/app.js'));
  assert.ok(!cleanItems.some((i) => i.path.includes('node_modules')), 'DELETE-class files belong to the delete phase');
  assert.ok(!cleanItems.some((i) => i.path.endsWith('/auth.json')), 'EXCLUDE never reaches a phase');
  assert.ok(!cleanItems.some((i) => i.path.includes('/sessions/')), 'the M2 session payload is not M3\'s');
  // The plan defines "owned" for every later assertion, with pre-apply hashes:
  baseline.cleanOwned = Object.fromEntries(cleanItems.map((i) => [i.path, shaFile(path.join(ALICE, i.path))]));

  // dirty copies → ONE item each, path marked with the trailing slash
  for (const root of ['workspace/dirty-repo/', 'workspace/unpushed-repo/', 'workspace/unborn-dirty/']) {
    const item = p.items.find((i) => i.path === root);
    assert.ok(item, `${root} planned as one worktree item`);
    assert.equal(item.action, 'ARCHIVE');
    assert.equal(item.kind, 'worktree');
    assert.ok(item.size > 0, 'the plan reports the copy\'s owned volume');
  }
  // the uncommitted file of the dirty copy rides in the item's payload list
  const dirtyItem = p.items.find((i) => i.path === 'workspace/dirty-repo/');
  const dirtyPaths = dirtyItem.files.map((f) => f.path);
  assert.ok(dirtyPaths.includes('workspace/dirty-repo/untracked.txt'));
  assert.ok(dirtyPaths.includes('workspace/dirty-repo/creds.secret'), 'a gitignored owned file is planned, not lost');
  assert.ok(!dirtyPaths.includes('workspace/dirty-repo/auth.json'), 'EXCLUDE stays out of the payload');

  // fake-repo: git cannot say → declined (principle 2), never planned
  assert.ok(!p.items.some((i) => i.path.startsWith('workspace/fake-repo')), 'an undeterminable copy is declined');
  assert.ok(p.filtered >= 2, `declined entries are counted (got ${p.filtered})`);

  assert.deepEqual(snapshot(TMP), baseline.tree, 'dry-run must not create, move or change a single byte');
  assert.equal(fs.existsSync(LEDGER('alice')), false, 'no ledger written');
  assert.equal(fs.existsSync(QUAR('alice')), false, 'no quarantine written');
  assert.deepEqual(walkFiles(GCS), [], 'no object uploaded');
});

test('--apply: clean copy → quarantine, dirty copies → verified bundle archives, foreign classes byte-identical', async () => {
  const r = await runCli(['worktree', '--profile', 'alice', '--apply', '--drain-timeout', '0', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.failed, 0);
  const applied = p.items.filter((i) => i.status === 'applied');
  const bundleApplied = applied.filter((i) => i.action === 'ARCHIVE');
  assert.equal(bundleApplied.length, 3, 'three dirty copies archived');
  assert.equal(applied.length - bundleApplied.length, Object.keys(baseline.cleanOwned).length,
    'the clean copy planned exactly its owned files');

  // ── clean copy: every owned file moved to quarantine, byte-exact ──────────
  const quar = QUAR('alice');
  for (const [rel, digest] of Object.entries(baseline.cleanOwned)) {
    const src = path.join(ALICE, rel); // plan paths are profile-relative
    const dst = path.join(quar, rel);
    assert.equal(fs.existsSync(src), false, `clean copy: ${rel} left the profile`);
    assert.equal(fs.existsSync(dst), true, `clean copy: ${rel} is in quarantine`);
    assert.equal(shaFile(dst), digest, `clean copy: ${rel} is byte-exact in quarantine`);
  }
  // foreign classes inside the clean copy stayed put:
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'clean-repo', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'REGEN-CONTENT');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'clean-repo', 'auth.json'), 'utf8'), '{"token":"secret-1"}');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'clean-repo', 'sessions', 's-1.json'), 'utf8'), '{"id":"s-1"}');

  // ── dirty copies: owned content gone, archives in the fake bucket ─────────
  for (const root of ['workspace/dirty-repo', 'workspace/unpushed-repo']) {
    const left = walkFiles(path.join(ALICE, root));
    assert.ok(!left.includes('src/main.js') && !left.includes('a.txt') && !left.includes('b.txt'),
      `${root}: tracked content removed`);
    assert.ok(left.every((rel) => rel === 'auth.json' || rel.startsWith('.git/logs/')),
      `${root}: only foreign classes remain (got ${JSON.stringify(left)})`);
    const key = KEY('alice', root);
    assert.ok(fs.existsSync(path.join(GCS, key)), `${key} uploaded`);
  }
  assert.equal(fs.existsSync(path.join(ALICE, 'workspace', 'unborn-dirty')), false,
    'a copy with no foreign classes leaves nothing behind — the root itself is gone');
  assert.deepEqual(walkFiles(path.join(ALICE, 'workspace', 'unborn-dirty')), []);

  // fake-repo: byte-identical, still on disk
  assert.deepEqual(snapshot(path.join(ALICE, 'workspace', 'fake-repo')), baseline.fake, 'a declined copy is untouched');

  // the archive is a real tar: manifest + bundle + patch + payload
  const tar = zlib.gunzipSync(fs.readFileSync(path.join(GCS, KEY('alice', 'workspace/dirty-repo'))));
  const list = spawnSync('tar', ['-tf', '-'], { input: tar, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  const members = list.stdout.split('\n').filter(Boolean).map((m) => m.replace(/^\.\//, ''));
  assert.ok(members.includes('manifest.json'));
  assert.ok(members.includes('worktree.bundle'), 'the bundle of unpushed/HEAD refs travels with the archive');
  assert.ok(members.includes('worktree.patch'), 'the uncommitted delta travels with the archive');
  assert.ok(members.includes('payload/untracked.txt'), 'untracked files travel as payload');
  assert.ok(members.includes('payload/creds.secret'), 'gitignored owned files travel as payload');
  assert.ok(!members.some((m) => m.includes('auth.json')), 'secrets never enter the archive');

  // ── ledger ────────────────────────────────────────────────────────────────
  const records = readLedger('alice');
  const deletes = records.filter((x) => x.action === 'DELETE');
  const archives = records.filter((x) => x.action === 'ARCHIVE');
  assert.equal(deletes.length, Object.keys(baseline.cleanOwned).length, 'one DELETE record per quarantined file');
  for (const rec of deletes) {
    assert.equal(rec.phase, 'worktree');
    assert.ok(rec.dest.startsWith('workspace/clean-repo/'), `quarantine dest: ${rec.dest}`);
    assert.ok(fs.existsSync(path.join(quar, rec.dest)), 'the record points at the quarantined copy');
    assert.equal(shaFile(path.join(quar, rec.dest)), rec.sha256, 'quarantine bytes match the ledger');
  }
  assert.equal(archives.length, 3, 'one ARCHIVE record per dirty copy');
  for (const rec of archives) {
    assert.equal(rec.phase, 'worktree');
    assert.match(rec.path, /\/$/, 'a bundle record path ends with "/"');
    assert.ok(rec.dest.startsWith(`profiles/alice/worktrees/`), `blob key: ${rec.dest}`);
    // ledger sha = the tar BEFORE gzip (archive-sessions convention); the
    // object stored in the bucket is the gzipped tar:
    assert.equal(
      crypto.createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(path.join(GCS, rec.dest)))).digest('hex'),
      rec.sha256,
      'the ledger hashes the stored tar (pre-gzip)',
    );
  }

  // the profile outside the copies never moved
  assert.equal(fs.readFileSync(path.join(ALICE, 'notes', 'keep.md'), 'utf8'), '# keep me\n');
});

test('--verify is green: every record checks out, nothing is half-removed', async () => {
  const r = await runCli(['worktree', '--profile', 'alice', '--verify', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  const total = Object.keys(baseline.cleanOwned).length + 3;
  assert.equal(p.verify.ok, total, `ok=${p.verify.ok} failures=${JSON.stringify(p.verify.failures)}`);
  assert.equal(p.verify.failures.length, 0);
  assert.equal(p.verify.pendingCount, 0, 'no planned item is missing a record (fake-repo is declined, not pending)');
  assert.equal(p.lock, null, 'verify is read-only: no lock');
});

test('--revert restores both mechanisms byte-exact (quarantine + blob rebuild)', async () => {
  const r = await runCli(['worktree', '--profile', 'alice', '--revert', '--drain-timeout', '0', '--json']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.revert.failures.length, 0, JSON.stringify(p.revert.failures));
  assert.equal(p.revert.restored + p.revert.already, Object.keys(baseline.cleanOwned).length + 3);

  // the dirty copies come back whole — every file and symlink byte-identical
  // (EMPTY dirs are not archived: git recreates .git/objects/pack & co on
  // demand, and the epic's acceptance is «файлы байт-в-байт», not dir entries —
  // so the tree compare below is content-only):
  const content = (snap) => snap.filter((l) => !l.startsWith('d '));
  assert.deepEqual(content(snapshot(path.join(ALICE, 'workspace', 'dirty-repo'))), content(baseline.dirty), 'dirty copy restored byte-for-byte');
  assert.deepEqual(content(snapshot(path.join(ALICE, 'workspace', 'unpushed-repo'))), content(baseline.unpushed), 'unpushed copy restored byte-for-byte');
  assert.deepEqual(content(snapshot(path.join(ALICE, 'workspace', 'unborn-dirty'))), content(baseline.unborn), 'unborn copy restored byte-for-byte');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'dirty-repo', 'src', 'main.js'), 'utf8'), 'v2 with uncommitted work\n');
  assert.equal(fs.readFileSync(path.join(ALICE, 'workspace', 'dirty-repo', 'creds.secret'), 'utf8'), 'gitignored-but-owned\n');
  // the clean copy: every quarantined file is back with its exact bytes
  for (const [rel, digest] of Object.entries(baseline.cleanOwned)) {
    const abs = path.join(ALICE, rel); // plan paths are profile-relative
    assert.ok(fs.existsSync(abs), `clean copy: ${rel} restored`);
    assert.equal(shaFile(abs), digest, `clean copy: ${rel} restored byte-exact`);
  }
  assert.equal(fs.statSync(path.join(ALICE, 'workspace', 'clean-repo', 'run.sh')).mode & 0o777, 0o755, 'exec bit survives quarantine restore');

  const restored = readLedger('alice').filter((x) => x.action === 'RESTORED');
  assert.equal(restored.length, Object.keys(baseline.cleanOwned).length + 3, 'every restore is ledgered');

  const v = await runCli(['worktree', '--profile', 'alice', '--verify', '--json']);
  assert.equal(v.status, 0, v.stderr);
  const vp = v.json().profiles[0];
  assert.equal(vp.verify.failures.length, 0, JSON.stringify(vp.verify.failures));
  assert.equal(vp.verify.ok, Object.keys(baseline.cleanOwned).length + 3, 'post-revert verify: every record healthy');
});

test('a failed upload deletes nothing, ledgers ARCHIVE + ARCHIVE_FAILED and fails the run (exit 2)', async () => {
  const bob = path.join(USERS, 'bob');
  makePushedRepo(path.join(bob, 'copy'));
  write(path.join(bob, 'copy', 'f.txt'), 'payload\n');
  commitAll(path.join(bob, 'copy'), 'init');
  git(['push', '-q', 'origin', 'main'], path.join(bob, 'copy'));
  write(path.join(bob, 'copy', 'f.txt'), 'dirty payload\n');
  const before = snapshot(bob);

  const r = await runCli(
    ['worktree', '--profile', 'bob', '--apply', '--drain-timeout', '0', '--json'],
    { GCS_FAKE_FAIL: 'save' },
  );
  assert.equal(r.status, 2, `a failed upload must fail the run\n${r.stdout}\n${r.stderr}`);

  assert.deepEqual(snapshot(bob), before, 'nothing was deleted without a confirmed upload');
  assert.deepEqual(walkFiles(GCS).filter((k) => k.includes('/bob/')), [], 'and nothing was stored');

  const records = readLedger('bob');
  assert.deepEqual(records.map((x) => x.action), ['ARCHIVE', 'ARCHIVE_FAILED'],
    'record-before-action, then the compensating record: the fold says `returned`');
  assert.equal(records[1].dest, records[0].dest, 'the compensating record keeps the reserved key');

  // verify: the archive never made it but the copy is whole → healthy retry
  const v = await runCli(['worktree', '--profile', 'bob', '--verify', '--json']);
  assert.equal(v.status, 0, `${v.stdout}\n${v.stderr}`);
  assert.equal(v.json().profiles[0].verify.ok, 1);
  assert.equal(v.json().profiles[0].verify.failures.length, 0);
});

test('a failed reconstruction gate deletes nothing — the check runs before the first unlink (exit 2)', async () => {
  const carol = path.join(USERS, 'carol');
  makePushedRepo(path.join(carol, 'copy'));
  write(path.join(carol, 'copy', 'f.txt'), 'payload\n');
  commitAll(path.join(carol, 'copy'), 'init');
  git(['push', '-q', 'origin', 'main'], path.join(carol, 'copy'));
  write(path.join(carol, 'copy', 'f.txt'), 'dirty payload\n');
  const before = snapshot(carol);

  // The upload succeeds; the download-back (which the rebuild gate needs) does
  // not — so the run fails exactly at the «проверка в временном клоне» step.
  const r = await runCli(
    ['worktree', '--profile', 'carol', '--apply', '--drain-timeout', '0', '--json'],
    { GCS_FAKE_FAIL: 'download' },
  );
  assert.equal(r.status, 2, `an unverifiable archive must fail the run\n${r.stdout}\n${r.stderr}`);
  const p = r.json().profiles[0];
  assert.equal(p.failed, 1);
  assert.match(p.errors[0], /injected failure/, 'the run fails at the download-back (rebuild gate), not earlier');
  assert.deepEqual(snapshot(carol), before, 'the copy is intact — the gate ran before any deletion');

  const records = readLedger('carol');
  assert.deepEqual(records.map((x) => x.action), ['ARCHIVE', 'ARCHIVE_FAILED'], 'the compensating record lands on `returned`');
  // the object itself IS stored (the upload half succeeded) — only the check failed
  assert.ok(fs.existsSync(path.join(GCS, KEY('carol', 'copy'))), 'the uploaded object survives for the next run');
});

test('unit: worktreeKey is a safe, collision-free blob key', () => {
  const phase = require('../scripts/profile-migrate/phases/worktree.cjs');
  const { assertSafeKey } = require('../src/session-blob-store');
  assert.equal(phase._worktreeKey('alice', 'workspace/dirty-repo'), 'profiles/alice/worktrees/workspace/dirty-repo.tar.gz');
  for (const root of ['a b/c d', 'код/проект', 'x/../y', '.hidden', 'a-b', 'a b']) {
    const key = phase._worktreeKey('p', root);
    assertSafeKey(key);
    assert.ok(key.startsWith('profiles/p/worktrees/'), key);
    assert.ok(!key.includes('..'), key);
  }
  // two roots that SANITIZE alike must not collide:
  assert.notEqual(phase._worktreeKey('p', 'a b'), phase._worktreeKey('p', 'a-b'));
  assert.notEqual(phase._worktreeKey('p', 'a/b'), phase._worktreeKey('p', 'a-b'));
});

test('unit: the classifier reports the OUTERMOST working-copy root (and never the profile root)', () => {
  const classifier = require('../scripts/profile-migrate/classifier.cjs');
  const { loadRules } = classifier;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wt-classifier-'));
  try {
    const profile = path.join(root, 'profile');
    write(path.join(profile, 'outside.txt'), 'x');
    write(path.join(profile, 'outer', '.git', 'HEAD'), 'ref: refs/heads/main');
    write(path.join(profile, 'outer', 'a.txt'), 'a');
    write(path.join(profile, 'outer', 'inner', '.git', 'HEAD'), 'ref: refs/heads/main');
    write(path.join(profile, 'outer', 'inner', 'b.txt'), 'b');

    const { rules } = loadRules(path.join(ROOT, 'config', 'profile-clean-list.yaml'));
    const classify = () => {
      const seen = new Map();
      classifier.classifyProfile(profile, {
        rules,
        onEntry(e) { if (e.kind === 'file') seen.set(e.rel, e.repoRoot); },
      });
      return seen;
    };

    let seen = classify();
    assert.equal(seen.get('outer/a.txt'), 'outer');
    assert.equal(seen.get('outer/.git/HEAD'), 'outer');
    // a nested repo belongs to the OUTER copy — one unit for M3, not two:
    assert.equal(seen.get('outer/inner/b.txt'), 'outer', 'the inner .git never overwrites the outer root');
    assert.equal(seen.get('outside.txt'), null);

    // The PROFILE ROOT itself becomes a repo (M6): the root claims the whole
    // tree, every repoRoot turns falsy and the worktree phase plans NOTHING —
    // a profile-as-repo is deliberately not an M3 worktree.
    write(path.join(profile, '.git', 'HEAD'), 'ref: refs/heads/main');
    write(path.join(profile, 'rootfile.txt'), 'r');
    seen = classify();
    assert.ok(!seen.get('rootfile.txt'), `profile-root repo must be falsy, got ${JSON.stringify(seen.get('rootfile.txt'))}`);
    assert.ok(!seen.get('outer/a.txt'), 'even an inner copy is declined while the profile root is a repo');
    assert.ok(!seen.get('outer/inner/b.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
