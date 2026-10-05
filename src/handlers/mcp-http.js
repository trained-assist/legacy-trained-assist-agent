'use strict';
// POST /mcp — the same trained-skills registry over HTTP JSON-RPC, for engine runs
// that do NOT live on this machine (GitHub Actions, see issue #73 / the GHA runner).
//
// Why this exists instead of moving the MCP out of the agent: the MCP is not
// self-contained. `buildMcpConfig` (src/browser.js) hands the server `mcpToolEnv` —
// the service user's platform secrets plus per-profile token files — and the tools
// read agent state that lives here (sessions, artifacts, credentials, cron, durable
// tasks, playbooks) and drive the host browser, including the RU-geo one. An engine
// elsewhere cannot host it. So the MCP stays, and only the transport changes: a
// unix-socket bridge for engines on this host (src/agent-mcp-bridge.js), HTTP for
// engines anywhere.
//
// Stateless by construction: one JSON-RPC message per POST, no session id, no
// stored state. Verified against opencode 1.18.34, which sends `initialize`,
// `notifications/initialized`, `tools/list`, `tools/call` and never requires
// `mcp-session-id` back.
//
// Auth is a run-scoped token (src/agent-run-tokens.js), NEVER AGENT_SECRET: this is
// the endpoint a public-CI job reaches, and AGENT_SECRET is full-server access.
// Mint one with POST /mcp/token (below, behind the normal gate).

const fs = require('fs');
const { runTokenFromAuthHeader } = require('../agent-run-tokens');
const { runMcpTool, listActionTools } = require('../mcp-action');
const { userWorkDir } = require('../data-paths');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'trained-skills', version: '1.0.0' };
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// JSON-RPC error codes we use. -32700/-32600/-32601 are spec; -32000 is
// "application error" and carries the tool's own message.
const RPC_PARSE = -32700;
const RPC_BAD_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INTERNAL = -32603;

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/**
 * Work dir of the profile the run token is scoped to. Created on demand: the token
 * may name a profile whose directory does not exist yet, and a tools/call that has
 * nowhere to write is a worse failure than an empty dir.
 */
function scopedWorkDir(username) {
  const workDir = userWorkDir(username);
  fs.mkdirSync(workDir, { recursive: true });
  return workDir;
}

/**
 * Handle one JSON-RPC message.
 *
 * Kept pure-ish: every side effect goes through the injected `runTool`/`listTools`,
 * so the whole protocol surface is testable without spawning a real tool process.
 * A tool that fails is NOT a protocol error — MCP expects `isError: true` in the
 * result, and a JSON-RPC error there makes the client treat a broken tool as a
 * broken server.
 */
async function handleRpc({ message, username, listTools, runTool }) {
  const { id, method, params } = message || {};

  // A notification has no id and must not be answered. opencode sends
  // `notifications/initialized` and `notifications/cancelled` through this path.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list': {
      const workDir = scopedWorkDir(username);
      const tools = listTools(username, { workDir });
      return rpcResult(id, { tools });
    }

    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string' || !name) return rpcError(id, RPC_BAD_REQUEST, 'tools/call requires params.name');
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
      const workDir = scopedWorkDir(username);
      try {
        const text = await runTool({ tool: name, params: args, username, workDir });
        return rpcResult(id, { content: [{ type: 'text', text: text == null ? '' : String(text) }] });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: 'text', text: (e && e.message) || 'tool error' }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// POST /mcp — mounted BEFORE the AGENT_SECRET gate in server.js. Returns false when
// the path is not ours, the same contract as handlers/web.js.
async function handleMcp(req, url, res, ctx) {
  if (req.method !== 'POST' || url.pathname !== '/mcp') return false;

  const { json, readBody, readBodyBuffer } = ctx;
  const auth = req.headers['authorization'] || '';
  const scope = runTokenFromAuthHeader(auth);
  // No AGENT_SECRET fallback here on purpose — see the header note.
  if (!scope) {
    res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
    return true;
  }
  const username = scope.username;
  if (!USERNAME_RE.test(String(username || ''))) {
    return json(res, 400, { error: 'invalid run scope' }), true;
  }

  let raw;
  try {
    // tools/call arguments can be large (transcripts, page HTML) — 4 MB, not the 1 MB
    // the small-body default: a truncated arguments object fails as a confusing tool error.
    raw = readBodyBuffer ? (await readBodyBuffer(req, 4 * 1024 * 1024)).toString('utf8') : await readBody(req);
  } catch {
    return json(res, 400, { error: 'body too large' }), true;
  }

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return json(res, 200, rpcError(null, RPC_PARSE, 'Parse error')), true;
  }
  // A JSON-RPC batch is an array; MCP clients send one message per request. Refusing
  // loudly beats answering only the first element and leaving the rest hanging.
  if (Array.isArray(message)) {
    return json(res, 200, rpcError(null, RPC_BAD_REQUEST, 'batch is not supported; send one message per request')), true;
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return json(res, 200, rpcError(message && message.id, RPC_BAD_REQUEST, 'Invalid Request')), true;
  }

  const reply = await handleRpc({
    message,
    username,
    listTools: ctx.listTools || ((user, options) => listActionTools(user, options)),
    runTool: ctx.runTool || ((opts) => runMcpTool(opts)),
  });

  // Notification (no id): 202 Accepted with no body, per the MCP HTTP transport.
  if (!reply) {
    res.writeHead(202).end();
    return true;
  }
  return json(res, 200, reply), true;
}

// POST /mcp/token — mounted AFTER the auth gate. Hands an engine host a
// short-lived run token scoped to one profile, so it can reach POST /mcp without
// ever seeing AGENT_SECRET.
//
// Two callers are accepted by the gate in server.js:
//   - AGENT_SECRET — the operator of this host (a human or an in-cluster service);
//   - MCP_HOST_TOKEN — a remote engine host (issue #2114 trap #9), which must
//     never hold AGENT_SECRET and would otherwise have no way in. Since a run
//     token dies with this process (trap #8), the host mints per run, here.
//
// Deliberately not a general token factory: the scope carries no taskId, and the
// token dies with this process. If a remote engine needs a longer life, the run
// model (#73) re-issues per run rather than extending this.
async function handleMcpToken(req, url, res, ctx) {
  if (req.method !== 'POST' || url.pathname !== '/mcp/token') return false;

  const { json, readBody } = ctx;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }), true; }

  const username = String((body || {}).username || '');
  if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'invalid username' }), true;

  const token = ctx.issueRunToken
    ? ctx.issueRunToken({ taskId: `mcp:${username}`, username })
    : require('../agent-run-tokens').issueRunToken({ taskId: `mcp:${username}`, username });

  return json(res, 200, { token, url: '/mcp', username }), true;
}

module.exports = { handleMcp, handleMcpToken, handleRpc, PROTOCOL_VERSION, SERVER_INFO, USERNAME_RE };