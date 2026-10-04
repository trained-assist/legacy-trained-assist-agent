'use strict';
// Typed errors of the capability relay (issue #2061 PR1).
//
// One enum → one fixed JSON-RPC code. The relay never invents codes at a call site:
// every failure a caller can see is one of these eight, and `error.data` always
// carries the same shape, so the engine can branch on `data.code` instead of
// matching message text.

/** Typed code → JSON-RPC error code. Fixed in the contract; never reused for another meaning. */
const ERROR_CODES = Object.freeze({
  misconfigured: -32010,
  unauthorized: -32011,
  not_found: -32012,
  invalid_arguments: -32013,
  conflict: -32014,
  version_mismatch: -32015,
  upstream_unavailable: -32016,
  timeout: -32017,
});

const CODE_LIST = Object.freeze(Object.keys(ERROR_CODES));

const STATUS_CODES = Object.freeze({
  400: 'invalid_arguments',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'not_found',
  408: 'timeout',
  409: 'conflict',
  422: 'invalid_arguments',
  504: 'timeout',
});

/** HTTP status → typed code. 5xx and everything unmapped are upstream_unavailable. */
function statusToCode(status) {
  const mapped = STATUS_CODES[Number(status)];
  if (mapped) return mapped;
  if (Number(status) >= 500) return 'upstream_unavailable';
  return 'upstream_unavailable';
}

/** The only fields of an upstream error envelope we are allowed to surface. */
function safeReason(json, status) {
  const envelope = (json && typeof json === 'object')
    ? (json.error && typeof json.error === 'object' ? json.error
      : Array.isArray(json.errors) && json.errors[0] ? json.errors[0]
        : json)
    : null;
  const code = envelope && typeof envelope.code === 'string' ? envelope.code : '';
  const message = envelope && typeof envelope.message === 'string' ? envelope.message : '';
  const text = [code, message].filter(Boolean).join(': ').replace(/\s+/g, ' ').trim();
  const base = text || `HTTP ${status == null ? 'error' : status}`;
  return base.length > 200 ? `${base.slice(0, 197)}...` : base;
}

class RelayError extends Error {
  /**
   * @param {string} code   one of ERROR_CODES
   * @param {object} [opts]
   * @param {string} [opts.safeReason]      allowlisted upstream reason (no payload, no secrets)
   * @param {boolean}[opts.outcomeUnknown]  true when a deadline may hide a completed mutation
   * @param {number} [opts.contractVersion]
   * @param {object} [opts.detail]          extra safe fields (contractVersion etc.)
   */
  constructor(code, opts = {}) {
    const safe = CODE_LIST.includes(code) ? code : 'upstream_unavailable';
    super(safeReason({ message: opts.message }, 0));
    this.name = 'RelayError';
    this.code = safe;
    this.rpcCode = ERROR_CODES[safe];
    this.safeReasonValue = opts.safeReason || safeReason({ message: opts.message }, 0);
    // Alias: callers read `e.safeReason`, the writer is `safeReasonValue` so this
    // property never shadows the module function of the same name inside errors.js.
    Object.defineProperty(this, 'safeReason', { get: () => this.safeReasonValue, enumerable: true });
    this.outcomeUnknown = Boolean(opts.outcomeUnknown);
    this.contractVersion = opts.contractVersion ?? null;
    this.detail = opts.detail && typeof opts.detail === 'object' ? opts.detail : null;
    // The relay never retries (retryBudget = 0, issue #2061 §5): a caller that wants a
    // second attempt must decide so itself, knowing whether the outcome is unknown.
    this.retryable = false;
  }

  /** Uniform `error.data` for every typed failure. */
  toData() {
    return {
      code: this.code,
      safeReason: this.safeReasonValue,
      contractVersion: this.contractVersion,
      outcomeUnknown: this.outcomeUnknown,
      retryable: this.retryable,
      ...(this.detail || {}),
    };
  }
}

function isRelayError(e) {
  return e instanceof RelayError;
}

module.exports = { RelayError, ERROR_CODES, CODE_LIST, statusToCode, safeReason, isRelayError };