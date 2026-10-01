'use strict';

// Playbook compiler (issue #1372, slice P2): compile a resolved Playbook v1 into
// the concrete durable-plan payload that DurableTaskStore.createPlan consumes.
//
// A playbook is the reusable, versioned process; a run binds it to one concrete
// goal and pins {playbook_id, playbook_version}. The compiler is pure — it never
// touches the store or a session — so the same playbook compiles for many goals
// without mutating the artifact, and a plan already pinned to a version is
// immune to later edits of that playbook.
//
// Rendering substitutes {goal}/{input}/{...vars} in goal/title/instructions;
// declared `inputs` must be present (or derivable from the goal) before that.
// Agent steps must declare executor_role + minimum_model_level + context_budget:
// the JSON schema allows null, but the plan contract does not, so a missing one
// is a clear COMPILE_INVALID error — never a silently invented default. The only
// defaults applied are the playbook's own `defaults` (max_attempts / timeout),
// falling back to the house values.

const { validateItem } = require('./durable-task-plan');
const { playbookError, _internal } = require('./playbook-store');
const { validateHooks, TASK_HOOK_EVENTS } = require('./playbook-hooks');

const { substitute } = _internal;

// Deterministic validator keys a durable wait can poll. Lazy: the validators
// module is only needed for playbooks that declare a wait.
function waitableKeys() {
  return Object.keys(require('./playbook-validators').getDefaultRegistry());
}

const DEFAULT_MAX_ATTEMPTS = 3;
// 40 min = the engine run cap; the executor also floors every step at it (gtd-controller).
const DEFAULT_TIMEOUT_SECONDS = 2400;

// Resolve one step's boundary hooks. Step hooks stay on their own item; a stage
// boundary is carried by the stage's first/last item (items are strictly ordered,
// so stage entry/exit coincide with those item boundaries).
function compileItemHooks(stage, step, index, count) {
  const hooks = {};
  if (Array.isArray(step.on_complete) && step.on_complete.length) hooks.on_complete = step.on_complete;
  if (Array.isArray(step.on_fail) && step.on_fail.length) hooks.on_fail = step.on_fail;
  if (index === 0 && Array.isArray(stage.on_enter) && stage.on_enter.length) hooks.stage_enter = stage.on_enter;
  if (index === count - 1 && Array.isArray(stage.on_exit) && stage.on_exit.length) hooks.stage_exit = stage.on_exit;
  return Object.keys(hooks).length ? hooks : null;
}

function compileTaskHooks(playbook) {
  validateHooks(playbook.hooks, { where: 'hooks', events: TASK_HOOK_EVENTS });
  const hooks = {};
  if (Array.isArray(playbook.hooks?.task_done) && playbook.hooks.task_done.length) hooks.task_done = playbook.hooks.task_done;
  if (Array.isArray(playbook.hooks?.task_failed) && playbook.hooks.task_failed.length) hooks.task_failed = playbook.hooks.task_failed;
  return Object.keys(hooks).length ? hooks : null;
}

// A goal_template that contains {input}/{goal} renders the concrete goal into the
// task goal. A template without a slot is kept and the goal is appended, so the
// run's goal is never silently dropped by a playbook that hardcoded its wording.
function renderGoal(playbook, vars, goal) {
  const template = playbook.goal_template;
  if (typeof template !== 'string' || !template.trim()) return goal;
  const rendered = substitute(template, vars);
  return /\{(input|goal)\}/.test(template) ? rendered : `${rendered} — ${goal}`;
}

// Task-level acceptance criteria. Goal-specific criteria may be supplied per run;
// when omitted, one deterministic criterion is derived from the playbook itself:
// "every step validation passes", carrying each step's validation so P3's
// finalizer has a machine-checkable contract. This is derived, not invented.
function deriveAcceptanceCriteria(playbook, userValue) {
  const validations = [];
  for (const stage of playbook.stages || []) {
    for (const step of stage.steps || []) {
      validations.push({ stage: stage.id, step: step.title, validation: step.validation });
    }
  }
  return [{
    id: `${playbook.id}-complete`,
    description: userValue,
    source: `playbook:${playbook.id}@${playbook.version}`,
    validations,
  }];
}

// A GitHub repository the goal links to, as owner/name. Only an unambiguous link
// counts: two different repositories in one goal derive nothing.
function deriveGithubRepo(goal) {
  const found = new Set();
  for (const m of String(goal).matchAll(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[/#?\s)"'»,]|$)/g)) {
    found.add(`${m[1]}/${m[2]}`);
  }
  return found.size === 1 ? [...found][0] : null;
}

const DERIVERS = { github_repo: deriveGithubRepo };

// Declared inputs (#1725): a required one that vars do not carry is derived from
// the goal when the playbook says how, otherwise the run is rejected — a plan whose
// steps say «Репозиторий: {repo}» silently fails in the background.
function resolveInputs(playbook, vars, goalText) {
  const resolved = { ...vars };
  const missing = [];
  for (const input of playbook.inputs || []) {
    const value = resolved[input.name];
    if (value != null && String(value).trim()) continue;
    const derived = input.derive && DERIVERS[input.derive] ? DERIVERS[input.derive](goalText) : null;
    if (derived) resolved[input.name] = derived;
    else if (input.required !== false) missing.push(input);
  }
  if (missing.length) {
    const list = missing.map(i => `vars.${i.name}${i.description ? ` (${i.description})` : ''}`).join('; ');
    throw playbookError('INPUT_REQUIRED',
      `плейбук «${playbook.id}» требует ${list} — передай их в playbook_run(vars: {…})`);
  }
  return resolved;
}

function compilePlaybook(playbook, { goal, vars = {}, acceptance_criteria = null, user_value = null } = {}) {
  if (!playbook || typeof playbook !== 'object') {
    throw playbookError('COMPILE_INVALID', 'плейбук не передан');
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw playbookError('GOAL_REQUIRED', 'нужна цель запуска (goal)');
  }
  const goalText = goal.trim();
  // The run goal always wins over stray vars: a caller cannot shadow {goal}/{input}.
  const renderVars = { ...resolveInputs(playbook, vars || {}, goalText), input: goalText, goal: goalText };
  const defaults = playbook.defaults || {};

  const items = [];
  for (const stage of playbook.stages || []) {
    const steps = stage.steps || [];
    // Unknown hook type is a compile error, never a silently dropped hook.
    validateHooks({ on_enter: stage.on_enter, on_exit: stage.on_exit },
      { where: `stage «${stage.id}»`, events: ['on_enter', 'on_exit'] });
    steps.forEach((step, stepIndex) => {
      validateHooks({ on_complete: step.on_complete, on_fail: step.on_fail },
        { where: `шаг «${step.title}»`, events: ['on_complete', 'on_fail'] });
      const item = {
        title: substitute(step.title, renderVars),
        stage: stage.id,
        execution_kind: step.execution_kind,
        executor_role: step.executor_role ?? null,
        minimum_model_level: step.minimum_model_level ?? null,
        context_budget: step.context_budget ?? null,
        validation: step.validation,
        delay_after_sec: step.delay_after_sec ?? 0,
        max_attempts: step.max_attempts ?? defaults.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
        execution_timeout_seconds:
          step.execution_timeout_seconds ?? defaults.execution_timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
      };
      const itemHooks = compileItemHooks(stage, step, stepIndex, steps.length);
      if (itemHooks) item.hooks = itemHooks;
      if (step.instructions) item.instructions = substitute(step.instructions, renderVars);
      if (step.wait) {
        // A declared wait polls the step's validation deterministically; a key
        // with no validator could never pass — reject it now, not at timeout.
        const unknown = Object.keys(step.validation || {}).filter(k => !waitableKeys().includes(k));
        if (unknown.length) {
          throw playbookError('COMPILE_INVALID',
            `шаг «${item.title}»: wait требует детерминированных валидаторов, неизвестно: ${unknown.join(', ')}`);
        }
        item.wait = { poll_every_sec: step.wait.poll_every_sec, timeout_sec: step.wait.timeout_sec };
      }
      if (step.already_done) {
        // already_done is evaluated by the registry at claim time — a key with no
        // validator could never pass, so reject it now (like wait), not silently.
        const unknown = Object.keys(step.already_done).filter(k => !waitableKeys().includes(k));
        if (unknown.length) {
          throw playbookError('COMPILE_INVALID',
            `шаг «${item.title}»: already_done требует детерминированных валидаторов, неизвестно: ${unknown.join(', ')}`);
        }
        item.already_done = step.already_done;
      }
      try {
        validateItem(item);
      } catch (error) {
        throw playbookError('COMPILE_INVALID', `шаг «${item.title}»: ${error.message}`);
      }
      items.push(item);
    });
  }
  if (!items.length) {
    throw playbookError('COMPILE_INVALID', `плейбук «${playbook.id}» не содержит шагов`);
  }

  const planGoal = renderGoal(playbook, renderVars, goalText);
  const planUserValue = (typeof user_value === 'string' && user_value.trim())
    ? user_value.trim()
    : (playbook.user_value_template
      ? substitute(playbook.user_value_template, renderVars)
      : `Плейбук «${playbook.title}»: ${planGoal}`);
  const criteria = Array.isArray(acceptance_criteria) && acceptance_criteria.length
    ? acceptance_criteria
    : deriveAcceptanceCriteria(playbook, planUserValue);

  return {
    goal: planGoal,
    user_value: planUserValue,
    acceptance_criteria: criteria,
    items,
    // Task-level hooks, resolved at compile time and pinned with the plan's
    // playbook_version. Null when the playbook declares none.
    hooks: compileTaskHooks(playbook),
  };
}

module.exports = {
  compilePlaybook,
  deriveAcceptanceCriteria,
  compileItemHooks,
  compileTaskHooks,
  deriveGithubRepo,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SECONDS,
};
