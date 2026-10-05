'use strict';

// #143 rule 6 — «перед завершением проверь dirty/untracked, непереданные коммиты и
// remote SHA; не смог сохранить → partial/blocked с recovery refs, не называй
// local-only „saved/done“». This is the read-only checker the runtime uses; it never
// commits, pushes, or rewrites anything, and it never throws.
//
// Two callers:
//   • durable plan finalization — a plan whose workspace still holds modified tracked
//     files or unpushed commits must not report `done` (gtd-controller.settleTaskCompletion);
//   • a chat run — a short notice when the working directory holds unpushed commits
//     (the classic «committed locally, never pushed» miss).
//
// Untracked files are NOT treated as unsaved on purpose: a plan may legitimately leave
// reports/artifacts next to the code, and blocking on those would punish the intended
// behaviour. Only modified tracked files and unpushed commits count.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 5000;

function git(dir, args, run) {
  try {
    const r = (run || spawnSync)('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return r && r.status === 0 ? String(r.stdout || '').trim() : null;
  } catch {
    return null;
  }
}

// Untrimmed stdout — `git status --porcelain` is column-positional (`XY<space>path`)
// and trimming the whole output would eat the first line's leading status space.
function gitRaw(dir, args, run) {
  try {
    const r = (run || spawnSync)('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return r && r.status === 0 ? String(r.stdout || '') : null;
  } catch {
    return null;
  }
}

// Read-only save state of one directory. Never throws; a non-repo is `isRepo:false`.
function gitSaveState(dir, { run = null } = {}) {
  if (!dir) return { isRepo: false, dir: null };
  if (git(dir, ['rev-parse', '--is-inside-work-tree'], run) !== 'true') {
    return { isRepo: false, dir };
  }
  const branch = git(dir, ['branch', '--show-current'], run) || '(detached)';
  const head = git(dir, ['rev-parse', 'HEAD'], run);
  // -uno: untracked files are excluded from the verdict anyway, and scanning them is the
  // expensive part of `git status` on a large tree. Keeps this check off the run's hot path.
  const porcelain = gitRaw(dir, ['status', '--porcelain', '-uno'], run) || '';
  // Modified TRACKED files only — `??` (untracked) is deliberately excluded.
  const modified = porcelain.split('\n')
    .filter(l => l && !l.startsWith('??'))
    .map(l => l.slice(3).trim())
    .filter(Boolean);
  let ahead = null;
  let hasUpstream = false;
  if (git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], run)) {
    hasUpstream = true;
    const counts = git(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], run);
    if (counts) ahead = Number(counts.split(/\s+/)[1]) || 0;
  }
  return {
    isRepo: true, dir, branch, head,
    modified, modifiedCount: modified.length,
    ahead, hasUpstream,
    unsaved: modified.length > 0 || (ahead != null && ahead > 0),
  };
}

// The plan workspace of a task: `<workspacesDir>/<repo>/ws-*/code` whose branch ends
// with `plan-<id8>` — the same identity collectPlanWorkspaceEvidence uses. Returns null
// when the profile has no workspace for this plan (nothing to check).
function planWorkspaceSaveState(profileId, taskId, { run = null, workspacesDir = null } = {}) {
  let base = workspacesDir;
  if (!base) {
    try { base = require('./data-paths').engineeringWorkspacesDir(profileId); } catch { return null; }
  }
  const suffix = `plan-${String(taskId).slice(0, 8)}`;
  let repos = [];
  try { repos = fs.readdirSync(base); } catch { return null; }
  for (const repo of repos) {
    let wss = [];
    try { wss = fs.readdirSync(path.join(base, repo)).filter(d => d.startsWith('ws-')); } catch { continue; }
    for (const ws of wss) {
      const dir = path.join(base, repo, ws, 'code');
      const branch = git(dir, ['branch', '--show-current'], run);
      if (!branch || !branch.endsWith(suffix)) continue;
      return gitSaveState(dir, { run });
    }
  }
  return null;
}

// Recovery refs for the human/next step, never a claim of success.
function formatUnsaved(state, { repo = null } = {}) {
  if (!state || !state.isRepo || !state.unsaved) return null;
  const parts = [];
  if (state.modifiedCount > 0) parts.push(`${state.modifiedCount} изменённых файл(ов)`);
  if (state.ahead != null && state.ahead > 0) parts.push(`${state.ahead} незапушенных коммит(ов)`);
  const where = repo ? `${repo}@${state.branch}` : state.branch;
  return `⚠️ Работа не сохранена полностью: ${parts.join(', ')} в ${where}. ` +
    `Workspace сохранён: ${state.dir} — закоммить/запушь или продолжи работу; local-only результат не считается done.`;
}

module.exports = { gitSaveState, planWorkspaceSaveState, formatUnsaved, GIT_TIMEOUT_MS };
