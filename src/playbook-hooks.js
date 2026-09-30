'use strict';

// Playbook hooks (issue #1372, slice P4): the closed hook dictionary, its
// compile-time validation, boundary rendering and execution.
//
// A hook is declared on a boundary of a playbook (stage.on_enter/on_exit,
// step.on_complete/on_fail, task_done/task_failed) and is executed by the
// durable executor (src/gtd-controller.js) exactly once per boundary. The
// dictionary is CLOSED — a hook `type` outside it is a compile-time error, never
// a silently ignored no-op.
//
// Effect + approval policy (docs/architecture/action-cron-contract-v1.md):
// `notify` / `create_issue` / `publish` have external side effects and require
// explicit consent; `check` is read-only. A hook that needs consent but has none
// is recorded as `skipped` and never fails the task. Execution is delegated to
// injected sinks — this module never reimplements a transport (bot delivery,
// GitHub issue creation, publishing) and never invents new orchestration.

const { playbookError, _internal } = require('./playbook-store');

const { substitute } = _internal;

// The closed dictionary declared in contracts/playbook.schema.json#/$defs/hook.
const HOOK_TYPES = Object.freeze(['notify', 'check', 'create_issue', 'publish']);

// Hooks with an external side effect. Sending a message, opening an issue or
// publishing a page are all observable outside the plan, so they need consent.
const EXTERNAL_EFFECT_TYPES = Object.freeze(['notify', 'create_issue', 'publish']);

const TASK_HOOK_EVENTS = Object.freeze(['task_done', 'task_failed']);
const ITEM_HOOK_EVENTS = Object.freeze(['on_complete', 'on_fail', 'stage_enter', 'stage_exit']);

const HOOK_STATUSES = Object.freeze(['fired', 'skipped', 'failed']);

function validateHook(hook, where = 'hook') {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    throw playbookError('COMPILE_INVALID', `${where}: hook must be an object`);
  }
  if (!HOOK_TYPES.includes(hook.type)) {
    throw playbookError('COMPILE_INVALID',
      `${where}: unknown hook type ${JSON.stringify(hook.type)} (allowed: ${HOOK_TYPES.join(', ')})`);
  }
  if (hook.to != null && typeof hook.to !== 'string') {
    throw playbookError('COMPILE_INVALID', `${where}.to must be a string`);
  }
  if (hook.text != null && typeof hook.text !== 'string') {
    throw playbookError('COMPILE_INVALID', `${where}.text must be a string`);
  }
  return hook;
}

// Validate a hook map ({event: hookList}). `events` narrows the allowed events
// (task hooks vs item hooks) so a misplaced event is rejected too.
function validateHooks(hooks, { where = 'hooks', events = null } = {}) {
  if (hooks == null) return;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw playbookError('COMPILE_INVALID', `${where}: hooks must be an object`);
  }
  for (const [event, list] of Object.entries(hooks)) {
    if (events && !events.includes(event)) {
      throw playbookError('COMPILE_INVALID', `${where}: unknown hook event ${JSON.stringify(event)}`);
    }
    if (list == null) continue;
    if (!Array.isArray(list)) {
      throw playbookError('COMPILE_INVALID', `${where}.${event}: hook list must be an array`);
    }
    list.forEach((hook, i) => validateHook(hook, `${where}.${event}[${i}]`));
  }
}

// Parse a persisted hooks_json column into a safe map. Malformed JSON degrades to
// "no hooks" rather than crashing a tick — a broken artifact row must not wedge
// the executor (the compiler is the only writer and validates, so this is depth).
function parseHooks(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Replace {goal}/{stage}/{error}/... placeholders in a hook's text. Unknown
// placeholders are left verbatim (same rule as the rest of playbook rendering).
function renderHook(hook, vars = {}) {
  if (!hook) return hook;
  const out = { ...hook };
  if (typeof hook.text === 'string') out.text = substitute(hook.text, vars);
  if (typeof hook.to === 'string') out.to = substitute(hook.to, vars);
  return out;
}

function needsApproval(hook) {
  return EXTERNAL_EFFECT_TYPES.includes(hook && hook.type);
}

// Stable identity of one boundary firing. Used as the fire-once key: the same
// (task, item, event, index) is handled exactly once, whether it fired or was
// skipped, so a tick replay never re-delivers a notification.
function hookBoundaryKey({ taskId, itemId = null, event, index }) {
  return `${taskId}\u0000${itemId || ''}\u0000${event}\u0000${index}`;
}

// Resolve consent for external-effect hooks. Explicit boolean/function wins;
// otherwise the plan's own run policy may opt in (`hooks_approved`).
//
// #1909: a profile with the standing bg-notify preference ON has already said
// «пиши мне о фоновой работе» — that opt-in is the consent for `notify` hooks
// (the audit found 52/63 notify hooks skipped with «no explicit consent»: nobody
// ever passed approve_hooks, so plan failures/questions never reached anyone).
// create_issue / publish are NOT covered by it — a message in one's own chat is
// one thing, opening an issue or publishing a page is another; those still need
// the explicit approve_hooks.
function resolveHookApproval(task, approveHooks = null) {
  if (typeof approveHooks === 'function') return approveHooks;
  if (typeof approveHooks === 'boolean') return () => approveHooks;
  let policy = {};
  try { policy = task && task.execution_policy_json ? JSON.parse(task.execution_policy_json) : {}; } catch { policy = {}; }
  const approved = policy && (policy.hooks_approved === true || policy.approve_hooks === true);
  if (approved === true) return () => true;
  const profileId = task && task.profile_id;
  if (!profileId) return () => false;
  let notifyOptIn = false;
  try { notifyOptIn = require('./bg-notify').isBgNotifyEnabled(profileId); } catch { /* unreadable flag → no consent */ }
  return (hook) => !!(notifyOptIn && hook && hook.type === 'notify');
}

// Execute every hook for one boundary. Never throws: an unavailable transport or
// a failing sink is recorded and surfaced, but must not fail the durable task
// (a notification is not part of the work's acceptance criteria).
//
// sinks: { notify?, check?, create_issue?, publish? } — each an async
// ({hook, text, task, item, event}) => any. A missing sink is recorded skipped.
async function executeHooks({
  store, task, item = null, event, hooks, vars = {}, approved = false, sinks = {},
}) {
  const list = Array.isArray(hooks) ? hooks : [];
  const isApproved = typeof approved === 'function' ? approved : () => approved === true;
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') continue;
    const key = hookBoundaryKey({ taskId: task.id, itemId: item && item.id, event, index: i });
    if (store.hasHookRun(key)) { results.push({ type: raw.type, status: 'already-handled' }); continue; }

    const hook = renderHook(raw, vars);
    const record = (status, detail = null) => store.recordHookExecution({
      task_id: task.id, task_item_id: (item && item.id) || null, event, hook_index: i,
      hook_type: raw.type, status, detail, boundary_key: key,
    });

    if (needsApproval(raw) && !isApproved(raw, task)) {
      record('skipped', `no explicit consent for ${raw.type}`);
      results.push({ type: raw.type, status: 'skipped', reason: 'no-approval' });
      continue;
    }
    const sink = sinks[raw.type];
    if (typeof sink !== 'function') {
      record('skipped', `no ${raw.type} transport configured`);
      results.push({ type: raw.type, status: 'skipped', reason: 'no-transport' });
      continue;
    }
    try {
      await sink({ hook, text: hook.text, task, item, event });
      record('fired');
      results.push({ type: raw.type, status: 'fired' });
    } catch (error) {
      record('failed', String((error && error.message) || error).slice(0, 300));
      results.push({ type: raw.type, status: 'failed', reason: error && error.message });
    }
  }
  return results;
}

module.exports = {
  HOOK_TYPES, EXTERNAL_EFFECT_TYPES, TASK_HOOK_EVENTS, ITEM_HOOK_EVENTS, HOOK_STATUSES,
  validateHook, validateHooks, parseHooks, renderHook, needsApproval,
  hookBoundaryKey, resolveHookApproval, executeHooks,
};
