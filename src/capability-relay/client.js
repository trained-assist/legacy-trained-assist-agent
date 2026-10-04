'use strict';
// HTTP adapter to the capability API (issue #2061 PR1).
//
// Thin by construction: build the URL from the contract, POST once, return the body
// untouched, map failures onto the typed codes. No retries (retryBudget = 0 — §5 of the
// issue), no payload interpretation, no business logic: whatever the canonical handler
// returns is what the engine gets, so an MCP call and a direct REST call agree.

const { RelayError, ERROR_CODES, statusToCode, safeReason } = require('./errors.js');
const { loadContract, invokeUrl, checkResponseVersion } = require('./contract.js');
const { safeEmitter } = require('./telemetry.js');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
/** The only auth-context keys the relay forwards; `identity` stays opaque and unlogged. */
const AUTH_CONTEXT_KEYS = Object.freeze(['identity', 'profileId', 'runId', 'taskId', 'operationId']);

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(n));
}

function pickAuthContext(authContext) {
  const out = {};
  if (!authContext || typeof authContext !== 'object') return out;
  for (const key of AUTH_CONTEXT_KEYS) {
    const value = authContext[key];
    if (typeof value === 'string' && value) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * @param {object} o
 * @param {Function} o.fetchImpl   injected — the only reason this module is testable
 * @param {string} o.endpoint      base URL of the capability API
 * @param {string} o.token         caller credential for that API only
 * @param {number} [o.timeoutMs]
 * @param {object} [o.contract]    override (tests); production reads the deployed file
 * @param {Function} [o.onEvent]   telemetry sink, one event per call
 * @param {Function} [o.now]
 */
function createRelayClient({
  fetchImpl, endpoint, token, timeoutMs = DEFAULT_TIMEOUT_MS,
  contract = loadContract(), onEvent, now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new RelayError('misconfigured', { message: 'relay client requires a fetchImpl' });
  }
  if (!endpoint || typeof endpoint !== 'string') {
    throw new RelayError('misconfigured', { message: 'CAPABILITY_RELAY_ENDPOINT is not set' });
  }
  if (!token || typeof token !== 'string') {
    throw new RelayError('misconfigured', { message: 'CAPABILITY_RELAY_TOKEN is not set' });
  }
  const emit = safeEmitter(onEvent);
  const defaultTimeout = clampTimeout(timeoutMs);

  return {
    contractVersion: contract.version,
    contract,
    endpoint,
    invoke,
  };

  /**
   * @param {object} call
   * @param {string} call.toolId       canonical capability id (contract.tools[].toolId)
   * @param {object} [call.arguments]
   * @param {object} [call.authContext]
   * @param {number} [call.timeoutMs]  per-call deadline, capped
   * @returns {Promise<object>} the API response body, unchanged
   */
  async function invoke({ toolId, arguments: args = {}, authContext, timeoutMs: callTimeoutMs } = {}) {
    if (!toolId || typeof toolId !== 'string') {
      throw new RelayError('invalid_arguments', { message: 'toolId is required' });
    }
    const tool = contract.tools.find(t => t.toolId === toolId);
    if (!tool) {
      throw new RelayError('not_found', {
        message: `capability ${toolId} is not in contract version ${contract.version}`,
        contractVersion: contract.version,
      });
    }

    const deadlineMs = clampTimeout(callTimeoutMs || defaultTimeout);
    // Two doors, one client (#2061 §2): the default envelope endpoint from the
    // contract, or the per-capability `invoke` binding when the handler serves a
    // path of its own (the communication Worker). Transport mapping only.
    const binding = tool.invoke || null;
    const base = String(endpoint).replace(/\/+$/, '');
    const url = binding ? `${base}${binding.path}` : invokeUrl(contract, toolId, endpoint);
    const context = pickAuthContext(authContext);
    const headers = {
      'Content-Type': 'application/json',
      'X-Relay-Contract-Version': String(contract.version),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (context.runId) headers['X-Relay-Run-Id'] = String(context.runId);
    if (binding) {
      // The bound door takes raw arguments, so correlation rides headers instead of
      // the body — same rule: forwarded, never inspected or logged.
      if (context.profileId) headers['X-Relay-Profile-Id'] = String(context.profileId);
      if (context.taskId) headers['X-Relay-Task-Id'] = String(context.taskId);
      if (context.operationId) headers['X-Relay-Operation-Id'] = String(context.operationId);
    }
    const body = binding && binding.body === 'arguments'
      ? JSON.stringify(args)
      : JSON.stringify({ contractVersion: contract.version, arguments: args, authContext: context });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const started = now();
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted || (e && e.name === 'AbortError');
      const code = aborted ? 'timeout' : 'upstream_unavailable';
      const latencyMs = Math.max(0, now() - started);
      emit(baseEvent({ tool, contract, context, latencyMs, outcome: 'error', code, outcomeUnknown: aborted ? true : tool.mutates }));
      throw new RelayError(code, {
        message: aborted ? `capability ${toolId} exceeded the ${deadlineMs}ms deadline` : `capability ${toolId} transport failure`,
        safeReason: aborted ? `deadline_exceeded: ${deadlineMs}ms` : `transport_failure: ${(e && (e.code || e.name)) || 'unknown'}`,
        // A deadline on a mutating call leaves the outcome unknown: the handler may
        // have finished. No automatic retry — the caller decides.
        outcomeUnknown: aborted ? true : tool.mutates,
        contractVersion: contract.version,
      });
    }
    clearTimeout(timer);
    const latencyMs = Math.max(0, now() - started);

    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body handled below */ }

    if (res && res.ok) {
      if (binding) {
        // The bound handler pins its OWN contract version (e.g. Worker's 'v1') in a
        // header of its choosing — string equality, no numeric coercion: 'v1' is not 1.
        const reported = (res.headers && typeof res.headers.get === 'function' ? res.headers.get(binding.version_header) : null)
          ?? (json && json.contractVersion !== undefined ? String(json.contractVersion) : null);
        if (reported === null || String(reported) !== binding.contract_version) {
          const e = new RelayError('version_mismatch', {
            message: `capability ${toolId} handler reports contract version ${reported === null ? 'none' : reported}, relay is pinned to ${binding.contract_version}`,
            safeReason: `handler_version_mismatch: ${reported === null ? 'none' : reported} != ${binding.contract_version}`,
            contractVersion: contract.version,
            detail: { source: binding.version_header },
          });
          emit(baseEvent({ tool, contract, context, latencyMs, outcome: 'error', code: e.code, outcomeUnknown: false }));
          throw e;
        }
      } else {
        const reported = (json && json.contractVersion !== undefined)
          ? json.contractVersion
          : (res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-relay-contract-version') : null);
        try {
          checkResponseVersion(contract.version, reported, { contract });
        } catch (e) {
          emit(baseEvent({ tool, contract, context, latencyMs, outcome: 'error', code: e.code, outcomeUnknown: false }));
          throw e;
        }
      }
      emit(baseEvent({ tool, contract, context, latencyMs, outcome: 'ok', code: null, outcomeUnknown: false }));
      // SR-03: the body is the result — not a re-typed copy of it.
      return json;
    }

    const envelope = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
    const code = envelope && Object.prototype.hasOwnProperty.call(ERROR_CODES, envelope.code)
      ? envelope.code
      : statusToCode(res && res.status);
    const outcomeUnknown = code === 'timeout' ? true : (code === 'upstream_unavailable' ? Boolean(tool.mutates) : false);
    emit(baseEvent({ tool, contract, context, latencyMs, outcome: 'error', code, outcomeUnknown }));
    throw new RelayError(code, {
      message: `capability ${toolId} failed: HTTP ${res && res.status}`,
      safeReason: safeReason(json, res && res.status),
      outcomeUnknown,
      contractVersion: contract.version,
      detail: { status: res && res.status ? Number(res.status) : null },
    });
  }
}

function baseEvent({ tool, contract, context, latencyMs, outcome, code, outcomeUnknown }) {
  return {
    toolId: tool.toolId,
    contractVersion: contract.version,
    profileId: context.profileId,
    runId: context.runId,
    taskId: context.taskId,
    operationId: context.operationId,
    latencyMs,
    outcome,
    code,
    outcomeUnknown,
  };
}

module.exports = { createRelayClient, AUTH_CONTEXT_KEYS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };