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
const { claudeAdmissible } = require('./engine-admission');

// level → {engine, ocProfile}. bachelor/master are OpenCode ladder profiles;
// doctor is the strongest tier and runs on Claude (cross-engine fallback /
// degradation is the recovery slice P3c). `free` vs `service` for bachelor is a
// product choice — default `service` (the standard Go ladder) for stable availability;
// override with PLAYBOOK_LEVEL_MAP={"bachelor":{"engine":"opencode","ocProfile":"free"}}.
const DEFAULT_LEVEL_MAP = Object.freeze({
  // Both OpenCode levels run on the standard service ladder (owner 2026-09-27) — the old
  // `value` led with paid OpenRouter and `max` ended on it, which is how durable/web steps leaked
  // there. Whole ladder dead (every rung failed → CONFIG) → the free ladder, NEVER Claude/Codex
  // (owner 2026-09-29, #1899): Claude credit is kept for critical work; auto-spending it when
  // cheap quotas run out drains it exactly when it's needed. Guarded by test/failure-classifier.
  bachelor: { engine: 'opencode', ocProfile: 'service', fallback: [{ engine: 'opencode', ocProfile: 'free' }] },
  master: { engine: 'opencode', ocProfile: 'service', fallback: [{ engine: 'opencode', ocProfile: 'free' }] },
  // Claude has no model ladder of its own. When an engine is unavailable (engine
  // health) or this step already failed on it with AUTH/CONFIG, the step runs on the
  // next rung of `fallback` instead of failing: claude → codex → opencode `doctor`
  // profile (owner 2026-09-28, #1689: Go MiMo first, then stronger models — not the
  // cheapest `deepseek` tier). This is the CROSS-ENGINE rung ladder and it is owned
  // here; the model ladder INSIDE the opencode rung lives in the llm-ladder worker
  // (#1687 landed — the earlier «interim local copy, keep in sync» note referred to
  // that worker-side ladder, not to this table). Default, overridable per plan / env.
  doctor: { engine: 'claude', ocProfile: null, fallback: [
    { engine: 'codex', ocProfile: null },
    { engine: 'opencode', ocProfile: 'doctor' },
  ] },
});

// executor_role → OpenCode agent role (opencode-ladder ROLES).
const ROLE_TO_OC = Object.freeze({
  researcher: 'explore',
  developer: 'build',
  reviewer: 'review',
  verifier: 'review',
});
// researcher used to be pinned to the `research` profile (OpenCode Go subscription, MiMo)
// for playbook steps too. Owner 2026-10-01 incident: both Go keys hit the WEEKLY usage cap;
// opencode then retries the 429 silently (no stdout) until the 5-min inactivity watchdog
// kills it — every research step of every plan "timed out" and burned its attempts. A
// flat-cap subscription is not a durable-step route: playbook researchers now go through
// the llm-ladder like every other level (the worker owns provider failover). hermes_research
// keeps its own Go pin (opencode-ladder-provider DIRECT_MODEL). Env PLAYBOOK_ROLE_MAP can
// re-pin it.
const DEFAULT_ROLE_MAP = Object.freeze({});

// role × level routes that beat the plain level map. reviewer@doctor is the INDEPENDENT
// review (owner 2026-09-30): the doctor builder runs on Claude, so the strongest review must
// come «с другой стороны» — a different model family. Codex first, then the OpenCode doctor
// profile; never Claude (a Claude review of Claude's work is not independent). Applies on the
// normal rung only, like role overrides; a plan with its own level_map runs without role
// routing (gtd-controller passes useRoleMap:false), so a pinned plan still owns every step.
const DEFAULT_ROLE_LEVEL_MAP = Object.freeze({
  reviewer: Object.freeze({
    doctor: { engine: 'codex', ocProfile: null, fallback: [{ engine: 'opencode', ocProfile: 'doctor' }] },
  }),
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

function loadRoleMap() {
  const raw = process.env.PLAYBOOK_ROLE_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    console.warn('[playbook-executor] bad PLAYBOOK_ROLE_MAP:', e.message);
    return {};
  }
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
// Per-plan override: execution_policy.level_map (same shape as PLAYBOOK_LEVEL_MAP)
// replaces only the levels it names, on top of env/default. Lets one plan (e.g. the
// playbook e2e harness) run its levels on different engines without touching prod.
function planLevelMap(policy) {
  const base = loadLevelMap();
  const over = policy && typeof policy === 'object' ? policy.level_map : null;
  if (!over || typeof over !== 'object') return base;
  const merged = { ...base };
  for (const level of LEVELS) {
    const m = over[level];
    if (m && typeof m === 'object' && (m.engine === 'opencode' || m.engine === 'claude' || m.engine === 'codex')) merged[level] = m;
  }
  return merged;
}

// Quality escalation: the next level whose resolved engine/profile actually differs
// from the current one (with bachelor and master on the same profile, a one-rung
// bump would change nothing). null at the ceiling. Automatic escalation never lands on
// Claude/Codex unless allowPaid (owner requirement #1899: no paid insurance when cheap
// models run OUT OF QUOTA). Since 2026-10-01 durable-recovery passes allowPaid for every
// plan unless it sets execution_policy.quality_escalation_to_doctor=false (owner: «по
// дефолту OpenCode, Claude на doctor и на эскалации» — опенкод облажался → Claude). The opt-in covers QUALITY failures only; quota /
// provider exhaustion never reaches this function, so #1899 still holds there.
function nextDistinctLevel(item, levelMap, { allowPaid = false } = {}) {
  const cur = resolveStepExecution(item, { levelMap, useRoleMap: false });
  const from = LEVELS.indexOf(cur.modelLevel);
  if (from < 0) return null;
  for (let i = from + 1; i < LEVELS.length; i++) {
    const r = resolveStepExecution({ ...item, current_model_level: LEVELS[i] }, { levelMap, useRoleMap: false });
    if (r.engine !== 'opencode') return allowPaid ? LEVELS[i] : null;
    if (r.engine !== cur.engine || r.ocProfile !== cur.ocProfile) return LEVELS[i];
  }
  return null;
}

function resolveStepExecution(item = {}, { defaultEngine = null, levelMap = null, roleMap = null, useRoleMap = true } = {}) {
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

  // A step without a full contract (legacy task_create items, a playbook step that
  // forgot role/level) runs on OpenCode at the master level (owner 2026-10-01: «по
  // дефолту OpenCode, Claude только на doctor и эскалации»). Claude is reachable only
  // through an explicit doctor level or quality escalation. `defaultEngine` still lets
  // a caller pin the pre-2026-10 behaviour.
  if (!role || !level) {
    if (defaultEngine) {
      return { executionKind, engine: defaultEngine, ocProfile: null, ocRole: null, skipModels: [], modelLevel: level, reason: 'no-contract' };
    }
    const r = resolveStepExecution({ ...item, executor_role: role || 'developer', minimum_model_level: level || 'master', current_model_level: level || 'master' },
      { levelMap: map, roleMap, useRoleMap: false });
    return { ...r, reason: 'no-contract' };
  }

  // A role override is intended for the normal rung only. Once durable recovery
  // escalates current_model_level, the ordinary level map regains control.
  const roleOverrides = { ...DEFAULT_ROLE_MAP, ...(roleMap || loadRoleMap()) };
  // A plan that pins its own routing (execution_policy.level_map, e.g. the playbook
  // e2e harness) owns every step's engine — role defaults don't override it.
  const normalRung = useRoleMap && item.current_model_level === item.minimum_model_level;
  const roleLevelMapped = normalRung ? (DEFAULT_ROLE_LEVEL_MAP[role] || {})[level] : null;
  const roleMapped = roleLevelMapped || (normalRung ? roleOverrides[role] : null);
  const mapped = roleMapped || map[level] || DEFAULT_LEVEL_MAP[level];
  const ocRole = mapped.engine === 'opencode' ? (ROLE_TO_OC[role] || 'build') : null;
  const fbList = Array.isArray(mapped.fallback) ? mapped.fallback
    : (mapped.fallback && typeof mapped.fallback === 'object' ? [mapped.fallback] : []);
  const toStep = (m) => ({
    engine: m.engine,
    ocProfile: m.engine === 'opencode' ? m.ocProfile : null,
    ocRole: m.engine === 'opencode' ? (ROLE_TO_OC[role] || 'build') : null,
  });

  // Claude cannot actually run without authorization: it dies on 401 before doing any work and the
  // step burns one of its three attempts doing so (live 2026-10-01: the doctor rung and the
  // default-on quality escalation both aimed at a host whose Claude credentials were suspended).
  // So a claude target is honoured only while admission allows it; otherwise the step takes the
  // level's OWN fallback list — the rungs that map already declares as «if the primary is unusable»
  // — instead of a hard-coded substitute. Applies to a plan's pinned level_map too: «не зови Claude»
  // is an owner-level decision about the machine, not a preference one plan may overrule.
  //
  // The number of rungs stays EXACTLY what the level map declares. Two invariants depend on it and
  // both broke when an extra safety rung was appended here (caught by CI on #2018):
  //   reviewer@doctor is asserted to be [codex → opencode doctor] and nothing more, and
  //   durable-recovery treats a step with NO fallbacks as terminal — an unconditional extra rung
  //   turns every terminal engine failure into an endless re-pend on a fallback engine.
  // So: substitution only. If every declared rung is inadmissible, the step runs on opencode with
  // no fallbacks (its pre-existing shape) rather than silently gaining rungs it never had.
  const candidates = [mapped, ...fbList].filter(m => m && m.engine);
  const admissible = candidates.filter(m => m.engine !== 'claude' || claudeAdmissible());
  const primary = admissible[0] || { engine: 'opencode', ocProfile: null };
  const rest = admissible.slice(1).map(toStep);

  return {
    executionKind,
    engine: primary.engine,
    ocProfile: primary.engine === 'opencode' ? primary.ocProfile : null,
    ocRole: primary.engine === 'opencode' ? (ROLE_TO_OC[role] || 'build') : null,
    fallbacks: rest,
    // context_budget → skipModels is a no-op until a model→context registry
    // exists (design §4.3). Kept in the contract so P3c can populate it.
    skipModels: [],
    modelLevel: level,
    reason: `level:${level}`,
  };
}

module.exports = { resolveStepExecution, planLevelMap, nextDistinctLevel, DEFAULT_LEVEL_MAP, DEFAULT_ROLE_MAP, DEFAULT_ROLE_LEVEL_MAP, ROLE_TO_OC, LEVELS, ROLES, loadRoleMap };
