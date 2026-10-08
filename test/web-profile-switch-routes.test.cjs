'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { handleWeb } = require('../src/handlers/web');
const { signJwt } = require('../src/web-auth');

const SECRET = 'web-profile-switch-test-secret';
const ROOT = path.join(__dirname, '..');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function startServer(secrets = { WEB_JWT_SECRET: SECRET }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await handleWeb(req, url, res, { secrets }) === false) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('legacy Agent profile UI lists only signed profile cookies and switches only to an authenticated profile', async t => {
  const { server, origin } = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalCookies = [
    `web_token_alice=${signJwt('alice', SECRET)}`,
    `web_token_bob=${signJwt('bob', SECRET)}`,
    `web_token_forged=${signJwt('mallory', SECRET)}`,
    'web_current=alice',
  ].join('; ');

  const listed = await fetch(`${origin}/web/profiles`, { headers: { cookie: originalCookies } });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await listed.json(), { profiles: ['alice', 'bob'], current: 'alice' });

  const switched = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: originalCookies, origin,
      'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob' }),
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await switched.json(), { ok: true, username: 'bob' });
  assert.match(switched.headers.get('set-cookie') ?? '', /^web_current=bob;/);

  const selected = await fetch(`${origin}/web/profiles`, {
    headers: { cookie: `${originalCookies}; web_current=bob` },
  });
  assert.deepEqual(await selected.json(), { profiles: ['alice', 'bob'], current: 'bob' });
});

test('profile routes reject unauthenticated, forged, malformed, and unconfigured requests', async t => {
  const { server, origin } = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await fetch(`${origin}/web/profiles`)).status, 401);
  assert.equal((await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob' }),
  })).status, 401);

  const alice = `web_token_alice=${signJwt('alice', SECRET)}; web_current=alice`;
  const forged = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: alice, origin,
      'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob' }),
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers.get('set-cookie'), null);

  const malformed = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: alice, origin,
      'content-type': 'application/json' },
    body: JSON.stringify({ username: '../bob' }),
  });
  assert.equal(malformed.status, 400);

  const foreignOrigin = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: alice, origin: 'https://attacker.example',
      'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  });
  assert.equal(foreignOrigin.status, 403);

  const noOrigin = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: alice, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice' }),
  });
  assert.equal(noOrigin.status, 403);

  const unsafeContentType = await fetch(`${origin}/web/switch-profile`, {
    method: 'POST', headers: { cookie: alice, origin, 'content-type': 'text/plain' },
    body: JSON.stringify({ username: 'alice' }),
  });
  assert.equal(unsafeContentType.status, 415);

  const unconfigured = await startServer({});
  t.after(() => new Promise(resolve => unconfigured.server.close(resolve)));
  assert.equal((await fetch(`${unconfigured.origin}/web/profiles`, { headers: { cookie: alice } })).status, 503);
});

test('profile list preserves the legacy single-profile login cookie', async t => {
  const { server, origin } = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`${origin}/web/profiles`, {
    headers: { cookie: `web_token=${signJwt('legacy', SECRET)}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profiles: ['legacy'], current: 'legacy' });
});

test('full Agent HTTP router mounts profile listing and switching for the web UI', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-web-profile-switch-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SECRETS_SOURCE: 'env',
      TELEGRAM_BOT_TOKEN: 'synthetic-telegram-token', AGENT_SECRET: 'synthetic-agent-secret',
      WEB_JWT_SECRET: SECRET, HOME: home, USERS_DIR: path.join(home, 'users'),
      AGENT_DATA_DIR: path.join(home, 'data'), AGENT_TOKENS_DIR: path.join(home, 'tokens'), NODE_ENV: 'test' },
  });
  let logs = '';
  proc.stdout.on('data', chunk => { logs += chunk; });
  proc.stderr.on('data', chunk => { logs += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const cookies = [
    `web_token_alice=${signJwt('alice', SECRET)}`,
    `web_token_bob=${signJwt('bob', SECRET)}`,
    'web_current=alice',
  ].join('; ');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Agent server startup timeout\n${logs}`)), 20_000);
      proc.stdout.on('data', chunk => {
        if (logs.includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Agent server exited ${code}\n${logs}`)); });
    });
    const listed = await fetch(`${origin}/web/profiles`, { headers: { cookie: cookies } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { profiles: ['alice', 'bob'], current: 'alice' });

    const switched = await fetch(`${origin}/web/switch-profile`, {
      method: 'POST', headers: { cookie: cookies, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).username, 'bob');
    assert.match(switched.headers.get('set-cookie') ?? '', /^web_current=bob;/);
  } finally {
    proc.kill('SIGTERM');
    if (proc.exitCode === null) await new Promise(resolve => proc.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
