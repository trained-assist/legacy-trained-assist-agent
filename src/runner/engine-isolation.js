'use strict';

// Glue between runEngineProcess and the T0 isolation pieces (issue #1649):
// run token + MCP bridge + env allowlist + run-as slot. With both switches off
// (the default) it returns the spawn inputs unchanged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const iso = require('../agent-isolation');
const { issueRunToken, revokeRunToken } = require('../agent-run-tokens');
const bridge = require('../agent-mcp-bridge');
const { SYSTEM_ROOT } = require('../data-paths');

function bridgeDir() {
  return process.env.AGENT_MCP_BRIDGE_DIR || path.join(SYSTEM_ROOT, 'agent-bridge');
}

// Fallback for a caller that wrote a plain .mcp.json: take the real specs from
// it and replace the file with the bridged one before the engine starts.
function serversFromConfigFile(mcpConfig) {
  if (!mcpConfig) return {};
  try {
    const real = JSON.parse(fs.readFileSync(mcpConfig, 'utf8'));
    const servers = real.mcpServers || {};
    const alreadyBridged = Object.values(servers).every(s => (s.args || []).includes(bridge.CLIENT_PATH));
    if (alreadyBridged) return {};
    console.warn(`[isolation] ${mcpConfig}: caller did not bridge MCP servers — bridging now`);
    fs.writeFileSync(mcpConfig, JSON.stringify(bridge.bridgedMcpConfig(real), null, 2));
    return servers;
  } catch { return {}; }
}

/**
 * @param {object} p
 * @param {string} p.engine
 * @param {string} p.taskId
 * @param {{username:string, workDir:string}} p.user
 * @param {string} p.cwd            engine cwd
 * @param {object} p.engineEnv      the full env the engine would get without isolation
 * @param {object} [p.userTokens]   this profile's token env (names are allowlisted)
 * @param {object|null} [p.bridgedServers]  real MCP specs from writeRunMcpConfig
 * @param {string} [p.mcpConfig]
 * @returns {Promise<{env:object, wrap:(bin:string,args:string[])=>[string,string[]], release:()=>void, isolated:boolean, runAs:string|null}>}
 */
async function prepareEngineSpawn({ engine, taskId, user, cwd, engineEnv, userTokens, bridgedServers, mcpConfig, config = iso.isolationConfig() }) {
  if (!config.envAllowlist) {
    return { env: engineEnv, wrap: (bin, args) => [bin, args], release() {}, isolated: false, runAs: null };
  }

  const runToken = issueRunToken({ taskId, username: user.username });
  let isoRun = null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    bridge.unregisterRun(runToken);
    revokeRunToken(runToken);
    if (isoRun) isoRun.release();
  };

  try {
    const socket = await bridge.ensureBridge(bridgeDir());
    // MCP servers keep the full service-side env, exactly as without isolation.
    bridge.registerRun(runToken, {
      servers: bridgedServers || serversFromConfigFile(mcpConfig),
      env: { ...engineEnv, AGENT_RUN_TOKEN: runToken },
      cwd,
    });
    if (config.runAs) isoRun = await iso.prepareIsolatedRun(config, { workDir: user.workDir, cwd, engine, reach: [socket] });
    const configFiles = engine === 'opencode'
      ? [path.join(config.serviceHome || os.homedir(), '.config', 'opencode', 'opencode.json'), engineEnv.OPENCODE_CONFIG].filter(Boolean)
      : [];
    const env = iso.buildAgentEnv(engineEnv, {
      userTokenNames: Object.keys(userTokens || {}),
      engineCredentialNames: iso.engineCredentialNames(engine, { configFiles }),
      extra: { AGENT_RUN_TOKEN: runToken, AGENT_MCP_BRIDGE_SOCKET: socket, ...(isoRun ? isoRun.env : {}) },
    });
    const wrap = isoRun ? (bin, args) => isoRun.spawnArgv(bin, args) : (bin, args) => [bin, args];
    return { env, wrap, release, isolated: true, runAs: isoRun ? isoRun.slot : null };
  } catch (e) {
    release();
    throw e;
  }
}

module.exports = { prepareEngineSpawn, bridgeDir };
