'use strict';
// Smoke for the read-only/profile API moved from server.js to src/handlers/api.js:
// every route is still mounted behind the Bearer gate and answers without a 5xx
// (a broken inline require in a moved block used to only fail at request time).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = [
  ['GET', '/capabilities?userId=u1'],
  ['GET', '/skills'],
  ['GET', '/analytics'],
  ['GET', '/stats'],
  ['GET', '/tasks/running?username=u1'],
  ['GET', '/projects?username=u1'],
  ['GET', '/project-decision?username=u1&chatId=1'],
  ['GET', '/sessions?username=u1'],
  ['POST', '/sessions/archive', { username: 'u1', ids: [] }],
  ['GET', '/sessions/s-missing?username=u1'],
  ['GET', '/files?username=u1'],
  ['GET', '/files/read?username=u1&path=hello.txt'],
  ['GET', '/publish/pages?username=u1'],
  ['DELETE', '/publish/pages', { username: 'u1', slug: 'nope' }],
];

test('moved API routes: 401 without the secret, no 5xx with it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-'));
  fs.mkdirSync(path.join(tmp, 'users', 'u1'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'users', 'u1', 'hello.txt'), 'hi');
  const port = 16000 + (process.pid % 2000);
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SECRETS_SOURCE: 'env', TELEGRAM_BOT_TOKEN: 'test-tg', AGENT_SECRET: 's3cret',
      HOME: tmp, USERS_DIR: path.join(tmp, 'users'), AGENT_DATA_DIR: path.join(tmp, 'data'), AGENT_TOKENS_DIR: path.join(tmp, 'tokens'),
      NODE_ENV: 'test' },
  });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const onData = c => { out += c; if (out.includes('listening on')) resolve(); };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
      setTimeout(() => reject(new Error(`server did not start\n${out}`)), 20_000);
    });
    for (const [method, route, body] of ROUTES) {
      const call = auth => fetch(`http://127.0.0.1:${port}${route}`, {
        method, ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer s3cret' } : {}) },
      });
      assert.equal((await call(false)).status, 401, `${method} ${route} must be behind the gate`);
      const r = await call(true);
      const text = await r.text();
      assert.ok(r.status < 500, `${method} ${route} → ${r.status}: ${text.slice(0, 200)}`);
      // A handler's own 404 (e.g. unknown session id) is JSON with `error`; an unmounted
      // route falls through to the server's generic 404.
      if (r.status === 404) {
        let j = {}; try { j = JSON.parse(text); } catch { /* not JSON */ }
        const lookupOfMissing = route.startsWith('/sessions/s-missing') || (method === 'DELETE' && route === '/publish/pages');
        assert.ok(lookupOfMissing && j.error, `${method} ${route} not mounted`);
      }
    }
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
