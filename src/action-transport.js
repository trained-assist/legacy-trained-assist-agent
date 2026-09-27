'use strict';

// Default invokeAction transport: call a registered provider action through the
// existing scoped-child router (src/mcp-action.js runMcpTool). This is the bridge
// that lets the /domain route and cron reach real providers through the one
// sanctioned path (spec §2, §5).
//
// Scope mapping: profileId IS the profile name (username); projectId selects the
// project workDir, else the profile workspace. Paths come from data-paths.js so
// nothing is derived inline. The child gets USER_ID/WORK_DIR via runMcpTool, the
// same isolation used by every MCP tool call — the transport never runs a
// provider handler in-process.

const { runMcpTool } = require('./mcp-action');
const { userWorkDir, projectDir } = require('./data-paths');

function resolveWorkDir(profileId, projectId) {
  const username = String(profileId);
  return projectId ? projectDir(username, projectId) : userWorkDir(username);
}

// runTool is injectable so the mapping/parsing can be unit-tested without
// spawning a child; production uses runMcpTool. `trigger`/`origin` come from the
// invokeAction invocation and are forwarded so an approved source executed
// through the adapter/broker sees the same trigger policy as the caller (#1533).
function createMcpTransport({ runTool = runMcpTool } = {}) {
  return async function transport({ action, arguments: args, profileId, projectId, trigger }) {
    const username = String(profileId);
    const workDir = resolveWorkDir(profileId, projectId);
    const text = await runTool({
      tool: action, params: args || {}, username, workDir,
      trigger: trigger || 'user',
      origin: trigger === 'cron' ? 'cron-service' : 'api',
    });
    if (text === undefined || text === null || text === '') return null;
    // MCP tools return text; structured actions return JSON. Parse when we can,
    // otherwise pass the raw text through (the provider owns its output shape).
    try { return JSON.parse(text); } catch { return text; }
  };
}

module.exports = { createMcpTransport, resolveWorkDir };
