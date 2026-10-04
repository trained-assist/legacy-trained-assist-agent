#!/usr/bin/env node
'use strict';
// capability-relay — MCP stdio server that relays a cloud capability call to the
// canonical handler (issue #2061 PR1).
//
// Same JSON-RPC dialect as src/mcp-skills/index.js (raw over stdio, no SDK): the
// engine only knows one MCP. What makes this server different is that it holds NO
// business logic: tools/list is a view over the contract, tools/call is one POST to
// the capability the contract names. A missing env is a typed `misconfigured` answer,
// never a dead process — the engine must stay usable with the feature switched off.

const readline = require('readline');
const { loadContract, toolView, findTool, checkResponseVersion } = require('./contract.js');
const { createRelayClient, DEFAULT_TIMEOUT_MS } = require('./client.js');
const { RelayError, isRelayError } = require('./errors.js');
const { relayEnvFrom, toolReady } = require('./env.js');
const { stderrLogger } = require('./telemetry.js');

// The engine's MCP version (src/mcp-skills/index.js) — not ours to choose; R7 exists
// because a version we don't speak must fail loudly instead of silently degrading.
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'capability-relay';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } });
}

/** Build the client for ONE tool from the relay's own minimal env. Throws a typed error when unconfigured. */
function buildClient(tool, env = process.env) {
  const relayEnv = relayEnvFrom(env);
  const contract = loadContract();
  const pin = relayEnv.CAPABILITY_RELAY_CONTRACT_VERSION;
  if (pin) {
    checkResponseVersion(contract.version, Number(pin), { contract, source: 'CAPABILITY_RELAY_CONTRACT_VERSION' });
  }
  // Endpoint and credential are named per capability (invoke binding) — a bound door
  // never silently falls back to the default door's env.
  const binding = tool && tool.invoke;
  const endpoint = binding ? relayEnv[binding.endpoint_env] : relayEnv.CAPABILITY_RELAY_ENDPOINT;
  const token = binding ? relayEnv[binding.token_env] : relayEnv.CAPABILITY_RELAY_TOKEN;
  if (!endpoint || !token) {
    const names = binding ? `${binding.endpoint_env} / ${binding.token_env}` : 'CAPABILITY_RELAY_ENDPOINT / CAPABILITY_RELAY_TOKEN';
    throw new RelayError('misconfigured', {
      message: `capability ${tool.toolId} is not configured: ${names} missing in the relay env`,
      contractVersion: contract.version,
    });
  }
  return createRelayClient({
    fetchImpl: (...args) => fetch(...args),
    endpoint,
    token,
    timeoutMs: relayEnv.CAPABILITY_RELAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    contract,
    onEvent: stderrLogger(),
  });
}

function handle(id, method, params) {
  if (method === 'initialize') {
    const contract = loadContract();
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
        contract: { urn: contract.urn, version: contract.version },
      },
      serverInfo: { name: SERVER_NAME, version: String(contract.version) },
    });
    return;
  }

  if (method === 'tools/list') {
    // Verbatim projection of the contract — the same name/schema a REST caller sees —
    // minus tools that are not ready (#2034: no credentials → no entry, never a claim
    // of readiness we cannot back).
    const contract = loadContract();
    respond(id, { tools: contract.tools.filter(t => toolReady(t, process.env)).map(toolView) });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    const meta = (params && params._meta) || {};
    const contract = loadContract();
    const tool = findTool(contract, name);
    if (!tool) {
      throw new RelayError('not_found', {
        message: `no capability named ${name} in contract version ${contract.version}`,
        contractVersion: contract.version,
      });
    }
    if (!toolReady(tool, process.env)) {
      // Called anyway (not in tools/list, but the contract knows it): an explicit
      // misconfigured, never a dead process and never a silent empty success.
      throw new RelayError('misconfigured', {
        message: `capability ${tool.toolId} is not ready: feature toggle off or endpoint/credential missing in the relay env`,
        contractVersion: contract.version,
      });
    }
    const client = buildClient(tool);
    return client
      .invoke({ toolId: tool.toolId, arguments: args || {}, authContext: meta.authContext, timeoutMs: meta.timeoutMs })
      .then(result => respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }))
      .catch(e => { throw e; });
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', line => {
    const raw = (line || '').trim();
    if (!raw) return;
    let req;
    try { req = JSON.parse(raw); } catch { return; /* notifications and junk are ignored, never fatal */ }
    const { id, method, params } = req || {};
    if (id === undefined || id === null) return; // notification: no response

    try {
      const out = handle(id, method, params);
      if (out && typeof out.catch === 'function') {
        out.catch(e => replyWithError(id, e));
      }
    } catch (e) {
      replyWithError(id, e);
    }
  });

  process.stdin.resume();
}

function replyWithError(id, e) {
  if (isRelayError(e)) {
    respondError(id, e.rpcCode, e.safeReasonValue, e.toData());
    return;
  }
  respondError(id, -32603, (e && e.message) || 'relay internal error');
}

if (require.main === module) main();

module.exports = { main, buildClient, handle, PROTOCOL_VERSION, SERVER_NAME };