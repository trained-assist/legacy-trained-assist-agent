#!/usr/bin/env node
'use strict';

// Core-owned provider adapter (design §0/§2.1, PR2).
//
// One process per (engineRunId, providerId, generationId, resourceBindingVersion).
// It is BOTH:
//   - an MCP stdio server for the coding engine (initialize/ping/tools/list/tools/call),
//   - an MCP stdio client/supervisor for the provider child.
//
// It never opens the operational SQLite: every action goes through the host's
// narrow ActionBroker, which alone runs invokeAction/ActionExecutions. The
// adapter owns the provider private copy, the provider child and the lease
// journal.
//
// Usage: node scripts/mcp-provider-adapter.js --binding-file <run-binding.json>

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const { stableStringify } = require('../src/mcp-skill-generation');
const { acquireProvider } = require('../src/mcp-skill-generation');
const { ActionBrokerClient } = require('../src/mcp-action-broker');
const { ProviderJournal } = require('../src/mcp-provider-journal');
const { ProviderRuntime } = require('../src/mcp-provider-runtime');
const { toolResultText } = require('../src/mcp-tool-result');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Load + verify the host-materialized RunBinding and its pinned generation
// snapshot. The adapter NEVER re-reads the active config.
function loadBinding(bindingFile) {
  let binding;
  try { binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8')); }
  catch (e) { throw adapterError('INVALID_BINDING', `Cannot read binding file: ${e.message}`); }
  if (!binding || binding.version !== 1 || typeof binding.snapshotPath !== 'string') {
    throw adapterError('INVALID_BINDING', 'Invalid RunBinding');
  }
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(binding.snapshotPath, 'utf8')); }
  catch (e) { throw adapterError('INVALID_BINDING', `Cannot read snapshot: ${e.message}`); }
  if (digest(stableStringify(snapshot)) !== binding.snapshotDigest) {
    throw adapterError('SNAPSHOT_MISMATCH', 'Pinned generation snapshot digest mismatch');
  }
  if (snapshot.generationId !== binding.generationId) {
    throw adapterError('SNAPSHOT_MISMATCH', 'Snapshot generation mismatch');
  }
  const source = (snapshot.sources || []).find(s => s.mcpServerId === binding.mcpServerId);
  if (!source) throw adapterError('PROVIDER_UNAVAILABLE', 'Source is not in the pinned snapshot');
  if (source.revision !== binding.sourceRevision || source.artifactDigest !== binding.artifactDigest) {
    throw adapterError('SNAPSHOT_MISMATCH', 'Source revision/artifact digest mismatch');
  }
  return { binding, snapshot, source };
}

// Static catalog from approved actions — never requires external provider JS.
function buildCatalog(source) {
  const actions = source.approvedManifest?.actions || [];
  return actions.map(a => {
    const tool = { name: a.name, inputSchema: a.inputSchema || { type: 'object' } };
    if (a.description) tool.description = a.description;
    return tool;
  });
}

// Real provider asset: full verify -> private copy -> post-copy verify via the
// PR1 acquireProvider path. Requires MCP_SKILLS_ROOT + a prepared release.
function realAssetLoader({ binding, snapshot, executionRoot, envAllowlist, root }) {
  const generation = { version: 1, generationId: binding.generationId, snapshot, policy: { root } };
  const lease = acquireProvider(generation, {
    mcpServerId: binding.mcpServerId, profileId: binding.profileId, executionRoot,
  });
  return {
    command: process.execPath,
    argv: [lease.entrypoint],
    entrypoint: lease.entrypoint,
    copyPath: lease.artifact,
    env: envAllowlist,
    release: lease.release,
  };
}

// Pure wiring, injectable for deterministic tests. Owns nothing global.
function createAdapter({
  binding, snapshot, source, journal, assetLoader, brokerClientFactory,
  executionRoot, hostId = null, bootId = null, envAllowlist = { PATH: process.env.PATH || '' },
  profileId = binding.profileId, shutdownGraceMs = 1000, root = process.env.MCP_SKILLS_ROOT || null,
} = {}) {
  if (!binding || !snapshot || !source) throw adapterError('INVALID_BINDING', 'binding/snapshot/source required');
  if (!journal) throw adapterError('INVALID_BINDING', 'journal required');

  const catalog = buildCatalog(source);
  const leaseKey = [binding.engineRunId, binding.providerId, binding.generationId,
    binding.resourceBindingVersion ?? ''].join('\0');
  const leaseGeneration = 1;

  let broker = null;
  let runtime = null;
  let started = null;
  let closed = false;

  async function connectBroker() {
    if (broker) return broker;
    const factory = brokerClientFactory || ((opts) => ActionBrokerClient.connect(binding.brokerEndpoint, opts));
    broker = await factory({ capability: binding.brokerCapability, onProvider: handleProvider });
    return broker;
  }

  async function startProvider() {
    if (runtime) return runtime;
    if (started) return started;
    started = (async () => {
      const lease = journal.begin({
        leaseKey, leaseGeneration, hostId, bootId,
        runBinding: { engineRunId: binding.engineRunId, providerId: binding.providerId,
          generationId: binding.generationId, mcpServerId: binding.mcpServerId },
      });
      if (!lease.acquired) {
        throw adapterError(lease.state === 'held' ? 'LEASE_HELD' : 'NEEDS_RECONCILE',
          `Provider lease not acquired: ${lease.state}`);
      }
      // Host-built env over the capability socket (P0.1a); PATH-only when the
      // host has no policy for this provider. Never the adapter's own env.
      const hostEnv = typeof broker?.providerEnv === 'function' ? await broker.providerEnv(binding.providerId) : null;
      const env = { ...envAllowlist, ...(hostEnv || {}) };
      runtime = new ProviderRuntime({
        journal, leaseKey, leaseGeneration, hostId, bootId,
        resolveAsset: () => assetLoader({ binding, snapshot, source, executionRoot, envAllowlist: env, root }),
        shutdownGraceMs,
      });
      await runtime.start();
      return runtime;
    })();
    return started;
  }

  async function handleProvider({ action, arguments: args }) {
    const rt = await startProvider();
    return rt.call(action, args || {});
  }

  async function callTool(name, args) {
    if (closed) throw adapterError('PROVIDER_UNAVAILABLE', 'Adapter is closed');
    if (!catalog.some(t => t.name === name)) throw adapterError('ACTION_NOT_FOUND', `Unknown tool: ${name}`);
    const client = await connectBroker();
    return client.call(name, args || {});
  }

  async function close(reason = 'adapter_closed') {
    if (closed) return;
    closed = true;
    try { if (runtime) await runtime.stop({ reason }); } catch { /* ignore */ }
    try { if (broker) broker.close(); } catch { /* ignore */ }
    try { journal.finish({ leaseKey, leaseGeneration, reason }); } catch { /* ignore */ }
  }

  return { listTools: () => catalog.map(t => ({ ...t })), callTool, handleProvider, close,
    leaseKey, leaseGeneration, get pid() { return runtime?.pid ?? null; } };
}

// ── stdio MCP server (engine side) ─────────────────────────────────────────

function serveStdio(adapter, { input = process.stdin, output = process.stdout, onExit } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');
  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await adapter.close('engine_eof'); } catch { /* ignore */ }
    if (onExit) onExit();
  }

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    if (id === undefined || id === null) return;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05',
          capabilities: { tools: {} }, serverInfo: { name: 'trained-assist-adapter', version: '1.0.0' } } });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: adapter.listTools() } });
      } else if (method === 'tools/call') {
        const result = await adapter.callTool(params?.name, params?.arguments || {});
        const text = toolResultText(params?.name, result, { pretty: false });
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
  rl.on('close', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  return { close: shutdown };
}

async function main() {
  const argv = process.argv.slice(2);
  const bindingFile = argv[argv.indexOf('--binding-file') + 1];
  if (!bindingFile || argv.indexOf('--binding-file') < 0) {
    console.error('Usage: mcp-provider-adapter.js --binding-file <run-binding.json>');
    process.exit(2);
  }
  const { binding, snapshot, source } = loadBinding(bindingFile);
  const executionRoot = path.join(path.dirname(bindingFile), 'leases');
  const journal = new ProviderJournal({ root: executionRoot });
  const envAllowlist = { PATH: process.env.PATH || '' };
  const adapter = createAdapter({ binding, snapshot, source, journal, executionRoot,
    hostId: process.env.HOST_ID || null, assetLoader: realAssetLoader, envAllowlist });
  serveStdio(adapter);
}

if (require.main === module) {
  main().catch((e) => { console.error('adapter failed:', e.message); process.exit(1); });
}

module.exports = { createAdapter, loadBinding, buildCatalog, realAssetLoader, serveStdio };
