'use strict';
// Canonical staging isolation guard (epic #1365 Phase 0 gate) — preloaded into
// EVERY staging scenario process via NODE_OPTIONS=--require (vitest forks and
// child processes inherit it). Fail-fast, not best-effort:
//
// 1. Every data root (HOME, TMPDIR — tests mkdtemp under os.tmpdir() —, USERS_DIR, AGENT_DATA_DIR, AGENT_TOKENS_*) must
//    realpath-resolve INSIDE STAGING_ROOT. ~160 code paths derive dirs from
//    os.homedir(), so HOME itself is a root — a prod home can never be reached.
// 2. Production credentials in the environment abort the run.
// 3. Outbound network is loopback-only: Telegram / OpenRouter / Cloudflare /
//    GitHub calls throw STAGING_OUTBOUND_BLOCKED instead of leaving the box.
//    Tests that need Telegram use a local fake (loopback) — that is allowed.
//    Every blocked attempt is appended to STAGING_BLOCKED_LOG for the manifest.
//
// This file is the source of truth in @trained-assist/mcp-skill-testkit; the
// core repo's scripts/staging/isolation-guard.cjs is a thin re-export of it.
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT_VARS = ['HOME', 'TMPDIR', 'USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT', 'AGENT_TOKENS_DIR'];
const SECRET_VARS = [
  'TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'AGENT_SECRET', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'DEEPSEEK_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '']);

function fail(msg) {
  const e = new Error(`[staging-isolation] ${msg}`);
  e.code = 'STAGING_ISOLATION';
  throw e;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A root may be created later by the test itself: resolve the nearest existing
// ancestor, so a not-yet-created dir is judged by where it WILL live.
function realOrAncestor(p) {
  let cur = path.resolve(p), tail = '';
  for (;;) {
    try { return path.join(fs.realpathSync(cur), tail); }
    catch { const up = path.dirname(cur); if (up === cur) return path.resolve(p); tail = path.join(path.basename(cur), tail); cur = up; }
  }
}

function checkRoots(env = process.env) {
  if (!env.STAGING_ROOT) fail('STAGING_ROOT is not set');
  const root = fs.realpathSync(env.STAGING_ROOT);
  for (const name of ROOT_VARS) {
    if (!env[name]) { if (name === 'HOME' || name === 'AGENT_DATA_DIR') fail(`${name} is not set`); continue; }
    const real = realOrAncestor(env[name]);
    if (!inside(real, root)) fail(`${name}=${real} is outside STAGING_ROOT=${root}`);
  }
  // Credentials are checked for the processes the gate itself launches (direct
  // children of the runner). Tests may spawn helpers with FAKE tokens — those
  // cannot leak anyway: outbound is loopback-only in every process.
  const direct = !env.STAGING_RUNNER_PID || String(process.ppid) === String(env.STAGING_RUNNER_PID);
  const leaked = direct ? SECRET_VARS.filter(v => env[v]) : [];
  if (leaked.length) fail(`production credentials present in env: ${leaked.join(', ')}`);
  return root;
}

function isLoopback(host) {
  if (host == null) return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK.has(h) || h.startsWith('127.') || h === '::ffff:127.0.0.1';
}

function recordBlocked(target) {
  const log = process.env.STAGING_BLOCKED_LOG;
  if (log) { try { fs.appendFileSync(log, `${process.pid} ${target}\n`); } catch {} }
}

function blocked(target) {
  recordBlocked(target);
  const e = new Error(`STAGING_OUTBOUND_BLOCKED: ${target} (staging allows loopback only)`);
  e.code = 'STAGING_OUTBOUND_BLOCKED';
  return e;
}

function installNetworkGuard() {
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const opts = args[0];
    let host, port;
    if (Array.isArray(opts)) return origConnect.apply(this, args); // internal normalized form
    if (typeof opts === 'object' && opts) { if (opts.path) return origConnect.apply(this, args); host = opts.host; port = opts.port; }
    else if (typeof opts === 'string' && isNaN(Number(opts))) return origConnect.apply(this, args); // unix socket path
    else { port = opts; host = typeof args[1] === 'string' ? args[1] : 'localhost'; }
    if (!isLoopback(host)) {
      const err = blocked(`${host}:${port}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return origConnect.apply(this, args);
  };
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let url;
      try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input)); } catch { return origFetch(input, init); }
      if (!['http:', 'https:'].includes(url.protocol) || isLoopback(url.hostname)) return origFetch(input, init);
      return Promise.reject(blocked(url.host));
    };
  }
}

if (require.main === module || process.env.STAGING_ISOLATION === '1') {
  checkRoots();
  installNetworkGuard();
}

module.exports = { checkRoots, isLoopback, installNetworkGuard, ROOT_VARS, SECRET_VARS };
