'use strict';

// Host-side source runtime (design §6/§7, PR2b). Owns the process-wide pieces
// the adapter processes need at engine launch:
//   - one active generation (compiled once from the approved config),
//   - one narrow ActionBroker (single execution owner),
//   - per-run SessionMcpPlan + materialized RunBindings + adapter descriptors.
//
// Inert by default: with no enabled sources in the approved config the runtime
// reports `enabled:false` and the runner wiring is a no-op, so production
// behaviour is unchanged until an admin activates a source.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compileSourceGeneration, planSessionMcp, materializeSessionMcp } = require('./mcp-skill-generation');
const { ActionBroker } = require('./mcp-action-broker');
const { ActionExecutions } = require('./action-executions');
const { loadProviderEnvPolicy, buildProviderEnv } = require('./mcp-provider-env');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'mcp-skill-sources.json');
const DEFAULT_RUNTIME_ROOT = path.join(process.env.AGENT_DATA_DIR || path.join(require('os').homedir(), 'agent-data'), 'mcp-runs');

function loadConfig(configPath) {
  const file = configPath || process.env.MCP_SKILL_SOURCES_CONFIG || DEFAULT_CONFIG_PATH;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { version: 1, sources: [], _error: e.message, _path: file }; }
  return { ...parsed, _path: file };
}

function hasEnabledSources(config) {
  return Array.isArray(config?.sources) && config.sources.some(s => s && s.enabled !== false);
}

// Merge managed adapter server descriptors into an engine MCP config object.
// Core/reserved names are never shadowed: an existing name is left untouched.
function mergeAdapterServers(mcpServers, adapterServers) {
  const merged = { ...(mcpServers || {}) };
  const skipped = [];
  for (const [id, descriptor] of Object.entries(adapterServers || {})) {
    if (merged[id]) { skipped.push(id); continue; }
    merged[id] = descriptor;
  }
  return { merged, skipped };
}

function createSourceRuntime(options = {}) {
  const config = options.config ?? loadConfig(options.configPath);
  const root = options.root ?? process.env.MCP_SKILLS_ROOT ?? path.resolve(__dirname, '..');
  const runtimeRoot = options.runtimeRoot ?? process.env.MCP_RUNS_ROOT ?? DEFAULT_RUNTIME_ROOT;
  const coreCatalog = options.coreCatalog ?? { providers: [], servers: [] };

  const enabled = options.generation
    ? true
    : hasEnabledSources(config) && !config._error;

  if (!enabled) {
    return {
      enabled: false, generation: null, config,
      async prepareRun() { return null; },
      async close() {},
    };
  }

  const generation = options.generation
    || compileSourceGeneration(config, coreCatalog, { root, runtimeRoot });
  const envPolicy = options.envPolicy ?? loadProviderEnvPolicy();
  const hostEnv = options.hostEnv ?? process.env;
  const executions = options.executions || new ActionExecutions();
  const broker = new ActionBroker({ executions, now: options.now });
  const socketPath = options.socketPath || path.join(runtimeRoot, 'broker.sock');
  let listening = null;
  const runs = new Map();

  async function ensureBroker() {
    if (!listening) {
      fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      listening = await broker.listen(socketPath);
    }
    return listening;
  }

  // Materialize one engine run: returns adapter server descriptors to add to
  // the engine MCP config, or null when this run has no external servers.
  async function prepareRun({ hostRunBinding, runtimeDir, coreServers = [] } = {}) {
    if (!hostRunBinding || typeof hostRunBinding !== 'object') throw new TypeError('hostRunBinding required');
    if (typeof runtimeDir !== 'string' || !runtimeDir) throw new TypeError('runtimeDir required');
    await ensureBroker();
    const capability = 'cap-' + crypto.randomBytes(24).toString('hex');
    const binding = { ...hostRunBinding, brokerEndpoint: socketPath, brokerCapability: capability };
    const plan = planSessionMcp(generation, binding, coreServers);
    if (!plan.servers.some(s => s.kind === 'external')) return null;

    const materialized = materializeSessionMcp(plan, runtimeDir);
    const providerEnvs = {};
    for (const s of plan.servers) {
      if (s.kind === 'external') providerEnvs[s.providerId] = buildProviderEnv({ policy: envPolicy, providerId: s.providerId, profileId: plan.hostBinding.profileId, hostEnv });
    }
    broker.registerCapability(capability, { generation, runBinding: binding, providerEnvs });
    runs.set(runtimeDir, { capability, materialized });

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      broker.revokeCapability(capability, 'run_released');
      try { materialized.release(); } catch { /* best effort */ }
      runs.delete(runtimeDir);
    };
    return { plan, servers: { ...materialized.descriptors }, release, capability, runtimeDir };
  }

  async function close() {
    for (const run of runs.values()) {
      broker.revokeCapability(run.capability, 'runtime_closed');
      try { run.materialized.release(); } catch { /* best effort */ }
    }
    runs.clear();
    await broker.close();
  }

  return { enabled: true, generation, config, prepareRun, close, broker, socketPath };
}

// Process-wide singleton (PR2b): runner/index.js and hermes-tools-run.js both
// need to prepareRun() against the SAME generation/broker for the life of the
// process — re-creating createSourceRuntime() per call would recompile the
// generation and spin up a new broker socket on every task. Lazy: the config
// (and therefore the enabled/disabled decision) is only read on first use.
let defaultRuntime = null;
function getDefaultSourceRuntime() {
  if (!defaultRuntime) defaultRuntime = createSourceRuntime();
  return defaultRuntime;
}

module.exports = {
  createSourceRuntime, getDefaultSourceRuntime,
  loadConfig, hasEnabledSources, mergeAdapterServers,
  DEFAULT_CONFIG_PATH, DEFAULT_RUNTIME_ROOT,
};
