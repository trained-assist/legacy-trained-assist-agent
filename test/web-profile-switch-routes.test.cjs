'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleWeb } = require('../src/handlers/web');
const { signJwt } = require('../src/web-auth');

const SECRET = 'web-profile-switch-test-secret';

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
