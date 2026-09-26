#!/usr/bin/env node
'use strict';

// Deterministic fake MCP provider for PR2 tests. Implements the tools-only
// subset the design declares: initialize / initialized, ping, tools/list,
// tools/call. No LLM, no network.
//
// Flags (optional, for crash/timeout tests):
//   --fail-tool         make tools/call return isError:true
//   --exit-on-call      exit the process before answering tools/call
//   --hang-on-call      never answer tools/call
//   --echo-env          include received env keys + USER_ID in the result

const readline = require('readline');

const argv = process.argv.slice(2);
const FAIL_TOOL = argv.includes('--fail-tool');
const EXIT_ON_CALL = argv.includes('--exit-on-call');
const HANG_ON_CALL = argv.includes('--hang-on-call');
const ECHO_ENV = argv.includes('--echo-env'); // env-policy tests: report what the child received

const TOOLS = [
  {
    name: 'marker_read',
    description: 'Static read-only marker tool used by deterministic wiring tests.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-provider', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    if (HANG_ON_CALL) return;
    if (EXIT_ON_CALL) { process.exit(7); }
    const args = params?.arguments || {};
    if (FAIL_TOOL) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'marker failure' }] } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify({ marker: args.q ?? null, tool: params?.name || null }) }],
      structuredContent: { marker: args.q ?? null, tool: params?.name || null,
        ...(ECHO_ENV ? { envKeys: Object.keys(process.env).filter(k => !k.startsWith('npm_')).sort(), userId: process.env.USER_ID ?? null } : {}) },
    } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
process.stdin.resume();
