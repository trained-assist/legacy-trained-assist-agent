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

// ── Host tokens: the right to MINT run tokens (issue #2114, trap #9) ────────────
//
// POST /mcp/token sits behind AGENT_SECRET, and a remote engine host must never
// hold that (it is full-server access: /run spawns sessions, /internal/* reaches
// the machine). Without a second credential there is no way for a host on
// another box to get a token at all — and handing one out by hand does not work
// either, because run tokens live in this process's memory: every restart of the
// MCP host kills them (trap #8).
//
// MCP_HOST_TOKEN is therefore a host-level credential, held only by boxes allowed
// to drive this one, used for exactly one thing: minting a run token per run
// (POST /mcp/token). Comma-separated so a second host is added, not a rotation.
// Power: mint tokens for ANY profile — the tools stay scoped by the run token,
// but the holder can pick the profile, so treat it like a machine credential
// (secrets.env, never in git, never in an engine's env). It is NOT accepted
// anywhere else: runTokenFromAuthHeader only matches `rt_…`, and only the
// /mcp/token route reads this.
const HOST_TOKEN_PREFIX = 'mcp_';
const HOST_TOKEN_MIN_LEN = 32;

// Constant-time compare — a byte-wise `===` on a secret leaks its prefix through
// timing, and this is a network-reachable credential.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still burn the comparison so a length mismatch is not obviously faster.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// "Authorization: Bearer mcp_…" → true | false. Config comes from the env on
// every call (never cached at require time) so a rotated token is live after a
// plain restart, and so tests can set it without module surgery.
function mcpHostTokenFromAuthHeader(header, env = process.env) {
  const m = new RegExp(`^Bearer (${HOST_TOKEN_PREFIX}[A-Za-z0-9_-]+)$`).exec(String(header || ''));
  if (!m) return false;
  const offered = m[1];
  if (offered.length < HOST_TOKEN_MIN_LEN) return false;
  const configured = String(env.MCP_HOST_TOKEN || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith(HOST_TOKEN_PREFIX) && s.length >= HOST_TOKEN_MIN_LEN);
  return configured.some(expected => safeEqual(offered, expected));
}

module.exports = { issueRunToken, verifyRunToken, revokeRunToken, runTokenFromAuthHeader, mcpHostTokenFromAuthHeader, HOST_TOKEN_PREFIX, HOST_TOKEN_MIN_LEN };
