'use strict';
// POST /internal/publish (#1470): domain skill repos publish pages over HTTP with
// AGENT_SECRET instead of requiring core's 97-publish in-process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('publishes for a profile with AGENT_SECRET; rejects without it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-publish-'));
  const port = 15000 + (process.pid % 2000);
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SECRETS_SOURCE: 'env', TELEGRAM_BOT_TOKEN: 'test-tg', AGENT_SECRET: 's3cret',
      HOME: tmp, USERS_DIR: path.join(tmp, 'users'), AGENT_DATA_DIR: path.join(tmp, 'data'), AGENT_TOKENS_DIR: path.join(tmp, 'tokens'),
      AGENT_PUBLIC_URL: 'https://pub.example', NODE_ENV: 'test' },
  });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const onData = c => { out += c; if (out.includes('listening on')) resolve(); };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
      setTimeout(() => reject(new Error(`server did not start\n${out}`)), 20_000);
    });
    const post = (body, auth) => fetch(`http://127.0.0.1:${port}/internal/publish`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer s3cret' } : {}) },
    });
    assert.equal((await post({ username: 'u1', slug: 'x', content: 'hi' }, false)).status, 401);
    assert.equal((await post({ username: '../etc', slug: 'x', content: 'hi' }, true)).status, 400);
    const ok = await post({ username: 'u1', slug: 'report-one', content: '<h1>Hi</h1>', title: 'Report', format: 'html' }, true);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.url, /\/p\/report-one$/);
    const page = await fetch(`http://127.0.0.1:${port}/p/report-one`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>Hi<\/h1>/);
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
