'use strict';

// MCP surface for Playbooks (Playbook v1, issue #1372).
//   P0: playbook_list / playbook_get (read-only registry).
//   P1: playbook_draft / playbook_edit / playbook_save (authoring via Hermes).
//   P2: playbook_run (compile a playbook + goal into a durable draft plan).
// Resolution is profile custom → domain sibling repo → system repo; see
// src/playbook-store.js. Authoring follows the flow draft → (edit)* → save:
// the draft is a durable profile-scope file, save() validates it and promotes
// it to ~/users/<profile>/playbooks/<id>.json with a bumped version. Repo
// ("system") playbooks are immutable here — they change through a PR.
// Execution itself (activating/running a plan) is a later slice.

const { PlaybookStore, renderPlaybook, playbookError } = require('../../playbook-store');
const { createPlaybookAuthoring } = require('../../playbook-authoring');
const { compilePlaybook } = require('../../playbook-compiler');
const { suggestPlaybookForAudience } = require('../../audience-default-playbook');

const authoring = createPlaybookAuthoring();

// Authoring rejects a missing profile loudly; playbook_run must do the same so
// an unscoped call can never resolve a different profile's playbooks.
function requireUser(ctx) {
  const username = ctx && ctx.userId;
  if (typeof username !== 'string' || !username.trim()) {
    throw playbookError('USER_REQUIRED', 'username (profile id) обязателен');
  }
  return username;
}

// Forward ALL arguments (args AND ctx) — dropping ctx silently sent
// username=undefined into the authoring layer, which wrote into a literal
// "users/undefined/" profile. Caught by the live smoke test.
function safe(fn) {
  return async (...allArgs) => {
    try {
      return await fn(...allArgs);
    } catch (error) {
      if (error && error.code) return { error: error.message, code: error.code };
      throw error;
    }
  };
}

module.exports = {
  tools: {

    playbook_list: {
      description:
        'List playbooks visible to the caller profile (resolution: profile custom → domain sibling repo → ' +
        'system repo), each at its winning level with version/source. Read-only — does not create or run anything. ' +
        'A malformed file is reported under diagnostics instead of crashing the list.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => new PlaybookStore({ profileId: ctx?.userId }).list(),
    },

    playbook_suggest: {
      description:
        'Suggest/pre-select the default playbook for an audience (bot surface) — e.g. freelance specs, exhibition ' +
        'catalog, engineering. Read-only: it only reports the suggestion and whether the profile can actually see ' +
        'that playbook; it never compiles, runs or activates a plan (activation is playbook_run activate=true once the user ' +
        'agreed to the task, or task_update status=active). Resolution: env AUDIENCE_DEFAULT_PLAYBOOK → config/audience-default-playbooks.json → built-ins, ' +
        'falling back to "development".',
      inputSchema: {
        type: 'object',
        properties: { audience: { type: 'string', description: 'Bot/surface audience; omit for the default map' } },
      },
      handler: async ({ audience } = {}, ctx) => {
        const store = new PlaybookStore({ profileId: ctx?.userId });
        return suggestPlaybookForAudience(audience, { store });
      },
    },

    playbook_get: {
      description:
        'Get a full playbook by id (optionally pinned to an exact version) plus a human-readable prompt render. ' +
        'Pass draft=true to read an unsaved authoring draft instead of the resolved playbook. ' +
        'Resolution: profile custom → domain sibling repo → system repo. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playbook id, e.g. "development"' },
          version: { type: 'integer', minimum: 1, description: 'Pin an exact version; omit for the resolved one' },
          draft: { type: 'boolean', description: 'Read the unsaved draft of this id (authoring), not the saved playbook' },
          vars: { type: 'object', description: 'Optional template values for {goal}, {error}, ... used only in the render' },
        },
        required: ['id'],
      },
      handler: async ({ id, version, draft, vars }, ctx) => {
        if (draft) {
          const stored = authoring.readDraft(ctx?.userId, id);
          if (!stored) return { error: `draft not found: ${id}` };
          return { draft: stored, render: renderPlaybook(stored, vars || {}) };
        }
        const playbook = new PlaybookStore({ profileId: ctx?.userId }).get(id, version);
        if (!playbook) return { error: `playbook not found: ${id}` };
        return { playbook, render: renderPlaybook(playbook, vars || {}) };
      },
    },

    playbook_draft: {
      description:
        'Author a new Playbook v1 from a natural-language process description: Hermes rewrites it into the ' +
        'validated playbook contract (house meta-patterns: mandatory machine-checkable validation per agent step, ' +
        'executor role/model-level/budget instead of concrete models, programmatic steps for objective checks). ' +
        'Returns the draft (profile scope) + prompt render; the draft is stored durably, nothing is promoted to a ' +
        'real playbook until playbook_save. Use based_on to start from an existing playbook.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'The process described in the user’s own words' },
          based_on: { type: 'string', description: 'Optional existing playbook id to start from' },
          model: { type: 'string', description: 'Optional OpenRouter fallback model for Hermes' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['description'],
      },
      handler: safe(({ description, based_on, model, vars }, ctx) =>
        authoring.draft({ username: ctx?.userId, description, based_on, model, vars })),
    },

    playbook_edit: {
      description:
        'Edit an existing playbook (or its unsaved draft) from a natural-language instruction, via Hermes. ' +
        'Returns the updated draft, a prompt render and a structural diff. Editing a system playbook produces a ' +
        'profile-scope draft that overrides it once saved — the repo file is never touched.',
      inputSchema: {
        type: 'object',
        properties: {
          playbook_id: { type: 'string', description: 'Playbook id (or draft id) to edit' },
          instruction: { type: 'string', description: 'What to change, in the user’s own words' },
          model: { type: 'string', description: 'Optional OpenRouter fallback model for Hermes' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['playbook_id', 'instruction'],
      },
      handler: safe(({ playbook_id, instruction, model, vars }, ctx) =>
        authoring.edit({ username: ctx?.userId, playbook_id, instruction, model, vars })),
    },

    playbook_save: {
      description:
        'Promote an authoring draft to a saved custom playbook in the caller profile ' +
        '(~/users/<profile>/playbooks/<id>.json), validating it and bumping its version above any playbook it ' +
        'overrides. Repo ("system") playbooks cannot be saved here — they change through a PR. The draft is ' +
        'consumed on success.',
      inputSchema: {
        type: 'object',
        properties: {
          playbook_id: { type: 'string', description: 'Id of the draft to save' },
          vars: { type: 'object', description: 'Optional template values used only in the render' },
        },
        required: ['playbook_id'],
      },
      handler: safe(({ playbook_id, vars }, ctx) =>
        authoring.save({ username: ctx?.userId, playbook_id, vars })),
    },

    playbook_run: {
      description:
        'Compile a saved Playbook v1 into a concrete durable plan: bind the playbook to a goal, render every step, pin ' +
        '{playbook_id, playbook_version} and persist one draft plan through the same atomic task_create path ' +
        '(user_value rendered from the template; acceptance_criteria derived from the step validations when omitted). ' +
        'By default the result is a DRAFT plan — stored, not executed. Pass activate=true when the user has ALREADY agreed ' +
        'to do this task (asked for it, said «делай», pressed an action button): that agreement is the activation consent, ' +
        'so the plan is created and set active in one call — do not ask again. Editing the playbook later never mutates a ' +
        'plan already pinned to its version. Repo/draft playbooks must be saved first (resolution sees saved playbooks only).',
      inputSchema: {
        type: 'object',
        required: ['playbook_id', 'goal'],
        properties: {
          playbook_id: { type: 'string', description: 'Saved playbook id, e.g. "development"' },
          goal: { type: 'string', description: 'Concrete goal for this run (substituted into {goal}/{input})' },
          version: { type: 'integer', minimum: 1, description: 'Pin an exact version; omit for the resolved one' },
          user_value: { type: 'string', description: 'Override the rendered user_value_template' },
          acceptance_criteria: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Goal-specific criteria; derived from step validations when omitted' },
          vars: { type: 'object', description: 'Extra template values for {placeholder} rendering' },
          approve_hooks: {
            type: 'boolean',
            description: 'Explicit consent to run external-effect hooks (notify/create_issue/publish) for this run. ' +
              'Without it those hooks are recorded as skipped and never fail the task.',
          },
          activate: {
            type: 'boolean',
            description: 'Create the plan already active (status=active) so the durable executor starts it. Use when the ' +
              'user has already agreed to the task; omit to leave a draft for the user to approve. Does NOT approve ' +
              'external-effect hooks — that stays approve_hooks.',
          },
          project_id: { type: 'string', description: 'Optional project to bind the plan (and its checklist.md projection) to' },
          session_id: { type: 'string', description: 'Optional session to attach the plan to' },
        },
      },
      handler: safe(async ({ playbook_id, goal, version, user_value, acceptance_criteria, vars, project_id, session_id, approve_hooks, activate }, ctx) => {
        const profileId = requireUser(ctx);
        const playbook = new PlaybookStore({ profileId }).get(playbook_id, version);
        if (!playbook) throw playbookError('PLAYBOOK_NOT_FOUND', `плейбук «${playbook_id}» не найден`);
        const compiled = compilePlaybook(playbook, { goal, vars, acceptance_criteria, user_value });
        // Persist through task_create so reference checks, the atomic SQLite
        // transaction and the checklist projection stay in one place.
        const { task_create } = require('./101-durable-tasks').tools;
        const persisted = await task_create.handler({
          goal: compiled.goal,
          user_value: compiled.user_value,
          acceptance_criteria: compiled.acceptance_criteria,
          items: compiled.items,
          hooks: compiled.hooks,
          execution_policy: approve_hooks ? { hooks_approved: true } : undefined,
          playbook_id: playbook.id,
          playbook_version: playbook.version,
          project_id: project_id || undefined,
          session_id: session_id || undefined,
        }, ctx);
        // Activation goes through task_update — the same single write path the
        // user-driven «запускай» step uses — so no status write bypasses the store.
        let task = persisted.task;
        if (activate === true && task && task.status === 'draft') {
          const { task_update } = require('./101-durable-tasks').tools;
          const updated = await task_update.handler({ task_id: task.id, status: 'active' }, ctx);
          if (updated && updated.task) task = updated.task;
        }
        return {
          task,
          items: persisted.items,
          projection: persisted.projection,
          projection_warning: persisted.projection_warning,
          playbook: { id: playbook.id, version: playbook.version, scope: playbook.scope, source: playbook.source },
          summary: { stages: playbook.stages.length, items: compiled.items.length },
          render: renderPlaybook(playbook, { ...(vars || {}), input: goal, goal }),
        };
      }),
    },

  },
};
