'use strict';

// MCP surface for DurableTaskStore (durable-task-orchestrator-v1). This is the
// read/write layer the GTD scheduler and web UI will eventually consume — see
// issue #1201. Deliberately does NOT touch runner.js/server.js/GTD scheduler
// wiring in this slice; the store already exists (src/durable-task-store.js,
// merged in #1200) and just needed a way to be called.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { itemSchema } = require('../../durable-task-plan');
const { userWorkDir, sessionFilePath } = require('../../data-paths');
const { getProject } = require('../../projects');
const { DurableTaskStore } = require('../../durable-task-store');
const { durableTaskDbPath } = require('../../data-paths');
const { VALIDATION_MODES } = require('../../playbook-validators');

let _store = null;
function store() {
  if (!_store) _store = new DurableTaskStore(durableTaskDbPath());
  return _store;
}

function requireProfile(ctx) {
  const profileId = ctx?.userId;
  if (!profileId) throw new Error('no profile_id on this session — cannot scope durable tasks');
  return String(profileId);
}

// Resolve references only beneath the authenticated profile. Never trust an
// incoming profile_id or a caller-supplied filesystem path.
function checkReferences(profileId, projectId, sessionId) {
  const safeId = value => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value);
  const root = userWorkDir(profileId);
  const ownedPath = file => {
    try { return fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep); } catch { return false; }
  };
  if (projectId && (!safeId(projectId) || !ownedPath(path.join(root, 'projects', projectId)) || !getProject(root, projectId))) {
    throw new Error('project not found in this profile');
  }
  if (sessionId && (!safeId(sessionId) || !ownedPath(sessionFilePath(profileId, sessionId)))) {
    throw new Error('session not found in this profile');
  }
}

// #1725: a plan created from a project-bound session belongs to that project. Without
// this, project_id stayed null and the plan's own session (s-plan-*) was bound by the
// runner's "active / most recent project" fallback — i.e. to whatever project the
// profile touched last, not the one the plan was started from. Explicit project_id
// still wins; no session / unbound session / vanished project → null as before.
function sessionProjectId(profileId, sessionId) {
  const sid = sessionId || process.env.AGENT_SESSION_ID || null;
  if (!sid || typeof sid !== 'string' || /[\\/\0]/.test(sid) || sid === '.' || sid === '..') return null;
  try {
    const sess = JSON.parse(fs.readFileSync(sessionFilePath(profileId, sid), 'utf8'));
    const pid = sess && typeof sess.projectId === 'string' ? sess.projectId : null;
    return pid && getProject(userWorkDir(profileId), pid) ? pid : null;
  } catch { return null; }
}

function withProjection(result, profileId) {
  if (!result.task.project_id || !result.task.acceptance_criteria_json) return result;
  try {
    checkReferences(profileId, result.task.project_id, null);
    result.projection = store().writeProjection(result.task.id, profileId,
      path.join(userWorkDir(profileId), 'projects', result.task.project_id));
  } catch (error) {
    // The committed DB is authoritative. A projection failure must not suggest
    // creation rolled back and encourage the caller to create a duplicate task.
    result.projection_warning = `Plan saved; projection unavailable: ${error.message}`;
  }
  return result;
}

module.exports = {
  _sessionProjectId: sessionProjectId,
  tools: {

    task_create: {
      description:
        'Create a new durable task (a goal tracked across sessions/restarts in SQLite; its checklist.md under ' +
        '.trained-assist/tasks/<id>/ is a generated projection of the plan — do not keep a separate root checklist.md ' +
        'for the same work). Supply user_value, acceptance_criteria and items to atomically persist a draft plan. Scoped to the caller\'s profile.',
      inputSchema: {
        type: 'object',
        required: ['goal'],
        properties: {
          goal: { type: 'string', description: 'What this task is trying to accomplish' },
          session_id: { type: 'string' },
          playbook_id: { type: 'string' }, playbook_version: { type: 'integer' },
          user_value: { type: 'string' },
          acceptance_criteria: { type: 'array', minItems: 1, items: { type: 'object' } },
          items: { type: 'array', minItems: 1, items: itemSchema },
          execution_policy: { type: 'object' }, request_id: { type: 'string' },
          hooks: {
            type: 'object',
            description: 'Resolved boundary hooks pinned to this plan: {task_done:[], task_failed:[]} ' +
              '(per-item hooks live on each item.hooks). External-effect hooks (notify/create_issue/publish) ' +
              'need consent via execution_policy.hooks_approved=true, otherwise they are logged as skipped.',
          },
          project_id: { type: 'string', description: 'Optional project id to associate' },
        },
      },
      handler: async ({ goal, project_id = null, ...plan }, ctx) => {
        const profileId = requireProfile(ctx);
        if (!project_id) project_id = sessionProjectId(profileId, plan.session_id);
        checkReferences(profileId, project_id, plan.session_id);
        const id = crypto.randomUUID();
        if (Object.keys(plan).length) {
          const result = store().createPlan({ ...plan, id, profile_id: profileId, project_id, goal });
          return withProjection(result, profileId);
        }
        const task = store().createTask({ id, profile_id: profileId, project_id, goal });
        return { task };
      },
    },

    task_item_add: {
      description:
        'Add a step to a durable task. For a CONTRACT plan (created by playbook_run/task_create with ' +
        'acceptance_criteria) this is a legal self-edit of the plan: pass the full step contract ' +
        '(execution_kind, executor_role, minimum_model_level, context_budget, validation, instructions) and ' +
        'after_item_id = the step that should precede it (usually your own Step id) — it then runs right after ' +
        'that step and routes by the plan level map like any compiled step. Legacy tasks: title + tier only.',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'title'],
        properties: {
          task_id: { type: 'string' },
          title: { type: 'string' },
          after_item_id: { type: 'string', description: 'Contract plan: insert right after this step (default: append)' },
          execution_kind: { type: 'string', enum: ['agent', 'programmatic'] },
          executor_role: { type: 'string', enum: ['researcher', 'developer', 'reviewer', 'verifier'] },
          minimum_model_level: { type: 'string', enum: ['bachelor', 'master', 'doctor'] },
          context_budget: { type: 'string', enum: ['small', 'medium', 'large'] },
          validation: { type: 'object', description: 'Contract plan: non-empty validation of the new step' },
          instructions: { type: 'string' },
          stage: { type: 'string' },
          position: { type: 'number', description: 'Legacy: order among siblings (default: append)' },
          execution_tier: { type: 'string', enum: ['free', 'standard', 'strong'] },
          delay_after_sec: { type: 'number', description: 'Delay before this item becomes runnable, in seconds' },
        },
      },
      handler: async ({ task_id, title, position, execution_tier, delay_after_sec, after_item_id, ...contract }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().getTask(task_id, profileId);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        if (task.acceptance_criteria_json) {
          try {
            const item = store().insertPlanItem(task_id, profileId, {
              afterItemId: after_item_id || null,
              item: {
                title, stage: contract.stage, instructions: contract.instructions,
                execution_kind: contract.execution_kind || 'agent', executor_role: contract.executor_role ?? null,
                minimum_model_level: contract.minimum_model_level ?? null, context_budget: contract.context_budget ?? null,
                validation: contract.validation, delay_after_sec: delay_after_sec || 0,
              },
            });
            return { item };
          } catch (e) { return { error: e.message }; }
        }
        const existing = store().listTaskItems(task_id, profileId);
        const item = store().createTaskItem({
          id: crypto.randomUUID(),
          task_id,
          position: position ?? existing.length,
          title,
          execution_tier: execution_tier || 'free',
          delay_after_sec: delay_after_sec || 0,
        });
        return { item };
      },
    },

    task_item_skip: {
      description:
        'Skip a step of a durable plan that does not apply (legal, audited) — e.g. "observe after release" for a ' +
        'CLI with no prod. Only a step that has not started yet. The reason is stored on the step and in its ' +
        'validation evidence ({skipped:true, reason}); the plan can still finalize.',
      inputSchema: {
        type: 'object',
        required: ['item_id', 'reason'],
        properties: { item_id: { type: 'string' }, reason: { type: 'string', description: 'Why this step does not apply' } },
      },
      handler: async ({ item_id, reason }, ctx) => {
        const profileId = requireProfile(ctx);
        try {
          const item = store().skipItem(item_id, profileId, { reason, by: 'agent' });
          const t = store().getTask(item.task_id, profileId);
          require('../../playbook-defects-log').logDefect({ profile_id: profileId, task_id: item.task_id,
            playbook: t && t.playbook_id || null, kind: 'skip', item_id: item.id, step: item.title, stage: item.stage, reason });
          // Skipping the last open step must not leave a finished plan unfinalized.
          const progress = store().progressSummary(item.task_id, profileId);
          if (progress.total > 0 && progress.finished >= progress.total) store().finalizePlan(item.task_id, profileId);
          return { item };
        } catch (e) { return { error: e.message }; }
      },
    },

    task_list: {
      description: 'List durable tasks for the caller\'s profile, optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'blocked', 'done', 'failed', 'cancelled'] },
        },
      },
      handler: async ({ status } = {}, ctx) => {
        const profileId = requireProfile(ctx);
        const tasks = store().listTasks(profileId, { status });
        return {
          tasks: tasks.map(t => ({ ...t, progress: store().progressSummary(t.id, profileId) })),
        };
      },
    },

    task_get: {
      description: 'Get a durable task with all its items, scoped to the caller\'s profile.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: { task_id: { type: 'string' } },
      },
      handler: async ({ task_id }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().getTask(task_id, profileId);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        const items = store().listTaskItems(task_id, profileId);
        return withProjection({ task, items, sessions: store().listSessions(task_id, profileId) }, profileId);
      },
    },

    task_update: {
      description:
        'Update a durable task\'s goal/status/project_id. A contract plan (created by playbook_run/task_create with ' +
        'acceptance_criteria) starts as a draft and is not executed until you set status="active" — that is the ' +
        'activation step (or create it active via playbook_run activate=true when the user already agreed to the task). Setting a contract plan to "done" goes through the finalization gate: every ' +
        'declared criterion validation must have a matching passing result, otherwise the update is rejected with ' +
        'what is still unmet.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string' },
          goal: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'blocked', 'done', 'failed', 'cancelled'] },
          project_id: { type: 'string' },
        },
      },
      handler: async ({ task_id, ...patch }, ctx) => {
        const profileId = requireProfile(ctx);
        checkReferences(profileId, patch.project_id, null);
        const task = store().updateTask(task_id, profileId, patch);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
        return { task };
      },
    },

    task_item_update: {
      description:
        'Update a step (item). Use validation_mode to choose how strictly this step is ' +
        'validated: "programmatic" (deterministic only), "programmatic+llm" (deterministic + ' +
        'cheap LLM judge — strongly recommended, especially on cheap models), or ' +
        '"programmatic+llm-fastpass" (loosest; a recorded escape hatch, never a silent bypass). ' +
        'Omit to inherit the plan default.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string' },
          validation_mode: { type: 'string', enum: [...VALIDATION_MODES] },
        },
      },
      handler: async ({ item_id, ...patch }, ctx) => {
        const profileId = requireProfile(ctx);
        const item = store().updateTaskItem(item_id, patch, profileId);
        if (!item) return { error: 'item not found (or not owned by this profile)' };
        return { item };
      },
    },

    task_item_wait: {
      description:
        'Park the CURRENT durable step until something external happens, instead of waiting inside the run ' +
        'or failing the step. Then end your reply with the line `DURABLE: waiting`. The server polls the ' +
        'condition cheaply (deterministic validators, no model) every poll_every_sec and re-runs this same ' +
        'step with a note on what happened when: the condition passes, the item is woken (task_item_wake — ' +
        'e.g. the user answered), or timeout_sec expires. Give at least one of: ' +
        '`until` — validator keys, e.g. {"ci_green": "<PR url>"}, {"merged": "<PR url>"}, ' +
        '{"http_ok": {"url": "https://host/health", "contains": "<sha>"}}, {"credential_present": "github"}, ' +
        '{"command_exit_zero": "journalctl -u svc --since -30min | grep -q \'ERR_X\'"}, {"task_done": "<task id>"}, ' +
        '{"file_exists": "path"}; `awaiting_user: true` — you asked the user something (send the question ' +
        'yourself first); `sleep_sec` — a plain timer (observe for a day, then re-check). ' +
        'Waiting does not spend the step\'s attempts.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string', description: 'The Step id from the durable prompt' },
          until: { type: 'object', description: 'Condition: {validator_key: value, ...}; all must pass' },
          awaiting_user: { type: 'boolean', description: 'Wake when the user answers (task_item_wake) or at timeout' },
          sleep_sec: { type: 'integer', description: 'Plain timer: re-run this step after N seconds' },
          poll_every_sec: { type: 'integer', description: 'How often to check `until` (default 300, min 60)' },
          timeout_sec: { type: 'integer', description: 'Give up after N seconds (default 86400, max 30 days); the step is re-run with a timeout note' },
          reason: { type: 'string', description: 'What you are waiting for, in plain words (shown on resume and to the user)' },
        },
      },
      handler: async ({ item_id, ...req }, ctx) => {
        const profileId = requireProfile(ctx);
        const s = store();
        const item = s.getTaskItem(item_id);
        const task = item && s.getTask(item.task_id, profileId);
        if (!item || !task) return { error: 'item not found (or not owned by this profile)' };
        if (item.status !== 'running') {
          return { error: `task_item_wait parks the step that is running now (status=${item.status})` };
        }
        const { normalizeAgentWait } = require('../../durable-wait');
        const { getDefaultRegistry } = require('../../playbook-validators');
        const { wait, error } = normalizeAgentWait(req, { now: Date.now(), registryKeys: Object.keys(getDefaultRegistry()) });
        if (error) return { error };
        s.setItemWait(item_id, profileId, wait);
        return {
          ok: true,
          wait,
          next: 'End your reply with the line `DURABLE: waiting`.',
        };
      },
    },

    task_item_wake: {
      description:
        'Wake a durable step that is waiting (task_item_wait / a playbook wait). Use it when the user ' +
        'answers the question a waiting step asked, or when you know its condition now holds. The message ' +
        'is handed to the resumed step. A programmatic wait is simply re-checked now.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string' },
          message: { type: 'string', description: 'The user\'s answer / what changed' },
        },
      },
      handler: async ({ item_id, message }, ctx) => {
        const profileId = requireProfile(ctx);
        return store().wakeItem(item_id, profileId, { message: message ?? null, by: 'user' });
      },
    },

    task_item_retry: {
      description:
        'Restart a durable step that FAILED terminally (e.g. its deterministic check failed and the attempt ' +
        'budget is spent) once the cause is fixed — the workspace artifact was moved to the plan folder, the ' +
        'missing file restored. Re-pends the step with a fresh attempt budget; if the whole plan was parked by ' +
        'the failure it becomes active again. Only a step in status "failed" can be retried.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string', description: 'The Step id from the durable prompt' },
          reason: { type: 'string', description: 'What changed — why the retry is safe' },
        },
      },
      handler: async ({ item_id, reason }, ctx) => {
        const profileId = requireProfile(ctx);
        const s = store();
        const item = s.getTaskItem(item_id);
        const task = item && s.getTask(item.task_id, profileId);
        if (!item || !task) return { error: 'item not found (or not owned by this profile)' };
        if (item.status !== 'failed') return { error: `task_item_retry only restarts a failed step (status=${item.status})` };
        const retried = s.retryItem(item_id, profileId, { reason: reason ?? null, by: 'agent' });
        if (!retried) return { error: 'item not found (or not owned by this profile)' };
        return { item: retried };
      },
    },

    task_item_exception: {
      description:
        'Close the step you are running NOW as an exception — done differently than the checklist expects, or ' +
        'not applicable — with a concrete reason. Then finish your reply with DURABLE: done. The step\'s checks are ' +
        'recorded as passed-by-exception (no judge) and the exception is logged for checklist improvement and shown ' +
        'to the owner. Use it honestly: an exception is visible, a silent miss is not.',
      inputSchema: {
        type: 'object',
        required: ['item_id', 'reason'],
        properties: { item_id: { type: 'string', description: 'Your Step id' }, reason: { type: 'string' } },
      },
      handler: async ({ item_id, reason }, ctx) => {
        const profileId = requireProfile(ctx);
        try { return { item: store().markItemException(item_id, profileId, { reason, by: 'agent' }) }; }
        catch (e) { return { error: e.message }; }
      },
    },

    task_item_complete: {
      description:
        'Mark a task item done (or failed, with an error). On success this arms the next ' +
        'sibling item per its delay_after_sec policy.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: {
          item_id: { type: 'string' },
          error: { type: 'string', description: 'If set, marks the item failed instead of done' },
        },
      },
      handler: async ({ item_id, error }, ctx) => {
        const profileId = requireProfile(ctx);
        const item = error
          ? store().failItem(item_id, profileId, { error })
          : store().completeItem(item_id, profileId);
        if (!item) return { error: 'item not found (or not owned by this profile)' };
        return { item };
      },
    },

  },
};
