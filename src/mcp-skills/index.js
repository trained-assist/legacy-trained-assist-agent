#!/usr/bin/env node
// MCP server — trained-skills
// Raw JSON-RPC 2.0 over stdio (no SDK dependency, avoids ESM/CJS issues)
'use strict';

const readline = require('readline');
const registry = require('./registry.js');
const { toolResultText } = require('../mcp-tool-result');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;

  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  // Notifications have no id — no response needed
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'trained-skills', version: '1.0.0' },
      });

    } else if (method === 'tools/list') {
      respond(id, { tools: registry.listTools() });

    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await registry.callTool(name, args || {});
      const text = toolResultText(name, result);
      respond(id, { content: [{ type: 'text', text }] });

    } else {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    respondError(id, -32603, e.message);
  }
});

// Keep process alive while stdin is open
process.stdin.resume();
