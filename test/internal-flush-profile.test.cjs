'use strict';
// POST /internal/flush-profile (epic #1784): the profile migrator is a SEPARATE
// process and must ask the live server to drop its buffered JSONL records BEFORE
// it snapshots a profile — otherwise src/jsonl-batched-flush.js writes the buffer
// later and re-creates a file the migrator just archived (risk R2 of the
// live-implementation analysis). Same AGENT_SECRET Bearer gate as every other
// auth-gated route in server.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The value behind `flushed`: a buffer is written and counted, an empty one counts 0.
test('flushAll writes every buffered record and reports {flushed, failed}', () => {
  const { appendBuffered, flushAll } = require('../src/jsonl-batched-flush');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-profile-buf-'));
  const file = path.join(dir, 'artifacts.jsonl');
  try {
    assert.deepEqual(flushAll(), { flushed: 0, failed: 0 }, 'nothing buffered');
    appendBuffered(file, { a: 1 });
    appendBuffered(file, { a: 2 });
    assert.deepEqual(flushAll(), { flushed: 2, failed: 0 }, 'both buffered records are flushed and counted');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n');
    assert.deepEqual(flushAll(), { flushed: 0, failed: 0 }, 'the buffer is empty again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The {ok:false} half of the contract: a write that fails must be REPORTED, not
// swallowed — otherwise the migrator would snapshot thinking the buffer is empty
// (risk R2). A directory at the target path makes atomicText's rename fail, so
// the records stay buffered.
test('flushAll reports a failed flush instead of pretending success', () => {
  const { appendBuffered, flushAll } = require('../src/jsonl-batched-flush');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-profile-fail-'));
  const file = path.join(dir, 'artifacts.jsonl');
  try {
    fs.mkdirSync(file); // a DIRECTORY where the JSONL file should be → rename fails
    appendBuffered(file, { a: 1 });
    appendBuffered(file, { a: 2 });
    const out = flushAll();
    assert.equal(out.flushed, 0, 'nothing reached disk');
    assert.equal(out.failed, 1, 'the failing file is counted');
    assert.equal(out.flushed + out.failed >= 1, true);
    // the records are still buffered — a later flush (or the endpoint's caller
    // seeing failed>0) knows the snapshot is not safe yet
    const again = flushAll();
    assert.equal(again.failed, 1, 'still failing, still reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /internal/flush-profile — AGENT_SECRET required, username validated, {ok,flushed} returned', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-flush-'));
  const port = 18000 + (process.pid % 2000);
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SECRETS_SOURCE: 'env', TELEGRAM_BOT_TOKEN: 'test-tg', AGENT_SECRET: 's3cret',
      HOME: tmp, USERS_DIR: path.join(tmp, 'users'), AGENT_DATA_DIR: path.join(tmp, 'data'), AGENT_TOKENS_DIR: path.join(tmp, 'tokens'),
      AGENT_PUBLIC_URL: 'https://pub.example', NODE_ENV: 'test' },
  });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start\n${out}`)), 20_000);
      const onData = c => { out += c; if (out.includes('listening on')) { clearTimeout(timer); resolve(); } };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}\n${out}`)); });
    });
    const post = (body, auth, query = '') => fetch(`http://127.0.0.1:${port}/internal/flush-profile${query}`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer s3cret' } : {}) },
    });

    assert.equal((await post(JSON.stringify({ username: 'u1' }), false)).status, 401, 'no Bearer → 401');
    assert.equal((await post(JSON.stringify({ username: 'u1' }), true)).status, 200, 'body username accepted');
    assert.equal((await post('', true, '?username=u1')).status, 200, 'query username accepted');
    assert.equal((await post(JSON.stringify({ username: '../etc' }), true)).status, 400, 'path traversal rejected');
    assert.equal((await post(JSON.stringify({}), true)).status, 400, 'missing username rejected');
    assert.equal((await post('{not json', true)).status, 400, 'bad json rejected');

    const res = await post(JSON.stringify({ username: 'u1' }), true);
    const json = await res.json();
    assert.deepEqual(Object.keys(json).sort(), ['failed', 'flushed', 'ok'], 'response shape');
    assert.equal(json.ok, true, 'ok=false (and HTTP 500) only when records stay buffered');
    assert.equal(json.failed, 0);
    assert.equal(typeof json.flushed, 'number');
    assert.equal(json.flushed, 0, 'nothing buffered in this server → 0');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
