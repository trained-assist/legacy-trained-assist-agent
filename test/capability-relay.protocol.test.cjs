'use strict';
// Issue #2061 PR1 → #2034 PR2, slice T3 — the stdio protocol itself (spawned process, not a require).
// SR-01 (initialize carries the contract, no provider secrets), SR-02 (tools/list is the
// contract, minus not-ready tools), SR-05 (no env → typed misconfigured, process survives).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startRelay } = require('./fixtures/relay-stdio.cjs');
const { startMockWorker } = require('./fixtures/mock-capability-worker.cjs');
const { loadContract, listTools } = require('../src/capability-relay/contract.js');

const TOOL_NAME = 'generate_next_message_to_conversation_partner';
const TOKEN = 'relay-test-token';
const ARGS = {
  goal: { instruction: 'написать следующее письмо' },
  communication_style: { instructions: 'деловой, коротко' },
  language: 'ru',
  conversation_history: { format: 'messages', messages: [{ speaker: 'sender', text: 'Здравствуйте!' }] },
};

let worker = null;
let env = {};

before(async () => {
  worker = await startMockWorker({ token: TOKEN });
  env = {
    CAPABILITY_RELAY_COMMUNICATION: '1',
    COMMUNICATION_API_URL: worker.url,
    COMMUNICATION_TOKEN: TOKEN,
    CAPABILITY_RELAY_CONTRACT_VERSION: '1',
  };
});
after(async () => { if (worker) await worker.close(); });

test('initialize answers the engine protocol version and exposes the contract version (SR-01)', async t => {
  const relay = startRelay(env);
  t.after(() => relay.close());
  const { error, result } = await relay.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(error, undefined);
  assert.equal(result.protocolVersion, '2024-11-05', "the engine's version, not ours to pick");
  assert.deepEqual(result.capabilities.contract, { urn: 'urn:trained-assist:capability-relay-contract:v1', version: 1 });
  assert.equal(result.serverInfo.name, 'capability-relay');
  // The env of the child is the relay's own minimal env — no provider keys pass through.
  assert.equal('CF_API_TOKEN' in env, false);
  assert.equal('OPENROUTER_API_KEY' in env, false);
  assert.equal('LLM_LADDER_URL' in env, false);
});

test('tools/list returns exactly contract.tools[] — the canonical Worker name, no translation (SR-02)', async t => {
  const relay = startRelay(env);
  t.after(() => relay.close());
  const { result } = await relay.request('tools/list', {});
  assert.deepEqual(result.tools, listTools(loadContract()));
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, TOOL_NAME);
  assert.equal(typeof result.tools[0].inputSchema, 'object');
  assert.ok(result.tools[0].inputSchema.required.includes('conversation_history'));
});

test('tools/call reaches the handler and returns its body as text content', async t => {
  const relay = startRelay(env);
  t.after(() => relay.close());
  const { error, result } = await relay.request('tools/call', {
    name: TOOL_NAME,
    arguments: ARGS,
    _meta: { authContext: { profileId: 'p1', runId: 'r1', operationId: 'op-proto' } },
  });
  assert.equal(error, undefined, JSON.stringify(error));
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'text');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 'generated');
  assert.equal(payload.echo.correlation.runId, 'r1', 'host correlation travelled to the handler');
  assert.equal(payload.echo.correlation.operationId, 'op-proto');
  assert.match(relay.stderr(), /communication\.generate_next_message_to_conversation_partner/, 'one telemetry line on stderr');
});

test('an unknown method is -32601, an unknown capability is a typed not_found', async t => {
  const relay = startRelay(env);
  t.after(() => relay.close());
  const methodErr = await relay.request('resources/list', {});
  assert.equal(methodErr.error.code, -32601);
  const toolErr = await relay.request('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(toolErr.error.code, -32012, 'not_found is a typed code, not -32603');
  assert.equal(toolErr.error.data.code, 'not_found');
});

test('without env a call is misconfigured (-32010), tools/list is EMPTY, the process stays alive (SR-05)', async t => {
  const relay = startRelay({});
  t.after(() => relay.close());
  const first = await relay.request('initialize', {});
  assert.equal(first.error, undefined, 'initialize must work even with the feature off');
  const list = await relay.request('tools/list', {});
  assert.deepEqual(list.result.tools, [], 'no credentials → no readiness claim, ever');
  const call = await relay.request('tools/call', { name: TOOL_NAME, arguments: ARGS });
  assert.equal(call.error.code, -32010);
  assert.equal(call.error.data.code, 'misconfigured');
  assert.equal(call.error.data.retryable, false);
  assert.match(call.error.message, /not ready|not configured/);
  assert.equal(relay.alive(), true, 'the engine must not lose the server over a missing env');
});

test('creds present but toggle OFF → same honest answer: empty list, misconfigured call', async t => {
  const relay = startRelay({ COMMUNICATION_API_URL: worker.url, COMMUNICATION_TOKEN: TOKEN });
  t.after(() => relay.close());
  const list = await relay.request('tools/list', {});
  assert.deepEqual(list.result.tools, [], 'default-off toggle is part of readiness, not just the mount');
  const call = await relay.request('tools/call', { name: TOOL_NAME, arguments: ARGS });
  assert.equal(call.error.code, -32010);
  assert.equal(call.error.data.code, 'misconfigured');
  assert.equal(relay.alive(), true);
});

test('a contract-version pin that disagrees with the file refuses to serve (SR-04)', async t => {
  const relay = startRelay({ ...env, CAPABILITY_RELAY_CONTRACT_VERSION: '2' });
  t.after(() => relay.close());
  const call = await relay.request('tools/call', { name: TOOL_NAME, arguments: ARGS });
  assert.equal(call.error.code, -32015);
  assert.equal(call.error.data.code, 'version_mismatch');
  assert.equal(relay.alive(), true);
});
