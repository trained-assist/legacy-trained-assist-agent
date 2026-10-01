'use strict';
// One admission point for "may this run use engine X", so that the answer can never depend on
// which code path asked. Before this module the runner had the auth gate, the boot-resume path
// had a hard-coded `p.engine || 'claude'`, the durable executor had `doctor → claude`, and
// hermes had its own default: four places, four answers, and one of them kept resurrecting Claude
// from the pending journal long after the profile itself was switched to OpenCode (live
// 2026-10-01: `[resume] fallback engine=claude` while every sibling session resumed on opencode).
//
// Three distinct states, deliberately not collapsed into "available / not available":
//
//   null                    — Claude may run. Nothing was asked of the owner.
//   'owner_switch_off'      — the owner deliberately keeps Claude off (AGENT_CLAUDE_SWITCH=off)
//                             or has no authorization installed and the broker suspended the
//                             engine. Silence is the correct behaviour: there is nothing to
//                             report about an engine nobody asked for.
//   'auth_gate' | 'suspended' — Claude WAS expected (profile engine, /switch2klod, a doctor step)
//                             and is broken. This is the only case worth a Telegram notice.
//
// The lateral move goes to the profile's own engine when it is not Claude — the runner used to
// hard-code codex here, so a profile that had deliberately moved to OpenCode got Codex instead
// (and the notice even said so), with no way to ask for anything else.

const { authGate, getAuthFlag } = require('./auth-flag');

const ENGINES = ['claude', 'codex', 'opencode'];

function normEngine(engine) {
  return ENGINES.includes(engine) ? engine : null;
}

// Owner switch. Kept as an env var on purpose: it must work for every profile at once and
// survive a deploy without a code change, and «поставь авторизацию — включим обратно» is one
// systemctl edit. 'on' is the default and means «no deliberate switch», NOT «force Claude past
// a suspension» — a broken credential is still broken.
function ownerSwitchedOff() {
  return String(process.env.AGENT_CLAUDE_SWITCH || '').toLowerCase() === 'off';
}

// { blocked, reason, failedAt } — why Claude may not run right now (or null when it may).
function claudeAdmission(opts = {}) {
  if (ownerSwitchedOff()) return { blocked: true, reason: 'owner_switch_off', failedAt: null };
  const gate = authGate('claude', opts);
  if (gate.blocked) {
    return {
      blocked: true,
      reason: gate.suspended ? 'suspended' : 'auth_gate',
      failedAt: gate.failedAt || null,
    };
  }
  return { blocked: false, reason: null, failedAt: null };
}

// Cheap predicate for callers that only need yes/no (the durable level map, hermes).
function claudeAdmissible(opts = {}) {
  return !claudeAdmission(opts).blocked;
}

/**
 * Decide the engine for one run.
 *
 * @param {object}        opts
 * @param {string|null}   opts.requested      engine the caller wanted (may be null/unknown)
 * @param {string|null}   opts.profileEngine  engine the profile is configured for (the lateral target)
 * @param {string[]}      opts.fallbackChain  extra targets tried before the safe default
 * @param {object}        opts.gateOpts       forwarded to authGate (tests pin the clock this way)
 * @returns {{engine: string, movedFrom: string|null, reason: string|null, notice: boolean}}
 */
function resolveEngine({ requested, profileEngine = null, fallbackChain = [], gateOpts = {} } = {}) {
  const want = normEngine(requested);
  if (want !== 'claude') return { engine: want || 'opencode', movedFrom: null, reason: null, notice: false };

  const admission = claudeAdmission(gateOpts);
  if (!admission.blocked) return { engine: 'claude', movedFrom: null, reason: null, notice: false };

  const candidates = [normEngine(profileEngine), ...fallbackChain.map(normEngine), 'opencode']
    .filter((e, i, arr) => e && e !== 'claude' && arr.indexOf(e) === i);
  return {
    engine: candidates[0] || 'opencode',
    movedFrom: 'claude',
    reason: admission.reason,
    // Only a real breakage the owner did not ask for is news. Silence for a deliberate switch and
    // for a suspension: in both states nobody is waiting for Claude, and a «⚠️ Авторизация Claude
    // недоступна» every cooldown is what made «мы его отключили, а он всё равно зовётся» look true.
    // A user who explicitly asks for Claude is answered inline instead — see profile-commands.js.
    notice: admission.reason === 'auth_gate',
  };
}

// The engine-switch commands must refuse to promise what admission would take away two seconds
// later: /switch2klod while Claude is suspended would set a preference that every run silently
// overrides. Callers use this to answer «сейчас Claude не запустится, потому что …».
function claudeUnavailableReason() {
  return claudeAdmission().reason;
}

function isSuspended() {
  return !!getAuthFlag('claude').suspended;
}

module.exports = {
  resolveEngine, claudeAdmission, claudeAdmissible, claudeUnavailableReason,
  ownerSwitchedOff, isSuspended,
};