'use strict';
// Resolves the GitHub token used by the issue-fixer / bugs-collector pipelines.
//
// Order:
//   1. GITHUB_ISSUES_TOKEN  — production secret (secrets.env, sourced by the cron wrappers)
//   2. GH_TOKEN
//   3. the user's credential file agent-tokens/<user>/github, read through the
//      shared tolerant reader (src/token-value.js) so JSON shapes
//      ({"value":...} / {"access_token":...}) are handled like everywhere else.
//
// Deliberately does NOT fall back to the token embedded in the git remote URL.
// That fallback kept a wide-scope token sitting in .git/config and hid the
// JSON-credential bug for months; a missing token now fails loudly instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTokenValue } = require('./token-value');
const { readCredentialFile } = require('./credential-store');

function githubTokenPath(tokensDir, user) {
  return path.join(tokensDir, String(user), 'github');
}

function resolveGithubToken({ tokensDir, user, env = process.env } = {}) {
  if (env.GITHUB_ISSUES_TOKEN) return env.GITHUB_ISSUES_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  const root = tokensDir || env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const uid = user || env.USER_ID || env.AGENT_USER_ID;
  if (!uid) return null;
  try {
    const p = githubTokenPath(root, uid);
    if (fs.existsSync(p)) return readTokenValue(readCredentialFile(p)) || null;
  } catch { /* no token on disk */ }
  return null;
}

module.exports = { resolveGithubToken, githubTokenPath };
