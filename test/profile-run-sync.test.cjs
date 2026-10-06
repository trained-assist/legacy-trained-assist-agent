'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runSync = require('../src/profile-run-sync');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || `git ${args.join(' ')} failed`);
  return String(r.stdout || '').trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-run-sync-'));
  const dir = path.join(root, 'profile');
  const remote = path.join(root, 'remote.git');
  const stateRoot = path.join(root, 'agent-data');
  fs.mkdirSync(dir, { recursive: true });
  git(root, '--version');
  let r = spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  git(dir, 'config', 'user.email', 'agent@local');
  git(dir, 'config', 'user.name', 'agent');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'baseline\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, remote, stateRoot };
}

function bareFile(remote, branch, file) {
  const r = spawnSync('git', ['-C', remote, 'show', `refs/heads/${branch}:${file}`], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

async function start(f, runId) {
  const result = await runSync.beginProfileRun(f.dir, {
    profileId: 'alice', runId, token: 'not-a-real-token', remoteUrl: f.remote, root: f.stateRoot,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test('each run gets a unique remote branch, checkpoints files during the run, and merges on completion', async (t) => {
  const f = fixture(t);
  const runId = '8cc1d055-8b7c-4fcb-9d98-111111111111';
  const started = await start(f, runId);
  assert.equal(started.branch, `runs/${runId}`);
  assert.equal(git(f.remote, 'rev-parse', `refs/heads/runs/${runId}`).length, 40,
    'the branch is pushed before the run changes profile files');

  fs.mkdirSync(path.join(f.dir, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'projects', 'p1', 'result.md'), 'first checkpoint bytes\n');
  const checkpoint = await runSync.checkpointProfileRun(f.dir, {
    profileId: 'alice', runId, token: 'not-a-real-token', root: f.stateRoot,
  });
  assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint));
  assert.equal(bareFile(f.remote, `runs/${runId}`, 'projects/p1/result.md'), 'first checkpoint bytes');
  assert.equal(bareFile(f.remote, 'main', 'projects/p1/result.md'), null, 'work is visible on run branch before main merge');

  const completed = await runSync.mergeCompletedProfileRun(f.dir, {
    profileId: 'alice', runId, token: 'not-a-real-token', root: f.stateRoot,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(completed.status, 'merged');
  assert.equal(bareFile(f.remote, 'main', 'projects/p1/result.md'), 'first checkpoint bytes');
  assert.equal(git(f.remote, 'rev-parse', `refs/heads/runs/${runId}`).length, 40,
    'the source run branch remains available after merge');
  const retry = await runSync.mergeCompletedProfileRun(f.dir, {
    profileId: 'alice', runId, token: 'not-a-real-token', root: f.stateRoot,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.alreadyMerged, true, 'merge retry is idempotent');
});

test('two completed run branches merge sequentially without dropping either result', async (t) => {
  const f = fixture(t);
  const one = '11111111-1111-4111-8111-111111111111';
  const two = '22222222-2222-4222-8222-222222222222';
  await start(f, one);
  await start(f, two);
  fs.mkdirSync(path.join(f.dir, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'projects', 'p1', 'one.md'), 'one\n');
  assert.equal((await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId: one, token: 'x', root: f.stateRoot })).ok, true);

  fs.rmSync(path.join(f.dir, 'projects', 'p1', 'one.md'));
  fs.writeFileSync(path.join(f.dir, 'projects', 'p1', 'two.md'), 'two\n');
  assert.equal((await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId: two, token: 'x', root: f.stateRoot })).ok, true);

  assert.equal((await runSync.mergeCompletedProfileRun(f.dir, { profileId: 'alice', runId: one, token: 'x', root: f.stateRoot })).ok, true);
  assert.equal((await runSync.mergeCompletedProfileRun(f.dir, { profileId: 'alice', runId: two, token: 'x', root: f.stateRoot })).ok, true);
  assert.equal(bareFile(f.remote, 'main', 'projects/p1/one.md'), 'one');
  assert.equal(bareFile(f.remote, 'main', 'projects/p1/two.md'), 'two');
});

test('merge conflict is explicit and both source branches remain intact', async (t) => {
  const f = fixture(t);
  const one = '33333333-3333-4333-8333-333333333333';
  const two = '44444444-4444-4444-8444-444444444444';
  await start(f, one);
  await start(f, two);
  fs.writeFileSync(path.join(f.dir, 'notes.md'), 'result one\n');
  assert.equal((await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId: one, token: 'x', root: f.stateRoot })).ok, true);
  fs.writeFileSync(path.join(f.dir, 'notes.md'), 'result two\n');
  assert.equal((await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId: two, token: 'x', root: f.stateRoot })).ok, true);

  assert.equal((await runSync.mergeCompletedProfileRun(f.dir, { profileId: 'alice', runId: one, token: 'x', root: f.stateRoot })).ok, true);
  const conflict = await runSync.mergeCompletedProfileRun(f.dir, { profileId: 'alice', runId: two, token: 'x', root: f.stateRoot });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.status, 'merge_conflict');
  assert.match(conflict.lastError, /CONFLICT/);
  assert.equal(bareFile(f.remote, `runs/${one}`, 'notes.md'), 'result one');
  assert.equal(bareFile(f.remote, `runs/${two}`, 'notes.md'), 'result two');
});

test('a failed run-branch push keeps its local commit and retry pushes the same branch', async (t) => {
  const f = fixture(t);
  const runId = '55555555-5555-4555-8555-555555555555';
  await start(f, runId);
  fs.writeFileSync(path.join(f.dir, 'notes.md'), 'recoverable bytes\n');
  const movedRemote = `${f.remote}.offline`;
  fs.renameSync(f.remote, movedRemote);
  const failed = await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId, token: 'x', root: f.stateRoot });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'retryable');
  assert.equal(failed.step, 'push_checkpoint');
  const branchHead = git(f.dir, 'rev-parse', `refs/heads/runs/${runId}`);
  fs.renameSync(movedRemote, f.remote);
  const recovered = await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId, token: 'x', root: f.stateRoot });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(git(f.remote, 'rev-parse', `refs/heads/runs/${runId}`), branchHead,
    'retry reuses the preserved local commit instead of creating another archive/branch');
  assert.equal(bareFile(f.remote, `runs/${runId}`, 'notes.md'), 'recoverable bytes');
});

test('a restarted process resumes the same run branch and preserves earlier file contents', async (t) => {
  const f = fixture(t);
  const runId = '66666666-6666-4666-8666-666666666666';
  await start(f, runId);
  const file = path.join(f.dir, 'projects', 'p1', 'result.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"iteration":1,"value":"first"}\n');
  assert.equal((await runSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId, token: 'x', root: f.stateRoot })).ok, true);

  // Model a killed Node process: module memory is discarded, while the profile
  // repository, pending-task journal, and remote run branch survive.
  delete require.cache[require.resolve('../src/profile-run-sync')];
  const restartedSync = require('../src/profile-run-sync');
  const resumed = await restartedSync.beginProfileRun(f.dir, {
    profileId: 'alice', runId, token: 'x', remoteUrl: f.remote, root: f.stateRoot,
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.branch, `runs/${runId}`);
  assert.equal(bareFile(f.remote, resumed.branch, 'projects/p1/result.json'), '{"iteration":1,"value":"first"}');

  fs.writeFileSync(file, '{"iteration":2,"value":"second"}\n');
  assert.equal((await restartedSync.checkpointProfileRun(f.dir, { profileId: 'alice', runId, token: 'x', root: f.stateRoot })).ok, true);
  assert.equal(bareFile(f.remote, resumed.branch, 'projects/p1/result.json'), '{"iteration":2,"value":"second"}');
  assert.equal((await restartedSync.mergeCompletedProfileRun(f.dir, { profileId: 'alice', runId, token: 'x', root: f.stateRoot })).ok, true);
  assert.equal(bareFile(f.remote, 'main', 'projects/p1/result.json'), '{"iteration":2,"value":"second"}');
});
