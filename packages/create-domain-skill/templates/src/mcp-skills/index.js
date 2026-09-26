#!/usr/bin/env node
// MCP server — {{domain}}-skills. Raw JSON-RPC 2.0 over stdio (no SDK).
'use strict';

const readline = require('readline');
const registry = require('./registry.js');
const { toolResultText } = require('./tool-result.js');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function respondError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification

  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '{{domain}}-skills', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      respond(id, { tools: registry.listTools() });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await registry.callTool(name, args || {});
      respond(id, { content: [{ type: 'text', text: toolResultText(name, result) }] });
    } else {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    respondError(id, -32603, e.message);
  }
});

process.stdin.resume();
