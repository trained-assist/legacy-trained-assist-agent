'use strict';

// Runs a single MCP tool call without spinning up a Claude Code session —
// the "command → tool" fast path for parameterized Telegram quick-commands
// (see /action in server.js) and for the cron transport (src/action-transport.js).
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
//
// Source resolution (issue #1533) goes through the SAME rule as the session
// path (src/browser.js): an approved external source that is enabled +
// eligible for the profile + has an available artifact wins over the sibling
// with the same mcpServerId and is executed through the core adapter/broker,
// not a direct sibling spawn. With the source disabled/ineligible/unavailable
// the sibling is the fallback, then core. Duplicate names across any two
// active sources are a CONFLICT (src/action-tool-catalog.js).

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const registry = require('./mcp-skills/registry');
const { buildToolCatalog } = require('./action-tool-catalog');
const { presentSiblings } = require('./skill-siblings');
const { getDefaultSourceRuntime } = require('./mcp-source-runtime');

const INDEX_PATH = path.join(__dirname, 'mcp-skills', 'index.js');
const DEFAULT_TIMEOUT_MS = 45_000;

// Sibling skill providers (hh, freelance, engineering — src/skill-siblings.js) are
// discovered from their checkouts. Duplicate names across any two sources are
// configuration errors, never implicit local-first overrides (contract v1).
const siblings = presentSiblings().map(s => ({ ...s, registry: require(s.registryPath) }));

// Static, user-independent catalog. listTools() is filtered by each module's
// isReady(), which keys on USER_ID — empty in this shared server process — so it
// would hide every ready-gated tool (hh_proactive_search → "Unknown tool" on cron,
// #1530). Readiness is enforced by the per-user child, not by this name gate.
function staticCatalog(reg) {
  return typeof reg.listAllTools === 'function' ? reg.listAllTools() : reg.listTools();
}

// The approved sources that may serve this profile right now. Mirrors
// planSessionMcp: a source only mounts (and only suppresses a sibling) when it
// is enabled, allowlisted for the profile, and its artifact verifies. Reads the
// generation snapshot only — no broker, no child, no rehash cost.
function approvedSourcesForProfile(profileId, runtime) {
  const generation = runtime && runtime.enabled ? runtime.generation : null;
  const sources = generation?.snapshot?.sources || [];
  return sources
    .filter(s => s && s.enabled && Array.isArray(s.profiles) && s.profiles.includes(profileId)
      && s.artifactStatus === 'available')
    .map(s => ({
      id: s.id,
      providerId: s.providerId,
      mcpServerId: s.mcpServerId,
      actions: (s.approvedManifest?.actions || []).map(a =>
        a.description ? { name: a.name, description: a.description } : { name: a.name }),
    }));
}

function resolveRuntime(option) {
  return option !== undefined ? option : getDefaultSourceRuntime();
}

// Effective catalog for one profile: core + non-suppressed siblings + approved.
function buildCatalogForProfile({ profileId, runtime, siblingList = siblings }) {
  return buildToolCatalog({
    coreTools: staticCatalog(registry),
    siblings: siblingList.map(s => ({ id: s.id, mcpServerId: s.mcpServerId, tools: staticCatalog(s.registry) })),
    approvedSources: profileId ? approvedSourcesForProfile(profileId, runtime) : [],
  });
}

// Safe in-process: tool metadata only, no user-scoped execution. profileId is
// optional for back-compat (core+siblings only); pass it on the transport path
// so approved-manifest actions are part of the gate too.
function listActionTools(profileId, options = {}) {
  const runtime = profileId ? resolveRuntime(options.sourceRuntime) : null;
  return buildCatalogForProfile({ profileId, runtime, siblingList: options.siblings || siblings }).tools;
}

// siblingNames: { [siblingId]: Set<toolName> } for the siblings present on this host.
function resolveToolSource(tool, localNames, siblingNames = {}) {
  const owners = localNames.has(tool) ? ['local'] : [];
  for (const [id, names] of Object.entries(siblingNames)) if (names?.has(tool)) owners.push(id);
  if (owners.length > 1) {
    throw Object.assign(new Error(`Duplicate action: ${tool} (${owners.join(', ')})`), { code: 'CONFLICT' });
  }
  if (owners.length === 1) return owners[0];
  throw Object.assign(new Error('Action is not registered'), { code: 'ACTION_NOT_FOUND' });
}

async function runMcpTool({
  tool, params, username, workDir, timeoutMs = DEFAULT_TIMEOUT_MS,
  trigger = 'user', origin = 'api', sourceRuntime, siblings: siblingList,
}) {
  if (!tool || typeof tool !== 'string') throw Object.assign(new Error('tool required'), { code: 'bad_request' });
  const list = siblingList || siblings;
  const runtime = resolveRuntime(sourceRuntime);

  // A duplicate name across active sources throws CONFLICT here — never resolved implicitly.
  const catalog = buildCatalogForProfile({ profileId: username, runtime, siblingList: list });

  const owner = catalog.owners.get(tool);
  if (!owner) throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: 'bad_request' });

  if (owner.kind === 'approved') {
    return runApprovedTool({ owner, tool, params, username, workDir, timeoutMs, runtime, trigger, origin });
  }

  // MCP_HOST_ACTION is forced off: /action and the action transport never reach host-only actions.
  const indexPath = owner.kind === 'local'
    ? INDEX_PATH
    : list.find(s => s.id === owner.id).indexPath;
  return spawnToolCall({ indexPath, tool, params, username, workDir, timeoutMs, hostAction: false });
}

// Execute an approved-source action through the core adapter — the same
// process the engine spawns from .mcp.json (adapter -> broker -> invokeAction ->
// provider). The host materializes one revocable run for this call and releases
// it as soon as the child exits.
async function runApprovedTool({ owner, tool, params, username, workDir, timeoutMs, runtime, trigger, origin }) {
  if (!runtime || !runtime.enabled) {
    throw Object.assign(new Error(`Provider unavailable: ${tool}`), { code: 'PROVIDER_UNAVAILABLE' });
  }
  const taskId = `action-${username || 'anon'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const runtimeDir = path.join(workDir || process.cwd(), '.mcp-runs', taskId);
  let run;
  try {
    run = await runtime.prepareRun({
      hostRunBinding: {
        engineRunId: taskId, rootTaskId: taskId, profileId: username,
        trigger, origin, resourceBindingVersion: 'v1',
      },
      runtimeDir,
    });
  } catch (e) {
    throw Object.assign(e, { code: e.code || 'PROVIDER_UNAVAILABLE' });
  }
  try {
    const descriptor = run?.servers?.[owner.source.mcpServerId];
    if (!descriptor) {
      throw Object.assign(new Error(`Provider unavailable: ${tool}`), { code: 'PROVIDER_UNAVAILABLE' });
    }
    return await spawnToolCall({
      command: descriptor.command, args: descriptor.args,
      tool, params, username, workDir, timeoutMs, hostAction: false,
    });
  } finally {
    if (run) run.release();
  }
}

// Host-only actions (epic #1470 P1.3, HH first): deterministic quick answers the
// runner used to compute in-process from the core hh-quick copy. A provider hides
// them from the model's tools/list and refuses them unless spawned with
// MCP_HOST_ACTION=1 — set only here, for user-typed commands handled by core.
function hostActionOwners() {
  return siblings
    .filter(s => typeof s.registry.listHostActions === 'function')
    .flatMap(s => s.registry.listHostActions().map(t => ({ tool: t, sibling: s })));
}

function listHostActions() {
  return hostActionOwners().map(o => o.tool);
}

function runHostAction({ tool, params, username, workDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const owners = hostActionOwners().filter(o => o.tool.name === tool);
  if (owners.length === 0) {
    return Promise.reject(Object.assign(new Error(`Host action is not registered: ${tool}`), { code: 'ACTION_NOT_FOUND' }));
  }
  if (owners.length > 1) {
    return Promise.reject(Object.assign(new Error(`Duplicate host action: ${tool}`), { code: 'CONFLICT' }));
  }
  return spawnToolCall({ indexPath: owners[0].sibling.indexPath, tool, params, username, workDir, timeoutMs, hostAction: true });
}

// Either an `indexPath` (core/sibling MCP server) or a `command`+`args` adapter
// descriptor (approved source). Both speak the same single-call stdio protocol.
function spawnToolCall({ indexPath, command, args, tool, params, username, workDir, timeoutMs, hostAction }) {
  return new Promise((resolve, reject) => {
    const fail = (code, message) => reject(Object.assign(new Error(message), { code }));

    // process.execPath (not the string 'node') — avoids depending on PATH resolution
    // inside whatever env/sandbox this server process is itself running under.
    const child = spawn(command || process.execPath, args || [indexPath], {
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

module.exports = {
  runMcpTool, runHostAction, listHostActions, listActionTools, resolveToolSource,
  buildCatalogForProfile, approvedSourcesForProfile,
};
