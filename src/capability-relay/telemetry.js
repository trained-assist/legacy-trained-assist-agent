'use strict';
// One structured line per invoke on stderr (issue #2061 §5, R12).
//
// Correlation fields only: toolId, contract version, profile/run/task/operation ids,
// latency, outcome, typed code. NEVER the arguments, never the response body, never
// the token — a relay log is readable by anyone with journal access.

const FIELDS = Object.freeze([
  'ts', 'toolId', 'contractVersion', 'profileId', 'runId', 'taskId', 'operationId',
  'latencyMs', 'outcome', 'code', 'outcomeUnknown',
]);

function noop() {}

/** Scalar, bounded, single-line. Anything else (objects, arrays) is dropped, not stringified. */
function field(value, max = 120) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function eventOf(event) {
  const out = {};
  for (const key of FIELDS) {
    if (key === 'latencyMs' || key === 'outcomeUnknown') {
      if (event[key] !== undefined && event[key] !== null) out[key] = event[key];
      continue;
    }
    const value = field(event[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The exact line shape written to stderr. */
function formatEvent(event) {
  const ts = event.ts || new Date().toISOString();
  return `capability-relay ${JSON.stringify({ ts: field(ts, 40), ...eventOf(event) })}`;
}

function stderrLogger(stream = process.stderr) {
  return function log(event) {
    try { stream.write(`${formatEvent(event)}\n`); } catch { /* telemetry must never break a call */ }
  };
}

/** Relay calls the emitter itself, so a broken consumer can't fail the invoke. */
function safeEmitter(onEvent) {
  if (typeof onEvent !== 'function') return noop;
  return function emit(event) {
    try { onEvent(event); } catch { /* telemetry must never break a call */ }
  };
}

module.exports = { FIELDS, formatEvent, stderrLogger, safeEmitter, noop };