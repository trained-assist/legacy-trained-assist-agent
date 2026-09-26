'use strict';

// Runs a single MCP tool call without spinning up a Claude Code session —
// the "command → tool" fast path for parameterized Telegram quick-commands
// (see /action in server.js).
//
// Every call spawns a fresh, single-purpose `mcp-skills/index.js` process.
// This is not an optimization detail — it's required for correctness.
// Tool modules read `USER_ID` into a module-level const at require time
// (e.g. src/mcp-skills/tools/90-hh.js:10 — `const USER_ID = process.env.USER_ID || ''`).
// That constant is captured once per process and never re-read. Calling
// registry.callTool() in-process inside the shared, multi-tenant server
// would run every /action request under whichever user's id happened to be
// set when the module first loaded (or under no user at all) — a silent
// cross-tenant data leak, not a race condition you can paper over. Do not
// "optimize" this into an in-process registry.callTool() call.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const registry = require('./mcp-skills/registry');
const { mergeToolCatalogs } = require('./action-provider-registry');

const INDEX_PATH = path.join(__dirname, 'mcp-skills', 'index.js');
const DEFAULT_TIMEOUT_MS = 45_000;

// HH metadata is discovered from the existing external provider. Duplicate names
// are configuration errors, never implicit local-first overrides (contract v1).
const HH_SKILL_INDEX_PATH = path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'src', 'mcp-skills', 'index.js');
const hhRegistry = fs.existsSync(HH_SKILL_INDEX_PATH)
  ? require(path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'src', 'mcp-skills', 'registry'))
  : null;

// Safe in-process: listTools() is static tool metadata, not user-scoped execution.
function listActionTools() {
  return mergeToolCatalogs(registry.listTools(), hhRegistry ? hhRegistry.listTools() : []);
}

function resolveToolSource(tool, localNames, hhNames) {
  if (localNames.has(tool) && hhNames?.has(tool)) {
    throw Object.assign(new Error(`Duplicate action: ${tool}`), { code: 'CONFLICT' });
  }
  if (localNames.has(tool)) return 'local';
  if (hhNames?.has(tool)) return 'hh';
  throw Object.assign(new Error('Action is not registered'), { code: 'ACTION_NOT_FOUND' });
}

function resolveIndexPath(tool) {
  const localNames = new Set(registry.listTools().map(t => t.name));
  const hhNames = hhRegistry ? new Set(hhRegistry.listTools().map(t => t.name)) : null;
  return resolveToolSource(tool, localNames, hhNames) === 'hh' ? HH_SKILL_INDEX_PATH : INDEX_PATH;
}

function runMcpTool({ tool, params, username, workDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!tool || typeof tool !== 'string') return Promise.reject(Object.assign(new Error('tool required'), { code: 'bad_request' }));
  if (!listActionTools().some(t => t.name === tool)) return Promise.reject(Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'bad_request' }));
  // MCP_HOST_ACTION is forced off: /action and the action transport never reach host-only actions.
  return spawnToolCall({ indexPath: resolveIndexPath(tool), tool, params, username, workDir, timeoutMs, hostAction: false });
}

// Host-only HH actions (epic #1470 P1.3): deterministic quick answers the runner
// used to compute in-process from the core hh-quick copy. The provider hides them
// from the model's tools/list and refuses them unless spawned with
// MCP_HOST_ACTION=1 — set only here, for user-typed commands handled by core.
function listHostActions() {
  return hhRegistry && typeof hhRegistry.listHostActions === 'function' ? hhRegistry.listHostActions() : [];
}

function runHostAction({ tool, params, username, workDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!listHostActions().some(t => t.name === tool)) {
    return Promise.reject(Object.assign(new Error(`Host action is not registered: ${tool}`), { code: 'ACTION_NOT_FOUND' }));
  }
  return spawnToolCall({ indexPath: HH_SKILL_INDEX_PATH, tool, params, username, workDir, timeoutMs, hostAction: true });
}

function spawnToolCall({ indexPath, tool, params, username, workDir, timeoutMs, hostAction }) {
  return new Promise((resolve, reject) => {
    const fail = (code, message) => reject(Object.assign(new Error(message), { code }));

    // process.execPath (not the string 'node') — avoids depending on PATH resolution
    // inside whatever env/sandbox this server process is itself running under.
    const child = spawn(process.execPath, [indexPath], {
      // cwd matters, not just WORK_DIR: tools like context-store resolve paths off
      // process.cwd() (inherited from Claude Code's own cwd today), not the env var.
      cwd: workDir || process.cwd(),
      env: { ...process.env, USER_ID: String(username || ''), WORK_DIR: workDir || '', MCP_HOST_ACTION: hostAction ? '1' : '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      fail('timeout', `tool timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(e, { code: 'spawn_error' }));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const line = out.split('\n').find(l => l.trim());
      if (!line) return fail('empty_response', err.trim() || 'empty response from tool process');

      let msg;
      try { msg = JSON.parse(line); }
      catch { return fail('bad_response', `malformed tool response: ${line.slice(0, 300)}`); }

      if (msg.error) return fail('tool_error', msg.error.message || 'tool error');
      resolve(msg.result?.content?.[0]?.text);
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: params || {} },
    }) + '\n');
    child.stdin.end();
  });
}

module.exports = { runMcpTool, runHostAction, listHostActions, listActionTools, resolveToolSource };
