'use strict';
// Chat / non-durable ladder fallback (#1899 пункты 2–3).
//
// When the llm-ladder worker answers `ladder_exhausted` (502 ladder_error "every rung failed" —
// the Go allowance is spent on every key AND the OpenRouter tail has no money), the run must not
// die with «попробуй позже», and it must never pull Claude/Codex in as paid insurance (owner
// requirement #1899: the Claude balance is reserved for explicitly chosen work). ONE automatic
// re-run of the same task on the FREE ladder does the rescue, guarded by `ladderFallbackDone` —
// exactly like `engineFallbackDone` guards the engine fallback, so the retry happens once per run.
//
//   worker_unreachable → stays BLOCKED (the worker never served the call — a service outage is
//                        not "the rungs refused"; retrying it here would just re-hit the outage)
//   context            → stays FAILED (the prompt is too big for the model; the user must split it)
//   ladder_exhausted   → ONE re-run on opencode/free, never on claude/codex
//
// Durable plan steps are out of scope here (`durable: true` → no re-run): their own free-ladder
// fallback is the durable executor's CONFIG → `fallback_rung` recovery (src/durable-recovery.js,
// #1900/#1901), and a second in-run mechanism on top of it would only burn the step's attempts.
//
// The user is told ONCE per profile that the service moved to the free tier (#1899 п.3). The
// flag lives in the profile's context store — contexts/ladder/free-tariff.json, same 0600
// atomic write as every other context file — so repeated switches stay silent.

const fs = require('fs');
const { atomicJson } = require('./atomic-json');
const { contextFilePath } = require('./data-paths');

// Owner wording (#1899 п.3): cheap models exhausted → we are on the free tier, quality may drop.
const FREE_TARIFF_WARNING = '⚠️ Дешёвые модели исчерпаны, работаем на бесплатной ступени — качество может быть ниже.';

// What the chat shows while the one free re-run is queued.
const FREE_RETRY_NOTICE = '🔄 Повторяю задачу один раз на бесплатной ступени (лестница «free»)…';

// The ONLY automatic ladder rescue of a chat run: opencode → opencode/free, once.
// Anything else (another engine, another worker failure class, already retried, a durable plan
// step) is null and the caller keeps its existing terminal message. Never returns claude/codex
// (owner requirement #1899).
function ladderFallbackTarget({ engine, workerFailure, ladderFallbackDone, durable = false }) {
  if (engine !== 'opencode') return null;
  if (workerFailure !== 'ladder_exhausted') return null;
  if (ladderFallbackDone) return null;
  if (durable) return null;
  return { engine: 'opencode', ocProfile: 'free' };
}

function freeTariffFlagFile(username) {
  return contextFilePath(username, 'ladder', 'free-tariff');
}

function hasFreeTariffWarning(username) {
  if (!username) return false;
  try {
    return !!JSON.parse(fs.readFileSync(freeTariffFlagFile(username), 'utf8')).value;
  } catch { return false; }
}

// Claim this profile's ONE free-tariff warning: true for the first switch (send the warning),
// false for every later one (stay silent). An unwriteable flag must not swallow the warning —
// the user still gets it, we just cannot remember it.
function claimFreeTariffWarning(username) {
  if (!username) return true;
  if (hasFreeTariffWarning(username)) return false;
  try {
    atomicJson(freeTariffFlagFile(username), { value: true, updated_at: new Date().toISOString() }, { space: 2 });
  } catch (e) {
    console.warn('[ladder-fallback] free-tariff flag write failed:', e.message);
  }
  return true;
}

// The message the chat gets when the run is re-run on the free ladder: the one-time tariff
// warning on the profile's first switch, the retry notice every time.
function ladderFallbackMessage(username) {
  const firstSwitch = claimFreeTariffWarning(username);
  return [firstSwitch ? FREE_TARIFF_WARNING : null, FREE_RETRY_NOTICE].filter(Boolean).join('\n');
}

module.exports = {
  FREE_TARIFF_WARNING, FREE_RETRY_NOTICE,
  ladderFallbackTarget, ladderFallbackMessage,
  freeTariffFlagFile, hasFreeTariffWarning, claimFreeTariffWarning,
};
