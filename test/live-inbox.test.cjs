'use strict';
// Live inbox (owner 2026-09-29): get_new_messages → server → gateway held-messages,
// and the consumed ids that ride back on run-finished (src/live-inbox.js).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;
let calls = [];
let reply;
function mockGateway(r) {
  reply = r;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status ? reply.status < 400 : true, status: reply.status || 200, json: async () => reply.body };
  };
}
function inbox() {
  delete require.cache[require.resolve('../src/live-inbox')];
  return require('../src/live-inbox');
}
const item = (id, extra = {}) => ({ message_id: id, date: 1790640000, text: `msg ${id}`, kind: 'text', files: [], ready: true, ...extra });

beforeEach(() => { calls = []; process.env.MEDIA_GATEWAY_URL = 'https://gw.example/'; });
afterEach(() => { global.fetch = realFetch; delete process.env.MEDIA_GATEWAY_URL; });

test('server resolves chat/topic/requestId from the run — the engine never supplies them', async () => {
  const li = inbox();
  li.registerInboxRun({ taskId: 't1', chatId: -100500, threadId: 7, requestId: 'intake-abc' });
  mockGateway({ body: { busy: true, items: [item(11)] } });
  const r = await li.fetchNewMessages('t1', { secret: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.messages[0].text, 'msg 11');
  assert.match(r.messages[0].at, /МСК$/);
  assert.equal(calls[0].url, 'https://gw.example/internal/held-messages?chatId=-100500&threadId=7&requestId=intake-abc');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer s');
});

test('each message is handed out once; a repeat call returns only newer ones', async () => {
  const li = inbox();
  li.registerInboxRun({ taskId: 't2', chatId: 42, requestId: 'r' });
  mockGateway({ body: { busy: true, items: [item(1)] } });
  assert.equal((await li.fetchNewMessages('t2', { secret: 's' })).messages.length, 1);
  mockGateway({ body: { busy: true, items: [item(1), item(2)] } });
  const r = await li.fetchNewMessages('t2', { secret: 's' });
  assert.deepEqual(r.messages.map(m => m.text), ['msg 2']);
  assert.deepEqual(li.takeConsumed('t2').sort(), [1, 2]);
  assert.deepEqual(li.takeConsumed('t2'), [], 'registry entry is dropped after run-finished');
});

test('files and still-downloading items are never marked consumed (they stay for the next task)', async () => {
  const li = inbox();
  li.registerInboxRun({ taskId: 't3', chatId: 42, requestId: 'r' });
  mockGateway({ body: { busy: true, items: [item(1, { kind: 'file', files: ['a.pdf'] }), item(2, { kind: 'voice' }), item(3, { ready: false })] } });
  const r = await li.fetchNewMessages('t3', { secret: 's' });
  assert.equal(r.messages.length, 2);
  assert.deepEqual(r.messages[0].files, ['a.pdf']);
  assert.equal(r.pending, 1);
  assert.deepEqual(li.takeConsumed('t3'), [2]);
});

test('gateway down → clear error, nothing consumed (message is kept)', async () => {
  const li = inbox();
  li.registerInboxRun({ taskId: 't4', chatId: 42, requestId: 'r' });
  mockGateway(new Error('ECONNREFUSED'));
  const r = await li.fetchNewMessages('t4', { secret: 's' });
  assert.equal(r.ok, false);
  assert.match(r.error, /не потеряны/);
  mockGateway({ status: 502, body: {} });
  assert.equal((await li.fetchNewMessages('t4', { secret: 's' })).ok, false);
  assert.deepEqual(li.takeConsumed('t4'), []);
});

test('web/internal runs (chatId 0) and unknown tasks get an honest empty answer, no gateway call', async () => {
  const li = inbox();
  assert.equal(li.registerInboxRun({ taskId: 'w', chatId: 0 }), false);
  mockGateway({ body: { busy: true, items: [item(1)] } });
  const r = await li.fetchNewMessages('w', { secret: 's' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.messages, []);
  assert.ok(r.note);
  assert.equal(calls.length, 0);
});

test('not busy / foreign run on the gateway → nothing new', async () => {
  const li = inbox();
  li.registerInboxRun({ taskId: 't5', chatId: 42, requestId: 'r' });
  mockGateway({ body: { busy: true, mismatch: true, items: [] } });
  assert.deepEqual((await li.fetchNewMessages('t5', { secret: 's' })).messages, []);
  mockGateway({ body: { busy: false, items: [] } });
  assert.deepEqual((await li.fetchNewMessages('t5', { secret: 's' })).messages, []);
});

test('held messages are read from the gateway of the run\'s own bot (audience)', async () => {
  const li = inbox();
  const { BOTS } = require('../src/bot-registry');
  li.registerInboxRun({ taskId: 'tf', chatId: 1714048, requestId: 'intake-f', audience: 'freelance' });
  mockGateway({ body: { busy: true, items: [item(5)] } });
  await li.fetchNewMessages('tf', { secret: 's' });
  const base = BOTS.find(b => b.audience === 'freelance').gateway_url;
  assert.ok(calls[0].url.startsWith(`${base}/internal/held-messages?`), calls[0].url);
});
