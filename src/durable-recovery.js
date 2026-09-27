'use strict';
// P3c — recovery-policy integration in the durable executor (issue #1457).
//
// recovery-policy.js answers "what to do" for a failure class; failure-classifier.js
// answers "what happened". This module is the missing third piece the policy's own
// header (recovery-policy.js:7-10) named as the follow-up: it maps a policy action
// onto a concrete move against a durable task item, using ONLY mechanisms that
// already exist —
//   • re-pend + tier escalation          → retryFailedItem (here)
//   • the OpenCode model ladder          → opencode-ladder.forceAdvance
//   • the per-step engine/level resolver → playbook-executor.resolveStepExecution
//     (bumping current_model_level walks bachelor→master→doctor and, at doctor,
//      crosses to the Claude engine — that IS the existing engine-fallback path)
//
// Everything is bounded twice: the item's own max_attempts (via retryFailedItem)
// and DEFAULT_RECOVERY_BUDGET through nextAction(). A class whose action list is
// used up, or a spent budget, yields a terminal outcome — the item stays failed.
// The classifier is injectable so tests stay deterministic and offline.

const { classifyDeterministic } = require('./failure-classifier');
const { nextAction, DEFAULT_RECOVERY_BUDGET } = require('./recovery-policy');
const { getRetryDelayMs } = require('./retry-policy');
const { resolveStepExecution } = require('./playbook-executor');

// Which policy action re-pends the same target (the pre-P3c path).
const RETRY_ACTIONS = new Set(['retry_same', 'conservative_retry', 'execution_retry', 'tool_specific_retry']);
// Which action walks the model ladder one rung (and the engine at the top).
const MODEL_ACTIONS = new Set(['next_model', 'next_model_or_provider', 'compact_or_larger_context_model']);
// Which action switches provider/engine rather than model.
const PROVIDER_ACTIONS = new Set(['next_provider', 'alternate_provider', 'fallback', 'free_fallback']);

// A failed item retries until its declared `max_attempts` are spent (P3a: the
// per-step budget the compiler writes into the item). Tier escalation still
// happens on each retry (legacy durable tasks); once attempts are exhausted the
// item stays 'failed' — never re-pended forever. `itemId` is re-read fresh
// because startExecution already bumped attempt_count. `escalate` is false for
// engine/env crashes: a crash is not an item-quality signal, so it retries at
// the same tier until the attempt budget is spent.
function retryFailedItem(store, itemId, profileId, { retryDelayMs = 0, escalate = true } = {}) {
  const item = store.getTaskItem(itemId);
  if (!item) return { retried: false, attempts: 0, maxAttempts: 0 };
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 1;
  if (attempts >= maxAttempts) return { retried: false, attempts, maxAttempts };
  if (escalate) store.escalateItem(itemId, profileId); // legacy tier ladder; also sets pending
  store.updateTaskItem(itemId, { status: 'pending', due_at: Date.now() + retryDelayMs }, profileId);
  return { retried: true, attempts, maxAttempts };
}

function _step(item, task) {
  return task && task.acceptance_criteria_json
    ? resolveStepExecution(item)
    : { engine: 'claude', ocProfile: null, ocRole: null };
}

// Advance one rung of the OpenCode ladder for the role the step actually uses.
// Mirrors runner/index.js forceOpencodeAlternation: forceAdvance() the model
// currently filling that role. Lazy require so tests inject a fake and never
// touch the real ladder-state file.
function _advanceRung(item, task, ladder) {
  const step = _step(item, task);
  if (step.engine !== 'opencode' || !step.ocProfile) return null;
  const lib = ladder || require('./opencode-ladder');
  try {
    const overrides = lib.buildOcProfileOverrides(step.ocProfile);
    const role = step.ocRole || 'build';
    const model = overrides && overrides.agent && overrides.agent[role] && overrides.agent[role].model;
    if (!model) return null;
    lib.forceAdvance(step.ocProfile, role, model);
    return `${step.ocProfile}/${model}`;
  } catch (e) {
    console.warn('[durable-recovery] advanceRung:', e.message);
    return null;
  }
}

// Provider switch for a step = advancing a rung: every OpenCode profile (deepseek included,
// whose ladder ends on OpenRouter) carries a per-role ladder. Claude is the strongest tier — no
// alternative provider exists (SESSION-CRASH-RETRY-SPEC.md §2.4), so it just re-pends.
function _switchProvider(item, task, ladder) {
  return _advanceRung(item, task, ladder);
}

/**
 * Recover a failed durable step. Classifies `errorText`, asks the policy for the
 * next action given how many recovery moves this item has already spent, and
 * applies it. Returns the decision for callers to log/record.
 *
 * @param {object}   o
 * @param {object}   o.store
 * @param {object}   o.task        durable_tasks row (needs profile_id)
 * @param {string}   o.itemId
 * @param {string}   [o.errorText]
 * @param {Function} [o.classifier]   sync/async (text, opts) → {class}
 * @param {number}   [o.budget]       recovery-step budget (default DEFAULT_RECOVERY_BUDGET)
 * @param {object}   [o.ladder]       injectable opencode-ladder (tests)
 * @param {boolean}  [o.escalate=true]
 * @param {number}   [o.retryDelayMs=0]
 * @returns {Promise<{recovered:boolean,failureClass:string,action:string|null,
 *                    attempts:number,maxAttempts:number,reason:string}>}
 */
async function recoverDurableItem({
  store, task, itemId, errorText = '',
  classifier = classifyDeterministic, budget = DEFAULT_RECOVERY_BUDGET,
  ladder = null, escalate = true, retryDelayMs = 0,
} = {}) {
  const profileId = task.profile_id;
  const item = store.getTaskItem(itemId) || { id: itemId, attempt_count: 0, max_attempts: 1 };
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 1;

  let failureClass = 'UNKNOWN';
  try {
    const verdict = await classifier(errorText, {});
    if (verdict && verdict.class) failureClass = verdict.class;
  } catch (e) {
    console.warn('[durable-recovery] classifier:', e.message);
  }

  // How many recovery moves already applied to this item's failure streak. Each
  // execution is one attempt; the first failure is spent=0 → actions[0].
  const spent = Math.max(0, attempts - 1);
  const action = nextAction(failureClass, { spent, budget });

  const terminal = (reason) => {
    store.updateTaskItem(itemId, {
      last_failure_class: failureClass, last_recovery_action: 'terminal',
    }, profileId);
    return { recovered: false, failureClass, action: null, attempts, maxAttempts, reason };
  };

  // Bound: the item's own attempt budget AND the recovery budget. nextAction()
  // already returns null past `budget`, at 'terminal', or when the class's own
  // action list is used up.
  if (attempts >= maxAttempts) return terminal('attempts-exhausted');
  if (action == null) return terminal('terminal');

  let move = action;
  let delayMs = retryDelayMs;

  if (MODEL_ACTIONS.has(action)) {
    store.bumpModelLevel(itemId, profileId);
    const advanced = _advanceRung(item, task, ladder);
    if (advanced) move = `${action}:${advanced}`;
  } else if (PROVIDER_ACTIONS.has(action)) {
    const switched = _switchProvider(item, task, ladder);
    if (switched) move = `${action}:${switched}`;
  } else if (action === 'backoff_retry_same') {
    const d = getRetryDelayMs(spent + 1);
    if (d == null) return terminal('backoff-exhausted');
    delayMs = d;
  }
  // RETRY_ACTIONS (and any action this executor doesn't recognize) fall through
  // to a plain re-pend — the safest bounded move.

  const r = retryFailedItem(store, itemId, profileId, { retryDelayMs: delayMs, escalate });
  if (!r.retried) return terminal('attempts-exhausted');
  store.updateTaskItem(itemId, {
    last_failure_class: failureClass, last_recovery_action: move,
  }, profileId);
  return { recovered: true, failureClass, action: move, attempts: r.attempts, maxAttempts: r.maxAttempts, reason: 'repended' };
}

module.exports = {
  recoverDurableItem, retryFailedItem,
  RETRY_ACTIONS, MODEL_ACTIONS, PROVIDER_ACTIONS,
};
