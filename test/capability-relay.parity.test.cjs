'use strict';
// Issue #2061 PR1 T4 → #2034 PR2: REST ↔ MCP parity on 127.0.0.1.
//
// The mock serves the door the live Worker serves (POST /v1/dialogs/next-message,
// raw-args body, bearer token, x-contract-version). Parity = a direct REST call to
// that door and a relayed MCP call return the SAME body — the premise of «одна
// каноническая реализация» (#2061 §2). Error cases are asserted on both faces too:
// the relay must map what the handler actually answers, not invent its own story.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startRelay } = require('./fixtures/relay-stdio.cjs');
const { startMockWorker } = require('./fixtures/mock-capability-worker.cjs');
const { loadContract } = require('../src/capability-relay/contract.js');

const TOOL_NAME = 'generate_next_message_to_conversation_partner';
const TOKEN = 'relay-test-token';
const DOOR = loadContract().tools[0].invoke.path;
const ARGS = {
  goal: { instruction: 'следующий ход' },
  communication_style: { instructions: 'коротко' },
  language: 'ru',
  conversation_history: { format: 'messages', messages: [{ speaker: 'partner', text: 'Интересно, продолжайте' }] },
};

let worker = null;
let env = {};

before(async () => {
  worker = await startMockWorker({ token: TOKEN });
  env = {
    CAPABILITY_RELAY_COMMUNICATION: '1',
    COMMUNICATION_API_URL: worker.url,
    COMMUNICATION_TOKEN: TOKEN,
  };
});
after(async () => { if (worker) await worker.close(); });

async function direct(body = ARGS, { url = worker.url + DOOR, token = TOKEN, headers = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function relayed(request, relayEnv = env) {
  const relay = startRelay(relayEnv);
  try { return await request(relay); } finally { await relay.close(); }
}

test('direct REST call == relayed MCP call: the same body both ways (SR-03)', async () => {
  const rest = await direct();
  assert.equal(rest.status, 200);
  const mcp = await relayed(r => r.request('tools/call', {
    name: TOOL_NAME,
    arguments: ARGS,
    _meta: { authContext: { profileId: 'p1', runId: 'r-parity', taskId: 't1' } },
  }));
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  assert.equal(mcp.result.isError, false);
  const relayedBody = JSON.parse(mcp.result.content[0].text);
  // Same generator output; the relay adds no fields of its own (echo only carries
  // correlation the relay was told to forward — assert it separately below).
  assert.equal(relayedBody.status, rest.json.status);
  assert.equal(relayedBody.message_text, rest.json.message_text);
  assert.deepEqual(relayedBody.echo.arguments, rest.json.echo.arguments, 'arguments arrive unreshaped');
  // Correlation: forwarded, not invented.
  assert.equal(relayedBody.echo.correlation.runId, 'r-parity');
  assert.equal(relayedBody.echo.correlation.profileId, 'p1');
});

test('a wrong credential is rejected the same way on both faces: 401 direct, typed unauthorized (-32011) relayed', async () => {
  const rest = await direct(ARGS, { token: 'wrong-token' });
  assert.equal(rest.status, 401);
  assert.equal(rest.json.error.code, 'UNAUTHORIZED');
  const mcp = await relayed(r => r.request('tools/call', { name: TOOL_NAME, arguments: ARGS }),
    { ...env, COMMUNICATION_TOKEN: 'wrong-token' });
  assert.equal(mcp.error.code, -32011);
  assert.equal(mcp.error.data.code, 'unauthorized');
  assert.equal(mcp.error.data.retryable, false);
});

test('the same operationId twice: 409 direct, typed conflict (-32014) relayed — no double run', async () => {
  const h = { 'X-Relay-Operation-Id': 'op-once' };
  const first = await direct(ARGS, { headers: h });
  assert.equal(first.status, 200);
  const second = await direct(ARGS, { headers: h });
  assert.equal(second.status, 409);
  const mcp = await relayed(r => Promise.all([
    r.request('tools/call', { name: TOOL_NAME, arguments: ARGS, _meta: { authContext: { operationId: 'op-relay' } } }),
    r.request('tools/call', { name: TOOL_NAME, arguments: ARGS, _meta: { authContext: { operationId: 'op-relay' } } }),
  ]));
  const codes = mcp.map(x => x.error && x.error.code).filter(Boolean);
  assert.ok(codes.includes(-32014), `one of the two calls must be a typed conflict, got ${JSON.stringify(mcp.map(x => x.error))}`);
});

test('an exceeded deadline is a typed timeout (-32017), not a hang and not a success', async t => {
  const slow = await startMockWorker({ token: TOKEN, delayMs: 1500 });
  t.after(() => slow.close());
  const mcp = await relayed(r => r.request('tools/call', { name: TOOL_NAME, arguments: ARGS }),
    { ...env, COMMUNICATION_API_URL: slow.url, CAPABILITY_RELAY_TIMEOUT_MS: '200' });
  assert.equal(mcp.error.code, -32017);
  assert.equal(mcp.error.data.code, 'timeout');
  assert.equal(mcp.error.data.retryable, false);
});

test('a handler reporting another contract version is an explicit version_mismatch (-32015)', async t => {
  const foreign = await startMockWorker({ token: TOKEN, version: 'v2' });
  t.after(() => foreign.close());
  const mcp = await relayed(r => r.request('tools/call', { name: TOOL_NAME, arguments: ARGS }),
    { ...env, COMMUNICATION_API_URL: foreign.url });
  assert.equal(mcp.error.code, -32015);
  assert.equal(mcp.error.data.code, 'version_mismatch');
});

test('an unknown path on the handler is 404/not_found on the direct face (the relay never guesses a route)', async () => {
  const rest = await direct(ARGS, { url: `${worker.url}/capabilities/whatever/invoke` });
  assert.equal(rest.status, 404);
  assert.equal(rest.json.error.code, 'NOT_FOUND');
});
