'use strict';

// Deterministic external-world provider for behaviour tests. Wraps the bundled
// fake-provider-mcp.js script: gives the consumer its path/argv to hand to a
// provider adapter, or starts it as a real stdio MCP server.
//
//   const provider = fakeProvider({ flags: ['--fail-tool'] });
//   // pass provider.argv to the adapter, or:
//   const server = await provider.start();
//   await server.stop();

const { join } = require('path');
const { startMcpServer } = require('./start-mcp-server');

const ENTRYPOINT = join(__dirname, '..', 'fake-provider-mcp.js');

const DEFAULT_TOOLS = [{
  name: 'marker_read',
  description: 'Static read-only marker tool used by deterministic wiring tests.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
}];

function fakeProvider({ tools, flags = [], args = [], env = {}, workDir } = {}) {
  if (tools && !Array.isArray(tools)) throw new Error('fakeProvider: `tools` must be an array of tool descriptors');
  const allFlags = [...flags, ...args];
  const childEnv = { ...env };
  if (tools && tools.length) childEnv.FAKE_PROVIDER_TOOLS_JSON = JSON.stringify(tools);
  if (allFlags.length) childEnv.FAKE_PROVIDER_FLAGS = allFlags.join(',');

  return {
    entrypoint: ENTRYPOINT,
    command: process.execPath,
    argv: [ENTRYPOINT, ...allFlags],
    flags: allFlags,
    tools: tools && tools.length ? tools : DEFAULT_TOOLS,
    env: childEnv,
    start: (overrides = {}) => startMcpServer({
      entrypoint: ENTRYPOINT,
      args: allFlags,
      env: childEnv,
      workDir,
      ...overrides,
    }),
  };
}

fakeProvider.entrypoint = ENTRYPOINT;
fakeProvider.defaultTools = DEFAULT_TOOLS;

module.exports = { fakeProvider, FAKE_PROVIDER_ENTRYPOINT: ENTRYPOINT, DEFAULT_TOOLS };
