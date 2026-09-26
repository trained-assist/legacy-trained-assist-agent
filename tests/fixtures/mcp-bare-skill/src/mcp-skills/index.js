'use strict';
// Fixture: a skill boundary WITHOUT the empty-result guard (what siblings had before #1481).
const registry = require('./registry.js');
require('readline').createInterface({ input: process.stdin }).on('line', async (line) => {
  const { id, method, params } = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  if (method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: { tools: {} } });
  else if (method === 'tools/list') send({ tools: registry.listTools() });
  else if (method === 'tools/call') {
    const r = await registry.callTool(params.name, params.arguments || {});
    send({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }] });
  }
});
