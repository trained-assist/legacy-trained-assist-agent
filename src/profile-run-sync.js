'use strict';

// Per-execution profile snapshots. The profile working tree is shared by parallel
// conversations, so these operations use refs + a private index instead of checkout;
// a run must never move another run's HEAD or overwrite its index.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SYSTEM_ROOT } = require('./data-paths');
const { profileRepoUrl } = require('./profile-save');

const STATE_VERSION = 1;
const MERGE_RETRIES = 4;
const ACTIVE = new Set();

function runBranchName(runId) {
  const id = String(runId || '');
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id)) throw new Error('runId must be a stable 8–128 character id');
  return `runs/${id}`;
}

function stateFile(profileId, runId, root = SYSTEM_ROOT) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(profileId || ''))) throw new Error('invalid profileId');
  const branch = runBranchName(runId).slice('runs/'.length);
  return path.join(root, 'profile-runs', String(profileId), `${branch}.json`);
}

function git(dir, args, { token = null, timeout = 30_000, env = {} } = {}) {
  const cmd = ['-C', dir, ...args];
  if (token) {
    const helper = `!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=${token}"; }; f`;
    cmd.splice(2, 0, '-c', `credential.helper=${helper}`);
  }
  const r = spawnSync('git', cmd, { encoding: 'utf8', timeout, env: { ...process.env, ...env } });
  return { status: r?.status ?? null, stdout: String(r?.stdout || '').trim(), stderr: String(r?.stderr || ''), error: r?.error || null };
}

function gitOk(dir, args, options) {
  const r = git(dir, args, options);
  return r.status === 0 ? r.stdout : null;
}

function writeState(profileId, runId, state, root = SYSTEM_ROOT) {
  const file = stateFile(profileId, runId, root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: STATE_VERSION, profileId, runId, ...state }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function readState(profileId, runId, root = SYSTEM_ROOT) {
  try { return JSON.parse(fs.readFileSync(stateFile(profileId, runId, root), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function fail(profileId, runId, state, step, error, root) {
  const next = { ...state, step, status: 'retryable', lastError: String(error || 'unknown').slice(0, 1000), updatedAt: new Date().toISOString() };
  writeState(profileId, runId, next, root);
  return { ok: false, ...next };
}

function remoteMain(dir, token) {
  const sym = gitOk(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { token });
  if (sym && sym.startsWith('origin/')) return sym.slice('origin/'.length);
  const advertised = gitOk(dir, ['ls-remote', '--symref', 'origin', 'HEAD'], { token });
  const advertisedMatch = advertised && /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m.exec(advertised);
  if (advertisedMatch) return advertisedMatch[1];
  for (const candidate of ['main', 'master']) {
    if (git(dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], { token }).status === 0) return candidate;
  }
  const upstream = gitOk(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { token });
  if (upstream?.startsWith('origin/')) return upstream.slice('origin/'.length);
  return null;
}

function prepareProfileRepo(dir, profileId, token, remoteUrl) {
  if (gitOk(dir, ['rev-parse', '--is-inside-work-tree'], { token }) !== 'true') {
    const init = git(dir, ['init', '-b', 'main'], { token });
    if (init.status !== 0) return { ok: false, error: init.stderr || 'git init failed' };
  }
  const expectedRemote = remoteUrl || profileRepoUrl(profileId);
  const currentRemote = gitOk(dir, ['remote', 'get-url', 'origin'], { token });
  let remote = null;
  if (currentRemote === expectedRemote) remote = { status: 0 };
  else if (currentRemote) remote = git(dir, ['remote', 'set-url', 'origin', expectedRemote], { token });
  else remote = git(dir, ['remote', 'add', 'origin', expectedRemote], { token });
  if (remote.status !== 0) return { ok: false, error: remote.stderr || 'failed to configure profile origin' };

  // Keep the profile image on the same clean-list boundary as the existing M6 saver.
  try {
    const classifier = require('../scripts/profile-migrate/classifier.cjs');
    const gitignore = require('../scripts/profile-migrate/gitignore.cjs');
    const rules = classifier.loadRules(classifier.DEFAULT_CLEAN_LIST).rules;
    fs.writeFileSync(path.join(dir, '.gitignore'), gitignore.buildGitIgnore(rules));
  } catch (e) { return { ok: false, error: `profile clean-list setup failed: ${e.message}` }; }

  const fetch = git(dir, ['fetch', '--no-tags', 'origin'], { token, timeout: 30 * 60_000 });
  // Fetch exits non-zero for a new, empty profile repo. That is handled below by
  // seeding only an empty/baseline commit; no run's working-tree files go to main.
  const currentMain = remoteMain(dir, token);
  if (currentMain) return { ok: true, defaultBranch: currentMain };

  const localHead = gitOk(dir, ['rev-parse', 'HEAD'], { token });
  let seed = localHead;
  if (!seed) {
    const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-run-empty-index-'));
    const indexFile = path.join(indexDir, 'index');
    try {
      const opts = { token, env: { GIT_INDEX_FILE: indexFile } };
      if (git(dir, ['read-tree', '--empty'], opts).status !== 0) return { ok: false, error: 'could not create empty profile baseline' };
      const tree = gitOk(dir, ['write-tree'], opts);
      if (!tree) return { ok: false, error: 'could not write empty profile baseline' };
      seed = gitOk(dir, ['-c', 'user.name=Trained Assist Agent', '-c', 'user.email=agent@trainedassist.store', 'commit-tree', tree, '-m', 'initialize profile repository'], { token });
      if (!seed) return { ok: false, error: 'could not commit empty profile baseline' };
    } finally { fs.rmSync(indexDir, { recursive: true, force: true }); }
  }
  const seeded = pushRef(dir, token, seed, 'refs/heads/main');
  if (!seeded.ok) return { ok: false, error: `could not initialize profile main: ${seeded.error}` };
  const refetch = git(dir, ['fetch', '--no-tags', 'origin', 'main'], { token, timeout: 30 * 60_000 });
  if (refetch.status !== 0) return { ok: false, error: refetch.stderr || 'failed to fetch initialized profile main' };
  return { ok: true, defaultBranch: 'main' };
}

function pushRef(dir, token, localRef, remoteRef) {
  const r = git(dir, ['push', 'origin', `${localRef}:${remoteRef}`], { token, timeout: 30 * 60_000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: r.error?.message || r.stderr || `git push exited ${r.status}` };
}

// Create or recover the execution branch and publish it before the agent starts.
// The starting point is fetched main. The shared working tree is NOT committed to
// main here: it may contain an unfinished parallel run, and bypassing that run's
// branch would silently integrate it before its completion/merge step.
async function beginProfileRun(dir, { profileId, runId, token, remoteUrl = null, root = SYSTEM_ROOT } = {}) {
  const branch = runBranchName(runId);
  let state = readState(profileId, runId, root) || { branch, sessionId: null, createdAt: new Date().toISOString() };
  if (state.status === 'branch_ready' || state.status === 'checkpointed' || state.status === 'merge_pending' || state.status === 'merged') {
    return { ok: true, ...state, resumed: true };
  }

  const prepared = prepareProfileRepo(dir, profileId, token, remoteUrl);
  if (!prepared.ok) return fail(profileId, runId, state, 'prepare_profile_repo', prepared.error, root);
  const defaultBranch = prepared.defaultBranch;
  const fetch = git(dir, ['fetch', '--no-tags', 'origin', defaultBranch], { token, timeout: 30 * 60_000 });
  if (fetch.status !== 0) return fail(profileId, runId, state, 'fetch_default_branch', fetch.error?.message || fetch.stderr, root);
  const mainRef = `refs/remotes/origin/${defaultBranch}`;
  const localRunRef = `refs/heads/${branch}`;
  const remoteRunRef = `refs/heads/${branch}`;
  const remoteBranch = git(dir, ['ls-remote', '--exit-code', '--heads', 'origin', remoteRunRef], { token });
  if (remoteBranch.status === 0) {
    const fetched = git(dir, ['fetch', '--no-tags', 'origin', `+${remoteRunRef}:${localRunRef}`], { token, timeout: 30 * 60_000 });
    if (fetched.status !== 0) return fail(profileId, runId, state, 'fetch_run_branch', fetched.stderr, root);
  } else if (git(dir, ['show-ref', '--verify', '--quiet', localRunRef], { token }).status !== 0) {
    const created = git(dir, ['branch', '--no-track', branch, mainRef], { token });
    if (created.status !== 0) return fail(profileId, runId, state, 'create_run_branch', created.stderr, root);
  }
  const pushed = pushRef(dir, token, localRunRef, remoteRunRef);
  if (!pushed.ok) return fail(profileId, runId, state, 'push_run_branch', pushed.error, root);
  state = { ...state, branch, defaultBranch, baseRef: mainRef, status: 'branch_ready', step: 'branch_ready', updatedAt: new Date().toISOString(), lastError: null };
  writeState(profileId, runId, state, root);
  return { ok: true, ...state, resumed: false };
}

// Stage the profile snapshot into a run-specific temporary index, commit it directly
// on the run ref, then push that ref. A failed push leaves the local commit and retry
// state intact; retrying the same runId neither creates a second branch nor loses files.
async function checkpointProfileRun(dir, { profileId, runId, token, root = SYSTEM_ROOT, state: givenState = null, at = Date.now() } = {}) {
  const state = givenState || readState(profileId, runId, root) || { branch: runBranchName(runId) };
  const branch = state.branch || runBranchName(runId);
  const ref = `refs/heads/${branch}`;
  if (ACTIVE.has(ref)) return { ok: false, status: 'busy', branch, retryable: true };
  ACTIVE.add(ref);
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-run-index-'));
  const indexFile = path.join(indexDir, 'index');
  const options = { token, env: { GIT_INDEX_FILE: indexFile }, timeout: 30 * 60_000 };
  try {
    const tip = gitOk(dir, ['rev-parse', ref], { token });
    if (!tip) return fail(profileId, runId, state, 'resolve_run_branch', 'local run branch is missing', root);
    let r = git(dir, ['read-tree', tip], options);
    if (r.status !== 0) return fail(profileId, runId, state, 'read_run_tree', r.stderr, root);
    r = git(dir, ['add', '-A', '--', '.'], options);
    if (r.status !== 0) return fail(profileId, runId, state, 'stage_profile', r.error?.message || r.stderr || `git add exited ${r.status}`, root);
    const tree = gitOk(dir, ['write-tree'], options);
    if (!tree) return fail(profileId, runId, state, 'write_run_tree', 'git write-tree failed', root);
    const parentTree = gitOk(dir, ['show', '-s', '--format=%T', tip], { token });
    let head = tip;
    if (tree !== parentTree) {
      const commit = gitOk(dir, ['-c', 'user.name=Trained Assist Agent', '-c', 'user.email=agent@trainedassist.store', 'commit-tree', tree, '-p', tip, '-m', `run ${runId} checkpoint ${new Date(at).toISOString()}`], { token });
      if (!commit) return fail(profileId, runId, state, 'commit_checkpoint', 'git commit-tree failed', root);
      const update = git(dir, ['update-ref', ref, commit, tip], { token });
      if (update.status !== 0) return fail(profileId, runId, state, 'update_run_ref', update.stderr, root);
      head = commit;
    }
    const pushed = pushRef(dir, token, ref, `refs/heads/${branch}`);
    if (!pushed.ok) return fail(profileId, runId, { ...state, head }, 'push_checkpoint', pushed.error, root);
    const next = { ...state, branch, head, status: 'checkpointed', step: 'checkpointed', checkpointAt: new Date(at).toISOString(), updatedAt: new Date().toISOString(), lastError: null };
    writeState(profileId, runId, next, root);
    return { ok: true, ...next };
  } finally {
    ACTIVE.delete(ref);
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

function mergeRunTree(dir, mainRef, runRef, token) {
  const merged = git(dir, ['merge-tree', '--write-tree', mainRef, runRef], { token, timeout: 30_000 });
  if (merged.status !== 0) return { ok: false, conflict: merged.status === 1, error: merged.stdout || merged.stderr || `git merge-tree exited ${merged.status}` };
  const tree = merged.stdout.split(/\s+/)[0];
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return { ok: false, conflict: false, error: 'git merge-tree returned no tree id' };
  return { ok: true, tree };
}

// Integrate a completed run without checkout or force push. Concurrent completions
// race on a normal fast-forward push; losers refetch and re-merge. Conflicts leave both
// remote branches untouched and persist an explicit retryable conflict state.
async function mergeCompletedProfileRun(dir, { profileId, runId, token, root = SYSTEM_ROOT } = {}) {
  let state = readState(profileId, runId, root) || { branch: runBranchName(runId) };
  if (state.status === 'merged') return { ok: true, ...state, alreadyMerged: true };
  state = { ...state, status: 'merge_pending', step: 'merge_pending', updatedAt: new Date().toISOString() };
  writeState(profileId, runId, state, root);
  const defaultBranch = state.defaultBranch || remoteMain(dir, token);
  if (!defaultBranch) return fail(profileId, runId, state, 'resolve_default_branch', 'remote has no main/master branch', root);
  const runRef = `refs/heads/${state.branch}`;
  for (let attempt = 1; attempt <= MERGE_RETRIES; attempt++) {
    const fetch = git(dir, ['fetch', '--no-tags', 'origin', defaultBranch], { token, timeout: 30 * 60_000 });
    if (fetch.status !== 0) return fail(profileId, runId, state, 'fetch_before_merge', fetch.stderr, root);
    const mainRef = `refs/remotes/origin/${defaultBranch}`;
    const mainHead = gitOk(dir, ['rev-parse', mainRef], { token });
    const runHead = gitOk(dir, ['rev-parse', runRef], { token });
    if (!mainHead || !runHead) return fail(profileId, runId, state, 'resolve_merge_refs', 'main or run branch is missing', root);
    const isAncestor = git(dir, ['merge-base', '--is-ancestor', runRef, mainRef], { token });
    if (isAncestor.status === 0) {
      const done = { ...state, status: 'merged', step: 'merged', mergedAt: new Date().toISOString(), mergedHead: mainHead, lastError: null };
      writeState(profileId, runId, done, root);
      return { ok: true, ...done, alreadyMerged: true };
    }
    const tree = mergeRunTree(dir, mainRef, runRef, token);
    if (!tree.ok) {
      const status = tree.conflict ? 'merge_conflict' : 'retryable';
      const conflict = { ...state, status, step: 'merge', mergeAttempt: attempt, lastError: tree.error.slice(0, 1000), updatedAt: new Date().toISOString() };
      writeState(profileId, runId, conflict, root);
      return { ok: false, ...conflict, conflict: tree.conflict };
    }
    const commit = gitOk(dir, ['-c', 'user.name=Trained Assist Agent', '-c', 'user.email=agent@trainedassist.store', 'commit-tree', tree.tree, '-p', mainHead, '-p', runHead, '-m', `merge run ${runId}`], { token });
    if (!commit) return fail(profileId, runId, state, 'create_merge_commit', 'git commit-tree failed', root);
    const pushed = pushRef(dir, token, commit, `refs/heads/${defaultBranch}`);
    if (pushed.ok) {
      const done = { ...state, status: 'merged', step: 'merged', mergedAt: new Date().toISOString(), mergedHead: commit, lastError: null };
      writeState(profileId, runId, done, root);
      return { ok: true, ...done };
    }
    state = { ...state, status: 'merge_pending', step: 'push_merge', mergeAttempt: attempt, lastError: pushed.error, updatedAt: new Date().toISOString() };
  }
  writeState(profileId, runId, state, root);
  return { ok: false, ...state, retryable: true };
}

async function completeProfileRun(dir, options = {}) {
  const checkpoint = await checkpointProfileRun(dir, options);
  if (!checkpoint.ok) return checkpoint;
  return mergeCompletedProfileRun(dir, options);
}

module.exports = {
  runBranchName, stateFile, readState, beginProfileRun,
  checkpointProfileRun, mergeCompletedProfileRun, completeProfileRun,
  _git: git,
};
