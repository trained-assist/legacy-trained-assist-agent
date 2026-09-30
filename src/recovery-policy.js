'use strict';
// Recovery Policy — issue #1175. Deliberately separate from failure-classifier.js: the
// classifier answers "what happened", this module answers "what to do about it". An LLM never
// chooses a recovery action directly — only ever a failure class from the fixed enum in
// failure-taxonomy.js, which is then looked up here against a static table a human wrote.
//
// Actions are opaque strings; this module does not perform them. The runner integration (a
// separate, follow-up change — see issue #1175 checklist) maps each action onto a concrete step
// against the model ladder (now the llm-ladder worker, #1687), retry-policy.js backoff, and the
// engine-fallback-to-opencode path already in runner/index.js.

const { FAILURE_CLASSES } = require('./failure-taxonomy');

// Ordered action pipeline per failure class. Index = how many recovery steps already spent on
// this execution's current failure streak. Source: spec "Execution Failure Classification &
// Event-Based Recovery", section 4.
const POLICY = {
  RATE_LIMIT: ['backoff_retry_same', 'next_provider'],
  TRANSIENT: ['retry_same', 'fallback'],
  MODEL_ERROR: ['retry_same', 'next_model'],
  QUOTA: ['next_model_or_provider', 'free_fallback'],
  AUTH: ['alternate_provider', 'terminal'],
  CONTEXT: ['compact_or_larger_context_model', 'retry_same'],
  TOOL_ERROR: ['tool_specific_retry', 'execution_retry'],
  CONFIG: ['alternate_target', 'terminal'],
  USER_STOP: ['terminal'],
  // #1911: killed by the step's own budget. Backoff first (a step that needs more
  // time usually needs less scope, the retry sees the failure reasons), then one
  // rung up; never the quality ladder's doctor jump — a timeout is not a bad answer.
  TIMEOUT: ['backoff_retry_same', 'next_model'],
  UNKNOWN: ['conservative_retry', 'fallback', 'terminal'],
};

// Bounds total recovery steps per execution so no failure class — including a misclassified one
// that keeps landing on the same rung — can retry forever (spec section 5).
const DEFAULT_RECOVERY_BUDGET = 5;

function actionsFor(failureClass) {
  if (!FAILURE_CLASSES.includes(failureClass)) return POLICY.UNKNOWN;
  return POLICY[failureClass] || POLICY.UNKNOWN;
}

// Picks the next recovery action for a failure, given how many recovery steps this execution has
// already spent on its current failure streak. USER_STOP always terminates regardless of budget
// — spec section 3/9: "never retry". Returns null when the budget is exhausted or the class's own
// action list is used up ('terminal' reached); the caller should treat null as a terminal FAILED
// outcome for this execution (subject to GTD picking it up later, per spec section 7).
function nextAction(failureClass, { spent = 0, budget = DEFAULT_RECOVERY_BUDGET } = {}) {
  if (failureClass === 'USER_STOP') return null;
  if (spent >= budget) return null;
  const actions = actionsFor(failureClass);
  if (spent >= actions.length) return null; // this class's own action list is used up → terminal
  const action = actions[spent];
  return action === 'terminal' ? null : action;
}

module.exports = { POLICY, DEFAULT_RECOVERY_BUDGET, actionsFor, nextAction };
