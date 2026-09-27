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
  tools: {

    task_create: {
      description:
        'Create a new durable task (a goal tracked across sessions/restarts in SQLite, ' +
        'not a JSON checklist.md). Supply user_value, acceptance_criteria and items to atomically persist a draft plan. Scoped to the caller\'s profile.',
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
        'Add an item (step) to an existing durable task. Items run in position order ' +
        'and can escalate execution tier (free → standard → strong) on failure.',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'title'],
        properties: {
          task_id: { type: 'string' },
          title: { type: 'string' },
          position: { type: 'number', description: 'Order among siblings (default: append)' },
          execution_tier: { type: 'string', enum: ['free', 'standard', 'strong'] },
          delay_after_sec: { type: 'number', description: 'Delay before this item becomes runnable, in seconds' },
        },
      },
      handler: async ({ task_id, title, position, execution_tier, delay_after_sec }, ctx) => {
        const profileId = requireProfile(ctx);
        const task = store().getTask(task_id, profileId);
        if (!task) return { error: 'task not found (or not owned by this profile)' };
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
        'explicit activation step. Setting a contract plan to "done" goes through the finalization gate: every ' +
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

    task_item_resume: {
      description:
        'Put a failed or blocked step back into play with a fresh attempt budget (and a fresh wait window). ' +
        'Use after the user answered the question a step stopped on (append the answer to the plan\'s run ' +
        'notebook first) or handed over the credentials it waited for. Done steps are left unchanged.',
      inputSchema: {
        type: 'object',
        required: ['item_id'],
        properties: { item_id: { type: 'string' } },
      },
      handler: async ({ item_id }, ctx) => {
        const profileId = requireProfile(ctx);
        const item = store().resumeItem(item_id, profileId);
        if (!item) return { error: 'item not found (or not owned by this profile)' };
        return { item };
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
