'use strict';
// The relay's OWN minimal env (issue #2061 §5, R3).
//
// The relay is a separate stdio process, so what it receives is its whole world:
// it must not inherit the service env. `buildMcpToolEnv` is deliberately NOT used —
// that env carries CF_API_TOKEN, provider keys and bot tokens, and the relay needs
// exactly one credential of its own.

/** The only variables the relay may ever see. Anything else is dropped. */
const RELAY_ENV_ALLOW = Object.freeze([
  'CAPABILITY_RELAY_ENDPOINT',        // base URL of the default (envelope) capability API
  'CAPABILITY_RELAY_TOKEN',           // caller credential for THAT api only
  'CAPABILITY_RELAY_CONTRACT_VERSION', // optional pin; mismatch → version_mismatch
  'CAPABILITY_RELAY_TIMEOUT_MS',      // optional default deadline
  'CAPABILITY_RELAY_COMMUNICATION',   // feature toggle of the communication capability (default-off, #2034)
  'COMMUNICATION_API_URL',            // endpoint of the communication Worker (#2061 PR2)
  'COMMUNICATION_TOKEN',              // caller credential for that Worker only
  'USER_ID',                          // correlation, never a principal
  'AGENT_RUN_ID',                     // correlation
]);

/** Secrets that must never reach the relay. Asserted by the mount test, not just by comment. */
const FORBIDDEN_ENV_PATTERNS = Object.freeze([
  /^CF_API_TOKEN$/, /^CLOUDFLARE_API_TOKEN$/, /^CF_ACCOUNT_ID$/, /^CLOUDFLARE_ACCOUNT_ID$/,
  /^OPENROUTER_API_KEY$/, /^OPENCODE_/, /^ANTHROPIC/, /^TELEGRAM_/, /^LLM_LADDER/,
  /^HH_/, /^AGENT_SECRET$/, /^CRED_ENCRYPTION_KEY$/, /^ZERO_CREDS/, /^SERVICE_/, /^DEEPGRAM/,
]);

/** Relay env out of a full environment: allowlist in, everything else out. */
function relayEnvFrom(env = process.env) {
  const out = {};
  for (const key of RELAY_ENV_ALLOW) {
    if (env[key] !== undefined && env[key] !== null && String(env[key]) !== '') out[key] = String(env[key]);
  }
  return out;
}

/** Feature flag: no endpoint in the service env → the relay is not mounted at all. */
function relayConfigured(env = process.env) {
  return Boolean(env && env.CAPABILITY_RELAY_ENDPOINT);
}

/** A toggle counts as ON unless it is explicitly falsy ('0', 'off', 'false'). */
function truthy(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'off' && v !== 'false' && v !== 'no';
}

/**
 * Is this contract tool ready to serve (issue #2034, честная готовность)?
 *
 * A tool with an `invoke` binding (the communication capability) is ready only when
 * its toggle is ON and both its endpoint and credential env vars are set — the
 * definition of `isReady()` behind `tools/list` and the prompt-domain probe.
 * A tool on the default door keeps PR1 semantics: endpoint + token in the service env.
 *
 * @param {object} tool  a contract tool entry
 * @param {object} [env] defaults to process.env (the relay child gets only the allowlist)
 */
function toolReady(tool, env = process.env) {
  const binding = tool && tool.invoke;
  if (!binding) return Boolean(env && env.CAPABILITY_RELAY_ENDPOINT && env.CAPABILITY_RELAY_TOKEN);
  if (!truthy(env && env[binding.toggle_env])) return false;
  return Boolean(env && env[binding.endpoint_env] && env[binding.token_env]);
}

function leaksForbidden(env) {
  return Object.keys(env).filter(k => FORBIDDEN_ENV_PATTERNS.some(re => re.test(k)));
}

module.exports = {
  RELAY_ENV_ALLOW, FORBIDDEN_ENV_PATTERNS,
  relayEnvFrom, relayConfigured, toolReady, truthy, leaksForbidden,
};
