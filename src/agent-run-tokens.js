'use strict';

// Run-scoped callback tokens (issue #1649). An engine run gets AGENT_RUN_TOKEN
// instead of the server-wide AGENT_SECRET: it identifies exactly one run
// ({taskId, username}), lives only in this process's memory and is revoked when
// the run ends. Callers check the scope (e.g. extend-timeout only for its own
// taskId) — a run token is never accepted as AGENT_SECRET.

const crypto = require('crypto');

const PREFIX = 'rt_';
const tokens = new Map(); // sha256(token) → scope

function keyOf(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function issueRunToken({ taskId, username }) {
  const token = PREFIX + crypto.randomBytes(32).toString('hex');
  tokens.set(keyOf(token), { taskId: String(taskId || ''), username: String(username || ''), issuedAt: Date.now() });
  return token;
}

function verifyRunToken(token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  return tokens.get(keyOf(token)) || null;
}

function revokeRunToken(token) {
  if (typeof token === 'string') tokens.delete(keyOf(token));
}

// "Authorization: Bearer rt_…" → scope | null
function runTokenFromAuthHeader(header) {
  const m = /^Bearer (rt_[0-9a-f]{64})$/.exec(String(header || ''));
  return m ? verifyRunToken(m[1]) : null;
}

module.exports = { issueRunToken, verifyRunToken, revokeRunToken, runTokenFromAuthHeader };
