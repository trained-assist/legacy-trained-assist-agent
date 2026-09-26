const fs = require('fs');
const path = require('path');
const os = require('os');

// Unified per-model health store (issue #1467).
//
// Why: a model/provider "залипает" (opencode-go/deepseek-v4.1-flash intermittently returned
// `Bad Request: {"model":...}`). Before this, ladder health lived in opencode-ladder.js keyed by
// (profile, role, model) — so the SAME upstream model, which appears in the ladders of several
// profiles (deepseek-go, max, value), had its flakiness learned separately in each one, and a
// transient error was not persisted at all. The owner's framing (2026-09-26): "клиент единый
// сервис, единый для всех профилей" → the health of a model is a property of the MODEL, not of
// who is asking; one store, shared by every profile/role.
//
// Backoff: "ошибка разовая обычно" → first retry is short (base 15s), then ×2, capped. Policy lives
// in config/model-routing.json so it is data, not a constant buried in code; the same values are
// also the built-in defaults, so a missing/unreadable config never breaks model selection.
//
// State file: ~/.config/opencode/model-health.json (override OPENCODE_MODEL_HEALTH_FILE for tests).
// The path is resolved lazily on every call (not at require time) so a test can point it at a
// tmpdir and re-require opencode-ladder.js without also having to clear this module's cache.

const DEFAULT_STATE_FILE = path.join(os.homedir(), '.config', 'opencode', 'model-health.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config', 'model-routing.json');

const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 15000,     // first rollback is short — the owner: "ошибка разовая обычно"
  multiplier: 2,     // 15s → 30s → 60s → 120s → 240s → 300s(cap)
  capMs: 300000,
  failureWindowMs: 900000, // failures older than this stop counting against the model
});

function stateFile() {
  return process.env.OPENCODE_MODEL_HEALTH_FILE || DEFAULT_STATE_FILE;
}

function _configFile() {
  return process.env.MODEL_ROUTING_CONFIG || DEFAULT_CONFIG_FILE;
}

// Memoized by path+mtime so repeated resolveModel/recordFailure calls within one turn don't
// re-read the file, but an edited config (test or deploy) is picked up on the next call.
let _cfgCache = { path: null, mtimeMs: -1, value: null };
function loadConfig() {
  const p = _configFile();
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { return {}; }
  if (_cfgCache.path === p && _cfgCache.mtimeMs === mtimeMs) return _cfgCache.value;
  let value = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object') value = parsed;
  } catch (e) {
    console.warn('[model-health] config load failed, using defaults:', e.message);
    value = {};
  }
  _cfgCache = { path: p, mtimeMs, value };
  return value;
}

// Backoff policy (data over code): config value when present and sane, built-in default otherwise.
function policy() {
  const cfg = loadConfig();
  const b = (cfg && cfg.backoff) || {};
  const pick = (k, d) => (Number.isFinite(b[k]) && b[k] > 0 ? b[k] : d);
  return {
    baseMs: pick('baseMs', DEFAULT_BACKOFF.baseMs),
    multiplier: pick('multiplier', DEFAULT_BACKOFF.multiplier),
    capMs: pick('capMs', DEFAULT_BACKOFF.capMs),
    failureWindowMs: pick('failureWindowMs', DEFAULT_BACKOFF.failureWindowMs),
  };
}

// Delay before attempt N of the same model: base * multiplier^(N-1), capped.
function backoffFor(failures, p) {
  const pol = p || policy();
  const n = Math.max(1, Number(failures) || 1);
  return Math.min(pol.baseMs * Math.pow(pol.multiplier, n - 1), pol.capMs);
}

// Named ladder from the central routing config, e.g. ladder('deepseek-go'). Returns null when the
// config has no such ladder — the caller then falls back to a profile's inline `ladder` (legacy).
function ladder(name) {
  if (!name) return null;
  const cfg = loadConfig();
  return (cfg.ladders && cfg.ladders[name]) || null;
}

function _readState() {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Atomic write (tmp+rename), same durability contract as execution-history.js — a crash mid-write
// must never leave a half-written JSON that poisons every later read.
function _writeState(state) {
  const f = stateFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
}

function _isSkippedEntry(e, now) {
  if (!e) return false;
  if (e.skipUntil === null) return true; // config-class: never auto-clears
  if (!e.skipUntil) return false;
  const t = Date.parse(e.skipUntil);
  return Number.isFinite(t) && t > now;
}

// Should this model be skipped right now, for EVERY profile/role sharing it?
function isSkipped(model, now = Date.now()) {
  if (!model) return false;
  return _isSkippedEntry(_readState()[model], now);
}

function get(model) {
  return _readState()[model] || null;
}

function all(now = Date.now()) {
  const state = _readState();
  const out = {};
  for (const [model, e] of Object.entries(state)) {
    out[model] = { ...e, skipped: _isSkippedEntry(e, now) };
  }
  return out;
}

// Records a failure for `model` and returns the stored entry.
//   class 'config'    → skipUntil null (a human must fix the account; never auto-clears)
//   class 'transient' → failures++ and skipUntil = now + backoff(failures)
//   anything else (quota / force / …) → failures++ and skipUntil = now + retryAfterMs
//                                        (or backoff(failures) when no explicit TTL is given)
function recordFailure(model, { class: cls = 'transient', retryAfterMs, errorText } = {}) {
  if (!model) return null;
  const pol = policy();
  const now = Date.now();
  const state = _readState();
  let e = state[model];
  // A stale failure streak (nothing recent) should not keep growing the backoff forever.
  if (!e || (e.firstFailureAt && now - Date.parse(e.firstFailureAt) > pol.failureWindowMs)) {
    e = { failures: 0, firstFailureAt: new Date(now).toISOString() };
  }
  e.failures = (e.failures || 0) + 1;
  e.lastFailureAt = new Date(now).toISOString();
  e.class = cls;
  if (errorText) e.lastError = String(errorText).slice(0, 500);
  if (cls === 'config') {
    e.skipUntil = null;
  } else if (cls === 'transient') {
    e.skipUntil = new Date(now + backoffFor(e.failures, pol)).toISOString();
  } else {
    const ms = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : backoffFor(e.failures, pol);
    e.skipUntil = new Date(now + ms).toISOString();
  }
  state[model] = e;
  _writeState(state);
  return e;
}

// A successful call proves the model works again — clear its whole record.
function recordSuccess(model) {
  if (!model) return;
  const state = _readState();
  if (state[model]) {
    delete state[model];
    _writeState(state);
  }
}

// Remaining backoff for a model, + a small epsilon so a retry scheduled on this delay fires
// strictly AFTER the skip window has expired (otherwise resolveModel would still skip the rung
// and the "retry the SAME model" contract would silently turn into an early degrade).
function nextRetryDelayMs(model, now = Date.now()) {
  if (!model) return null;
  const e = _readState()[model];
  if (!e || !e.skipUntil) return null;
  const t = Date.parse(e.skipUntil);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, t - now) + 250;
}

function clear(model) {
  const state = _readState();
  if (model) delete state[model];
  else for (const k of Object.keys(state)) delete state[k];
  _writeState(state);
}

module.exports = {
  DEFAULT_STATE_FILE, DEFAULT_CONFIG_FILE, DEFAULT_BACKOFF,
  stateFile, policy, backoffFor, ladder,
  isSkipped, get, all,
  recordFailure, recordSuccess, nextRetryDelayMs, clear,
};
