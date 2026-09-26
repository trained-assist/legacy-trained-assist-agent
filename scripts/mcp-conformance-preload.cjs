'use strict';
// Preloaded by check-mcp-conformance.js: replaces the skill's registry.js with a single
// probe tool that returns args.value, so the real index.js boundary is tested alone.
const registryPath = require('fs').realpathSync(process.env.MCP_CONFORMANCE_REGISTRY);
const probe = {
  listTools: () => [{ name: 'conformance_probe', description: 'Conformance probe: returns args.value', inputSchema: { type: 'object' } }],
  callTool: async (_name, args) => (args || {}).value,
};
const Module = require('module');
const m = new Module(registryPath, null);
m.filename = registryPath;
m.loaded = true;
m.exports = probe;
Module._cache[registryPath] = m;
