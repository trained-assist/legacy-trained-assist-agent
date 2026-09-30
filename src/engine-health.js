'use strict';
// Engine Health — current operational state per engine (claude|codex|opencode), kept SEPARATE
// from Credentials (auth-flag.js / CLI credential stores) and from Failure Events
// (execution-history.js). Spec: storage-paths-auth-refactor §7–§10.
//
//   healthy     — the last authenticated engine call succeeded
//   degraded    — recent relevant failure(s), still below the unavailable threshold
//   unavailable — >= ENGINE_UNAVAILABLE_AFTER_FAILURES consecutive relevant failures
//
// Credentials vs health: only the AUTH failure class means "credentials invalid". QUOTA,
// RATE_LIMIT, CONFIG, TRANSIENT, … degrade health but must NEVER be reported as an auth loss —
// conflating them is exactly what made the old flat auth flag lie (a QUOTA_EXCEEDED was written
// as if credentials were broken). markEngineSuccess self-heals the current state; failure
// HISTORY is not erased — it stays in execution-history.js.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { engineHealthDbPath } = require('./data-paths');

const ENGINES = ['claude', 'codex', 'opencode'];

// Failure classes that reflect a real engine/provider problem and should move health.
// USER_STOP is intentional user action; UNKNOWN is too noisy (incomplete tasks, parser gaps) —
// neither should degrade an engine's health.
const HEALTH_RELEVANT = new Set([
  'AUTH', 'QUOTA', 'RATE_LIMIT', 'TRANSIENT', 'MODEL_ERROR', 'CONTEXT', 'CONFIG', 'TOOL_ERROR',
]);

// Only AUTH means the credentials themselves are invalid. Everything else is health, not creds.
const CREDENTIAL_INVALID = new Set(['AUTH']);

// Infer VM name the same way auth-flag.js does: explicit env > URL hint > default.
const VM_NAME = process.env.VM_NAME ||
  (process.env.AGENT_PUBLIC_URL?.includes('178.212') ? 'ru-vm' : 'gcp-main');

let _db = null;
let _stmts = null;

// N consecutive relevant failures before an engine is considered unavailable (spec §10).
function unavailableAfter() {
  const n = parseInt(process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES || '3', 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

// Half-open circuit breaker. `unavailable` used to be terminal until a SUCCESSFUL call — but
// every router (durable fallback ladder, chat fallback) skips an unavailable engine, so that
// success never came: codex hit QUOTA on 2026-09-26 and stayed `unavailable` for days after its
// quota had long reset, silently dropping the doctor ladder to claude → opencode. Now the
// unavailable verdict EXPIRES: once the last failure is older than the cooldown, readers see
// `degraded` + half_open:true, so the next routed call is a probe. A failed probe refreshes
// last_failure_at (a new cooldown starts, no new operator alert — the stored row never left
// `unavailable`); a successful one self-heals through markEngineSuccess. AUTH (credentials
// really invalid) waits longer than quota/transient classes.
function cooldownMs(failureClass) {
  const env = failureClass === 'AUTH'
    ? process.env.ENGINE_AUTH_COOLDOWN_SEC
    : process.env.ENGINE_UNAVAILABLE_COOLDOWN_SEC;
  const dflt = failureClass === 'AUTH' ? 6 * 3600 : 3600;
  const n = parseInt(env || String(dflt), 10);
  return (Number.isFinite(n) && n >= 0 ? n : dflt) * 1000;
}

function _effective(row, nowMs = Date.now()) {
  if (!row || row.status !== 'unavailable' || !row.last_failure_at) return row;
  const since = nowMs - Date.parse(row.last_failure_at);
  if (!(since >= cooldownMs(row.last_failure_class))) return row;
  return { ...row, status: 'degraded', half_open: true };
}

function normalizeEngine(engine) {
  return ENGINES.includes(engine) ? engine : 'claude';
}

function _open() {
  if (_db) return _db;
  const dbPath = engineHealthDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS engine_health (
      engine               TEXT PRIMARY KEY,
      vm                   TEXT,
      status               TEXT NOT NULL DEFAULT 'healthy'
                           CHECK (status IN ('healthy','degraded','unavailable')),
      last_success_at      TEXT,
      last_failure_at      TEXT,
      last_failure_class   TEXT,
      last_failure_message TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT NOT NULL
    );
  `);
  _stmts = {
    get: _db.prepare('SELECT * FROM engine_health WHERE engine = ?'),
    all: _db.prepare('SELECT * FROM engine_health ORDER BY engine'),
    upsert: _db.prepare(`
      INSERT INTO engine_health
        (engine, vm, status, last_success_at, last_failure_at, last_failure_class,
         last_failure_message, consecutive_failures, updated_at)
      VALUES
        (@engine, @vm, @status, @last_success_at, @last_failure_at, @last_failure_class,
         @last_failure_message, @consecutive_failures, @updated_at)
      ON CONFLICT(engine) DO UPDATE SET
        vm = excluded.vm,
        status = excluded.status,
        last_success_at = excluded.last_success_at,
        last_failure_at = excluded.last_failure_at,
        last_failure_class = excluded.last_failure_class,
        last_failure_message = excluded.last_failure_message,
        consecutive_failures = excluded.consecutive_failures,
        updated_at = excluded.updated_at
    `),
    del: _db.prepare('DELETE FROM engine_health'),
  };
  return _db;
}

function _defaultRow(engine) {
  return {
    engine,
    vm: VM_NAME,
    status: 'healthy',
    last_success_at: null,
    last_failure_at: null,
    last_failure_class: null,
    last_failure_message: null,
    consecutive_failures: 0,
    updated_at: null,
  };
}

function _row(engine) {
  _open();
  return _stmts.get.get(engine) || _defaultRow(engine);
}

function _upsert(row) {
  _open();
  _stmts.upsert.run(row);
  return _row(row.engine);
}

// Records a failure. Irrelevant classes (USER_STOP/UNKNOWN) are a no-op. Escalates
// degraded → unavailable at the configured consecutive-failure threshold.
function markEngineFailure(engine, { failureClass, message, vm, at } = {}) {
  const eng = normalizeEngine(engine);
  const cls = failureClass || 'UNKNOWN';
  if (!HEALTH_RELEVANT.has(cls)) return _row(eng);
  const prev = _row(eng);
  const consecutive = (prev.consecutive_failures || 0) + 1;
  const now = at || new Date().toISOString();
  const row = _upsert({
    engine: eng,
    vm: vm || VM_NAME,
    status: consecutive >= unavailableAfter() ? 'unavailable' : 'degraded',
    last_success_at: prev.last_success_at,
    last_failure_at: now,
    last_failure_class: cls,
    last_failure_message: String(message || '').slice(0, 500),
    consecutive_failures: consecutive,
    updated_at: now,
  });
  // #1912: the degraded → unavailable TRANSITION alerts the operator once per
  // outage (audit: codex sat `unavailable` (QUOTA) 5 days with no signal to anyone).
  if (row && row.status === 'unavailable' && prev.status !== 'unavailable') {
    try { require('./degrade-alert').engineUnavailable(eng, { message: message || cls }); }
    catch { /* alerting must never break health bookkeeping */ }
  }
  return row;
}

// Self-heal: a successful authenticated engine call resets status to healthy and the failure
// streak to 0. last_failure_* is preserved as history (spec §9).
function markEngineSuccess(engine, { vm, at } = {}) {
  const eng = normalizeEngine(engine);
  const prev = _row(eng);
  const now = at || new Date().toISOString();
  return _upsert({
    engine: eng,
    vm: vm || VM_NAME,
    status: 'healthy',
    last_success_at: now,
    last_failure_at: prev.last_failure_at,
    last_failure_class: prev.last_failure_class,
    last_failure_message: prev.last_failure_message,
    consecutive_failures: 0,
    updated_at: now,
  });
}

// Readers get the EFFECTIVE status (half-open after cooldown); writers keep using the raw row.
function getEngineHealth(engine, { now } = {}) {
  return _effective(_row(normalizeEngine(engine)), now);
}

function getAllEngineHealth() {
  _open();
  const byEngine = Object.fromEntries(_stmts.all.all().map(r => [r.engine, r]));
  return Object.fromEntries(ENGINES.map(e => [e, _effective(byEngine[e] || _defaultRow(e))]));
}

function isCredentialInvalidClass(cls) {
  return CREDENTIAL_INVALID.has(cls);
}

// Test-only: clear all rows so a fresh temp DB starts empty.
function _resetForTests() {
  try { if (_db) _stmts.del.run(); } catch { /* not open yet */ }
}

module.exports = {
  ENGINES,
  HEALTH_RELEVANT,
  unavailableAfter,
  cooldownMs,
  markEngineFailure,
  markEngineSuccess,
  getEngineHealth,
  getAllEngineHealth,
  isCredentialInvalidClass,
  _resetForTests,
};
