'use strict';

// Playbook e2e core — shared by the /internal/e2e/* API (handlers/internal.js) and the
// scripts/e2e/playbooks-e2e.js driver. Starts a plan from a playbook with a per-plan
// level map, reports it step by step, and lets a driver act where a human normally
// would: answer a step that waits for the user, poll this plan's waits right now.
// Everything here is profile-scoped and goes through the same store/compiler as
// playbook_run — no e2e-only execution path.

const { durableStore } = require('./gtd-controller');
const { PlaybookStore } = require('./playbook-store');
const { compilePlaybook } = require('./playbook-compiler');
const { planLevelMap, resolveStepExecution } = require('./playbook-executor');

const DEFAULT_LEVEL_MAP = Object.freeze({
  doctor: { engine: 'opencode', ocProfile: 'service' },
  master: { engine: 'opencode', ocProfile: 'free' },
  bachelor: { engine: 'opencode', ocProfile: 'free' },
});
const E2E_PREAMBLE = 'Это автоматический e2e-тест процесса. Пользователь недоступен: НЕ спрашивай его и НЕ уходи в awaiting_user — '
  + 'принимай разумные допущения и записывай их в итог шага. ';
const PROFILE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function e2eError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkProfile(profile) {
  if (!PROFILE_RE.test(String(profile || ''))) throw e2eError(400, 'invalid profile');
}

function findTask(store, taskId, profile) {
  checkProfile(profile);
  const id = String(taskId || '');
  const task = store.getTask(id, profile)
    || (/^[0-9a-f-]{6,}$/.test(id)
      ? store.db.prepare('SELECT * FROM durable_tasks WHERE profile_id = ? AND id LIKE ?').get(profile, `${id}%`)
      : null);
  if (!task) throw e2eError(404, `plan ${id} not found for profile ${profile}`);
  return task;
}

function startPlan({ profile, playbookId, goal, vars = null, levelMap = null, preamble = true, store = durableStore() }) {
  checkProfile(profile);
  if (!playbookId || !goal) throw e2eError(400, 'playbook_id and goal are required');
  const map = levelMap && typeof levelMap === 'object' ? levelMap : DEFAULT_LEVEL_MAP;
  const playbook = new PlaybookStore({ profileId: profile }).get(playbookId);
  if (!playbook) throw e2eError(404, `playbook ${playbookId} not found`);
  const compiled = compilePlaybook(playbook, { goal: (preamble ? E2E_PREAMBLE : '') + goal, vars: vars || {} });
  const { task, items } = store.createPlan({
    profile_id: profile, goal: compiled.goal, user_value: compiled.user_value,
    acceptance_criteria: compiled.acceptance_criteria, items: compiled.items, hooks: compiled.hooks,
    playbook_id: playbook.id, playbook_version: playbook.version,
    execution_policy: { level_map: map, e2e: true },
  });
  store.updateTask(task.id, profile, { status: 'active' });
  const resolved = planLevelMap({ level_map: map });
  return {
    plan: { id: task.id, playbook: `${playbook.id}@${playbook.version}`, profile },
    routing: items.map(it => {
      // Same routing the executor uses for a plan with its own level map: the role map
      // (researcher → Gemini research profile) does not apply — e2e runs every step on
      // the plan's engines (free models on the test).
      const r = resolveStepExecution(it, { levelMap: resolved, useRoleMap: false });
      return { n: it.position + 1, title: it.title, route: r.executionKind === 'programmatic'
        ? 'programmatic' : `${r.engine}/${r.ocProfile || '-'} (${r.modelLevel}, ${r.ocRole || '-'})` };
    }),
  };
}

// The step's own «ИТОГ ШАГА» block (what later steps see), from its recorded reply.
function stepSummary(evidenceJson) {
  if (!evidenceJson) return null;
  let text = evidenceJson;
  try { const ev = JSON.parse(evidenceJson); text = ev.reply || JSON.stringify(ev); } catch { /* raw */ }
  const i = text.lastIndexOf('ИТОГ ШАГА');
  return (i >= 0 ? text.slice(i) : text).replace(/DURABLE:[^\n]*/g, '').trim().slice(0, 600) || null;
}

function collectSteps(store, task) {
  const items = store.listTaskItems(task.id, task.profile_id);
  const execs = store.db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at').all(task.id);
  const byItem = new Map();
  for (const e of execs) {
    if (!byItem.has(e.task_item_id)) byItem.set(e.task_item_id, []);
    byItem.get(e.task_item_id).push(e);
  }
  return items.map(it => {
    const ex = byItem.get(it.id) || [];
    const engines = [...new Set(ex.map(e => `${e.engine || '?'}/${e.profile || '-'}${e.model_level ? `@${e.model_level}` : ''}${e.provider ? ` (${e.provider})` : ''}`))];
    const first = ex[0]; const last = ex[ex.length - 1];
    let wait = null;
    try { wait = it.wait_json ? JSON.parse(it.wait_json) : null; } catch { /* ignore */ }
    return {
      id: it.id, n: it.position + 1, stage: it.stage, title: it.title, status: it.status, kind: it.execution_kind,
      level: it.minimum_model_level, current_level: it.current_model_level, attempts: it.attempt_count,
      executions: ex.length, engines,
      duration_ms: first ? ((last.finished_at || Date.now()) - first.started_at) : null,
      last_error: it.last_error || (last && last.error_text) || null,
      failure_class: it.last_failure_class || null, recovery: it.last_recovery_action || null,
      wait: wait ? {
        awaiting_user: wait.awaiting_user === true, until: wait.until || null, reason: wait.reason || null,
        deadline_at: wait.deadline_at || null, last_poll: wait.last_poll || null,
      } : null,
      summary: stepSummary(it.evidence_json),
    };
  });
}

function planReport(taskId, profile, { store = durableStore() } = {}) {
  const task = findTask(store, taskId, profile);
  const steps = collectSteps(store, task);
  const counts = steps.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  return {
    plan: { id: task.id, playbook: task.playbook_id, status: task.status, created_at: task.created_at },
    counts, current: steps.find(r => !['done', 'skipped'].includes(r.status)) || null, steps,
  };
}

// e2e acceleration: this plan's parked steps poll on the next tick instead of after
// poll_every_sec. Their wait condition is still evaluated for real.
function accelerateWaits(taskId, profile, { store = durableStore() } = {}) {
  const task = findTask(store, taskId, profile);
  return store.db.prepare(`UPDATE task_items SET due_at = ? WHERE task_id = ? AND status = 'waiting'`)
    .run(Date.now(), task.id).changes;
}

// Answer a step that waits for the user — same effect as task_item_wake from chat.
function wakeStep(itemId, profile, message, { store = durableStore(), by = 'e2e' } = {}) {
  checkProfile(profile);
  const out = store.wakeItem(String(itemId || ''), profile, { message, by });
  if (out && out.error) throw e2eError(409, out.error);
  return out;
}

function listPlans(profile, { store = durableStore() } = {}) {
  checkProfile(profile);
  return store.listTasks(profile).map(t => ({
    id: t.id, playbook: t.playbook_id, status: t.status, created_at: t.created_at,
    goal: String(t.goal).replace(E2E_PREAMBLE, '').slice(0, 120),
  }));
}

function cancelPlan(taskId, profile, { store = durableStore() } = {}) {
  const task = findTask(store, taskId, profile);
  store.updateTask(task.id, profile, { status: 'cancelled' });
  return { id: task.id, status: 'cancelled' };
}

module.exports = {
  DEFAULT_LEVEL_MAP, E2E_PREAMBLE,
  startPlan, planReport, collectSteps, stepSummary, accelerateWaits, wakeStep, listPlans, cancelPlan, findTask,
};
