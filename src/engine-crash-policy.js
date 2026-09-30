'use strict';
// Decision for the runner's early "quick crash" branch (src/runner/index.js): when an engine
// process exited non-zero having produced almost no output, do we treat it as a TERMINAL crash
// right here (show a crash message and stop), or let it fall through to the provider-fallback
// path further down (_runTask's isAuthError branch → engine_fallback_to_opencode)?
//
// The bug this encodes (2026-09-25): a Codex "usage limit" failure was handled HERE whenever the
// process exited non-zero, returning the "Переключись на другой движок" dead-end — even though
// the exact same error, when the process happened to exit 0, already reached the
// engine_fallback_to_opencode branch and switched providers automatically. The auto-fallback
// therefore depended on an incidental exit code / output size instead of on the error itself.
// Evidence on the live VM: Codex QUOTA with exitCode unset → action engine_fallback_to_opencode
// COMPLETED (08:38); the same QUOTA with exitCode 1 → action null, FAILED, four times in a row
// (10:39–10:44). A user stuck behind a quota-exhausted engine saw no switch.
//
// An auth/quota/usage-limit error on an engine that can still fall back must NOT dead-end here —
// it must fall through so the existing fallback logic runs. Pure and dependency-light so the
// rule is unit-testable without spawning an engine.

const { isAuthError } = require('./auth-flag');

// Below this output length (and with nothing in claudeResult) a non-zero-exit run counts as a
// "quick crash": the process died before producing anything worth showing.
const QUICK_CRASH_MAX_OUTPUT = 50;

// Engines that have an automatic fallback target (OpenCode) in the runner. Mirrors the
// `(engine === 'claude' || engine === 'codex') && !engineFallbackDone` guard on the fallback
// branch so the two can never disagree about whether a fallback is still possible.
function engineCanFallBack(engine, engineFallbackDone) {
  return (engine === 'claude' || engine === 'codex') && !engineFallbackDone;
}

// true  → handle as a terminal quick-crash here (show the crash message).
// false → do NOT return here; fall through so the auth/quota branch can switch providers.
function isTerminalQuickCrash({ exitCode, timedOut, outputLength, hasResult, engine, engineFallbackDone, errorText }) {
  if (exitCode === 0 || timedOut) return false;
  if (outputLength >= QUICK_CRASH_MAX_OUTPUT || hasResult) return false;
  // Provider-unusable error that can still be recovered by switching engines → fall through.
  if (engineCanFallBack(engine, engineFallbackDone) && isAuthError(errorText || '')) return false;
  return true;
}

// Human-facing wording for a provider-unusable failure. A QUOTA / RATE_LIMIT hit is NOT lost
// credentials (spec §7): the engine's auth is fine, it is out of budget for a while. The
// auth-flag split already stopped treating the two as one — but the MESSAGE the runner sends was
// still hardcoded to "потерял авторизацию" for every class, so a user behind an exhausted Codex
// plan was told his login had broken (observed 2026-09-25: live errorText "You've hit your usage
// limit … try again at Sep 29th", failureClass QUOTA, surfaced as "Codex потерял авторизацию").
// Class-aware wording keeps the message honest and actionable.
function isQuotaLikeClass(failureClass) {
  return failureClass === 'QUOTA' || failureClass === 'RATE_LIMIT';
}

function engineFallbackNotice(engineLabel, failureClass, targetLabel = 'OpenCode') {
  const reason = isQuotaLikeClass(failureClass) ? 'упёрся в лимит' : 'потерял авторизацию';
  return `⚠️ ${engineLabel} ${reason} — автоматически переключаюсь на ${targetLabel} для этой задачи.`;
}

// Where a chat task goes when its engine is out of quota / credentials (owner 2026-09-30:
// «архитектор — Claude; кончился лимит → Codex, потом OpenCode»). Claude → Codex while Codex is
// usable (engine health not `unavailable`; an expired verdict reads half-open, so a recovered
// quota is probed instead of being skipped forever), else OpenCode. Codex → OpenCode. This is
// a LATERAL move between the paid engines the user already runs on, not an escalation from a
// cheap model — #1899 (never auto-spend Claude/Codex as insurance for cheap models) still holds:
// nothing here ever routes opencode upward.
function chatFallbackEngine(engine, { healthOf } = {}) {
  if (engine !== 'claude') return 'opencode';
  let status = null;
  try {
    const of = healthOf || (e => require('./engine-health').getEngineHealth(e));
    status = (of('codex') || {}).status || null;
  } catch { status = null; }
  return status === 'unavailable' ? 'opencode' : 'codex';
}

function engineLabelOf(engine) {
  return engine === 'codex' ? 'Codex' : engine === 'opencode' ? 'OpenCode' : 'Claude Code';
}

function engineAuthNotice(engineLabel, failureClass) {
  return isQuotaLikeClass(failureClass)
    ? `⚠️ ${engineLabel} временно упёрся в лимит — оператор уже уведомлён, скоро починим.`
    : `⚠️ Авторизация ${engineLabel} истекла — оператор уже уведомлён, скоро починим.`;
}

// Loop recovery (2026-09-29): a cheap OpenCode model that got stuck (loop guard fired —
// typically bash placeholders instead of the MCP call it wanted) used to dead-end with
// «Переключись на Claude: /switch2klod». ONE automatic re-run of the same task on the FREE
// OpenCode ladder (different models than the stuck deepseek rung) — NEVER Claude/Codex
// (owner requirement #1899: Claude credit is not auto-spent as insurance). The owner can
// still pick Claude by hand. engineFallbackDone guards against a second re-run.
function loopRecoveryEngine(engine, engineFallbackDone) {
  return engine === 'opencode' && !engineFallbackDone ? { engine: 'opencode', ocProfile: 'free' } : null;
}

function loopFallbackNotice() {
  return '⚠️ Модель OpenCode застряла и не смогла выполнить действие — повторяю задачу на других бесплатных моделях.';
}

module.exports = {
  loopRecoveryEngine, loopFallbackNotice,
  isTerminalQuickCrash, engineCanFallBack, QUICK_CRASH_MAX_OUTPUT,
  isQuotaLikeClass, engineFallbackNotice, engineAuthNotice,
  chatFallbackEngine, engineLabelOf,
};
