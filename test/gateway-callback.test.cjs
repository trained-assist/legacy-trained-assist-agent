// Epic #1527 PR1 — agent → gateway run-finished callback (src/gateway-callback.js)
// and the chat-scoped accepted-not-finished counter that /tasks/running?chatId= reads.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;
let fetched = [];

function mockFetchOk() {
  global.fetch = async (url, init) => {
    fetched.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}
function mockFetchFail(status = 500) {
  global.fetch = async (url, init) => {
    fetched.push({ url: String(url), init });
    return { ok: false, status, json: async () => ({}) };
  };
}

beforeEach(() => {
  fetched = [];
  delete process.env.MEDIA_GATEWAY_URL;
  // fresh module instance so the module-level MEDIA_GATEWAY_URL snapshot re-reads env
  delete require.cache[require.resolve('../src/gateway-callback')];
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.MEDIA_GATEWAY_URL;
  delete require.cache[require.resolve('../src/gateway-callback')];
});

function cb() { return require('../src/gateway-callback'); }

test('no-op without MEDIA_GATEWAY_URL', async () => {
  const { notifyRunFinished } = cb();
  mockFetchOk();
  const sent = await notifyRunFinished({ chatId: 42, requestId: 'r1', secret: 's' });
  assert.equal(sent, false);
  assert.equal(fetched.length, 0);
});

test('no-op without a real chatId (web/internal sentinel 0 or non-numeric)', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example/';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  assert.equal(await notifyRunFinished({ chatId: 0, secret: 's' }), false);
  assert.equal(await notifyRunFinished({ chatId: null, secret: 's' }), false);
  assert.equal(await notifyRunFinished({ chatId: 'nope', secret: 's' }), false);
  assert.equal(fetched.length, 0);
});

test('negative chatId (Telegram group) is delivered, not dropped (#1534 regression)', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  const sent = await notifyRunFinished({ chatId: -5578467476, requestId: 'intake-abc', secret: 's' });
  assert.equal(sent, true);
  assert.equal(fetched.length, 1);
  assert.equal(JSON.parse(fetched[0].init.body).chatId, -5578467476);
});

test('POSTs run-finished with bearer, trailing slash stripped, full payload', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example///';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  const sent = await notifyRunFinished({
    chatId: 42, threadId: 7, requestId: 'intake-abc', taskId: 't-1', outcome: 'error', secret: 'sekret',
  });
  assert.equal(sent, true);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, 'https://gw.example/internal/run-finished');
  assert.equal(fetched[0].init.method, 'POST');
  assert.equal(fetched[0].init.headers.Authorization, 'Bearer sekret');
  const body = JSON.parse(fetched[0].init.body);
  assert.deepEqual(body, {
    chatId: 42, threadId: 7, requestId: 'intake-abc', taskId: 't-1', outcome: 'error',
  });
});

test('failed delivery returns false and never throws (fire-and-forget)', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchFail(503);
  assert.equal(await notifyRunFinished({ chatId: 42, requestId: 'r', secret: 's' }), false);
  global.fetch = async () => { throw new Error('network down'); };
  assert.equal(await notifyRunFinished({ chatId: 42, requestId: 'r', secret: 's' }), false);
});

test('no secret configured → no request', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete process.env.AGENT_SECRET;
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  assert.equal(await notifyRunFinished({ chatId: 42, secret: undefined }), false);
  assert.equal(fetched.length, 0);
});

test('isChatTaskRunning: counter true from runTask entry until settle', async () => {
  const runner = require('../src/runner');
  const chatId = 987654321;
  assert.equal(runner.isChatTaskRunning(chatId), false);
  assert.equal(runner.isChatTaskRunning(null), false);

  // 'стоп' takes the pre-queue stop path inside _runTaskInner: no admission,
  // no process, no Telegram (secrets carry no BOT_TOKEN → send skipped).
  // The wrapper must bump the counter BEFORE returning the promise (that is
  // the window the gateway's /tasks/running?chatId= poll relies on) and
  // release it once the promise settles.
  const p = runner.runTask({
    taskId: 'gw-cb-test',
    user: { id: chatId, username: 'gwtest', workDir: null, audience: 'default' },
    task: 'стоп',
    secrets: {},
    threadId: null,
    requestId: 'gw-cb-req-1',
  });
  // Sync, before any await: already marked.
  assert.equal(runner.isChatTaskRunning(chatId), true);
  await p;
  // Side chain (release + notify) was registered first on the same promise,
  // so it has run by the time our await resumes. MEDIA_GATEWAY_URL is unset
  // in this test env → notify is a no-op.
  assert.equal(runner.isChatTaskRunning(chatId), false);
});

test('isChatTaskRunning tracks NEGATIVE group chatId too (#1534 regression)', async () => {
  const runner = require('../src/runner');
  const groupChatId = -5578467476;
  assert.equal(runner.isChatTaskRunning(groupChatId), false);
  const p = runner.runTask({
    taskId: 'gw-cb-group-test',
    user: { id: groupChatId, username: 'gwtest', workDir: null, audience: 'default' },
    task: 'стоп',
    secrets: {},
    threadId: null,
    requestId: 'gw-cb-group-req-1',
  });
  assert.equal(runner.isChatTaskRunning(groupChatId), true);
  await p;
  assert.equal(runner.isChatTaskRunning(groupChatId), false);
});
test('live inbox: consumed ids ride on run-finished only when non-empty', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  await notifyRunFinished({ chatId: 42, requestId: 'r1', consumed: [501, 502], secret: 's' });
  await notifyRunFinished({ chatId: 42, requestId: 'r2', consumed: [], secret: 's' });
  assert.deepEqual(JSON.parse(fetched[0].init.body).consumed, [501, 502]);
  assert.equal('consumed' in JSON.parse(fetched[1].init.body), false);
});
