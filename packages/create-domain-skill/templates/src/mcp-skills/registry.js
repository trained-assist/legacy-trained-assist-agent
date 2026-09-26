'use strict';

// Auto-discover every tool file in tools/ (sorted). Each module may export:
//   isReady()  — bool; when false only `setupTools` are registered
//   setupTools — tool names always registered (status/connect tools)
//   tools      — { [name]: { description, inputSchema, handler } }
const fs = require('fs');
const path = require('path');

const toolsDir = process.env.TOOLS_DIR || path.join(__dirname, 'tools');
const handlers = {};
const defs = [];

for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')).sort()) {
  const mod = require(path.join(toolsDir, file));
  const ready = typeof mod.isReady === 'function' ? mod.isReady() : true;
  const setupSet = new Set(mod.setupTools || []);
  for (const [name, tool] of Object.entries(mod.tools || {})) {
    if (!ready && !setupSet.has(name)) continue;
    if (handlers[name]) { console.error(`[registry] duplicate tool name: ${name} in ${file}`); continue; }
    handlers[name] = tool.handler;
    defs.push({ name, description: tool.description, inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
  }
}

module.exports = {
  listTools: () => defs,
  callTool: (name, args) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    return fn(args, { userId: process.env.USER_ID });
  },
};
