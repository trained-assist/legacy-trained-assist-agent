'use strict';

// Provider env policy (design mcp-skill-source-runtime-wiring §7.1, epic #1470 P0.1a).
// An external provider child never inherits the host/adapter env. The host
// builds its env from scratch: PATH + identity derived from the RunBinding
// profileId (never from model args) + only the keys the deploy-owned policy
// (config/mcp-provider-env.json) lists for that provider. The env reaches the
// adapter over the capability-scoped broker socket, so secrets never land in
// engine MCP config, run-binding files, tool arguments or diagnostics.

const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_PATH = path.resolve(__dirname, '..', 'config', 'mcp-provider-env.json');
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
// Loader/credential hooks a policy may never forward (design §7.1).
const DENY = /^(PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|GIT_[A-Z0-9_]+|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN)$/;
const PROFILE = /^[A-Za-z0-9_-]{1,200}$/;
const GROUPS = ['identity', 'hostPaths', 'passthrough'];
const err = (m) => Object.assign(new Error(m), { code: 'INVALID_ARGUMENTS' });

function validatePolicy(policy) {
  if (!policy || policy.version !== 1 || !policy.providers || typeof policy.providers !== 'object' || Array.isArray(policy.providers)) {
    throw err('Invalid provider env policy');
  }
  for (const [providerId, entry] of Object.entries(policy.providers)) {
    if (!entry || typeof entry !== 'object') throw err(`Invalid env policy for ${providerId}`);
    const seen = new Set();
    for (const g of Object.keys(entry)) if (!GROUPS.includes(g)) throw err(`Unknown env policy group ${providerId}.${g}`);
    for (const g of GROUPS) {
      const keys = entry[g] ?? [];
      if (!Array.isArray(keys)) throw err(`${providerId}.${g} must be an array`);
      for (const k of keys) {
        if (typeof k !== 'string' || !KEY.test(k)) throw err(`Invalid env key ${providerId}.${g}: ${k}`);
        if (DENY.test(k)) throw err(`Env key not allowed for providers: ${k}`);
        if (seen.has(k)) throw err(`Duplicate env key ${providerId}: ${k}`);
        seen.add(k);
      }
    }
  }
  return policy;
}

function loadProviderEnvPolicy(file = process.env.MCP_PROVIDER_ENV_POLICY || DEFAULT_POLICY_PATH) {
  if (!fs.existsSync(file)) return { version: 1, providers: {} };
  return validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Unknown provider → PATH only (installation is not authorization).
function buildProviderEnv({ policy, providerId, profileId, hostEnv = process.env }) {
  if (typeof profileId !== 'string' || !PROFILE.test(profileId)) throw err('Invalid profileId for provider env');
  const env = { PATH: hostEnv.PATH || '' };
  const entry = policy?.providers?.[providerId];
  if (!entry) return env;
  for (const k of entry.identity || []) env[k] = profileId;
  for (const k of [...(entry.hostPaths || []), ...(entry.passthrough || [])]) {
    if (typeof hostEnv[k] === 'string' && hostEnv[k] !== '') env[k] = hostEnv[k];
  }
  return env;
}

module.exports = { loadProviderEnvPolicy, buildProviderEnv, validatePolicy, DEFAULT_POLICY_PATH };
