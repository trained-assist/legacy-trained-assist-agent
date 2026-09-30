'use strict';
// Issue #1916 PR-B — src/session-archive.js (epic #1784 M2) and the item
// filter of the archive-sessions phase.
//
// No GCS anywhere: blobs live in a temp directory through the file-backed test
// backend (same bucket shape as the injected fake in session-blob-store.test).
// What this file owns:
//   · the payload/pointer/digest boundary — the clean-list ARCHIVE class is
//     inherited by a whole subtree, and what the phase DECLINES is exactly as
//     important as what it takes (current-session must never leave the VM);
//   · blob keys: session bodies from the path, transcripts from the cwd INSIDE
//     the file (Claude's project-dir slug is lossy and not what PR-C recomputes);
//   · the upload → confirm → marker → unlink order (nothing is deleted without
//     a confirmed upload, a corrupt index is never clobbered);
//   · materialize (the PR-C stub) round-trips byte-exactly.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const archive = require('../src/session-archive');
const { createSessionBlobStore, createFileBackedBucket, sessionKey, transcriptKey, slugCwd } = require('../src/session-blob-store');
const classifier = require('../scripts/profile-migrate/classifier.cjs');
const runner = require('../scripts/profile-migrate/runner.cjs');
const phase = require('../scripts/profile-migrate/phases/archive-sessions.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-'));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(TMP, `${name}-`));
}

// The blob store under test: real client code, file-backed bucket, no ADC.
// `dir` is where the "objects" land, so a test can tamper with them directly.
function fakeBlobStore(name = 'gcs', env = {}) {
  const dir = tmpDir(name);
  return { blob: createSessionBlobStore({ bucket: createFileBackedBucket(dir, env) }), dir };
}

const RULES = classifier.loadRules(classifier.DEFAULT_CLEAN_LIST).rules;
const IDX_SESSIONS = RULES.findIndex((r) => r.pattern === 'sessions' && r.action === 'ARCHIVE');
const IDX_PROJECTS = RULES.findIndex((r) => r.pattern === '.agent-home/.claude/projects');
const IDX_GIT = RULES.findIndex((r) => r.when === 'git-repo');

function phaseCtx(profileRoot) {
  return { profile: 'alice', profileRoot, quarantineRoot: null, rules: RULES, mode: 'dry-run', log: () => {} };
}

function fileEntry(rel, ruleIdx, extra = {}) {
  return { kind: 'file', rel, action: 'ARCHIVE', ruleIdx, isFile: true, isSymlink: false, size: 1, ...extra };
}

// ── path classification ──────────────────────────────────────────────────────

test('archiveRelKind separates payload from pointers, caches and junk', () => {
  assert.equal(archive.archiveRelKind('sessions/s-1234567890-1.json'), 'session');
  assert.equal(archive.archiveRelKind('sessions/s-1.digest.json'), null, 'regenerable digest cache stays local');
  assert.equal(archive.archiveRelKind('sessions/current-session.json'), null, 'the pointer must stay local');
  assert.equal(archive.archiveRelKind('sessions/current-session--1003.json'), null, 'group/audience pointers too');
  assert.equal(archive.archiveRelKind('sessions/s-1.json.123.tmp'), null, 'atomic-json temp files are not payload');
  assert.equal(archive.archiveRelKind('sessions/notes.txt'), null, 'junk in sessions/ is not a session body');
  assert.equal(archive.archiveRelKind('sessions/nested/s-1.json'), null, 'only flat session bodies');
  assert.equal(archive.archiveRelKind('sessions.json'), null, 'the index itself is not payload');
  assert.equal(archive.archiveRelKind('.agent-home/.claude/projects/-home-alice/u-1.jsonl'), 'transcript');
  assert.equal(archive.archiveRelKind('.agent-home/.claude/projects/a/b/u.jsonl'), null, 'deep nesting is not ours');
  assert.equal(archive.archiveRelKind('.agent-home/.claude/sessions/u.json'), null, 'claude/sessions is out of M2 scope');
  assert.equal(archive.archiveRelKind('.agent-home/.claude/projects/-home/u.jsonl.bak'), null);
  assert.equal(archive.archiveRelKind(''), null);
  assert.equal(archive.archiveRelKind(null), null);
});

test('sessionRelId / transcriptRelId decline names a blob key could not spell', () => {
  assert.equal(archive.sessionRelId('sessions/s-1.json'), 's-1');
  assert.equal(archive.sessionRelId('sessions/s 1.json'), null, 'space is not a path segment');
  assert.equal(archive.sessionRelId('sessions/s.1.json'), 's.1', 'dots are fine');
  assert.equal(archive.transcriptRelId('.agent-home/.claude/projects/-x/u-1.jsonl'), 'u-1');
  assert.equal(archive.transcriptRelId('.agent-home/.claude/projects/-x/u 1.jsonl'), null);
});

test('sessionArchiveKey / transcriptArchiveKey build exactly the blob-store key schema', () => {
  assert.equal(
    archive.sessionArchiveKey('alice', 'sessions/s-123-456.json'),
    sessionKey('alice', 's-123-456'),
    'profiles/alice/sessions/s-123-456.json.gz',
  );
  assert.equal(archive.sessionArchiveKey('alice', 'sessions/current-session.json'), null);

  const rel = '.agent-home/.claude/projects/-home-foo/u-1.jsonl';
  assert.equal(
    archive.transcriptArchiveKey('alice', rel, '/home/foo'),
    transcriptKey('alice', slugCwd('/home/foo'), 'u-1'),
    'the key is built from the cwd, never from Claude’s directory slug',
  );
  assert.throws(() => archive.transcriptArchiveKey('alice', rel, ''), /no cwd/);
});

// ── cwd extraction ───────────────────────────────────────────────────────────

const META_LINES = [
  '{"type":"last-prompt","leafUuid":"d","sessionId":"u-1"}',
  '{"type":"mode","mode":"normal","sessionId":"u-1"}',
];

test('readTranscriptCwd scans past metadata lines and returns null when there is no cwd', () => {
  const withCwd = write(
    path.join(tmpDir('cwd'), 'u-1.jsonl'),
    [...META_LINES,
      '{"type":"user","cwd":"/home/vova/users/alice","sessionId":"u-1"}',
      '{"type":"assistant","cwd":"/home/vova/users/alice"}'].join('\n'),
  );
  assert.equal(archive.readTranscriptCwd(withCwd), '/home/vova/users/alice');

  const noCwd = write(path.join(tmpDir('cwd'), 'u-2.jsonl'), [...META_LINES, 'not json at all'].join('\n'));
  assert.equal(archive.readTranscriptCwd(noCwd), null);
  assert.equal(archive.readTranscriptCwd(path.join(TMP, 'nope.jsonl')), null, 'a vanished file is null, not a crash');
});

test('readTranscriptCwd survives a cwd line straddling the 64 KB read boundary (Cyrillic included)', () => {
  const cwd = '/дом/проект/very long project';
  // The cwd line alone is longer than one read chunk and starts inside the
  // first chunk, so the parser must reassemble it across two reads.
  const longLine = JSON.stringify({ type: 'user', cwd, pad: 'x'.repeat(70_000), sessionId: 'u-1' });
  const file = write(
    path.join(tmpDir('cwd'), 'u-1.jsonl'),
    [...META_LINES, longLine, JSON.stringify({ type: 'assistant', cwd })].join('\n'),
  );
  assert.equal(archive.readTranscriptCwd(file), cwd);
});

// ── the phase filter (the unit the task asks for: current-session never moves) ─

test('the phase filter plans only session bodies and transcripts', () => {
  const ctx = phaseCtx(path.join(TMP, 'filter-profile'));
  const keep = (rel, idx = IDX_SESSIONS) => assert.equal(phase.filter(ctx, fileEntry(rel, idx)), true, `planned: ${rel}`);
  const drop = (rel, why, extra = {}, idx = IDX_SESSIONS) => assert.equal(phase.filter(ctx, fileEntry(rel, idx, extra)), false, `${rel} → ${why}`);

  keep('sessions/s-1.json');
  keep('.agent-home/.claude/projects/-home-alice/u-1.jsonl', IDX_PROJECTS);

  drop('sessions/current-session.json', 'pointer stays');
  drop('sessions/current-session--1003.json', 'pointer stays');
  drop('sessions/s-1.digest.json', 'regenerable cache stays');
  drop('sessions/s 1.json', 'no segment-safe key');
  drop('sessions/notes.txt', 'not a session body');
  drop('sessions/s-link.json', 'symlink is never archived', { isFile: false, isSymlink: true });
  drop('workspace/repo/file.txt', 'git working copy is M3', {}, IDX_GIT);
  drop('workspace/repo/.git/config', 'git working copy is M3', {}, IDX_GIT);
  drop('.agent-home/.claude/projects/-home/u.jsonl.bak', 'not a transcript', {}, IDX_PROJECTS);
  drop('.agent-home/.claude/sessions/u.json', 'claude/sessions is out of scope', {}, IDX_SESSIONS);
});

test('scanProfile with the phase filter counts what it declined and plans only payload', () => {
  const root = path.join(TMP, 'scan-profile');
  const files = {
    'sessions/s-1.json': '{"id":"s-1"}',
    'sessions/s-2.json': '{"id":"s-2"}',
    'sessions/current-session.json': '{"id":"s-1"}',
    'sessions/s-1.digest.json': '{}',
    'sessions/junk.txt': 'x',
    '.agent-home/.claude/projects/-home/u-1.jsonl': '{"type":"user","cwd":"/home"}',
    'workspace/repo/.git/config': '[core]',
    'workspace/repo/file.txt': 'git file',
    'notes/keep.md': '# keep',
    'logs/app.log': 'regenerable log',
  };
  for (const [rel, content] of Object.entries(files)) write(path.join(root, rel), content);
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.symlinkSync('s-1.json', path.join(root, 'sessions', 's-link.json'));

  const ctx = phaseCtx(root);
  const scan = runner.scanProfile(root, RULES, ['ARCHIVE'], (e) => phase.filter(ctx, e));

  assert.deepEqual(
    scan.items.map((i) => i.path).sort(),
    [
      '.agent-home/.claude/projects/-home/u-1.jsonl',
      'sessions/s-1.json',
      'sessions/s-2.json',
    ],
    'only bodies + the transcript are planned',
  );
  // declined: current-session + digest + junk.txt + the symlink + 2 git files
  assert.equal(scan.filtered, 6, 'six ARCHIVE-class files were declined');
  const filesByClass = Object.fromEntries(scan.stats.classes.map((c) => [c.action, c.files]));
  assert.equal(filesByClass.ARCHIVE, 9, 'the class still counts everything — the filter is a second, narrower step');
  assert.deepEqual([...scan.dirs], ['logs'], 'only DELETE-class directories are prune candidates — sessions/ and the git tree stay');
});

// ── archive round-trip ───────────────────────────────────────────────────────

const BODY = JSON.stringify({ id: 's-1', topic: 'привет', messages: [{ role: 'user', content: 'hi' }] }, null, 2);
// ledger `size` is BYTES (lstat), never JS string length — 'привет' is 12 bytes, 6 chars.
const BODY_BYTES = Buffer.byteLength(BODY);

async function archiveFixture() {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob, dir } = fakeBlobStore();
  write(path.join(root, 'sessions', 's-1.json'), BODY);
  write(path.join(root, 'sessions.json'), `${JSON.stringify([{ id: 's-1', topic: 'привет' }], null, 2)}\n`);
  const rawSha = sha(BODY);
  const res = await archive.archiveSessionBody({
    blob,
    profile: 'alice',
    profileRoot: root,
    relPath: 'sessions/s-1.json',
    expected: { sha256: rawSha, size: BODY_BYTES },
  });
  return { root, blob, dir, res, rawSha };
}

test('archiveSessionBody: upload → confirm → index marker → local unlink', async () => {
  const { root, dir, res, rawSha } = await archiveFixture();

  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-1.json')), false, 'the body leaves the VM');
  assert.equal(res.key, 'profiles/alice/sessions/s-1.json.gz');
  assert.equal(res.rawSha256, rawSha);

  // The stored object is a gzip whose gunzip is byte-identical to the body.
  const stored = fs.readFileSync(path.join(dir, res.key));
  assert.equal(stored.length, res.size, 'marker size describes the stored object');
  assert.equal(sha(stored), res.sha256, 'marker sha256 describes the stored object');
  assert.equal(zlib.gunzipSync(stored).toString('utf8'), BODY, 'the archive is byte-exact');

  const index = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
  const marker = index[0].archived;
  assert.ok(marker, 'the index record carries the marker');
  assert.equal(marker.key, res.key);
  assert.equal(marker.sha256, res.sha256);
  assert.equal(marker.size, res.size);
  assert.ok(Number.isFinite(Date.parse(marker.at)), 'marker has a timestamp');
  assert.equal(index[0].topic, 'привет', 'the rest of the record is untouched');
});

test('archiveSessionBody with no index record still archives — marker skipped, file removed', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob } = fakeBlobStore();
  write(path.join(root, 'sessions', 's-99.json'), BODY);
  write(path.join(root, 'sessions.json'), JSON.stringify([{ id: 's-1' }]));

  const res = await archive.archiveSessionBody({
    blob, profile: 'alice', profileRoot: root, relPath: 'sessions/s-99.json',
    expected: { sha256: sha(BODY), size: BODY_BYTES },
  });
  assert.equal(res.marked, false, 'an orphan body has no record to mark (the ledger still has its key)');
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-99.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'))[0].archived, undefined);
});

test('archiveSessionBody leaves the file in place when the upload cannot be confirmed', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob, dir } = fakeBlobStore('gcs-fail', { GCS_FAKE_FAIL: 'save' });
  write(path.join(root, 'sessions', 's-1.json'), BODY);
  write(path.join(root, 'sessions.json'), JSON.stringify([{ id: 's-1' }]));

  await assert.rejects(
    archive.archiveSessionBody({
      blob, profile: 'alice', profileRoot: root, relPath: 'sessions/s-1.json',
      expected: { sha256: sha(BODY), size: BODY_BYTES },
    }),
    /GCS_FAKE_FAIL/,
  );
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-1.json')), true, 'nothing is deleted without a confirmed upload');
  assert.equal(fs.existsSync(path.join(dir, 'profiles/alice/sessions/s-1.json.gz')), false, 'and nothing was stored');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'))[0].archived, undefined, 'no marker without an upload');
});

test('archiveSessionBody refuses a corrupt index instead of clobbering it', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob } = fakeBlobStore();
  write(path.join(root, 'sessions', 's-1.json'), BODY);
  write(path.join(root, 'sessions.json'), 'NOT JSON AT ALL');

  await assert.rejects(
    archive.archiveSessionBody({
      blob, profile: 'alice', profileRoot: root, relPath: 'sessions/s-1.json',
      expected: { sha256: sha(BODY), size: BODY_BYTES },
    }),
    /unreadable/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'), 'NOT JSON AT ALL', 'a corrupt index is never rewritten');
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-1.json')), true, 'the body stays');
});

test('archiveSessionBody refuses bytes that changed since prepare', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob } = fakeBlobStore();
  write(path.join(root, 'sessions', 's-1.json'), BODY);
  write(path.join(root, 'sessions.json'), JSON.stringify([{ id: 's-1' }]));

  await assert.rejects(
    archive.archiveSessionBody({
      blob, profile: 'alice', profileRoot: root, relPath: 'sessions/s-1.json',
      expected: { sha256: sha('something else entirely'), size: BODY_BYTES },
    }),
    /changed between prepare and apply/,
  );
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-1.json')), true);
});

test('archiveTranscript: keyed by slugCwd(cwd), no index marker, local file unlinked', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob, dir } = fakeBlobStore();
  const cwd = '/home/vova/users/alice/projects/web';
  const rel = '.agent-home/.claude/projects/-CLAUDE-SLUG-NOT-THE-CWD/u-9.jsonl';
  const transcript = [
    ...META_LINES,
    JSON.stringify({ type: 'user', cwd, sessionId: 'u-9' }),
    JSON.stringify({ type: 'assistant', cwd, message: { role: 'assistant', content: 'ok' } }),
  ].join('\n');
  write(path.join(root, rel), transcript);
  write(path.join(root, 'sessions.json'), JSON.stringify([{ id: 's-1' }]));
  const before = fs.readFileSync(path.join(root, 'sessions.json'), 'utf8');

  const res = await archive.archiveTranscript({
    blob, profile: 'alice', profileRoot: root, relPath: rel,
    expected: { sha256: sha(transcript), size: Buffer.byteLength(transcript) },
  });

  assert.equal(res.key, `profiles/alice/transcripts/${slugCwd(cwd)}/u-9.jsonl.gz`);
  assert.ok(!res.key.includes('CLAUDE-SLUG'), 'Claude’s own directory slug never reaches the key');
  assert.equal(res.cwd, cwd);
  assert.equal(fs.existsSync(path.join(root, rel)), false, 'the transcript leaves the VM');
  assert.equal(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'), before, 'transcripts are not index records');
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, res.key))).toString('utf8'), transcript, 'byte-exact');
});

test('archive* refuses to store under a key other than the one reserved in the ledger', async () => {
  const root = path.join(tmpDir('profile'), 'alice');
  const { blob } = fakeBlobStore();
  const cwd = '/home/vova/users/alice/projects/web';
  const rel = '.agent-home/.claude/projects/-x/u-1.jsonl';
  const transcript = [...META_LINES, JSON.stringify({ type: 'user', cwd })].join('\n');
  write(path.join(root, 'sessions', 's-1.json'), BODY);
  write(path.join(root, 'sessions.json'), JSON.stringify([{ id: 's-1' }]));
  write(path.join(root, rel), transcript);

  await assert.rejects(
    archive.archiveSessionBody({
      blob, profile: 'alice', profileRoot: root, relPath: 'sessions/s-1.json',
      expected: { sha256: sha(BODY), size: BODY_BYTES },
      expectedKey: 'profiles/alice/sessions/somebody-else.json.gz',
    }),
    /differs from the reserved one/,
  );
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-1.json')), true, 'refused = untouched');

  await assert.rejects(
    archive.archiveTranscript({
      blob, profile: 'alice', profileRoot: root, relPath: rel,
      expected: { sha256: sha(transcript), size: Buffer.byteLength(transcript) },
      expectedKey: transcriptKey('alice', 'wrong-slug', 'u-1'),
    }),
    /differs from the reserved one/,
    'a content-derived key that drifted from the ledger would orphan the record',
  );
  assert.equal(fs.existsSync(path.join(root, rel)), true);
});

test('checkArchivedBlob reports ok / missing / error (an outage is never "the archive is gone")', async () => {
  const { blob, res, rawSha } = await archiveFixture();

  const ok = await archive.checkArchivedBlob({ blob, key: res.key, rawSha256: rawSha });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.gzSha256, res.sha256);

  const missing = await archive.checkArchivedBlob({ blob, key: 'profiles/alice/sessions/nope.json.gz', rawSha256: rawSha });
  assert.equal(missing.status, 'missing');

  const { blob: broken } = fakeBlobStore('gcs-outage', { GCS_FAKE_FAIL: 'download' });
  const outage = await archive.checkArchivedBlob({ blob: broken, key: res.key, rawSha256: rawSha });
  assert.equal(outage.status, 'error');
});

test('checkArchivedBlob flags a corrupt object (valid gzip of foreign bytes, and plain garbage)', async () => {
  const { blob, dir, res, rawSha } = await archiveFixture();
  const object = path.join(dir, res.key);

  fs.writeFileSync(object, zlib.gzipSync(Buffer.from('somebody else’s session')));
  const wrong = await archive.checkArchivedBlob({ blob, key: res.key, rawSha256: rawSha });
  assert.equal(wrong.status, 'corrupt');
  assert.match(wrong.message, /sha256 mismatch/);

  fs.writeFileSync(object, Buffer.from('garbage not gzip'));
  const garbage = await archive.checkArchivedBlob({ blob, key: res.key, rawSha256: rawSha });
  assert.equal(garbage.status, 'corrupt');
  assert.match(garbage.message, /gunzip/);
});

// ── materialize (the PR-C stub) ──────────────────────────────────────────────

test('materializeBlob restores byte-exactly and refuses a tampered object', async () => {
  const { root, blob, res } = await archiveFixture();
  const dest = path.join(root, 'sessions', 's-1.json');

  const out = await archive.materializeBlob({
    blob,
    key: res.key,
    destPath: dest,
    gzSha256: res.sha256,
    rawSha256: res.rawSha256,
  });
  assert.equal(out.status, 'written');
  assert.equal(fs.readFileSync(dest, 'utf8'), BODY, 'byte-exact');

  const again = await archive.materializeBlob({ blob, key: res.key, destPath: dest, gzSha256: res.sha256 });
  assert.equal(again.status, 'exists', 'an existing local copy is the caller’s decision, never clobbered silently');

  fs.rmSync(dest);
  await assert.rejects(
    archive.materializeBlob({ blob, key: res.key, destPath: dest, gzSha256: sha(BODY) }),
    /sha256 mismatch/,
    'a tampered object is rejected before anything is written',
  );
  assert.equal(fs.existsSync(dest), false, 'nothing half-written');
});

test('materializeSessionBody reads the marker and writes to the canonical path with the session mode', async () => {
  const { root, blob, res, rawSha } = await archiveFixture();
  const out = await archive.materializeSessionBody({
    blob,
    profileRoot: root,
    sessionId: 's-1',
    marker: { key: res.key, sha256: res.sha256, size: res.size },
    rawSha256: rawSha,
  });
  assert.equal(out.status, 'written');
  assert.equal(out.destPath, path.join(root, 'sessions', 's-1.json'));
  assert.equal(fs.readFileSync(out.destPath, 'utf8'), BODY);
  assert.equal(fs.statSync(out.destPath).mode & 0o777, 0o600, 'session bodies come back 0600, like session-store writes them');
  await assert.rejects(
    archive.materializeSessionBody({ blob, profileRoot: root, sessionId: 's-1', marker: null }),
    /no archived marker/,
  );
});
