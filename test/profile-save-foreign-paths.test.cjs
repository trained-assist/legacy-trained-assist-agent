'use strict';
// #1921 — the incremental profile save must survive foreign paths that are
// NOT the profile's working data:
//
//   · a file the process cannot read (owned by another service account, mode 670):
//     `git add -A` aborts with 128, the whole save is lost, and the caller gets the
//     opaque `commit failed` because stderr is discarded;
//   · a nested git repository (a service tree under .agent-home): `git add -A` either
//     aborts with 128 ("does not have a commit checked out") or records a gitlink
//     (mode 160000) that silently drops the directory's contents.
//
// These are the two live failures on trained-assist-product-owner (05.10.2026). The
// contract: a foreign path must not cost the user the rest of the profile — the
// readable working data is still committed and pushed, and no gitlink (silent data
// loss) enters the image.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { saveProfileState } = require('../src/profile-save');

const HAS_GIT = !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

function sh(cmd, opts = {}) {
  const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-save-foreign-'));
  const dir = path.join(root, 'profile');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(dir, { recursive: true });
  sh(`git init --bare -q ${remote}`);
  sh(`git -C ${dir} init -q`);
  sh(`git -C ${dir} config user.email agent@local && git -C ${dir} config user.name agent`);
  return { root, dir, remote };
}

test('an unreadable foreign file does not cost the profile its working data', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  // Real working data that MUST reach GitHub.
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'contexts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'contexts', 'profile.md'), 'working data\n');
  // A file the process cannot read — exactly what aborts `git add -A` (exit 128).
  fs.writeFileSync(path.join(dir, 'contexts', 'locked.jsonl'), '{"x":1}\n');
  fs.chmodSync(path.join(dir, 'contexts', 'locked.jsonl'), 0o000);

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });

  assert.equal(res.ok, true, `save must not fail wholesale, got ${JSON.stringify(res)}`);
  assert.equal(res.pushed, true);
  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `working data must be on the remote, got:\n${files}`);
  assert.ok(files.includes('contexts/profile.md'), `working data must be on the remote, got:\n${files}`);
});

test('a nested git repository is not committed as a gitlink (no silent data loss)', { skip: !HAS_GIT }, () => {
  const { dir, remote } = fixture();
  fs.writeFileSync(path.join(dir, 'notes.md'), 'hello\n');
  // A service tree that is itself a git repo (the real .agent-home shape).
  const nested = path.join(dir, '.agent-home', 'tmp-arch-review', 'arch');
  fs.mkdirSync(nested, { recursive: true });
  sh(`git -C ${nested} init -q && git -C ${nested} config user.email a@b && git -C ${nested} config user.name a`);
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n');
  sh(`git -C ${nested} add -A && git -C ${nested} commit -qm inner`);

  const res = saveProfileState(dir, { profileId: 'alice', token: 'x', remoteUrl: remote });

  assert.equal(res.ok, true, `save must not fail on a nested repo, got ${JSON.stringify(res)}`);
  // A gitlink (mode 160000) is silent data loss — the directory's contents are not
  // stored. Either the service tree is excluded or handled, but never a gitlink.
  const gitlinks = sh(`git -C ${remote} ls-tree -r HEAD`).out
    .split('\n').filter((l) => l.startsWith('160000'));
  assert.deepEqual(gitlinks, [], `nested repos must not enter the image as gitlinks:\n${gitlinks.join('\n')}`);
  const files = sh(`git -C ${remote} ls-tree -r --name-only HEAD`).out;
  assert.ok(files.includes('notes.md'), `working data must still be on the remote, got:\n${files}`);
});
