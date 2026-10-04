'use strict';
// Issue #2061 PR1 → #2034 PR2: slices T1 (contract + manifest) + T2 (error mapping) + T6 (telemetry, no tokens in the repo).
// No network: every HTTP outcome comes from an injected fetchImpl.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');
const contractMod = require('../src/capability-relay/contract.js');
const { createRelayClient } = require('../src/capability-relay/client.js');
const { RelayError, ERROR_CODES, statusToCode, safeReason } = require('../src/capability-relay/errors.js');
const { FIELDS, formatEvent } = require('../src/capability-relay/telemetry.js');

const { loadContract, listTools, findTool, invokeUrl, checkResponseVersion, CONTRACT_FILE, SCHEMA_FILE, schema } = contractMod;

const ROOT = path.resolve(__dirname, '..');
const WORKER_TOOL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'communication-worker-tool.json'), 'utf8'));
const MANIFEST_FILE = path.join(ROOT, 'contracts', 'capability-relay-v1', 'manifest.json');
const TOOL_ID = 'communication.generate_next_message_to_conversation_partner';

const ENDPOINT = 'http://127.0.0.1:9';
const TOKEN = 'relay-test-token';

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

// The default (envelope) door stays in the contract for future capabilities (#2061
// §6 PR3). The deployed contract has no tool on it anymore, so those tests carry
// their own synthetic tool — the transport is exercised without pretending the
// communication Worker serves an envelope it does not serve.
function genericContract() {
  return {
    ...loadContract(),
    tools: [{
      toolId: 'demo.write_thing',
      name: 'demo_write_thing',
      description: 'synthetic tool on the default envelope door',
      mutates: false,
      inputSchema: { type: 'object' },
    }],
  };
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

test('the canonical tool is the Worker\'s own name, description and schema — verbatim, aliases 0', () => {
  const contract = loadContract();
  assert.equal(contract.tools.length, 1, 'exactly one capability: a second name would be a second door');
  const tool = contract.tools[0];
  assert.equal(tool.toolId, TOOL_ID);
  assert.equal(tool.name, WORKER_TOOL.name, 'MCP name must be the Worker TOOLS[0].name, never translated');
  assert.equal(tool.description, WORKER_TOOL.description);
  assert.deepEqual(tool.inputSchema, WORKER_TOOL.inputSchema, 'inputSchema must be doslovno from protocol.mjs');
  assert.equal(tool.mutates, false, 'generation prepares a draft; it sends nothing');
  // Aliases: the contract exposes one name; nothing else may resolve to this tool.
  const names = contract.tools.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.equal(findTool(contract, WORKER_TOOL.name), tool);
});

test('the capability carries its own HTTP door: path, raw-args body, handler version pin, env binding', () => {
  const tool = loadContract().tools[0];
  const b = tool.invoke;
  assert.ok(b, 'PR2 registers the binding to the Worker\'s existing door');
  assert.equal(b.path, '/v1/dialogs/next-message');
  assert.equal(b.body, 'arguments');
  assert.equal(b.version_header, 'x-contract-version');
  assert.equal(b.contract_version, 'v1', "the Worker's CONTRACT_VERSION");
  assert.equal(b.endpoint_env, 'COMMUNICATION_API_URL');
  assert.equal(b.token_env, 'COMMUNICATION_TOKEN');
  assert.equal(b.toggle_env, 'CAPABILITY_RELAY_COMMUNICATION');
  for (const key of ['endpoint_env', 'token_env', 'toggle_env']) {
    assert.match(b[key], /^[A-Z][A-Z0-9_]*$/);
  }
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
});

test('manifest pins what the contract serves — contract version, handler release, env binding (no drift)', () => {
  const contract = loadContract();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  assert.equal(manifest.contract.urn, contract.urn);
  assert.equal(manifest.contract.version, contract.version);
  assert.equal(manifest.handler_release.capability, 'communication');
  const cap = manifest.capabilities.communication;
  assert.deepEqual(cap.tools, contract.tools.map(t => t.name));
  const binding = contract.tools[0].invoke;
  assert.equal(cap.endpoint_env, binding.endpoint_env);
  assert.equal(cap.token_env, binding.token_env);
  assert.equal(cap.toggle_env, binding.toggle_env);
  assert.equal(manifest.handler_release.contract_version, binding.contract_version);
});

test('no credential material in the contract, the manifest or the relay source (T6 grep gate)', () => {
  const files = [
    CONTRACT_FILE, MANIFEST_FILE,
    ...['env.js', 'client.js', 'contract.js', 'index.js', 'errors.js', 'telemetry.js', 'tools/communication.js']
      .map(f => path.join(ROOT, 'src', 'capability-relay', f)),
  ];
  const envName = /^[A-Z][A-Z0-9_]*$/;
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // Values of token/secret/credential-ish keys must be env var names or booleans,
    // never literals that look like a credential.
    for (const m of raw.matchAll(/"(?:token|secret|credential|password|api_?key)"\s*:\s*"([^"]*)"/gi)) {
      assert.ok(envName.test(m[1]), `${path.relative(ROOT, file)}: credential-shaped value ${m[1].slice(0, 12)}…`);
    }
    assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9_-]{20,}/, `${path.relative(ROOT, file)}: literal bearer token`);
  }
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

test('tool lookup resolves by MCP name and by canonical toolId; the two doors build different URLs', () => {
  const contract = loadContract();
  const byName = findTool(contract, WORKER_TOOL.name);
  const byId = findTool(contract, TOOL_ID);
  assert.equal(byName, byId);
  assert.equal(findTool(contract, 'nope'), null);
  // The default door: template from the contract, toolId substituted.
  const generic = genericContract();
  assert.equal(invokeUrl(generic, 'demo.write_thing', 'https://cap.example/'),
    'https://cap.example/capabilities/demo.write_thing/invoke');
  assert.equal(contract.http.invokePath.includes('{toolId}'), true);
  // The bound door: no template, the path the handler actually serves.
  const base = 'https://cap.example/';
  assert.equal(`${base.replace(/\/+$/, '')}${contract.tools[0].invoke.path}`, 'https://cap.example/v1/dialogs/next-message');
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
    error: { code: 'invalid_arguments', message: 'bad input' },
    output: { draft: 'candidate phone +7900 SECRET-CONTENT', token: 'CF_SECRET_TOKEN' },
    html: 'x'.repeat(5000),
  };
  const reason = safeReason(body, 400);
  assert.equal(reason, 'invalid_arguments: bad input');
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

  const contract = { ...genericContract(), tools: [{ ...genericContract().tools[0], mutates: true }] };
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

test('bound door: raw arguments in the body, correlation in headers, handler version from its own header (SR-03)', async () => {
  const body = { status: 'generated', message_text: 'draft', nested: [1, { deep: true }] };
  const fetchImpl = fakeFetch({ status: 200, body, headers: { 'x-contract-version': 'v1' } });
  const args = { goal: { instruction: 'next step' }, language: 'ru' };
  const got = await client(fetchImpl).invoke({
    toolId: TOOL_ID, arguments: args,
    authContext: { profileId: 'p1', runId: 'r1', taskId: 't1', operationId: 'op-1' },
  });
  assert.deepEqual(got, body, 'the relay must not reshape the handler response');
  assert.equal(fetchImpl.calls[0].url, `${ENDPOINT}/v1/dialogs/next-message`);
  assert.equal(fetchImpl.calls[0].init.body, JSON.stringify(args), 'raw arguments — no envelope a real door does not accept');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal('contractVersion' in sent, false);
  assert.equal('authContext' in sent, false);
  const h = fetchImpl.calls[0].init.headers;
  assert.equal(h.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h['X-Relay-Run-Id'], 'r1');
  assert.equal(h['X-Relay-Profile-Id'], 'p1');
  assert.equal(h['X-Relay-Task-Id'], 't1');
  assert.equal(h['X-Relay-Operation-Id'], 'op-1');
  assert.equal(fetchImpl.calls[0].init.body.includes(TOKEN), false, 'the credential stays in the header');
});

test('default door (future capability): the envelope body still travels as PR1 defined it', async () => {
  const body = { contractVersion: 1, output: { draftRef: 'abc' }, echo: { authContextDigest: 'd1' } };
  const fetchImpl = fakeFetch({ status: 200, body });
  const got = await client(fetchImpl, { contract: genericContract() })
    .invoke({ toolId: 'demo.write_thing', arguments: { channel: 'hh' }, authContext: { profileId: 'p1', runId: 'r1' } });
  assert.deepEqual(got, body);
  assert.equal(fetchImpl.calls[0].url, `${ENDPOINT}/capabilities/demo.write_thing/invoke`);
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.contractVersion, 1);
  assert.deepEqual(sent.arguments, { channel: 'hh' });
  assert.deepEqual(sent.authContext, { profileId: 'p1', runId: 'r1' });
  assert.equal(fetchImpl.calls[0].init.headers['X-Relay-Contract-Version'], '1');
});

test('a response carrying another (or no) handler version is rejected as version_mismatch — both doors', async () => {
  const bound = await client(fakeFetch({ status: 200, body: { status: 'generated' }, headers: { 'x-contract-version': 'v2' } }))
    .invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
  assert.equal(bound.code, 'version_mismatch');
  assert.equal(bound.rpcCode, -32015);

  const boundMissing = await client(fakeFetch({ status: 200, body: { status: 'generated' }, headers: {} }))
    .invoke({ toolId: TOOL_ID, arguments: {} }).then(() => null, e => e);
  assert.equal(boundMissing.code, 'version_mismatch', 'no version header = no silent pass');

  const boundOk = await client(fakeFetch({ status: 200, body: { status: 'generated' }, headers: { 'x-contract-version': 'v1' } }))
    .invoke({ toolId: TOOL_ID, arguments: {} });
  assert.deepEqual(boundOk, { status: 'generated' });

  const genericForeign = await client(fakeFetch({ status: 200, body: { contractVersion: 2 } }), { contract: genericContract() })
    .invoke({ toolId: 'demo.write_thing', arguments: {} }).then(() => null, e => e);
  assert.equal(genericForeign.code, 'version_mismatch');
  const genericViaHeader = await client(fakeFetch({ status: 200, body: {}, headers: { 'x-relay-contract-version': '1' } }), { contract: genericContract() })
    .invoke({ toolId: 'demo.write_thing', arguments: {} });
  assert.deepEqual(genericViaHeader, {}, 'the default door may ride the header');
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

test('only allowlisted auth-context fields are forwarded (default door, envelope); identity stays opaque', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { contractVersion: 1 } });
  await client(fetchImpl, { contract: genericContract() }).invoke({
    toolId: 'demo.write_thing',
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
    .invoke({ toolId: TOOL_ID, arguments: { language: 'ru' }, authContext: { profileId: 'p1', runId: 'r1', taskId: 't9', operationId: 'op-9' } })
    .catch(() => {});
  assert.equal(events.length, 1);
  const event = events[0];
  for (const key of ['toolId', 'contractVersion', 'profileId', 'runId', 'operationId', 'latencyMs', 'outcome', 'code', 'outcomeUnknown']) {
    assert.ok(key in event, `telemetry must carry ${key}`);
  }
  assert.equal(event.toolId, TOOL_ID);
  assert.equal(event.code, 'upstream_unavailable');
  const line = formatEvent({ ts: '2026-10-04T00:00:00.000Z', ...event, arguments: { language: 'ru' }, token: TOKEN });
  assert.doesNotMatch(line, /PAYLOAD-DRAFT|relay-test-token/);
  for (const key of FIELDS) assert.match(line, new RegExp(`"${key}"`));
});

test('telemetry never breaks a call, even when the consumer throws', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { status: 'generated' }, headers: { 'x-contract-version': 'v1' } });
  const got = await client(fetchImpl, { onEvent: () => { throw new Error('telemetry consumer blew up'); } })
    .invoke({ toolId: TOOL_ID, arguments: {} });
  assert.deepEqual(got, { status: 'generated' });
});
