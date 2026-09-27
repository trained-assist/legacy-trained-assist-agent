#!/usr/bin/env node
'use strict';

// stdio ↔ unix-socket relay the isolated engine launches as its "MCP server"
// (issue #1649, see src/agent-mcp-bridge.js). Runs as the slot user; knows only
// the bridge socket path and the run-scoped token from its env.

const net = require('net');

const serverId = process.argv[2];
const socketPath = process.env.AGENT_MCP_BRIDGE_SOCKET;
const token = process.env.AGENT_RUN_TOKEN;

if (!serverId || !socketPath || !token) {
  process.stderr.write('agent-mcp-bridge-client: missing server id, AGENT_MCP_BRIDGE_SOCKET or AGENT_RUN_TOKEN\n');
  process.exit(2);
}

const sock = net.createConnection({ path: socketPath, allowHalfOpen: true }, () => {
  sock.write(JSON.stringify({ token, server: serverId }) + '\n');
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});
sock.on('error', (e) => {
  process.stderr.write(`agent-mcp-bridge-client: ${e.message}\n`);
  process.exit(1);
});
sock.on('close', () => process.stdout.write('', () => process.exit(0))); // flush, then go
process.stdin.on('end', () => sock.end());
