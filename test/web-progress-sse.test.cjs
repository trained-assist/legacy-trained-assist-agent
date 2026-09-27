'use strict';
// Web SSE progress contract (2026-09-27): the web UI showed a frozen
// "Соединение открыто. Ожидаю ответ агента · N с" for the whole run because the
// agent's stream never carried progress events. The runner already tracks the
// current tool activity (the Telegram heartbeat label); streamWebTask must
// forward it to the browser as {type:'progress', message}. This pins that wiring:
// the browser's existing `type==='progress'` handler now actually gets fed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

function loadStream(runTaskImpl) {
  process.env.WEB_CONVREF_CANARY = 'web-canary';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-progress-'));
  process.env.HOME = tmp;
  process.env.USERS_DIR = path.join(tmp, 'users');
  process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
  fs.mkdirSync(path.join(tmp, 'users', 'web-canary'), { recursive: true });
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store|runner(\/index)?)\.js$/.test(key)) delete require.cache[key];
  }
  const runnerPath = require.resolve('../src/runner');
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true,
    exports: { runTask: runTaskImpl, isSessionRunning: () => false, stopSessionTask: () => false } };
  return require('../src/web-routes');
}

async function drive(streamWebTask, extra = {}) {
  const req = new EventEmitter();
  let body = '';
  const res = { writeHead() {}, write(s) { body += s; }, end() { res.ended = true; } };
  await streamWebTask({ req, res, secrets: {}, username: 'web-canary', task: 'hi', sessionId: null, ...extra });
  for (let i = 0; i < 50 && !res.ended; i++) await new Promise(r => setTimeout(r, 10));
  return body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}

test('runner activity is forwarded to the SSE stream as {type:progress,message}', async () => {
  const seen = [];
  const { streamWebTask } = loadStream(async (o) => {
    o.onProgress('Думаю…');
    o.onProgress('💻 ls -la');
    o.onProgress('📖 Читаю file.txt');
    return 'ok';
  });
  const ev = await drive(streamWebTask);
  const progress = ev.filter(e => e.type === 'progress').map(e => e.message);
  assert.deepEqual(progress, ['Думаю…', '💻 ls -la', '📖 Читаю file.txt'],
    'every onProgress label must surface as a progress event, in order');
  assert.equal(ev.at(-1).type, 'done');
});

test('no onProgress in runner options → stream still works (optional callback)', async () => {
  const { streamWebTask } = loadStream(async () => 'ok');
  const ev = await drive(streamWebTask);
  assert.equal(ev.at(-1).type, 'done');
  assert.ok(!ev.some(e => e.type === 'progress'), 'no progress events when nothing reports');
});
