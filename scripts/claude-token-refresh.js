#!/usr/bin/env node
'use strict';
/*
 * claude-token-refresh.js — single-owner OAuth refresh broker for Claude Code.
 *
 * WHY THIS EXISTS
 *   The agent spawns up to MAX_CONCURRENT_TASKS `claude --print` subprocesses,
 *   all sharing one ~/.claude/.credentials.json. Claude's OAuth access token
 *   lives ~8h; the *refresh* token is one-time-rotating. When the access token
 *   nears expiry, every live subprocess tries to refresh on its own, racing on
 *   the same refresh token: the first rotates it, the rest present a now-invalid
 *   token → 401 → credentials wiped → the operator is forced to re-login every
 *   few hours. See docs/claude-oauth-refresh.md.
 *
 * WHAT IT DOES
 *   Exactly ONE process ever refreshes. This broker:
 *     1. takes an exclusive flock on ~/.claude/.credentials.lock (blocks if a
 *        peer broker is mid-refresh; never two refreshes at once).
 *     2. reads credentials, and if the access token expires within --margin,
 *        performs the OAuth refresh and atomically writes the new pair back.
 *   Run it on a short timer (every ~30m) with a wide margin (~3h). The token is
 *   then always fresh long before any `claude` subprocess would refresh itself,
 *   so the subprocess refresh path is never taken → the race can't happen.
 *
 * USAGE
 *   node claude-token-refresh.js            # refresh iff within margin, else no-op
 *   node claude-token-refresh.js --force    # refresh now regardless of margin
 *   node claude-token-refresh.js --dry-run  # report state; no network, no write
 *   node claude-token-refresh.js --margin=10800   # seconds (default 10800 = 3h)
 *
 * SAFETY
 *   - A failed refresh (bad endpoint / 4xx) does NOT rotate the token server-side
 *     and does NOT touch the file: we only write on a validated 200 response.
 *   - Every write is atomic (temp + fsync + rename) and preceded by a timestamped
 *     backup in ~/.claude/credentials-backups/ (last 10 kept).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The broker is the only place that KNOWS the credentials are dead before any run tries them,
// so it owns the long-lived «Claude недоступен» flag the runner's admission gate reads
// (src/auth-flag.js → authGate). Set it on an auth-class refresh failure, clear it on the next
// successful refresh = «до следующей авторизации».
const { setAuthFailedFlag, clearAuthFailedFlag, getAuthFlag } = require('../src/auth-flag');

// Claude Code public OAuth client id + token endpoint (same values the CLI uses).
const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL || 'https://console.anthropic.com/v1/oauth/token';

const HOME = os.homedir();
const CRED_PATH = process.env.CLAUDE_CREDENTIALS_PATH || path.join(HOME, '.claude', '.credentials.json');
const LOCK_PATH = CRED_PATH + '.lock';
const BACKUP_DIR = path.join(path.dirname(CRED_PATH), 'credentials-backups');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const marginArg = args.find((a) => a.startsWith('--margin='));
const MARGIN_SEC = marginArg ? Number(marginArg.split('=')[1]) : Number(process.env.CLAUDE_REFRESH_MARGIN_SEC) || 10800; // 3h

function log(...a) { console.log(`[claude-token-refresh ${new Date().toISOString()}]`, ...a); }

// ── exclusive lock: only one broker refreshes at a time ─────────────────────
// O_CREAT|O_EXCL is atomic on POSIX. If the lock exists we back off (someone
// else is refreshing). Stale locks (process died) are reclaimed after 120s.
function acquireLock() {
  const deadline = Date.now() + 60000; // wait up to 60s for a peer to finish
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx'); // fail if exists
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // reclaim a stale lock
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > 120000) { fs.unlinkSync(LOCK_PATH); continue; }
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) return false;
      // busy-wait a beat without pulling in extra deps
      const until = Date.now() + 500; while (Date.now() < until) { /* spin */ }
    }
  }
}
function releaseLock() { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } }

function readCreds() {
  const raw = fs.readFileSync(CRED_PATH, 'utf8');
  return JSON.parse(raw);
}

// Support both the flat shape (accessToken/refreshToken/expiresAt at top level,
// as written on this VM) and the nested {claudeAiOauth:{...}} shape some Claude
// builds use. Return {obj, oauth, wrapped} so we can write back in-place.
function view(creds) {
  if (creds && typeof creds === 'object' && creds.claudeAiOauth) {
    return { oauth: creds.claudeAiOauth, wrapped: true };
  }
  return { oauth: creds, wrapped: false };
}

function backup(raw) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, `credentials-${stamp}.json`), raw, { mode: 0o600 });
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('credentials-')).sort();
    for (const f of files.slice(0, -10)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { log('backup warning:', e.message); }
}

function atomicWrite(obj) {
  const tmp = CRED_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'w', 0o600);
  fs.writeSync(fd, JSON.stringify(obj, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, CRED_PATH);
  // fsync the directory so the rename itself is durable across a crash/power loss, not just the
  // file contents. Best-effort: some platforms refuse fsync on a directory handle.
  try {
    const dfd = fs.openSync(path.dirname(CRED_PATH), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* best-effort */ }
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`refresh HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error('refresh: non-JSON response'); }
  if (!data.access_token || !data.refresh_token) {
    throw new Error('refresh: response missing access_token/refresh_token — file left untouched');
  }
  return data;
}

// Auth-class refresh failure only — a timeout, DNS miss or 5xx must NOT block the engine for
// hours; those are transient and the next run may well succeed. Live 2026-09-30/10-01:
// {"error":"invalid_grant","error_description":"account_on_hold"} every 30m while the access
// token had already expired → every `claude` run died instantly with 401 («код 1»).
const AUTH_REFRESH_FAILURE = /invalid[_\s-]?grant|account[_\s-]?on[_\s-]?hold|revoked|no refresh token|credentials are partial|\b401\b|unauthorized|invalid[_\s-]?token/i;

// Raises the long-lived flag the runner's admission gate reads (auth-flag.js authGate).
// Returns true when the flag was down and is now up, so the caller can say so once.
function raiseAuthFlag(msg) {
  if (!AUTH_REFRESH_FAILURE.test(msg)) return false;
  try {
    const wasUp = !!getAuthFlag('claude').failed;
    setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: msg, engine: 'claude' });
    if (!wasUp) log('auth flag SET — claude is redirected to codex/opencode until the next successful refresh');
    return !wasUp;
  } catch (e) {
    log('auth flag write failed:', e.message);
    return false;
  }
}

// «Следующая авторизация»: a successful refresh is exactly the event the flag waits for.
function lowerAuthFlag() {
  try { clearAuthFailedFlag('claude'); } catch (e) { log('auth flag clear failed:', e.message); }
}

async function main() {
  if (!fs.existsSync(CRED_PATH)) { log('no credentials file at', CRED_PATH, '- nothing to do'); return; }

  const raw = fs.readFileSync(CRED_PATH, 'utf8');
  const creds = JSON.parse(raw);
  const { oauth } = view(creds);
  const expiresAt = Number(oauth.expiresAt || oauth.expires_at || 0);
  const msLeft = expiresAt - Date.now();
  const hLeft = (msLeft / 3600000).toFixed(2);
  log(`token expires ${expiresAt ? new Date(expiresAt).toISOString() : '(unknown)'} (${hLeft}h left), margin=${(MARGIN_SEC / 3600).toFixed(1)}h`);

  const withinMargin = msLeft <= MARGIN_SEC * 1000;
  if (DRY_RUN) {
    log(`DRY-RUN: would ${FORCE || withinMargin ? 'REFRESH now' : 'skip (not within margin)'} — no network, no write`);
    return;
  }
  if (!FORCE && !withinMargin) { log('token still fresh — skipping'); return; }
  const hasRefresh = oauth.refreshToken || oauth.refresh_token;
  if (!hasRefresh) {
    // A partial credential file (access token but no refresh token) is exactly the state a bad
    // relay push leaves behind — never overwrite further, and say so clearly instead of a generic
    // "no refresh token".
    throw new Error((oauth.accessToken || oauth.access_token)
      ? 'credentials are partial (access token present, refresh token missing) — refusing to touch; restore from ~/.claude/credentials-backups/ or re-login'
      : 'no refresh token present in credentials');
  }

  if (!acquireLock()) { log('could not acquire lock (peer refreshing) — skipping this run'); return; }
  try {
    // re-read under lock: a peer may have refreshed while we waited
    const raw2 = fs.readFileSync(CRED_PATH, 'utf8');
    const creds2 = JSON.parse(raw2);
    const { oauth: oauth2 } = view(creds2);
    const left2 = Number(oauth2.expiresAt || oauth2.expires_at || 0) - Date.now();
    if (!FORCE && left2 > MARGIN_SEC * 1000) { log('peer already refreshed under lock — done'); return; }

    const rt = oauth2.refreshToken || oauth2.refresh_token;
    const data = await refresh(rt);

    backup(raw2);
    oauth2.accessToken = data.access_token;
    oauth2.refreshToken = data.refresh_token;
    if (data.expires_in) oauth2.expiresAt = Date.now() + Number(data.expires_in) * 1000;
    if (oauth2.expires_at !== undefined) oauth2.expires_at = oauth2.expiresAt; // keep snake mirror if present
    atomicWrite(creds2);
    log(`refreshed OK — new expiry ${new Date(oauth2.expiresAt).toISOString()} (${((oauth2.expiresAt - Date.now()) / 3600000).toFixed(2)}h)`);
    lowerAuthFlag();
  } finally {
    releaseLock();
  }
}

main().catch((e) => {
  console.error(`[claude-token-refresh ${new Date().toISOString()}] ERROR:`, e.message);
  raiseAuthFlag(e.message);
  process.exitCode = 1;
});
