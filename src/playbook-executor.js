'use strict';

// Playbook executor resolver (issue #1372, slice P3b).
//
// Pure: maps a task item's contract (executor_role + minimum_model_level, with
// context_budget accepted for forward compatibility) onto the concrete
// {engine, ocProfile, ocRole} the runner should use for that step. NO IO, NO
// ladder state — side effects (executions rows, failure handling) stay in
// gtd-controller / the runner.
//
// A playbook never names a concrete model/provider: it declares the *shape* of
// executor a step needs, and this module turns that into our ladder profiles
// (#1061). The mapping is data (LEVEL_MAP), overridable per run / via env, so a
// product decision ("bachelor → free vs value") is a config change, not a code
// change.

const LEVELS = ['bachelor', 'master', 'doctor'];
const ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];

// level → {engine, ocProfile}. bachelor/master are OpenCode ladder profiles;
// doctor is the strongest tier and runs on Claude (cross-engine fallback /
// degradation is the recovery slice P3c). `free` vs `value` for bachelor is a
// product choice — default `value` (deepseek/glm) for stable availability;
// override with PLAYBOOK_LEVEL_MAP={"bachelor":{"engine":"opencode","ocProfile":"free"}}.
const DEFAULT_LEVEL_MAP = Object.freeze({
  // Both OpenCode levels run on the standard Go deepseek profile (owner 2026-09-27) — `value`
  // led with paid OpenRouter and `max` ended on it, which is how durable/web steps leaked there.
  bachelor: { engine: 'opencode', ocProfile: 'deepseek' },
  master: { engine: 'opencode', ocProfile: 'deepseek' },
  doctor: { engine: 'claude', ocProfile: null },
});

// executor_role → OpenCode agent role (opencode-ladder ROLES).
const ROLE_TO_OC = Object.freeze({
  researcher: 'explore',
  developer: 'build',
  reviewer: 'review',
  verifier: 'review',
});

function loadLevelMap() {
  const raw = process.env.PLAYBOOK_LEVEL_MAP;
  if (!raw) return DEFAULT_LEVEL_MAP;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const merged = { ...DEFAULT_LEVEL_MAP };
      for (const level of LEVELS) {
        if (parsed[level] && typeof parsed[level] === 'object') merged[level] = parsed[level];
      }
      return merged;
    }
  } catch (e) {
    console.warn('[playbook-executor] bad PLAYBOOK_LEVEL_MAP:', e.message);
  }
  return DEFAULT_LEVEL_MAP;
}

/**
 * Resolve the engine/profile/role for one task item.
 *
 * @param {object} item  task_items row (execution_kind, executor_role,
 *                       minimum_model_level, current_model_level, context_budget)
 * @param {object} [opts]
 * @param {string} [opts.defaultEngine='claude'] engine for a legacy/contract-less
 *                       step — no override, keeps the pre-P3b behaviour.
 * @param {object} [opts.levelMap] override the level→engine/profile table.
 * @returns {{executionKind,engine,ocProfile,ocRole,skipModels,modelLevel,reason}}
 */
function resolveStepExecution(item = {}, { defaultEngine = 'claude', levelMap = null } = {}) {
  const map = levelMap || loadLevelMap();
  const executionKind = item && item.execution_kind === 'programmatic' ? 'programmatic' : 'agent';

  if (executionKind === 'programmatic') {
    return { executionKind, engine: null, ocProfile: null, ocRole: null, skipModels: [], modelLevel: null, reason: 'programmatic' };
  }

  const role = ROLES.includes(item.executor_role) ? item.executor_role : null;
  // current_model_level may exceed the minimum after a P3c escalation — use it
  // so an escalated step is never silently reset to a cheaper engine.
  const level = LEVELS.includes(item.current_model_level) ? item.current_model_level
    : LEVELS.includes(item.minimum_model_level) ? item.minimum_model_level
    : null;

  if (!role || !level) {
    return { executionKind, engine: defaultEngine, ocProfile: null, ocRole: null, skipModels: [], modelLevel: level, reason: 'no-contract' };
  }

  const mapped = map[level] || DEFAULT_LEVEL_MAP[level];
  const ocRole = mapped.engine === 'opencode' ? (ROLE_TO_OC[role] || 'build') : null;
  return {
    executionKind,
    engine: mapped.engine,
    ocProfile: mapped.engine === 'opencode' ? mapped.ocProfile : null,
    ocRole,
    // context_budget → skipModels is a no-op until a model→context registry
    // exists (design §4.3). Kept in the contract so P3c can populate it.
    skipModels: [],
    modelLevel: level,
    reason: `level:${level}`,
  };
}

module.exports = { resolveStepExecution, DEFAULT_LEVEL_MAP, ROLE_TO_OC, LEVELS, ROLES };
