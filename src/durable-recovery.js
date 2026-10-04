'use strict';
// P3c — recovery-policy integration in the durable executor (issue #1457).
//
// recovery-policy.js answers "what to do" for a failure class; failure-classifier.js
// answers "what happened". This module is the missing third piece the policy's own
// header (recovery-policy.js:7-10) named as the follow-up: it maps a policy action
// onto a concrete move against a durable task item, using ONLY mechanisms that
// already exist —
//   • re-pend + tier escalation          → retryFailedItem (here)
//   • the OpenCode model ladder          → the llm-ladder worker (#1687) — rung
//     failover happens there, so a provider/model action here is a plain re-pend
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
const { resolveStepExecution, planLevelMap, nextDistinctLevel, LEVELS } = require('./playbook-executor');

// Failure classes that mean "the model did not manage the task" (as opposed to the
// provider/credentials/infra failing): only these drive quality escalation.
const QUALITY_CLASSES = new Set(['UNKNOWN', 'TOOL_ERROR']);
const HARD_ENGINE_CLASSES = new Set(['AUTH', 'CONFIG']);
const QUALITY_MAX_ATTEMPTS = 3;

// #122: how many provider-silence / judge-`uncertain` retries a step may spend
// WITHOUT consuming its attempt budget. Bounded on purpose — «no attempt spent»
// must never mean «retry forever» (a permanently broken provider still ends
// terminal, just after this many free retries instead of burning max_attempts).
const INFRA_MAX_RETRIES = 5;

// R3: the engine's own hard wall-clock cap (claude-runner.js CLAUDE_TIMEOUT_MS).
// A step budget can never buy more than this, so escalation stops here.
const ENGINE_HARD_CAP_SEC = 40 * 60;

/**
 * R3 — a hard timeout is a STEP signal (the work did not fit the budget), not a model
 * failure. But re-running it with the SAME budget just kills it again — that is what the
 * 2026-10-01 incident burned three retries on. So the retry gets twice the time, capped
 * at the engine's hard cap: attempt 1 runs the declared budget honestly, attempt 2 gets
 * 2×, attempt 3 gets 4× (or the cap). The attempt itself is still spent — this only makes
 * the next attempt meaningfully different.
 */
function escalateStepBudget(store, itemId, profileId, item) {
  const current = Number(item && item.execution_timeout_seconds) || 0;
  if (current <= 0) return null; // no declared budget (legacy item) — nothing to grow
  const next = Math.min(ENGINE_HARD_CAP_SEC, current * 2);
  if (next === current) return current;
  const updated = store.updateTaskItem(itemId, { execution_timeout_seconds: next }, profileId);
  return (updated && updated.execution_timeout_seconds) || next;
}

// Which policy action re-pends the same target (the pre-P3c path).
const RETRY_ACTIONS = new Set(['retry_same', 'conservative_retry', 'execution_retry', 'tool_specific_retry']);
// Which action bumps the step's model level (bachelor→master→doctor; the engine at the top).
const MODEL_ACTIONS = new Set(['next_model', 'next_model_or_provider', 'compact_or_larger_context_model']);

// A failed item retries until its declared `max_attempts` are spent (P3a: the
// per-step budget the compiler writes into the item). Tier escalation still
// happens on each retry (legacy durable tasks); once attempts are exhausted the
// item stays 'failed' — never re-pended forever. `itemId` is re-read fresh
// because startExecution already bumped attempt_count. `escalate` is false for
// engine/env crashes: a crash is not an item-quality signal, so it retries at
// the same tier until the attempt budget is spent.
function retryFailedItem(store, itemId, profileId, { retryDelayMs = 0, escalate = true, refundAttempt = false } = {}) {
  const item = store.getTaskItem(itemId);
  if (!item) return { retried: false, attempts: 0, maxAttempts: 0 };
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 1;
  // #122: an infra refund does not check the attempt budget — the whole point is
  // that the attempt is given back; the bound lives in recoverDurableItem's
  // infra-retries budget.
  if (refundAttempt) {
    const r = store.refundItemAttempt(itemId, profileId, { dueAt: Date.now() + retryDelayMs });
    return { retried: !!r, attempts: r ? (r.attempt_count || 0) : attempts, maxAttempts };
  }
  if (attempts >= maxAttempts) return { retried: false, attempts, maxAttempts };
  if (escalate) store.escalateItem(itemId, profileId); // legacy tier ladder; also sets pending
  store.updateTaskItem(itemId, { status: 'pending', due_at: Date.now() + retryDelayMs }, profileId);
  return { retried: true, attempts, maxAttempts };
}

function _policy(task) {
  try { return task && task.execution_policy_json ? JSON.parse(task.execution_policy_json) : null; }
  catch { return null; }
}

function _planMap(task) {
  return planLevelMap(_policy(task));
}

// Resolve through the PLAN's level map — the step's engine/fallbacks as the executor sees them.
function _step(item, task) {
  return task && task.acceptance_criteria_json
    // same routing as the executor: a plan with its own level map ignores the role map
    ? resolveStepExecution(item, { levelMap: _planMap(task), useRoleMap: !(_policy(task) || {}).level_map })
    : resolveStepExecution(item);
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
 * @param {boolean}  [o.escalate=true]           legacy TIER ladder (free→standard→strong)
 * @param {boolean}  [o.escalateLevel=true]      quality path may bump current_model_level
 *                                               (#1907: false = retry at the SAME level only)
 * @param {number}   [o.retryDelayMs=0]
 * @returns {Promise<{recovered:boolean,failureClass:string,action:string|null,
 *                    attempts:number,maxAttempts:number,reason:string}>}
 */
async function recoverDurableItem({
  store, task, itemId, errorText = '',
  classifier = classifyDeterministic, budget = DEFAULT_RECOVERY_BUDGET,
  escalate = true, retryDelayMs = 0, quality = false, escalateLevel = true,
  // #122: provider silence (class INFRA) and the marker judge's `uncertain` are not
  // the step's fault — refund the attempt and spend the bounded infra budget instead.
  refundAttempt = false,
} = {}) {
  const profileId = task.profile_id;
  const item = store.getTaskItem(itemId) || { id: itemId, attempt_count: 0, max_attempts: 1 };
  const attempts = item.attempt_count || 0;
  const maxAttempts = item.max_attempts || 1;

  let failureClass = 'UNKNOWN';
  try {
    // runDueDurable forwards its own `classifier = null` default: null must mean the
    // deterministic classifier, not "throw and fall back to UNKNOWN" (which silently
    // disabled the whole class → action table for every prod durable failure).
    const verdict = await (classifier || classifyDeterministic)(errorText, {});
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

  // #122 — infra refund, checked BEFORE the attempt-budget terminal: provider
  // silence (class INFRA) or an explicit refund (marker judge `uncertain`) does
  // not consume the step's attempt budget. It is bounded by the item's own
  // `infra_retries` instead (INFRA_MAX_RETRIES), so a permanently broken provider
  // still ends terminal — just after free retries, not after burning max_attempts.
  if (failureClass === 'INFRA' || refundAttempt) {
    const infraRetries = item.infra_retries || 0;
    if (infraRetries >= INFRA_MAX_RETRIES) return terminal('infra-retries-exhausted');
    const r = retryFailedItem(store, itemId, profileId, { retryDelayMs, escalate: false, refundAttempt: true });
    if (!r.retried) return terminal('infra-refund-failed');
    store.updateTaskItem(itemId, {
      last_failure_class: failureClass, last_recovery_action: 'infra_retry',
    }, profileId);
    return { recovered: true, failureClass, action: 'infra_retry', attempts: r.attempts, maxAttempts: r.maxAttempts, reason: 'refunded' };
  }

  // Bound: the item's own attempt budget AND the recovery budget. nextAction()
  // already returns null past `budget`, at 'terminal', or when the class's own
  // action list is used up.
  if (attempts >= maxAttempts) return terminal('attempts-exhausted');

  // Quality failure (the model did not manage the task: DURABLE failed / no marker):
  // attempt 1 and 2 run at the step's level (2 with the failure reasons in its input),
  // attempt 3 runs one distinct level up. Provider/infra failures keep the class policy.
  // escalateLevel=false (#1907, uncertain verdict of the marker judge): retry at the SAME
  // level only — a protocol/uncertainty miss must never burn a doctor run.
  if (quality && QUALITY_CLASSES.has(failureClass) && task && task.acceptance_criteria_json) {
    // Three attempts, whatever max_attempts says: the same level twice, then one up.
    if (attempts >= QUALITY_MAX_ATTEMPTS) return terminal('quality-attempts-exhausted');
    let move = 'retry_same_with_reasons';
    if (attempts >= 2 && escalateLevel) {
      const next = nextDistinctLevel(item, _planMap(task), { allowPaid: (_policy(task) || {}).quality_escalation_to_doctor !== false });
      if (next) {
        store.updateTaskItem(itemId, { current_model_level: next }, profileId);
        move = `escalate:${item.current_model_level || item.minimum_model_level}→${next}`;
      }
    }
    const r = retryFailedItem(store, itemId, profileId, { retryDelayMs, escalate: false });
    if (!r.retried) return terminal('attempts-exhausted');
    store.updateTaskItem(itemId, { last_failure_class: failureClass, last_recovery_action: move }, profileId);
    return { recovered: true, failureClass, action: move, attempts: r.attempts, maxAttempts: r.maxAttempts, reason: 'repended' };
  }
  // Credentials/config failure on an engine that still has fallback rungs
  // (doctor: claude → codex → opencode master): re-pend; the executor skips the
  // engine this step already failed on and runs the next rung.
  if (HARD_ENGINE_CLASSES.has(failureClass)) {
    const step = _step(item, task);
    if (Array.isArray(step.fallbacks) && step.fallbacks.length) {
      const r = retryFailedItem(store, itemId, profileId, { retryDelayMs, escalate: false });
      if (!r.retried) return terminal('attempts-exhausted');
      store.updateTaskItem(itemId, { last_failure_class: failureClass, last_recovery_action: 'fallback_rung' }, profileId);
      return { recovered: true, failureClass, action: 'fallback_rung', attempts: r.attempts, maxAttempts: r.maxAttempts, reason: 'repended' };
    }
  }
  if (action == null) return terminal('terminal');

  let move = action;
  let delayMs = retryDelayMs;

  // R3: a hard timeout retry gets a BIGGER budget, so it is not the same run again
  // (the declared budget is honoured on attempt 1 — gtd-controller.js). The attempt
  // itself is still spent: this only changes what the next attempt is allowed to take.
  let budgetSec = null;
  if (failureClass === 'TIMEOUT') {
    budgetSec = escalateStepBudget(store, itemId, profileId, item);
    if (budgetSec) console.log(`[durable-recovery] timeout retry ${itemId.slice(0, 8)}: budget → ${budgetSec}s`);
  }

  if (MODEL_ACTIONS.has(action)) {
    // One rung up, but never an automatic jump onto Claude/Codex (#1899): a level that
    // resolves to a paid engine stays out of reach unless the plan declared it as minimum.
    const i = LEVELS.indexOf(item.current_model_level);
    const up = i >= 0 && i < LEVELS.length - 1
      ? resolveStepExecution({ ...item, current_model_level: LEVELS[i + 1] }, { levelMap: _planMap(task), useRoleMap: false })
      : null;
    if (up && up.engine === 'opencode') store.bumpModelLevel(itemId, profileId);
  } else if (action === 'backoff_retry_same') {
    const d = getRetryDelayMs(spent + 1);
    if (d == null) return terminal('backoff-exhausted');
    delayMs = d;
  }
  // RETRY_ACTIONS, provider actions (switching the OpenCode rung/provider is the llm-ladder
  // worker's job, #1687) and any unrecognized action fall through to a plain re-pend — the
  // safest bounded move.

  const r = retryFailedItem(store, itemId, profileId, { retryDelayMs: delayMs, escalate });
  if (!r.retried) return terminal('attempts-exhausted');
  store.updateTaskItem(itemId, {
    last_failure_class: failureClass, last_recovery_action: move,
  }, profileId);
  return { recovered: true, failureClass, action: move, attempts: r.attempts, maxAttempts: r.maxAttempts, reason: 'repended', budgetSec };
}

module.exports = {
  recoverDurableItem, retryFailedItem,
  RETRY_ACTIONS, MODEL_ACTIONS, INFRA_MAX_RETRIES, ENGINE_HARD_CAP_SEC, escalateStepBudget,
};
