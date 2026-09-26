const fs = require('fs');
const path = require('path');
const modelHealth = require('./model-health');

// Model-ladder resolver for OpenCode profiles (issue #1061 Фаза 1-2; unified per-model health
// issue #1467).
//
// A profile (.opencode/profiles/<name>.json) declares, per agent role, a ladder of models in
// preference order instead of one fixed model. Before each OpenCode invocation the runner asks
// this module to resolve the ladder into the flat {model, agent: {role: {model}}} shape OpenCode
// actually consumes (same shape the old static profiles already had — writeOpencodeMcpConfig in
// claude-runner.js doesn't change). After a failed invocation the runner reports the error back
// here; a quota/rate-limit-class error skips that MODEL (with a TTL), a config-class error
// (one-time account setup, e.g. "Global regions" not enabled) skips it with no TTL and is NOT
// meant to be retried automatically — the caller alerts an operator instead of burning through
// the rest of the ladder.
//
// Ladders are config-driven (issue #1467): a profile carries `"ladderRef": "<name>"` pointing at
// config/model-routing.json's `ladders`, so the model lists are data in ONE place instead of being
// hardcoded in every profile. A profile with an inline `ladder` (legacy) or a flat `model` keeps
// working unchanged, so un-migrated profiles don't break.
//
// Health is stored per MODEL, not per (profile, role, model) — the owner's "клиент единый сервис,
// единый для всех профилей": the same physical model listed in several profiles shares one
// backoff/exhaustion record (src/model-health.js). The `profile`/`role` args on the functions
// below are kept for call-site/back-compat but no longer part of the state key.
const ROLES = ['build', 'plan', 'explore', 'general', 'review'];

// Not more than this many rungs burned per task — a ladder where every rung rate-limits in a
// circle must fail loudly instead of looping forever (issue #1061 testing item 2).
const MAX_LADDER_ATTEMPTS = 5;

// error text -> { class, ttlMs }. 'quota' auto-clears after ttlMs and is safe to burn through
// automatically; 'config' means a human has to fix something account-side (subscription/region
// not enabled, pay-as-you-go balance empty) — never auto-clears, and the caller should alert
// rather than silently keep retrying other rungs on every task.
const CLASSIFIERS = [
  { class: 'config', ttlMs: null, pattern: /subscription required/i },
  { class: 'config', ttlMs: null, pattern: /requires global regions/i },
  { class: 'config', ttlMs: null, pattern: /insufficient account funds/i },
  // Model slug retired/never had free-tier access — confirmed live against OpenRouter
  // 2026-09-23: e.g. "This model is unavailable for free. The paid version is available
  // now - use this slug instead: ...". This is 'quota' (not 'config'): unlike "subscription
  // required" or "insufficient funds", which block the WHOLE account/profile and justify
  // stopping the task to alert an operator, a retired slug is specific to that one rung —
  // the other rungs in the ladder work fine, so the task should just skip forward silently
  // rather than dead-stop it. 30-day TTL is "practically permanent" — the exhaustion outlives
  // any single task's retry loop — without wiring a whole new never-clears-but-still-degrades
  // class through the config/quota branch in runner/index.js for a case this rare. Whoever
  // fixes the ladder should still remove the dead rung from the profile JSON and this TTL
  // becomes moot.
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /unavailable for free/i },
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /model not found/i },
  { class: 'quota', ttlMs: 30 * 24 * 60 * 60 * 1000, pattern: /no endpoints found/i },
  { class: 'quota', ttlMs: 60 * 60 * 1000, pattern: /rate[_\s-]{0,5}limit/i },
  { class: 'quota', ttlMs: 60 * 60 * 1000, pattern: /\b429\b/ },
  { class: 'quota', ttlMs: 24 * 60 * 60 * 1000, pattern: /usage limit/i },
  { class: 'quota', ttlMs: 24 * 60 * 60 * 1000, pattern: /quota[^.]{0,20}exceeded/i },
  // Provider-side capacity issue, not our account's quota — confirmed live 2026-09-23
  // (nemotron-3-ultra-550b-a55b:free returned "Upstream error from Nvidia: Service
  // temporarily overloaded" on 3/3 consecutive calls). Short TTL: this is about the
  // upstream provider being busy right now, not a limit that resets hourly/daily.
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /temporarily overloaded/i },
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /\b503\b/ },
  // opencode's generic server-side error. Confirmed live 2026-09-24: an invalid/retired model
  // slug on the opencode-go gateway (gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra) returns exactly
  // "Unexpected server error" while the valid sibling (gpt-6-luna) works. Without this pattern
  // the ladder only advanced via forceAdvance on retries; a short TTL degrades a dead rung
  // immediately without permanently poisoning a rung that might just be having a transient 5xx.
  { class: 'quota', ttlMs: 5 * 60 * 1000, pattern: /unexpected server error/i },
  // A malformed/rejected model request from the gateway, e.g. `Bad Request: {"model":"deepseek-v4.1-flash"}`
  // (observed live 2026-09-25 on the opencode-go deepseek rung: the same "top" model intermittently
  // rejects a request while its siblings serve fine). Intermittent by nature, so this is NOT a
  // reason to skip the rung right away — retrying the same model a few times is the point
  // (owner 2026-09-26: "частенько багует. нужны ретраи грамотные, альтернатива — если три ретрая
  // не сработали"). Classed 'transient': recordFailure() does NOT mark the rung exhausted and the
  // runner leaves it for the generic same-model retry path; only after the retry budget is spent
  // does forceAdvance() move the task to the sibling rung. Kept LAST of the pre-'context' rules so
  // a more specific signal (429 / usage limit / context) wins when both appear in one error string.
  { class: 'transient', ttlMs: 0, pattern: /bad\s*request/i },
  // The request itself didn't fit this rung's context window — not a quota/config problem
  // with the rung, so unlike the classes above this must NOT persist a shared exhaustion:
  // the next task on this rung (from any user) is very likely a normal-sized prompt that
  // would work fine. recordFailure() below special-cases this class to skip markExhausted
  // entirely; the caller instead skips this one rung for THIS task's own retry only.
  { class: 'context', ttlMs: null, pattern: /context[_\s-]?length/i },
  { class: 'context', ttlMs: null, pattern: /maximum context/i },
  { class: 'context', ttlMs: null, pattern: /context window/i },
  { class: 'context', ttlMs: null, pattern: /prompt is too long/i },
  { class: 'context', ttlMs: null, pattern: /input (?:is )?too long/i },
  { class: 'context', ttlMs: null, pattern: /too many tokens/i },
];

function classifyError(text) {
  const hit = CLASSIFIERS.find(c => c.pattern.test(text || ''));
  return hit ? { class: hit.class, ttlMs: hit.ttlMs } : null;
}

// ---- Shared per-model health (issue #1467) ------------------------------------------------
// Thin compatibility layer over src/model-health.js. The old API (markExhausted/clearExhausted
// with a (profile, role, model) key) is preserved so existing callers and tests keep working, but
// the state now lives in one per-model store shared by every profile.

// Marks `model` skipped. ttlMs null => never auto-clears (config-class), matching the old
// per-profile config-class contract.
function markExhausted(profile, role, model, ttlMs) {
  if (!model) return;
  if (ttlMs == null) modelHealth.recordFailure(model, { class: 'config' });
  else modelHealth.recordFailure(model, { class: 'quota', retryAfterMs: ttlMs });
}

function clearExhausted(profile, role, model) {
  modelHealth.clear(model || undefined);
}

// Classifies an engine error and, if it's ladder-relevant, marks the model exhausted.
// Returns null if the error isn't a ladder-degradation case (caller should handle it as before —
// e.g. the existing isAuthError/cross-engine fallback path for a total auth loss).
function recordFailure(profile, role, model, errorText) {
  const verdict = classifyError(errorText);
  if (!verdict) return null;
  if (verdict.class === 'context') {
    // Deliberately no markExhausted call — see the 'context' CLASSIFIERS entries above.
    // The caller (runner/index.js) skips this rung for its own retry via buildOcProfileOverrides'
    // skipModels, not by writing shared state that would block unrelated, normal-sized tasks.
    return { class: 'context', model, alertNeeded: false };
  }
  if (verdict.class === 'transient') {
    // Shared per-model backoff (issue #1467): the model gets a short, exponentially growing skip
    // window (15s → 30s → 60s …) so every profile dodges it while it's flaky — but the runner
    // still RETRIES THE SAME model once that window elapses (owner 2026-09-26: "три ретрая, потом
    // соседняя модель"). retryAfterMs lets the runner schedule that retry instead of falling back
    // to the generic crash backoff, so the first retry really is ~15s.
    const e = modelHealth.recordFailure(model, { class: 'transient', errorText });
    const retryAfterMs = e && e.skipUntil ? Math.max(0, Date.parse(e.skipUntil) - Date.now()) : null;
    return { class: 'transient', model, alertNeeded: false, retryAfterMs };
  }
  markExhausted(profile, role, model, verdict.ttlMs);
  return { class: verdict.class, model, alertNeeded: verdict.class === 'config' };
}

// Ladder for one role. Config-driven first (issue #1467): a profile may name a ladder from
// config/model-routing.json (`ladderRef`) instead of hardcoding the model list. Legacy shapes stay
// supported: an inline `ladder.<role>`, or the old flat `agent.<role>.model` / top-level `model`
// as a single-rung ladder.
function _roleLadder(profileRaw, role) {
  if (profileRaw.ladderRef) {
    const named = modelHealth.ladder(profileRaw.ladderRef);
    if (named?.[role]?.length) return named[role];
  }
  if (profileRaw.ladder?.[role]?.length) return profileRaw.ladder[role];
  const flat = profileRaw.agent?.[role]?.model || profileRaw.model;
  return flat ? [flat] : [];
}

// First non-skipped model in the role's ladder. Never returns undefined for a non-empty ladder —
// if every rung is currently skipped, degrades to the last rung rather than failing resolution
// outright (some model beats none; the caller's retry-count cap is what prevents an infinite loop,
// not this function refusing to pick anything).
//
// skipModels (optional) additionally excludes specific models WITHOUT touching persisted state —
// used for the context-overflow case, where a rung should be skipped for this one task's retry
// only, not for every other task sharing the same ladder (see recordFailure's 'context' branch).
function resolveModel(profileRaw, profileName, role, skipModels) {
  const ladder = _roleLadder(profileRaw, role);
  if (!ladder.length) return null;
  const skip = skipModels && skipModels.length ? new Set(skipModels) : null;
  const usable = ladder.find(m => !modelHealth.isSkipped(m) && !(skip && skip.has(m)));
  return usable || ladder[ladder.length - 1];
}

// Resolves every role's ladder for a profile into the flat {model, agent: {role: {model, ...}}}
// shape writeOpencodeMcpConfig spreads into the per-invocation OPENCODE_CONFIG. `rolePrompts` in
// the raw profile (e.g. russian's strict-reviewer prompt for `review`) survives ladder
// degradation unchanged — it's about the role, not which model is currently filling it.
//
// opts.skipModels (optional) is a per-task, non-persisted skip list for the `build` role only —
// that's the only role the runner retries within a single task (recordFailure always reports
// role: 'build'), so there's nothing to skip for the other roles.
function buildOcProfileOverrides(profileName, profilesDir, opts) {
  const dir = profilesDir || path.join(__dirname, '..', '.opencode', 'profiles');
  const profileRaw = JSON.parse(fs.readFileSync(path.join(dir, `${profileName}.json`), 'utf8'));
  const skipModels = opts?.skipModels;
  const agent = {};
  for (const role of ROLES) {
    const model = resolveModel(profileRaw, profileName, role, role === 'build' ? skipModels : undefined);
    if (!model) continue;
    agent[role] = { model, ...(profileRaw.rolePrompts?.[role] ? { prompt: profileRaw.rolePrompts[role] } : {}) };
  }
  return {
    model: agent.build?.model || resolveModel(profileRaw, profileName, 'build', skipModels) || profileRaw.model,
    agent,
  };
}

// Forces the ladder to skip `model` on the NEXT resolve, for a bounded window — used by the
// unified crash-retry in runner/index.js to try a different model even when the failure wasn't
// classified as quota/config (a bare crash tells us nothing about which provider is at fault, so
// "try the other one" is a reasonable blind guess — the owner's own framing was "если один то
// второй и наоборот"). Short TTL vs. the hours/days quota TTLs above, because this isn't asserting
// the model IS actually rate-limited — just that this task's own retry schedule shouldn't hammer
// the same rung on every attempt. Shared per model (issue #1467), so `profile`/`role` are vestigial.
const RETRY_FORCE_TTL_MS = 15 * 60 * 1000;

function forceAdvance(profile, role, model) {
  if (!profile || !model) return;
  modelHealth.recordFailure(model, { class: 'force', retryAfterMs: RETRY_FORCE_TTL_MS });
}

// A successful OpenCode run proves the model works — clear its shared health record so a transient
// backoff doesn't linger across tasks after the model has already recovered (issue #1467).
function recordSuccess(model) {
  modelHealth.recordSuccess(model);
}

module.exports = {
  ROLES, MAX_LADDER_ATTEMPTS, RETRY_FORCE_TTL_MS,
  classifyError, resolveModel, buildOcProfileOverrides,
  markExhausted, clearExhausted, recordFailure, forceAdvance, recordSuccess,
  stateFile: modelHealth.stateFile,
};
