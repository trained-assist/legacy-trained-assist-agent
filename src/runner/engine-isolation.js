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

const RUN_AS_UNSUPPORTED_ENGINES = new Set(['codex']);

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

// Files the service wrote for the engine (system prompt, MCP config, opencode config)
// may carry mode 0600 — that mode is the ACL mask, so the slot could not read them.
// Rewriting a file keeps its old mode, hence an explicit chmod before every run.
function shareEngineInputs(workDir, candidates) {
  if (process.env.GCS_WORKSPACE_SYNC) return; // GCS objects have no mode bits (#1735 step 5)
  const root = path.resolve(workDir) + path.sep;
  for (const c of candidates) {
    if (typeof c !== 'string' || !path.isAbsolute(c) || !path.resolve(c).startsWith(root)) continue;
    try {
      const st = fs.statSync(c);
      if (st.isFile() && (st.mode & 0o060) !== 0o060) fs.chmodSync(c, (st.mode & 0o777) | 0o060);
    } catch { /* not ours / gone — the engine will report it */ }
  }
}

// opencode authenticates `opencode-go` from its STORED credential
// (.agent-home/…/opencode/auth.json, staged from the service home) and gives it
// precedence over OPENCODE_API_KEY — verified on prod 2026-10-01: a valid env key plus a
// garbage auth.json fails with 401. So the per-run key goApiKey() draws would never reach
// the engine while the staged file carried another key: rewrite the staged copy with THIS
// run's key. Same file → same mode and ACL; only the bytes change. A missing file is left
// alone (the engine then falls back to the env var, which is the drawn key) and so is an
// empty key (a stored credential beats no credential at all).
// Exported for tests — the run-as path that produces a staged file needs slot machinery.
function syncOpencodeGoAuth({ home, key }) {
  if (!home || !key) return false;
  const authPath = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) return false;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    auth['opencode-go'] = { type: 'api', key };
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n');
    return true;
  } catch (e) {
    console.warn(`[isolation] cannot sync opencode auth.json: ${e.message}`);
    return false;
  }
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
async function prepareEngineSpawn({ engine, taskId, user, cwd, engineEnv, engineArgs = [], userTokens, bridgedServers, mcpConfig, config = iso.isolationConfig() }) {
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
    // Two reasons to skip run-as:
    // 1. Engineering worktrees (cwd outside the profile) share git objects with mirrors
    //    under the data dir that a slot cannot reach.
    // 2. Codex chmods files in its own home; in a shared profile home those files may
    //    belong to another slot → EPERM.  Both keep the env allowlist + bridge.
    const wd = path.resolve(user.workDir);
    const cwdInProfile = !cwd || path.resolve(cwd) === wd || path.resolve(cwd).startsWith(wd + path.sep);
    const engineBlocked = RUN_AS_UNSUPPORTED_ENGINES.has(engine);
    const runAs = config.runAs && cwdInProfile && !engineBlocked;
    if (config.runAs && !runAs) {
      const reason = !cwdInProfile ? `cwd outside the profile (${cwd})` : `engine ${engine} not supported`;
      console.log(`[isolation] ${taskId}: ${reason} — allowlist only, no run-as`);
    }
    if (runAs) isoRun = await iso.prepareIsolatedRun(config, { workDir: user.workDir, cwd, engine, reach: [socket] });
    if (isoRun) shareEngineInputs(user.workDir, [...(engineArgs || []), engineEnv.OPENCODE_CONFIG]);
    // opencode reads its staged auth.json INSTEAD of OPENCODE_API_KEY (see syncOpencodeGoAuth):
    // without this the drawn per-run key would be shadowed by whatever the service home held.
    if (engine === 'opencode' && isoRun) {
      syncOpencodeGoAuth({ home: iso.engineHomeDir(user.workDir), key: engineEnv.OPENCODE_API_KEY });
    }
    const configFiles = engine === 'opencode'
      ? [path.join(config.serviceHome || os.homedir(), '.config', 'opencode', 'opencode.json'), engineEnv.OPENCODE_CONFIG].filter(Boolean)
      : [];
    const env = iso.buildAgentEnv(engineEnv, {
      userTokenNames: Object.keys(userTokens || {}),
      engineCredentialNames: iso.engineCredentialNames(engine, { configFiles }),
      extra: { AGENT_RUN_TOKEN: runToken, AGENT_MCP_BRIDGE_SOCKET: socket, ...(isoRun ? isoRun.env : {}) },
    });
    // The final env goes along: names sudo cannot carry through the environment
    // (TMPDIR, #1791) are turned into argv assignments by sudoArgv.
    const wrap = isoRun ? (bin, args) => isoRun.spawnArgv(bin, args, env) : (bin, args) => [bin, args];
    return { env, wrap, release, isolated: true, runAs: isoRun ? isoRun.slot : null };
  } catch (e) {
    release();
    throw e;
  }
}

module.exports = { prepareEngineSpawn, bridgeDir, shareEngineInputs, syncOpencodeGoAuth };
