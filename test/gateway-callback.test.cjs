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

// Live 29.09: @freelance_spec_bot answered «Идёт текущая задача» for ~45 min after
// its run had finished — run-finished went to the classic gateway, so the freelance
// gateway's IntakeBuffer (outbox path: no /tasks/running poll) held until BUSY_MAX.
test('run-finished goes to the gateway of the bot the run came through (audience)', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  const { BOTS } = require('../src/bot-registry');
  mockFetchOk();
  assert.equal(await notifyRunFinished({ chatId: 1714048, requestId: 'r', audience: 'freelance', secret: 's' }), true);
  assert.equal(await notifyRunFinished({ chatId: 1714048, requestId: 'r', audience: 'recruiter', secret: 's' }), true);
  assert.equal(await notifyRunFinished({ chatId: 1714048, requestId: 'r', secret: 's' }), true);
  const gw = a => BOTS.find(b => b.audience === a).gateway_url;
  assert.equal(fetched[0].url, `${gw('freelance')}/internal/run-finished`);
  assert.equal(fetched[1].url, `${gw('recruiter')}/internal/run-finished`);
  assert.equal(fetched[2].url, 'https://gw.example/internal/run-finished');
  assert.notEqual(gw('freelance'), 'https://gw.example');
});

test('unknown audience is never pushed to another bot\'s gateway', async () => {
  process.env.MEDIA_GATEWAY_URL = 'https://gw.example';
  delete require.cache[require.resolve('../src/gateway-callback')];
  const { notifyRunFinished } = cb();
  mockFetchOk();
  assert.equal(await notifyRunFinished({ chatId: 42, audience: 'nosuchbot', secret: 's' }), false);
  assert.equal(fetched.length, 0);
});

test('every non-default registry bot has its own https gateway_url OR declares why it has none', () => {
  // The invariant is NOT "every bot has a gateway" — an external worker that only
  // calls POST /run owns no busy-hold and no /internal/run-finished, so there is
  // nothing to call. The invariant is that the absence is DECLARED: a silently
  // empty gateway_url is how a bot ends up with an unknown callback target, which
  // is the exact bug the run-finished push was built to kill.
  const { BOTS, botsMissingGatewayDeclaration } = require('../src/bot-registry');
  assert.deepEqual(botsMissingGatewayDeclaration(BOTS).map(b => b.audience), []);
  // The declaration must not become a loophole: a bot that has a gateway still has
  // to spell the URL out as https, and a bogus one is not accepted.
  for (const b of BOTS.filter(x => x.audience !== 'default' && x.enabled !== false)) {
    if (b.gateway_url) assert.match(String(b.gateway_url), /^https:\/\/[^/]+$/, `${b.audience} has a malformed gateway_url`);
  }
  // A bot with neither URL nor reason must be reported, whatever the URL looks like.
  const bad = [{ botId: 'x', audience: 'x', token_secret_name: 'X', enabled: true, gateway_url: 'http://insecure.example' }];
  assert.deepEqual(botsMissingGatewayDeclaration(bad).map(b => b.audience), ['x']);
  assert.deepEqual(botsMissingGatewayDeclaration([{ ...bad[0], gateway_absence_reason: 'внешний воркер, шлюза нет' }]), []);
});

test('the sales bot (@cmr_management_bot) answers as itself and declares it has no gateway', () => {
  const { BOTS, hasOwnGateway, gatewayUrl } = require('../src/bot-registry');
  const sales = BOTS.find(b => b.audience === 'sales');
  assert.ok(sales, 'sales audience must be registered');
  assert.equal(sales.token_secret_name, 'SALES_BOT_TOKEN');
  assert.ok(String(sales.gateway_absence_reason || '').trim(), 'no-gateway must be a stated reason');
  // No gateway of our tg-bot family → callbacks are skipped, which callers already
  // treat as a clean no-op (gateway-callback returns false, live-inbox explains).
  assert.equal(hasOwnGateway(sales), false);
  assert.equal(gatewayUrl('sales'), null);
  // And it must never inherit another bot's gateway (the 45-min «busy» bug).
  const env = { MEDIA_GATEWAY_URL: 'https://classic-gw.example' };
  assert.equal(gatewayUrl('sales', { env }), null);
  assert.equal(gatewayUrl('default', { env }), 'https://classic-gw.example');
});
