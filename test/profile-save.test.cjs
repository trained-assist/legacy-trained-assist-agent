'use strict';
// M6 (#1921): the profile save path commits the text image and pushes it.
//
// Runs against a REAL git in a temp dir with a local bare repo as the remote —
// no GitHub, no network. The contract under test is the one that matters:
//   · the .gitignore comes from the clean-list, so secrets never enter the image;
//   · a run with nothing to save is a no-op (no empty commits, no push);
//   · a run with changes commits AND pushes;
//   · a push failure is reported as an error with recovery refs, never as success.
//
// The secret-exclusion case starts from a fresh `saveProfileState` on a repo with
// no commits — which is the real M6 shape (profile repos are new). It must not be
// built by committing the secret first: gitignore does not un-track a file that is
// already in the index, so that would test git, not our code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  saveProfileState, formatSaveError, profileRepoUrl, profileRepoName,
  sanitizeProfileId, isGitRepo, hasChanges,
} = require('../src/profile-save');

const HAS_GIT = !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

function sh(cmd, opts = {}) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// A temp profile dir + a bare repo standing in for the GitHub remote.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-save-'));
  const dir = path.join(root, 'profile');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(dir, { recursive: true });
  sh(`git init --bare -q ${remote}`);
  // The runner sets these from the profile's git config; a CI/box identity.
  sh(`git -C ${dir} init -q`);
  sh(`git -C ${dir} config user.email agent@local && git -C ${dir} config user.name agent`);
  return { root, dir, remote };
}

test('repo naming matches profile-repo.mjs exactly', () => {
  assert.strictEqual(sanitizeProfileId('alice'), 'alice');
  assert.strictEqual(sanitizeProfileId('Alice'), 'alice');
  assert.strictEqual(sanitizeProfileId('alice_smith'), 'alice-smith');
  assert.strictEqual(profileRepoName('alice'), 'profile-alice');
  // "Alice" only gets a hash suffix when sanitising CHANGES the id. It does not:
  // lowercasing is part of sanitising, so 'Alice' → 'alice' is already canonical.
  assert.strictEqual(profileRepoName('Alice'), 'profile-alice');
  // A name that sanitising actually alters gets the suffix, so two ids that would
  // collapse onto one base cannot share a repo.
  assert.match(profileRepoName('alice_smith'), /^profile-alice-smith-[0-9a-f]{6}$/);
  assert.match(profileRepoUrl('alice'), /^https:\/\/github\.com\/profiles-artifacts\/profile-alice\.git$/);
});

test('a run with nothing to save is a no-op — no commit, no push', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  // First call: creates the repo, writes the gitignore, commits, pushes.
  assert.deepEqual(
    saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote }),
    { ok: true, committed: true, pushed: true },
  );
  const after = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(after.ok, true);
  assert.equal(after.committed, false);
  assert.equal(after.pushed, false);
});

test('a run with changes commits and pushes', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });

  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello world\n');
  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(res.ok, true);
  assert.equal(res.committed, true);
  assert.equal(res.pushed, true);

  assert.match(sh(`git -C ${remote} log --oneline`).out, /profile sync/);
  const content = sh(`git -C ${remote} show HEAD:notes.md`).out;
  assert.equal(content.trim(), 'hello world');
});

test('secrets are excluded from the image by the clean-list gitignore', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  // Secrets the clean-list must EXCLUDE — never tracked, never pushed.
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{"secret":"x"}\n');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"token":"y"}\n');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'auth.json'), '{"token":"z"}\n');

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(res.ok, true, JSON.stringify(res));

  // Nothing secret even entered the index.
  const tracked = sh(`git -C ${dir} ls-files`).out;
  for (const secret of ['.mcp.json', 'auth.json', 'sub/auth.json']) {
    assert.ok(!tracked.includes(secret), `${secret} must not be tracked, got:\n${tracked}`);
  }

  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `notes.md must be in the image, got:\n${files}`);
  for (const secret of ['.mcp.json', 'auth.json', 'sub/auth.json']) {
    assert.ok(!files.includes(secret), `${secret} must not be pushed, got:\n${files}`);
  }
});

test('session traces and agent runtime home never enter the profile Git image', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, '.session-traces'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.session-traces', 'run.jsonl'), '{"prompt":"private"}\n');
  fs.mkdirSync(path.join(dir, '.agent-home', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent-home', 'config', 'settings.json'), '{"runtime":true}\n');

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(res.ok, true, JSON.stringify(res));

  const localTracked = sh(`git -C ${dir} ls-files`).out;
  const remoteTree = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  for (const [where, tracked] of [['local', localTracked], ['remote', remoteTree]]) {
    assert.ok(!tracked.includes('.session-traces/'), `trace entered ${where} Git image: ${tracked}`);
    assert.ok(!tracked.includes('.agent-home/'), `agent HOME entered ${where} Git image: ${tracked}`);
  }
});

test('an unpushed commit from an earlier run is retried, not reported as done', { skip: !HAS_GIT }, () => {
  // The regression that shipped in #2136: the first push failed (org repo not
  // provisioned), leaving a real commit with a CLEAN tree. A tree-only probe then
  // concluded "nothing to save" and returned ok — reporting success over work that
  // had never reached GitHub. The next run must push that commit.
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  const first = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(first.pushed, true);

  // Simulate: commit made locally, remote unreachable at push time.
  sh(`git -C ${remote} update-ref -d refs/heads/master`); // remote loses the branch
  fs.writeFileSync(path.join(dir, 'notes.md'), 'second\n');
  const second = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(second.pushed, true, 'the commit must reach the remote');

  // Now the inverse: a commit that is already on the remote and a clean tree.
  const idle = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(idle.ok, true);
  assert.equal(idle.committed, false);
  assert.equal(idle.pushed, false);
});

test('a commit with no upstream is pushed — the failed-first-push case', { skip: !HAS_GIT }, () => {
  // The exact live regression: the first push failed because the org repo was not
  // provisioned, so there was a real commit, a CLEAN tree and NO upstream. A tree-only
  // probe (and an ahead-probe that reads 0 without an upstream) both conclude "nothing
  // to do" and return ok — success reported over work that never left the machine.
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  const failed = saveProfileState(dir, {
    profileId: 'alice', token: 'x', remoteUrl: '/nonexistent/repo.git',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.committed, true, 'the commit exists locally despite the failed push');

  // No upstream, clean tree — but the work is NOT on the remote yet.
  const retried = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(retried.pushed, true, 'a commit with no upstream must be pushed, not skipped');
  assert.match(sh(`git -C ${remote} log --oneline`).out, /profile sync/);
});

test('an unreadable file does not make the whole profile unsavable', { skip: !HAS_GIT }, () => {
  // T0 isolation (#1649) runs engines as unprivileged slots (ta-agent-*). Files they
  // own are unreadable for the profile's user, and `git add -A` aborts on the FIRST
  // such file — so a single slot-written scratch file makes the entire profile
  // unsavable. Observed twice on trained-assist-product-owner.
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'mine\n');

  // A file the current user cannot read, as if owned by another UID.
  const locked = path.join(dir, 'slot-scratch.json');
  fs.writeFileSync(locked, '{"slot":true}\n');
  sh(`chmod 000 ${locked}`);

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  sh(`chmod 644 ${locked}`);

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.pushed, true);
  // The readable content still made it — losing one file must not lose the profile.
  assert.match(sh(`git -C ${remote} log --oneline`).out, /profile sync/);
  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `notes.md must be saved, got:\n${files}`);
});

test('SEVERAL unreadable files do not make the profile unsavable', { skip: !HAS_GIT }, () => {
  // git reports one unreadable path per run, so a single retry only clears the first
  // and the next one fails identically — the profile with 9 slot-owned files would
  // never be saved. The commit must loop until `add` is clean.
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'mine\n');
  const locked = [];
  for (const name of ['a-scratch.json', 'b-scratch.json', 'c-scratch.json']) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '{"slot":true}\n');
    sh(`chmod 000 ${p}`);
    locked.push(p);
  }

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  for (const p of locked) sh(`chmod 644 ${p}`);

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.pushed, true);
  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `notes.md must be saved, got:\n${files}`);
});

test('a nested repo without a commit does not make the profile unsavable', { skip: !HAS_GIT }, () => {
  // The common case on a real profile (dozens of them): an embedded repo is staged
  // as a gitlink, which needs a commit to point at. A clone that was never committed
  // has no HEAD and `git add -A` fails with "does not have a commit checked out" —
  // taking the whole profile down with it.
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'mine\n');

  const nested = path.join(dir, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  sh(`git init -q ${nested}`);                      // initialised, never committed
  fs.writeFileSync(path.join(nested, 'lib.js'), 'module.exports=1;\n');

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.pushed, true);
  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `notes.md must be saved, got:\n${files}`);
});

test('a push failure is reported as an error, never as success', { skip: !HAS_GIT }, () => {
  const { dir } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  const res = saveProfileState(dir, {
    profileId: 'alice', token: 'x', remoteUrl: '/nonexistent/repo.git',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'push failed');
  assert.equal(res.committed, true, 'the commit exists locally even though push failed');

  const notice = formatSaveError(res, { dir, branch: 'main' });
  assert.match(notice, /не сохранён в GitHub/);
  assert.match(notice, /push не удался/);
  assert.ok(notice.includes(dir), 'recovery refs must name the local dir — the data is there');
});

test('formatSaveError returns null for a success result', () => {
  assert.equal(formatSaveError({ ok: true }, null), null);
  assert.equal(formatSaveError(null, null), null);
});

test('isGitRepo / hasChanges on a directory that is not a repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-save-empty-'));
  assert.equal(isGitRepo(root), false);
  assert.equal(hasChanges(root), false);
});
