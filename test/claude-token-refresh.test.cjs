'use strict';
// Integration tests for scripts/claude-token-refresh.js — the single-owner OAuth refresh broker.
// Covers the spec §8 guarantees: single-owner (lock/concurrency), atomic write, partial-response
// reject, no-write-on-failure, and the partial-credentials (missing refresh token) refusal.
//
// The broker is a CLI, so each case runs it as a subprocess against a stub token endpoint and a
// temp credentials file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'claude-token-refresh.js');

function mkCreds(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credPath = path.join(dir, '.credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(content, null, 2), { mode: 0o600 });
  return { dir, credPath };
}

// Stub OAuth endpoint. `handler` decides the response; counts requests.
function mkEndpoint(t, handler) {
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    state.count++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body, state));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/token`;
      t.after(() => server.close());
      resolve({ url, state });
    });
  });
}

function okResponse(res, { delayMs = 0, omitRefresh = false } = {}) {
  const payload = { access_token: 'new-access', expires_in: 28800 };
  if (!omitRefresh) payload.refresh_token = 'new-refresh';
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }, delayMs);
}

// Async spawn (NOT spawnSync): the stub endpoint runs in this same process, so blocking the
// event loop here would starve it and the child's fetch would just time out.
//
// AGENT_DATA_DIR is pinned to a temp dir: the broker writes the machine-wide «Claude недоступен»
// flag (and now its circuit-breaker suspension) under it. Without this a unit test that happens to
// produce an auth-shaped error would SUSPEND the live engine of the box running the suite —
// the tests would be able to switch Claude off for the operator.
function run(credPath, tokenUrl, extraArgs = [], opts = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCRIPT, ...extraArgs], {
      env: {
        ...process.env,
        CLAUDE_CREDENTIALS_PATH: credPath,
        CLAUDE_OAUTH_TOKEN_URL: tokenUrl,
        AGENT_DATA_DIR: opts.dataDir || path.dirname(credPath),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function readFlag(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'system-flags', 'claude_auth.json'), 'utf8')).claude || {};
  } catch { return {}; }
}

function expiredCreds(extra = {}) {
  return { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000, ...extra };
}

test('refreshes an expiring token, rotates the pair, and backs up the old file', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  const r = await run(credPath, url, ['--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.count, 1);

  const after = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.equal(after.accessToken, 'new-access');
  assert.equal(after.refreshToken, 'new-refresh');
  assert.ok(after.expiresAt > Date.now());

  const backups = fs.readdirSync(path.join(dir, 'credentials-backups'));
  assert.equal(backups.length, 1);
});

test('a partial refresh response (missing refresh_token) is rejected — file untouched', async (t) => {
  const before = expiredCreds();
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res, { omitRefresh: true }));

  const r = await run(credPath, url, ['--force']);
  assert.notEqual(r.status, 0);
  assert.equal(state.count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
  assert.ok(!fs.existsSync(path.join(path.dirname(credPath), 'credentials-backups')));
});

// CHANGED (2026-10-02, PR «Claude не вызывается, пока авторизация не установлена»).
// Was: `assert.notEqual(r.status, 0)` — a rejected credential must exit non-zero so cron flags it.
// Why the requirement changed: the rejection is no longer a retryable failure, it is a SUSPENDED
// engine — a deliberate state the operator has to answer by installing authorization. A 30-minute
// cron that exits 1 every tick trains everyone to ignore its output and buries real failures.
// Replacement: exit 0 + `suspended` recorded (asserted here and end-to-end in the breaker cases
// below, which also cover «no network call on the next tick» and both ways back to a running engine).
test('a rejected credential does not rotate or write, and suspends instead of retrying', async (t) => {
  const before = expiredCreds();
  const { dir, credPath } = mkCreds(t, before);
  const { url } = await mkEndpoint(t, (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"invalid_grant"}');
  });

  const r = await run(credPath, url, ['--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
  assert.equal(readFlag(dir).suspended, true);
});

test('--dry-run makes no network call and no write', async (t) => {
  const before = expiredCreds();
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  const r = await run(credPath, url, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
});

test('refuses a partial credentials file (access token, no refresh token)', async (t) => {
  const before = { accessToken: 'only-access', expiresAt: Date.now() - 1000 };
  const { credPath } = mkCreds(t, before);
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res));

  // CHANGED (2026-10-02, same PR as above): exit code 1 → 0, because a partial credentials file
  // is a hard rejection («only a new authorization fixes this») and now suspends the engine rather
  // than being retried every 30 minutes. Same replacement test coverage as the sibling case: the
  // broker case «a hard credential rejection SUSPENDS the engine» asserts status 0 + suspended.
  const r = await run(credPath, url, ['--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /partial/i);
  assert.equal(state.count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(credPath, 'utf8')), before);
});

test('single-owner: two concurrent brokers refresh only once (lock + re-read under lock)', async (t) => {
  const { credPath } = mkCreds(t, expiredCreds());
  // Delay the response so both processes are in flight and contend for the lock.
  const { url, state } = await mkEndpoint(t, (req, res) => okResponse(res, { delayMs: 400 }));

  const spawnOne = () => new Promise((resolve) => {
    const p = spawn('node', [SCRIPT], {
      env: { ...process.env, CLAUDE_CREDENTIALS_PATH: credPath, CLAUDE_OAUTH_TOKEN_URL: url },
      stdio: 'ignore',
    });
    p.on('exit', (code) => resolve(code));
  });

  const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
  assert.equal(a, 0);
  assert.equal(b, 0);
  assert.equal(state.count, 1, 'exactly one refresh call despite two brokers');
  assert.equal(JSON.parse(fs.readFileSync(credPath, 'utf8')).refreshToken, 'new-refresh');
});

// ── Circuit breaker ──────────────────────────────────────────────────────────
// Live 2026-10-01: this broker is on a 30-minute cron, and while Claude's credentials were
// rejected outright (invalid_grant / account_on_hold) every one of those runs still called the
// token endpoint and re-armed the runner's warning. From the owner's side: «опять вызывается Клод,
// хотя мы отключили». A timer cannot install an authorization, so the broker must stop asking.

test('a hard credential rejection SUSPENDS the engine instead of being retried forever', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'account_on_hold' }));
  });

  const r = await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(state.count, 1);
  // A known state, not a failure: cron must not report a broken job for an operator decision.
  assert.equal(r.status, 0, r.stderr);
  const flag = readFlag(dir);
  assert.equal(flag.failed, true);
  assert.equal(flag.suspended, true);
  assert.equal(flag.error_text.includes('invalid_grant'), true);

  // The next cron tick must not touch the network at all — this is the whole point.
  const r2 = await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(state.count, 1, 'suspended broker called the token endpoint again');
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /SUSPENDED/);
  assert.equal(fs.readFileSync(credPath, 'utf8').includes('old-refresh'), true, 'credentials were touched');
});

test('reinstalling the authorization resumes the engine; --resume does it by hand', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => {
    if (state.count === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    } else {
      okResponse(res);
    }
  });

  await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(readFlag(dir).suspended, true);

  const r = await run(credPath, url, ['--resume'], { dataDir: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state.count, 2, '--resume did not reach the token endpoint');
  assert.match(r.stdout, /refreshed OK/);
  assert.equal(readFlag(dir).suspended, false);
  assert.equal(readFlag(dir).failed, false);
});

test('a fresh credentials file lifts the suspension without any flag to flip', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => {
    if (state.count === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
    } else {
      okResponse(res);
    }
  });

  await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(readFlag(dir).suspended, true);

  // /login (or the Mac extension pushing a new pair) replaces the file → mtime > suspended_at.
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(credPath, JSON.stringify(expiredCreds(), null, 2), { mode: 0o600 });
  fs.utimesSync(credPath, later, later);

  const r = await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(state.count, 2, 'a reinstalled authorization was ignored');
  assert.match(r.stdout, /refreshed OK/);
  assert.equal(readFlag(dir).suspended, false);
});

test('a transient failure is NOT suspended — the next tick must retry', async (t) => {
  const { dir, credPath } = mkCreds(t, expiredCreds());
  const { url, state } = await mkEndpoint(t, (req, res) => {
    if (state.count === 1) { res.writeHead(503); res.end('upstream down'); }
    else { okResponse(res); }
  });

  const first = await run(credPath, url, ['--force'], { dataDir: dir });
  assert.notEqual(first.status, 0, 'a transient 5xx should still report failure');
  assert.equal(readFlag(dir).suspended, undefined, 'a 5xx must not suspend the engine');

  const second = await run(credPath, url, ['--force'], { dataDir: dir });
  assert.equal(state.count, 2, 'a transient failure was not retried');
  assert.match(second.stdout, /refreshed OK/);
});
