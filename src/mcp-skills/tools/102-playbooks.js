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

const fs = require('fs');
const path = require('path');

const authoring = createPlaybookAuthoring();

let _batchStore = null;
function batchStore() {
  if (!_batchStore) {
    const { DurableTaskStore } = require('../../durable-task-store');
    _batchStore = new DurableTaskStore(require('../../data-paths').durableTaskDbPath());
  }
  return _batchStore;
}

// What the last run of this profile actually resolved (src/skills/shadow.js writes it with real
// probed readiness). Missing/unreadable → null: playbook_health then computes from skills.json.
function readResolvedSkills(profileId) {
  try {
    const { userWorkDir } = require('../../data-paths');
    const rec = JSON.parse(require('fs').readFileSync(require('path').join(userWorkDir(profileId), '.skills-resolved.json'), 'utf8'));
    return rec && rec.resolved && Array.isArray(rec.resolved.modules) ? rec : null;
  } catch { return null; }
}

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

// Step toggles at plan start (playbook_run `steps`). A playbook is a template: for
// a small goal a third of its steps do not apply, and skipping them one by one after
// start (task_item_skip) meant nobody did it — plans ran research/design steps for a
// one-line fix. The run now takes the switch list up front and returns the full step
// list with `enabled`, so the calling session sees every step and what it may drop.
// Quality gates the owner made mandatory (CI + staging green, merged/deployed) stay on:
// a blanket skip of those is exactly what «общий skip недопустим» forbids.
const PROTECTED_VALIDATORS = ['ci_green', 'ci_and_staging_green', 'merged', 'pr_merged', 'merged_and_deployed'];

function isProtectedStep(item) {
  return Object.keys(item.validation || {}).some(k => PROTECTED_VALIDATORS.includes(k));
}

// → Map(index → reason) of steps to switch off; coded error on an unknown/protected
// step or a missing reason, before anything is written.
function resolveStepToggles(items, steps) {
  const off = new Map();
  for (const t of steps || []) {
    if (!t || t.enabled !== false) continue;
    const ref = t.step;
    const idx = Number.isInteger(ref) ? ref - 1
      : items.findIndex(i => i.title.trim().toLowerCase() === String(ref ?? '').trim().toLowerCase());
    if (idx < 0 || idx >= items.length) {
      throw playbookError('STEP_NOT_FOUND', `шаг «${ref}» не найден — укажи точное название или номер (1…${items.length})`);
    }
    if (isProtectedStep(items[idx])) {
      throw playbookError('STEP_PROTECTED', `шаг «${items[idx].title}» — обязательный гейт (CI/staging/мерж), выключить нельзя`);
    }
    const reason = String(t.reason || '').trim();
    if (!reason) throw playbookError('STEP_REASON_REQUIRED', `шаг «${items[idx].title}»: укажи reason — почему он не нужен`);
    off.set(idx, reason);
  }
  return off;
}

const STEPS_HINT = 'steps — все шаги плана с enabled. Шаги, которые к этой цели не относятся (исследование для ' +
  'однострочного фикса, дизайн для очевидной правки и т.п.), выключай сразу: в playbook_run — steps:[{step, ' +
  'enabled:false, reason}], для уже созданного плана — task_item_skip(item_id, reason). protected=true (CI/staging/' +
  'мерж) не выключаются. Ожидания (wait) настраиваются в шаге: poll_every_sec/timeout_sec.';

// ── Guide mode (#1887 п.1, #1894) ──────────────────────────────────────────
// Which run mode applies — decided here, deterministically (owner decision 29.09), not by
// a prompt rule. The open-guide scan and the session-plan lookup only run when they can
// matter (no explicit mode, interactive Telegram).
function chooseRunMode({ profileId, mode, activate, project_id }) {
  const guide = require('../../playbook-guide');
  const { currentRunIdentity } = require('../../run-identity');
  const { userWorkDir } = require('../../data-paths');
  const env = process.env;
  const identity = currentRunIdentity(env);
  const profileRoot = userWorkDir(profileId);
  const probe = !mode && identity.interactive;
  const openGuide = probe ? guide.findOpenGuide({ profileRoot, chatId: identity.chatId }) : null;
  let sessionPlan = null;
  if (probe && !openGuide) {
    try { sessionPlan = batchStore().activeTaskForSession(profileId, identity.sessionId); } catch { /* fail-open */ }
  }
  let chosen;
  try {
    chosen = guide.resolveMode({
      mode, activate, interactive: identity.interactive, guideDefault: guide.guideDefaultOn(env), openGuide, sessionPlan,
    });
  } catch (e) { throw playbookError(e.code || 'MODE_INVALID', e.message); }
  if (openGuide && chosen.reason === 'foreground_busy') chosen.busy = { goal: openGuide.goal, checklist_path: openGuide.checklist_path };
  if (chosen.mode !== 'guide') return chosen;
  // The section lands in the project the session works in (runner cwd = projectDir, which
  // GTD reads after the run). Never outside the profile: no project dir → background.
  // Only a project folder (projects/<id>/project.json) or the profile root itself — a code
  // worktree cwd (engineering-workspaces/…) must never get a checklist.md.
  const dir = project_id ? path.join(profileRoot, 'projects', String(project_id)) : process.cwd();
  const rel = path.relative(profileRoot, dir);
  const parts = rel.split(path.sep);
  const isProject = parts.length === 2 && parts[0] === 'projects' && fs.existsSync(path.join(dir, 'project.json'));
  if (!(rel === '' || isProject)) {
    if (chosen.reason === 'explicit') throw playbookError('GUIDE_NO_PROJECT', 'гайд пишет шаги в checklist.md проекта, а сессия не в папке проекта профиля — укажи project_id или mode:"background"');
    return { mode: 'background', reason: 'no_project_dir' };
  }
  return { ...chosen, dir };
}

function runGuide({ profileId, playbook, compiled, off, chosen }) {
  const guide = require('../../playbook-guide');
  const { currentRunIdentity } = require('../../run-identity');
  const identity = currentRunIdentity();
  const file = path.join(chosen.dir, 'checklist.md');
  const section = guide.renderGuideSection({
    goal: compiled.goal, items: compiled.items, off, isProtected: isProtectedStep,
    sessionId: identity.sessionId || 'unknown', chatId: identity.chatId || '0', playbook,
  });
  guide.appendGuideSection(file, section);
  if (off.size) {
    const { logDefect } = require('../../playbook-defects-log');
    for (const [idx, reason] of off) {
      logDefect({ profile_id: profileId, playbook: playbook.id, kind: 'skip', mode: 'guide',
        step: compiled.items[idx].title, stage: compiled.items[idx].stage, reason });
    }
  }
  return {
    mode: 'guide',
    mode_reason: chosen.reason,
    playbook: { id: playbook.id, version: playbook.version, scope: playbook.scope, source: playbook.source },
    summary: { stages: playbook.stages.length, items: compiled.items.length },
    steps: compiled.items.map((it, i) => ({
      n: i + 1, step: it.title, enabled: !off.has(i), validation: it.validation,
      ...(isProtectedStep(it) ? { protected: true } : {}),
    })),
    steps_hint: STEPS_HINT,
    checklist_path: file,
    checklist_md: section,
    guide_hint: guide.GUIDE_HINT,
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

    playbook_health: {
      description:
        'Check whether a playbook actually reaches THIS profile («доехал ли плейбук»): file resolves and compiles, ' +
        'the agent has a route to it from a plain request (prompt-domain playbook_run pointer / audience map / ' +
        'dev auto-offer / launcher), its declared requires {sections, tools} exist, and those sections/tools are ' +
        'enabled for the caller profile in this run. Omit id to check every visible playbook. Read-only, offline, ' +
        'no LLM. Use it to answer "а у меня этот плейбук виден?" or before promising a playbook to the user.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Playbook id; omit to check all playbooks visible to the profile' },
          audience: { type: 'string', description: 'Also check that the id is the default for this audience' },
        },
      },
      handler: safe(async ({ id, audience } = {}, ctx) => {
        const profileId = requireUser(ctx);
        const { checkPlaybookReachability } = require('../../playbook-reachability');
        const resolved = readResolvedSkills(profileId);
        const ids = id ? [id] : new PlaybookStore({ profileId }).list().playbooks.map(p => p.id);
        const reports = ids.map(pid => checkPlaybookReachability(pid, {
          profileId, audience, ...(resolved ? { resolved: resolved.resolved } : {}),
        }));
        return {
          ok: reports.every(r => r.ok),
          exposure_source: resolved ? `.skills-resolved.json (${resolved.at})` : 'computed from skills.json (no run record yet)',
          reports: reports.map(r => ({ id: r.id, ok: r.ok, rows: r.rows })),
        };
      }),
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
        'plan already pinned to its version. Repo/draft playbooks must be saved first (resolution sees saved playbooks only). ' +
        'In a Telegram chat the DEFAULT is mode «guide» (#1887): no durable plan — the tool appends the steps as a ' +
        'checklist.md section (Goal/Owner-session/Owner-chat/Mode: guide) and returns checklist_md; walk the steps in this ' +
        'dialog and tick [x] as they are done, gates only on a green check. The response always carries mode/mode_reason: ' +
        'background → the plan runs by itself, just tell the user it started.',
      inputSchema: {
        type: 'object',
        required: ['playbook_id', 'goal'],
        properties: {
          playbook_id: { type: 'string', description: 'Saved playbook id, e.g. "development"' },
          goal: { type: 'string', description: 'Concrete goal for this run (substituted into {goal}/{input})' },
          version: { type: 'integer', minimum: 1, description: 'Pin an exact version; omit for the resolved one' },
          user_value: { type: 'string', description: 'Override the rendered user_value_template' },
          acceptance_criteria: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Goal-specific criteria; derived from step validations when omitted' },
          vars: {
            type: 'object',
            description: 'Template values for {placeholder} rendering. Inputs the playbook declares as required must be here ' +
              '(engineering feature/debugging/new-software: repo = "owner/name", or a single GitHub link in goal) — otherwise ' +
              'the run fails with INPUT_REQUIRED instead of a plan that silently stalls.',
          },
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
          mode: {
            type: 'string', enum: ['guide', 'background'],
            description: 'Omit in the normal case — code decides. Telegram chat: «гайд» by default (no durable plan; the ' +
              'steps are appended as a checklist.md section of this project and you walk them HERE, in this dialog), or ' +
              'background if this chat already has an open guide. "background" only when the user explicitly asked «в фоне / ' +
              'параллельно / сам доделай». Web and plan steps are always background. mode:"guide" with activate:true is a ' +
              'MODE_CONFLICT error.',
          },
          project_id: { type: 'string', description: 'Optional project to bind the plan (and its checklist.md projection) to' },
          session_id: { type: 'string', description: 'Optional session to attach the plan to' },
          steps: {
            type: 'array',
            description: 'Step switches, applied before the plan starts: [{step: "<exact title>" | <1-based number>, ' +
              'enabled: false, reason: "why it does not apply"}]. Look at the step list first (playbook_get) and switch ' +
              'off every step that does not apply to THIS goal — for a small fix typically a third of a big playbook. ' +
              'CI/staging/merge gates cannot be switched off. Omitted = all steps on.',
            items: {
              type: 'object', required: ['step', 'enabled'],
              properties: {
                step: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }] },
                enabled: { type: 'boolean' },
                reason: { type: 'string', description: 'Required when enabled=false' },
              },
            },
          },
        },
      },
      handler: safe(async ({ playbook_id, goal, version, user_value, acceptance_criteria, vars, project_id, session_id, approve_hooks, activate, steps, mode }, ctx) => {
        const profileId = requireUser(ctx);
        const playbook = new PlaybookStore({ profileId }).get(playbook_id, version);
        if (!playbook) throw playbookError('PLAYBOOK_NOT_FOUND', `плейбук «${playbook_id}» не найден`);
        const compiled = compilePlaybook(playbook, { goal, vars, acceptance_criteria, user_value });
        const off = resolveStepToggles(compiled.items, steps);
        const chosen = chooseRunMode({ profileId, mode, activate, project_id });
        if (chosen.mode === 'guide') return runGuide({ profileId, playbook, compiled, off, chosen });
        // A background plan started while this chat already runs something in the
        // foreground must not attach to the live session: GTD skips a session with an
        // active durable plan (#1719), which would silently stop driving the guide.
        const detached = chosen.reason === 'foreground_busy' || chosen.reason === 'session_has_plan';
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
          session_id: (!detached && session_id) || undefined,
        }, ctx);
        // Activation goes through task_update — the same single write path the
        // user-driven «запускай» step uses — so no status write bypasses the store.
        let task = persisted.task;
        let items = persisted.items;
        if (off.size && task) {
          const byPosition = [...(items || [])].sort((a, b) => a.position - b.position);
          const { logDefect } = require('../../playbook-defects-log');
          for (const [idx, reason] of off) {
            const it = byPosition[idx];
            batchStore().skipItem(it.id, profileId, { reason, by: 'playbook_run' });
            // Same audit trail as task_item_skip: steps that keep being switched off are
            // the signal to trim the playbook itself.
            logDefect({ profile_id: profileId, task_id: task.id, playbook: playbook.id, kind: 'skip',
              item_id: it.id, step: it.title, stage: it.stage, reason });
          }
          items = byPosition.map(i => batchStore().getTaskItem(i.id));
        }
        if (activate === true && task && task.status === 'draft') {
          const { task_update } = require('./101-durable-tasks').tools;
          const updated = await task_update.handler({ task_id: task.id, status: 'active' }, ctx);
          if (updated && updated.task) task = updated.task;
        }
        const ordered = [...(items || [])].sort((a, b) => a.position - b.position);
        return {
          mode: 'background',
          mode_reason: chosen.reason,
          ...(chosen.busy ? { busy: chosen.busy } : {}),
          task,
          items,
          steps: ordered.map((i, n) => ({
            n: n + 1, step: i.title, item_id: i.id, enabled: i.status !== 'skipped',
            ...(isProtectedStep(compiled.items[n]) ? { protected: true } : {}),
          })),
          steps_hint: STEPS_HINT,
          projection: persisted.projection,
          projection_warning: persisted.projection_warning,
          playbook: { id: playbook.id, version: playbook.version, scope: playbook.scope, source: playbook.source },
          summary: { stages: playbook.stages.length, items: compiled.items.length },
          render: renderPlaybook(playbook, { ...(vars || {}), input: goal, goal }),
        };
      }),
    },

    // ── Meta-playbooks: batch / fanout (#1752) ──────────────────────────────
    playbook_run_batch: {
      description:
        'Run ONE playbook over N elements as a batch («вот 5 выставок — прогони все»): one durable parent plan with a ' +
        'fanout step spawns every element as its own child plan (playbook_run of playbook_id, own project per element), ' +
        'watches them on the durable tick, and on every finished/failed/stuck child asks a cheap supervisor model to pick ' +
        'one action (continue / retry the failed step / skip element / pause the whole batch on a systemic failure / ' +
        'escalate to the owner). No concurrency cap: children fire into free host slots. The owner chat gets one line per ' +
        'finished element, every pause/escalation and a final summary. Call it once the user agreed to run the batch — it ' +
        'starts immediately. Track with playbook_batch_status, steer with playbook_batch_control.',
      inputSchema: {
        type: 'object',
        required: ['playbook_id', 'items'],
        properties: {
          playbook_id: { type: 'string', description: 'Child playbook, e.g. "exhibition-catalog-to-sales-site"' },
          items: {
            type: 'array', minItems: 1,
            items: {
              anyOf: [
                { type: 'string', description: 'Goal of the element (e.g. the exhibition URL)' },
                { type: 'object', required: ['goal'], properties: {
                  goal: { type: 'string' }, name: { type: 'string', description: 'Human name — also the element project name' },
                  key: { type: 'string', description: 'Stable id inside the batch' }, vars: { type: 'object' } } },
              ],
            },
          },
          title: { type: 'string', description: 'Batch title for notifications' },
          skip_stages: { type: 'array', items: { type: 'string' }, description: 'Child playbook stage ids NOT run inside the batch (e.g. live at-stand work)' },
          exclusive_stages: { type: 'array', items: { type: 'string' }, description: 'Stages that touch a shared external resource: only one child at a time inside such a stage' },
          project_type: { type: 'string', description: 'Project type for each element project (e.g. "expo"); default generic' },
          project_mode: { type: 'string', enum: ['per_item', 'parent'], description: 'per_item (default): own project per element' },
          concurrency: { type: 'integer', minimum: 1, description: 'Optional cap on elements in flight. Omit = no cap (host slots decide)' },
          max_child_retries: { type: 'integer', minimum: 0, description: 'Supervisor retries per element (default 1)' },
          project_id: { type: 'string', description: 'Project the batch (parent plan) belongs to' },
          session_id: { type: 'string', description: 'Current session id (AGENT_SESSION_ID) — its chat receives batch notifications' },
        },
      },
      handler: safe(async (args, ctx) => {
        const profileId = requireUser(ctx);
        const playbook = new PlaybookStore({ profileId }).get(args.playbook_id);
        if (!playbook) throw playbookError('PLAYBOOK_NOT_FOUND', `плейбук «${args.playbook_id}» не найден`);
        const fanout = require('../../playbook-fanout');
        const elements = fanout.normalizeElements(args.items);
        // Fail fast: every element must compile before anything is spawned.
        for (const el of elements) compilePlaybook(playbook, { goal: el.goal, vars: el.vars || {} });
        const { userWorkDir } = require('../../data-paths');
        const projects = require('../../projects');
        if (args.project_id && !projects.getProject(userWorkDir(profileId), args.project_id)) {
          throw playbookError('PROJECT_NOT_FOUND', `проект «${args.project_id}» не найден`);
        }
        let owner = null;
        const sid = args.session_id || process.env.AGENT_SESSION_ID || null;
        if (sid) {
          const sess = require('../../session-store').getSession(userWorkDir(profileId), sid);
          const chatId = sess ? (sess.liveChatId ?? sess.ownerChatId) : null;
          if (chatId != null) owner = { chatId, audience: sess.audience || 'default', threadId: sess.threadId || null };
        }
        const res = fanout.createBatch(batchStore(), {
          profileId, playbook, elements, title: args.title || null, projectId: args.project_id || null, owner,
          skipStages: args.skip_stages || [], exclusiveStages: args.exclusive_stages || [],
          projectType: args.project_type || 'generic', projectMode: args.project_mode || 'per_item',
          concurrency: args.concurrency ?? null,
          maxChildRetries: Number.isInteger(args.max_child_retries) ? args.max_child_retries : undefined,
        });
        return {
          batch_task_id: res.task.id, status: res.task.status, title: res.state.config.title,
          elements: res.state.elements.map(e => ({ key: e.key, name: e.name, goal: e.goal, status: e.status })),
          notifications_to: owner ? 'launching chat' : 'profile owner chat',
          note: 'Пачка активна: элементы стартуют на ближайшем тике движка (≤5 мин), дальше шаги идут сразу друг за другом.',
        };
      }),
    },

    playbook_batch_status: {
      description: 'Status of a batch started by playbook_run_batch: every element with its child plan, progress (steps done/total), current or failed step, supervisor journal. Read-only.',
      inputSchema: { type: 'object', required: ['batch_task_id'], properties: { batch_task_id: { type: 'string' } } },
      handler: safe(async ({ batch_task_id }, ctx) => {
        const profileId = requireUser(ctx);
        return require('../../playbook-fanout').batchStatus(batchStore(), batch_task_id, profileId);
      }),
    },

    playbook_batch_control: {
      description: 'Steer a batch: action=resume (the systemic cause is fixed or the owner answered: un-pauses every element and wakes every step waiting for the owner with `message`), retry (re-run the failed step of element `key`), skip (drop element `key` with a reason), add (one more element: goal + optional name, spawned on the next tick).',
      inputSchema: {
        type: 'object', required: ['batch_task_id', 'action'],
        properties: {
          batch_task_id: { type: 'string' },
          action: { type: 'string', enum: ['resume', 'retry', 'skip', 'add'] },
          key: { type: 'string', description: 'Element key (for retry/skip)' },
          reason: { type: 'string' },
          goal: { type: 'string', description: 'Goal of the element to add (action=add)' },
          name: { type: 'string', description: 'Name of the element to add (action=add)' },
          message: { type: 'string', description: 'Owner answer handed to every woken element (action=resume)' },
        },
      },
      handler: safe(async ({ batch_task_id, action, key, reason, goal, name, message }, ctx) => {
        const profileId = requireUser(ctx);
        return require('../../playbook-fanout').controlBatch(batchStore(), batch_task_id, profileId, { action, key, reason, goal, name, message });
      }),
    },

  },
};
