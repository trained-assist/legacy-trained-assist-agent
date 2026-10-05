'use strict';

// M6 (#1921): commit + push the profile's text image to its private GitHub repo.
//
// The profile's text image (KEEP files from the clean-list) is committed to
// `profiles-artifacts/profile-<name>` so the user's data is durable and they can
// be granted access to it. The .gitignore is generated from the SAME clean-list
// the M0 classifier walks by, so the inventory and the image can never drift.
//
// Triggered at the end of a run when the profile's git state is unsaved.
// Failures are reported explicitly — never silently dropped, never claimed as
// saved when the push did not happen.
//
// The token is passed in by the caller (read from GCP Secret Manager). It is
// never printed, never written to a file, never put in the engine env.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GIT_TIMEOUT_MS = 15000;
const ORG = 'profiles-artifacts';

function git(dir, args, { token = null, timeout = GIT_TIMEOUT_MS } = {}) {
  const cmd = ['-C', dir, ...args];
  if (token) {
    // Inline credential helper — the token never touches disk or the process list.
    const helper = `!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=${token}"; }; f`;
    cmd.splice(2, 0, '-c', `credential.helper=${helper}`);
  }
  const r = spawnSync('git', cmd, { encoding: 'utf8', timeout });
  return r && r.status === 0 ? String(r.stdout || '').trim() : null;
}

function isGitRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function getRemote(dir) {
  return git(dir, ['remote', 'get-url', 'origin']);
}

function setRemote(dir, url) {
  const existing = getRemote(dir);
  if (existing === url) return true;
  if (existing) return git(dir, ['remote', 'set-url', 'origin', url]) !== null;
  return git(dir, ['remote', 'add', 'origin', url]) !== null;
}

// Must match scripts/profile-repo.mjs exactly — the repo name is derived from
// the profileId by a pure function, so both sides must agree.
function sanitizeProfileId(profileId) {
  return String(profileId).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

function profileRepoName(profileId) {
  const sanitized = sanitizeProfileId(profileId);
  const suffix = sanitized !== String(profileId).toLowerCase()
    ? `-${crypto.createHash('sha256').update(String(profileId)).digest('hex').slice(0, 6)}`
    : '';
  return `profile-${sanitized}${suffix}`;
}

function profileRepoUrl(profileId) {
  return `https://github.com/${ORG}/${profileRepoName(profileId)}.git`;
}

function writeGitignore(dir) {
  const classifier = require('../scripts/profile-migrate/classifier.cjs');
  const gitignore = require('../scripts/profile-migrate/gitignore.cjs');
  const rules = classifier.loadRules(classifier.DEFAULT_CLEAN_LIST).rules;
  fs.writeFileSync(path.join(dir, '.gitignore'), gitignore.buildGitIgnore(rules));
}

// "Is there something to save?" — INCLUDES untracked files.
//
// The run-end-save-check deliberately uses `-uno` (untracked does not count as
// unsaved for a plan workspace — reports and artifacts next to the code are
// intended). Here the opposite is required: the FIRST save of a profile finds
// every file untracked, so a `-uno` probe would report "nothing to do" and the
// profile would never reach GitHub at all. Committing then adds them via `add -A`.
function hasChanges(dir) {
  const status = git(dir, ['status', '--porcelain']);
  return status !== null && status !== '';
}

function commit(dir, message) {
  git(dir, ['add', '-A']);
  if (!hasChanges(dir)) return false;
  return git(dir, ['commit', '-m', message]) !== null;
}

function push(dir, { token }) {
  return git(dir, ['push', 'origin', 'HEAD'], { token }) !== null;
}

// Main entry. Returns { ok, committed, pushed, error? }.
// Never throws — a failure is a typed result the caller reports.
// remoteUrl — override the origin. The runner never passes it (production always
// targets the org repo); it exists so the test can point at a local bare repo
// instead of GitHub, and so an operator can point a profile at a mirror.
function saveProfileState(dir, { profileId, token, commitMessage = null, remoteUrl = null } = {}) {
  if (!dir || !profileId) return { ok: false, error: 'dir and profileId are required' };

  const origin = remoteUrl || profileRepoUrl(profileId);

  if (!isGitRepo(dir)) {
    git(dir, ['init']);
  }
  // The .gitignore is regenerated on every save: it is generated from the clean-list,
  // so a changed list must take effect without waiting for a fresh profile.
  writeGitignore(dir);
  // Origin is set unconditionally, NOT only right after `git init`: a profile dir can
  // already be a repo (the engine commits code there) with no origin or a stale one,
  // and then the push silently has nowhere to go.
  if (!setRemote(dir, origin)) {
    return { ok: false, error: 'failed to set remote' };
  }

  if (!hasChanges(dir)) return { ok: true, committed: false, pushed: false };

  const msg = commitMessage || `profile sync: ${new Date().toISOString()}`;
  if (!commit(dir, msg)) return { ok: false, error: 'commit failed' };
  if (!push(dir, { token })) return { ok: false, error: 'push failed', committed: true };

  return { ok: true, committed: true, pushed: true };
}

// Explicit notice for the user when the save did not complete. Recovery refs
// point at the local dir — the data is there, it just is not on GitHub yet.
function formatSaveError(err, state) {
  if (!err || !err.error) return null;
  const parts = [];
  if (err.committed) parts.push('коммит создан локально, но push не удался');
  else parts.push('коммит не создан');
  const where = state && state.dir ? `${state.dir}@${state.branch || 'unknown'}` : 'profile';
  return `⚠️ Профиль не сохранён в GitHub: ${parts.join(', ')} (${where}). ` +
    `Данные остаются на диске — повторите сохранение или продолжите работу.`;
}

module.exports = {
  saveProfileState,
  formatSaveError,
  profileRepoUrl,
  profileRepoName,
  sanitizeProfileId,
  isGitRepo,
  hasChanges,
  git,
};