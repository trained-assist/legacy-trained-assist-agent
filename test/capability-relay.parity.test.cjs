'use strict';
// Issue #2061 PR1, slice T4 — REST↔MCP parity against the mock handler on 127.0.0.1.
// SR-03: name/schema/result of a relayed call are identical to a direct REST call,
// and the auth context actually reaches the handler.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startMockWorker } = require('./fixtures/mock-capability-worker.cjs');
const { startRelay } = require('./fixtures/relay-stdio.cjs');
const { loadContract } = require('../src/capability-relay/contract.js');

const TOKEN = 'parity-secret-token';
const TOOL_ID = 'communication.prepare_message_draft';
const TOOL_NAME = 'capability_prepare_message_draft';

let worker = null;
let env = {};

before(async () => {
  worker = await startMockWorker({ token: TOKEN });
  env = { CAPABILITY_RELAY_ENDPOINT: worker.url, CAPABILITY_RELAY_TOKEN: TOKEN, CAPABILITY_RELAY_CONTRACT_VERSION: '1' };
});
after(async () => { if (worker) await worker.close(); });

/** The canonical REST call, made by hand — what a non-relayed caller would do. */
async function restInvoke({ arguments: args, authContext, token = TOKEN, contractVersion = loadContract().version }) {
  const res = await fetch(`http://127.0.0.1:${worker.port}/capabilities/${TOOL_ID}/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Relay-Contract-Version': String(contractVersion),
      ...(authContext.runId ? { 'X-Relay-Run-Id': authContext.runId } : {}),
    },
    body: JSON.stringify({ contractVersion, arguments: args, authContext }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function mcpInvoke({ arguments: args, authContext, extraEnv = {} }) {
  const relay = startRelay({ ...env, ...extraEnv });
  try {
    const { error, result } = await relay.request('tools/call', {
      name: TOOL_NAME,
      arguments: args,
      _meta: { authContext },
    });
    if (error) return { error };
    return { body: JSON.parse(result.content[0].text) };
  } finally {
    await relay.close();
  }
}

test('the same call over REST and over MCP returns a deep-equal result (SR-03)', async t => {
  // No operationId here on purpose: the handler dedupes by it (asserted separately),
  // so a repeated id would be a conflict instead of a second successful call.
  const authContext = { profileId: 'recruiter', runId: 'run-42', taskId: 'task-7' };
  const arguments_ = { channel: 'hh', candidateRef: 'cand-9', vacancyRef: 'vac-3', tone: 'formal', language: 'ru' };

  const rest = await restInvoke({ arguments: arguments_, authContext });
  const mcp = await mcpInvoke({ arguments: arguments_, authContext });

  assert.equal(rest.status, 200);
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  assert.deepEqual(mcp.body, rest.body, 'a relayed call must not differ from a direct one');
  assert.equal(mcp.body.toolId, TOOL_ID);
  assert.equal(mcp.body.output.channel, 'hh');
  assert.equal(mcp.body.output.tone, 'formal');
});

test('the auth context reached the handler on both paths, and no credential was recorded', async () => {
  const callsBefore = worker.calls.length;
  const authContext = { identity: 'host-issued-opaque-id', profileId: 'p2', runId: 'r2', taskId: 't2' };
  const args = { channel: 'telegram', candidateRef: 'cand-ctx' };

  const rest = await restInvoke({ arguments: args, authContext });
  const mcp = await mcpInvoke({ arguments: args, authContext });

  const seen = worker.calls.slice(callsBefore);
  assert.equal(seen.length, 2, 'both paths reached the handler');
  assert.equal(JSON.stringify(seen).includes(TOKEN), false, 'the mock must never store the token');
  assert.equal(JSON.stringify(seen).includes('host-issued-opaque-id'), false, 'identity is stored as a digest, not verbatim');
  assert.deepEqual(seen[0], seen[1], 'the handler received the same call on both paths');
  assert.ok(seen[1].authContextKeys.includes('identity'), 'identity as a KEY travelled, proving it was forwarded');
  // The handler itself computed the digest from the full context — so identity DID travel.
  assert.deepEqual(rest.body.echo, mcp.body.echo);
  assert.equal(rest.body.echo.authorizationScheme, 'bearer');
  assert.equal(typeof rest.body.echo.authContextDigest, 'string');
  assert.equal(rest.body.echo.authContextDigest, mcp.body.echo.authContextDigest);
});

test('an operationId already used is a typed conflict, not a duplicate send', async () => {
  const authContext = { profileId: 'p1', runId: 'r1', operationId: 'op-once' };
  const args = { channel: 'hh', candidateRef: 'cand-once' };
  const first = await mcpInvoke({ arguments: args, authContext });
  assert.equal(first.error, undefined, JSON.stringify(first.error));

  const second = await mcpInvoke({ arguments: args, authContext });
  assert.ok(second.error, 'the second attempt must be refused');
  assert.equal(second.error.code, -32014);
  assert.equal(second.error.data.code, 'conflict');
  assert.equal(second.error.data.outcomeUnknown, false, 'we KNOW nothing was sent twice');
  assert.equal(second.error.data.retryable, false);
});

test('a wrong caller credential maps to unauthorized (-32011)', async () => {
  const mcp = await mcpInvoke({
    arguments: { channel: 'hh', candidateRef: 'cand-auth' },
    authContext: { profileId: 'p1' },
    extraEnv: { CAPABILITY_RELAY_TOKEN: 'not-the-right-token' },
  });
  assert.ok(mcp.error, 'the handler rejected the credential');
  assert.equal(mcp.error.code, -32011);
  assert.equal(mcp.error.data.code, 'unauthorized');
  assert.match(mcp.error.message, /unauthorized/, 'only the allowlisted reason surfaces');
  assert.equal(JSON.stringify(mcp.error).includes('not-the-right-token'), false, 'no credential in the error');
});

test('a foreign contract version in the response is refused (SR-04)', async () => {
  const rest = await restInvoke({
    arguments: { channel: 'hh', candidateRef: 'cand-v' },
    authContext: { profileId: 'p1' },
    contractVersion: 999,
  });
  assert.equal(rest.status, 400, 'the handler refuses a foreign contract version');
  assert.equal(rest.body.error.code, 'invalid_arguments');
});