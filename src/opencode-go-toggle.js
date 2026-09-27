const fs = require('fs');
const path = require('path');
const os = require('os');

// Global (VM-wide, NOT per-trained-assist-profile) go/openrouter toggle for the shared
// "deepseek" OpenCode profile pair (issue #1096).
//
// Why this is separate from opencode-ladder.js's per-(ocProfile,role,model) exhaustion state:
// the team empirically confirmed the OpenCode Go subscription's rate limit is ACCOUNT-WIDE, not
// per-model — heavy use of one Go model (grok-4.7) exhausted a completely different Go model
// (deepseek-v4.1-flash) too. deepseek-go.json / deepseek-openrouter.json are each a single
// uniform model (no per-role ladder — issue #1096 explicitly asks not to vary by role), so
// there's nothing to "degrade to the next rung" within the profile the way max/value do; a Go
// quota hit here means "flip the whole VM to the other gateway", not "try a different model".
// trained-assist-agent runs on one shared GCP VM for the whole 3-person team, so a single state
// file here is sufficient — no cross-machine sync needed (unlike the sibling personal tool
// claude-session-manager, where each person has their own machine).
const STATE_FILE = process.env.OPENCODE_GO_MODE_FILE ||
  path.join(os.homedir(), '.config', 'opencode', 'go-mode.json');

// How long ANY switch to OpenRouter lasts before the next task tries Go again. Deliberately short
// (owner 2026-09-27): OpenRouter is metered and burned the whole balance while the toggle sat on it
// for hours. Trying Go again is cheap — a still-exhausted Go key fails fast with a quota error,
// noteFailure() rotates keys / flips back here, and the task retries — so a short window costs at
// most a couple of fast failed Go calls per window, while a recovered Go is picked up within minutes
// instead of the old ~5h (the Go console's full rate-limit window).
const AUTO_REVERT_MS = Number(process.env.OPENCODE_GO_REVERT_MS) || 15 * 60 * 1000;
// Floor for an automatic OpenRouter stint, so a key whose TTL is about to lapse doesn't bounce the
// VM straight back onto a gateway that just failed.
const MIN_OPENROUTER_MS = 60 * 1000;

function _read() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function _write(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Returns 'go' | 'openrouter'. EVERY switch to 'openrouter' is time-boxed and reverts to 'go' on
// its own once autoRevertAt passes — manual ones included. Before 2026-09-27 a manual
// /oc_openrouter stuck forever; one was left on and silently drained the whole OpenRouter balance.
// State files written by older code (manual, autoRevertAt null) get a revert time on first read.
function getMode() {
  const state = _read();
  if (!state || state.mode !== 'openrouter') return 'go';
  if (!state.autoRevertAt) {
    const base = Date.parse(state.switchedAt) || Date.now();
    state.autoRevertAt = new Date(base + AUTO_REVERT_MS).toISOString();
    _write(state);
  }
  if (Date.parse(state.autoRevertAt) <= Date.now()) {
    _write({ mode: 'go', switchedAt: new Date().toISOString(), switchedBy: 'auto-revert', autoRevertAt: null });
    return 'go';
  }
  return 'openrouter';
}

// When an automatic switch to OpenRouter should end: as soon as the first exhausted Go key heals
// (its TTL follows the error class — a 429 or a 503 heals far sooner than a daily cap), capped at
// AUTO_REVERT_MS. A manual switch always gets the full AUTO_REVERT_MS.
function _revertAt(now, auto) {
  let at = now + AUTO_REVERT_MS;
  if (auto) {
    try {
      const next = require('./opencode-go-keys').nextUsableAt(now);
      // next === 0 ⇒ no parked key on record (single-key pool: rotate() doesn't track it) — keep
      // the cap rather than bouncing back to a gateway we know nothing about.
      if (next) at = Math.min(at, Math.max(next, now + MIN_OPENROUTER_MS));
    } catch { /* keep the cap */ }
  }
  return at;
}

function setMode(mode, { auto = false } = {}) {
  const clean = mode === 'openrouter' ? 'openrouter' : 'go';
  const now = Date.now();
  _write({
    mode: clean,
    switchedAt: new Date(now).toISOString(),
    switchedBy: auto ? 'auto' : 'manual',
    autoRevertAt: clean === 'openrouter' ? new Date(_revertAt(now, auto)).toISOString() : null,
  });
  return clean;
}

// The concrete .opencode/profiles/<name>.json to load for the shared "deepseek" logical profile
// a user selects via /oc_deepseek.
function resolveProfileName() {
  return getMode() === 'openrouter' ? 'deepseek-openrouter' : 'deepseek-go';
}

// Called on an OpenCode invocation failure for the "deepseek" logical profile. Only acts when the
// failing model is on the opencode-go/* provider (an OpenRouter-side failure isn't this toggle's
// concern) and the error classifies as a quota hit (reuses opencode-ladder's own classifier so
// "Go usage limit exceeded" etc. stay defined in one place, not duplicated).
//
// Two-stage degradation, both returning true = "retry this task":
//   1. If another provisioned Go key exists, rotate auth.json onto it and STAY on the Go gateway
//      (opencode-go-keys.js) — fresh quota beats a different gateway.
//   2. Only once every key is exhausted, flip the VM-wide mode to 'openrouter' (auto-revert
//      after AUTO_REVERT_MS, ~15 min).
// Callers distinguish the two via getMode() (unchanged = key rotation).
function noteFailure(model, errorText) {
  if (!/^opencode-go\//.test(model || '')) return false;
  if (getMode() === 'openrouter') return false; // already switched
  const { classifyError } = require('./opencode-ladder');
  const keys = require('./opencode-go-keys');
  // A rejected key ("Invalid credential" / 401) is a dead key, not a dead gateway: rotate exactly
  // like a quota hit, but park it for a day. Before 2026-09-26 this fell through as an unclassified
  // error, so every Go call on the VM failed until a human noticed (and each resume burned its
  // attempts against the same dead key while the ladder degraded pointlessly between models).
  const dead = isDeadKeyError(errorText);
  const verdict = classifyError(errorText);
  if (!dead && (!verdict || verdict.class !== 'quota')) return false;
  // Park the key only as long as the error class says it's burned (503/server error → 5min, others
  // capped at EXHAUST_TTL_MS). A flat 5h for every quota-class error meant two
  // passing 503s parked both keys and put the whole VM on paid OpenRouter for 5 hours.
  const ttlMs = dead ? keys.DEAD_KEY_TTL_MS
    : Math.min(Number.isFinite(verdict.ttlMs) ? verdict.ttlMs : keys.EXHAUST_TTL_MS, keys.EXHAUST_TTL_MS);
  const rotated = keys.rotate({ ttlMs });
  if (rotated) {
    console.log(`[opencode-go-toggle] Go key ${rotated.fromIndex} ${dead ? 'REJECTED (invalid credential)' : 'exhausted'} — rotated to key ${rotated.toIndex}, staying on Go`);
    return true;
  }
  setMode('openrouter', { auto: true });
  return true;
}

function isDeadKeyError(errorText) {
  return /invalid credential|invalid api key|\b401\b|unauthorized/i.test(String(errorText || ''));
}

// Unconditional flip for the unified crash-retry in runner/index.js — same "if one fails, try
// the other, and vice versa" policy as opencode-ladder.js's forceAdvance, but for the deepseek
// go/openrouter pair, which has no ladder rungs to degrade through. Unlike noteFailure() this
// does NOT require the error to classify as quota — a bare crash retry alternates blind, on
// every unified retry attempt, so three retries toggle go→openrouter→go.
function forceFlip() {
  const next = getMode() === 'go' ? 'openrouter' : 'go';
  return setMode(next, { auto: true });
}

module.exports = { STATE_FILE, AUTO_REVERT_MS, MIN_OPENROUTER_MS, getMode, setMode, resolveProfileName, noteFailure, forceFlip, isDeadKeyError };
