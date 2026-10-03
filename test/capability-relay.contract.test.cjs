'use strict';
// Issue #2061 PR1, slices T1 (contract) + T2 (error mapping) + T6 (telemetry).
// No network: every HTTP outcome comes from an injected fetchImpl.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const Ajv = require('ajv');
const contractMod = require('../src/capability-relay/contract.js');
const { createRelayClient } = require('../src/capability-relay/client.js');
const { RelayError, ERROR_CODES, statusToCode, safeReason } = require('../src/capability-relay/errors.js');
const { FIELDS, formatEvent } = require('../src/capability-relay/telemetry.js');

const { loadContract, listTools, findTool, invokeUrl, checkResponseVersion, CONTRACT_FILE, SCHEMA_FILE, schema } = contractMod;

const ENDPOINT = 'http://127.0.0.1:9';
const TOKEN = 'relay-test-token';
const TOOL_ID = 'communication.prepare_message_draft';

function fakeFetch({ status = 200, body = {}, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    };
  };
  impl.calls = calls;
  return impl;
}

function client(fetchImpl, extra = {}) {
  return createRelayClient({
    fetchImpl, endpoint: ENDPOINT, token: TOKEN,
    contract: loadContract(),
    now: (() => { let t = 0; return () => (t += 10); })(),
    ...extra,
  });
}

// ── T1: the contract file ────────────────────────────────────────────────────

test('contract file is valid against its own schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema());
  const ok = validate(loadContract());
  assert.ok(ok, `contract failed schema: ${ajv.errorsText(validate.errors)}`);
});

test('contract declares version 1, its urn and a single typed error enum', () => {
  const contract = loadContract();
  assert.equal(contract.version, 1);
  assert.equal(contract.urn, 'urn:trained-assist:capability-relay-contract:v1');
  assert.deepEqual([...contract.errorCodes].sort(), [...Object.keys(ERROR_CODES)].sort());
});

test('tools/list is a 1:1 projection of contract.tools — names and schemas are not translated', () => {
  const contract = loadContract();
  const listed = listTools(contract);
  assert.equal(listed.length, contract.tools.length);
  for (let i = 0; i < listed.length; i++) {
    assert.deepEqual(listed[i], {
      name: contract.tools[i].name,
      description: contract.tools[i].description,
      inputSchema: contract.tools[i].inputSchema,
    });
  }
  const demo = contract.tools.find(t => t.toolId === TOOL_ID);
  assert.ok(demo, 'the demo capability from §3 of the issue must be in the contract');
  assert.equal(demo.name, 'capability_prepare_message_draft');
  assert.equal(typeof demo.mutates, 'boolean');
  assert.deepEqual(listTools(contract).find(t => t.name === demo.name), {
    name: demo.name, description: demo.description, inputSchema: demo.inputSchema,
  });
});

test('a foreign contract version is an explicit version_mismatch, never a silent switch', () => {
  assert.throws(() => checkResponseVersion(1, 2, { contract: loadContract() }), e =>
    e instanceof RelayError && e.code === 'version_mismatch' && e.rpcCode === ERROR_CODES.version_mismatch);
  assert.throws(() => checkResponseVersion(1, undefined, { contract: loadContract() }), e =>
    e instanceof RelayError && e.code === 'version_mismatch');
  // Numeric equality, because the header form of the same version arrives as a string.
  assert.equal(checkResponseVersion(1, 1, { contract: loadContract() }), true);
  assert.equal(checkResponseVersion(1, '1', { contract: loadContract() }), true);
  assert.throws(() => checkResponseVersion(1, 1.5, { contract: loadContract() }), e => e.code === 'version_mismatch');
});

test('tool lookup resolves by MCP name and by canonical toolId, and the invoke URL is built from the contract', () => {
  const contract = loadContract();
  const byName = findTool(contract, 'capability_prepare_message_draft');
  const byId = findTool(contract, TOOL_ID);
  assert.equal(byName, byId);
  assert.equal(findTool(contract, 'nope'), null);
  const url = invokeUrl(contract, TOOL_ID, 'https://cap.example/');
  assert.equal(url, `https://cap.example/capabilities/${TOOL_ID}/invoke`);
  assert.equal(contract.http.invokePath.includes('{toolId}'), true);
  assert.ok(fs.existsSync(CONTRACT_FILE) && fs.existsSync(SCHEMA_FILE));
});

// ── T2: error mapping, safeReason, no retries, deadlines ─────────────────────

test('every status of the mapping table becomes its typed JSON-RPC code', async () => {
  const cases = [
    [400, 'invalid_arguments'], [401, 'unauthorized'], [403, 'unauthorized'],
    [404, 'not_found'], [409, 'conflict'], [422, 'invalid_arguments'],
    [500, 'upstream_unavailable'], [503, 'upstream_unavailable'],
    [408, 'timeout'], [504, 'timeout'],
  ];
  for (const [status, code] of cases) {
    assert.equal(statusToCode(status), code, `HTTP ${status}`);
    const fetchImpl = fakeFetch({ status, body: { error: { code: 'nope' } } });
    const got = await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
    assert.ok(got instanceof RelayError, `HTTP ${status} must reject`);
    assert.equal(got.code, code, `HTTP ${status} → ${code}`);
    assert.equal(got.rpcCode, ERROR_CODES[code]);
  }
  assert.equal(statusToCode(418), 'upstream_unavailable');
});

test('a typed envelope from the handler wins over the status code', async () => {
  const fetchImpl = fakeFetch({ status: 400, body: { error: { code: 'conflict', message: 'operationId in use' } } });
  const e = await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, err => err);
  assert.equal(e.code, 'conflict');
  assert.equal(e.rpcCode, -32014);
});

test('the RPC error data is uniform: code, safeReason, contractVersion, outcomeUnknown, retryable=false', async () => {
  const fetchImpl = fakeFetch({ status: 403, body: { error: { code: 'unauthorized', message: 'token lacks scope' } } });
  const e = await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, err => err);
  assert.deepEqual(e.toData(), {
    code: 'unauthorized',
    safeReason: 'unauthorized: token lacks scope',
    contractVersion: 1,
    outcomeUnknown: false,
    retryable: false,
    status: 403,
  });
});

test('safeReason exposes only allowlisted envelope fields — payload, secrets and bodies never surface', () => {
  const body = {
    error: { code: 'invalid_arguments', message: 'bad channel' },
    output: { draft: 'candidate phone +7900 SECRET-CONTENT', token: 'CF_SECRET_TOKEN' },
    html: 'x'.repeat(5000),
  };
  const reason = safeReason(body, 400);
  assert.equal(reason, 'invalid_arguments: bad channel');
  assert.doesNotMatch(reason, /SECRET-CONTENT|CF_SECRET_TOKEN|x{50}/);
  // A body without an envelope still yields something bounded and single-line.
  const fallback = safeReason({ notice: 'Internal Server Error' }, 500);
  assert.equal(fallback, 'HTTP 500');
  const long = safeReason({ message: 'm'.repeat(500) }, 500);
  assert.equal(long.length, 200);
});

test('retryBudget = 0: exactly one fetch per call, including 5xx', async () => {
  const fetchImpl = fakeFetch({ status: 500, body: {} });
  await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: {} }).catch(() => {});
  assert.equal(fetchImpl.calls.length, 1, 'the relay must not retry — a caller decides');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
});

test('a read capability reports outcomeUnknown=false on upstream failure, a mutating one reports true', async () => {
  const readTool = fakeFetch({ status: 500, body: {} });
  const readErr = await client(readTool).invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
  assert.equal(readErr.code, 'upstream_unavailable');
  assert.equal(readErr.outcomeUnknown, false);

  const contract = { ...loadContract(), tools: [{ ...loadContract().tools[0], toolId: 'demo.write_thing', name: 'demo_write_thing', mutates: true }] };
  const writeTool = fakeFetch({ status: 500, body: {} });
  const writeErr = await client(writeTool, { contract }).invoke({ toolId: 'demo.write_thing', arguments: {} }).then(() => null, e => e);
  assert.equal(writeErr.outcomeUnknown, true);
});

test('an exceeded deadline is a typed timeout with outcomeUnknown=true and an aborted signal', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
  });
  const started = Date.now();
  const e = await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: {}, timeoutMs: 60 })
    .then(() => null, err => err);
  assert.equal(e.code, 'timeout');
  assert.equal(e.rpcCode, -32017);
  assert.equal(e.outcomeUnknown, true);
  assert.equal(e.retryable, false);
  assert.match(e.safeReason, /deadline_exceeded/);
  assert.ok(Date.now() - started < 5000, 'the deadline must actually cut the call short');
});

test('a success returns the API body untouched (SR-03 parity premise)', async () => {
  const body = { contractVersion: 1, output: { draftRef: 'abc', nested: [1, { deep: true }] }, echo: { authContextDigest: 'd1' } };
  const fetchImpl = fakeFetch({ status: 200, body });
  const got = await client(fetchImpl).invoke({ toolId: TOOL_ID, arguments: { channel: 'hh' }, authContext: { profileId: 'p1', runId: 'r1' } });
  assert.deepEqual(got, body, 'the relay must not reshape the handler response');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.contractVersion, 1);
  assert.deepEqual(sent.arguments, { channel: 'hh' });
  assert.deepEqual(sent.authContext, { profileId: 'p1', runId: 'r1' });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(fetchImpl.calls[0].init.headers['X-Relay-Contract-Version'], '1');
  assert.equal(fetchImpl.calls[0].init.headers['X-Relay-Run-Id'], 'r1');
});

test('a response carrying another (or no) contract version is rejected as version_mismatch', async () => {
  const foreign = await client(fakeFetch({ status: 200, body: { contractVersion: 2, output: {} } }))
    .invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
  assert.equal(foreign.code, 'version_mismatch');
  assert.equal(foreign.rpcCode, -32015);

  const missing = await client(fakeFetch({ status: 200, body: { output: {} }, headers: {} }))
    .invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
  assert.equal(missing.code, 'version_mismatch');

  const viaHeader = await client(fakeFetch({ status: 200, body: { output: {} }, headers: { 'x-relay-contract-version': '1' } }))
    .invoke({ toolId: TOOL_ID, arguments: {} });
  assert.deepEqual(viaHeader, { output: {} }, 'the version may ride a header when the body omits it');
});

test('an unknown toolId and a missing env are typed, not generic failures', async () => {
  const unknown = await client(fakeFetch({ status: 200, body: {} }))
    .invoke({ toolId: 'does.not_exist', arguments: {} }).then(() => null, e => e);
  assert.equal(unknown.code, 'not_found');
  assert.equal(unknown.retryable, false);

  assert.throws(() => createRelayClient({ fetchImpl: () => {}, endpoint: '', token: TOKEN }), e =>
    e instanceof RelayError && e.code === 'misconfigured' && e.rpcCode === -32010);
  assert.throws(() => createRelayClient({ fetchImpl: () => {}, endpoint: ENDPOINT, token: '' }), e =>
    e.code === 'misconfigured');
});

test('only allowlisted auth-context fields are forwarded; identity stays opaque and the token stays out of the body', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { contractVersion: 1 } });
  await client(fetchImpl).invoke({
    toolId: TOOL_ID,
    arguments: {},
    authContext: {
      identity: 'host-issued-opaque', profileId: 'p1', runId: 'r1', taskId: 't1', operationId: 'op-1',
      // must be dropped
      CF_API_TOKEN: 'nope', extra: { secret: 'x' }, principal: 'root',
    },
  });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(Object.keys(sent.authContext).sort(), ['identity', 'operationId', 'profileId', 'runId', 'taskId']);
  assert.equal(sent.authContext.identity, 'host-issued-opaque', 'proxied as-is, never reconstructed');
  assert.equal(JSON.stringify(sent).includes('nope'), false);
  assert.equal(JSON.stringify(sent).includes(TOKEN), false, 'the caller credential must not leave the header');
});

// ── T6: telemetry — correlation fields, never payload ────────────────────────

test('one telemetry event per call, carrying the correlation fields and no payload', async () => {
  const events = [];
  const fetchImpl = fakeFetch({ status: 500, body: { output: { draft: 'PAYLOAD-DRAFT' } } });
  await client(fetchImpl, { onEvent: e => events.push(e) })
    .invoke({ toolId: TOOL_ID, arguments: { channel: 'hh', candidateRef: 'ARGUMENT-VALUE' }, authContext: { profileId: 'p1', runId: 'r1', taskId: 't9', operationId: 'op-9' } })
    .catch(() => {});
  assert.equal(events.length, 1);
  const event = events[0];
  for (const key of ['toolId', 'contractVersion', 'profileId', 'runId', 'operationId', 'latencyMs', 'outcome', 'code', 'outcomeUnknown']) {
    assert.ok(key in event, `telemetry must carry ${key}`);
  }
  assert.equal(event.toolId, TOOL_ID);
  assert.equal(event.code, 'upstream_unavailable');
  const line = formatEvent({ ts: '2026-10-04T00:00:00.000Z', ...event, arguments: { channel: 'hh' }, token: TOKEN });
  assert.doesNotMatch(line, /ARGUMENT-VALUE|PAYLOAD-DRAFT|relay-test-token/);
  for (const key of FIELDS) assert.match(line, new RegExp(`"${key}"`));
});

test('telemetry never breaks a call, even when the consumer throws', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { contractVersion: 1, output: {} } });
  const got = await client(fetchImpl, { onEvent: () => { throw new Error('telemetry consumer blew up'); } })
    .invoke({ toolId: TOOL_ID, arguments: {} });
  assert.deepEqual(got, { contractVersion: 1, output: {} });
});