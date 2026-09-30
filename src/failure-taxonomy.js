'use strict';
// Shared vocabulary for the unified execution-failure recovery subsystem (issue #1175).
// Single source of truth so failure-classifier.js, recovery-policy.js and execution-history.js
// can't drift into inconsistent class/state names the way auth-flag.js (2 classes, all engines)
// and opencode-ladder.js (3 classes, OpenCode-only) did before this — see the audit at
// https://instant-publish.trainedassist.store/p/recovery-lifecycle-audit-sep23.

const FAILURE_CLASSES = [
  'AUTH', 'QUOTA', 'RATE_LIMIT', 'CONTEXT', 'TRANSIENT',
  'MODEL_ERROR', 'TOOL_ERROR', 'CONFIG', 'USER_STOP', 'UNKNOWN',
  // #1911: the engine was killed by a declared budget (execution_timeout_seconds /
  // inactivity / hard cap). Its own recovery — backoff, not «the answer was bad»:
  // before this class the kill surfaced as UNKNOWN and burned quality attempts.
  'TIMEOUT',
];

const EXECUTION_STATES = [
  'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'BLOCKED', 'CANCELLED',
];

function isFailureClass(cls) {
  return FAILURE_CLASSES.includes(cls);
}

function isExecutionState(state) {
  return EXECUTION_STATES.includes(state);
}

module.exports = { FAILURE_CLASSES, EXECUTION_STATES, isFailureClass, isExecutionState };
