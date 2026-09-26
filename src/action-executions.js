'use strict';

// Shared action history (spec §7 / contracts/action-v1/cron.sql).
//
// One row per logical invocation, whatever the trigger — user, cron, durable
// task, webhook, system. This is the durable record invokeAction writes and the
// /domain route + history API read. It is the single history: DurableTaskStore
// references these execution IDs rather than keeping a second dispatcher.
//
// Storage: the existing operational SQLite (durableTaskDbPath), same table as
// the cron.sql fixture. PR3 owns the migration in production; this module keeps
// the schema in one place for both.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { durableTaskDbPath } = require('./data-paths');

const TRIGGERS = ['user', 'cron', 'durable_task', 'webhook', 'system'];
const STATUSES = ['claimed', 'running', 'succeeded', 'failed', 'rejected', 'unknown'];

class ActionExecutions {
  constructor(dbPath = durableTaskDbPath()) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this._migrate();
    this._stmts = {};
  }

  _migrate() {
    // Kept in sync with contracts/action-v1/cron.sql (the executable fixture).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        timezone TEXT NOT NULL,
        action TEXT NOT NULL,
        arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        last_run_at INTEGER,
        next_run_at INTEGER NOT NULL,
        last_status TEXT CHECK(last_status IN ('running','succeeded','failed','rejected','unknown')),
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cron_jobs_due ON cron_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS cron_jobs_scope ON cron_jobs(profile_id, project_id);
      CREATE TABLE IF NOT EXISTS action_executions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        project_id TEXT,
        scope_key TEXT GENERATED ALWAYS AS (coalesce(project_id, '')) STORED,
        action TEXT NOT NULL,
        arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
        trigger TEXT NOT NULL CHECK(trigger IN ('user','cron','durable_task','webhook','system')),
        origin TEXT CHECK(origin IS NULL OR origin IN ('web','mcp','telegram','api','cron-service','durable')),
        channel TEXT,
        idempotency_key TEXT NOT NULL,
        cron_id TEXT REFERENCES cron_jobs(id) ON DELETE SET NULL,
        scheduled_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','rejected','unknown')),
        lease_owner TEXT,
        lease_until INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
        started_at INTEGER,
        finished_at INTEGER,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
        created_at INTEGER NOT NULL,
        UNIQUE(profile_id, scope_key, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS cron_occurrence ON action_executions(cron_id, scheduled_at)
        WHERE cron_id IS NOT NULL AND scheduled_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS action_history_scope ON action_executions(profile_id, project_id, created_at);
    `);
  }

  _prep(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  _row(row) {
    if (!row) return null;
    return {
      id: row.id,
      profileId: row.profile_id,
      projectId: row.project_id,
      action: row.action,
      arguments: JSON.parse(row.arguments_json),
      trigger: row.trigger,
      origin: row.origin,
      channel: row.channel,
      idempotencyKey: row.idempotency_key,
      cronId: row.cron_id,
      scheduledAt: row.scheduled_at,
      status: row.status,
      attempt: row.attempt,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      createdAt: row.created_at,
    };
  }

  findByKey({ profileId, projectId = null, idempotencyKey }) {
    const scopeKey = projectId == null ? '' : String(projectId);
    const row = this._prep(`SELECT * FROM action_executions
      WHERE profile_id = ? AND scope_key = ? AND idempotency_key = ?`)
      .get(profileId, scopeKey, idempotencyKey);
    return this._row(row);
  }

  beginExecution({ id, profileId, projectId = null, action, arguments: args = {}, trigger,
    idempotencyKey, origin = null, channel = null, cronId = null, scheduledAt = null,
    leaseOwner = null, leaseUntil = null, now = Date.now() }) {
    if (!TRIGGERS.includes(trigger)) throw Object.assign(new Error(`Invalid trigger: ${trigger}`), { code: 'INVALID_ARGUMENTS' });
    // scope_key is a GENERATED column — never inserted explicitly.
    this._prep(`INSERT INTO action_executions
      (id, profile_id, project_id, action, arguments_json, trigger, origin, channel,
       idempotency_key, cron_id, scheduled_at, status, lease_owner, lease_until, attempt, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, 1, ?, ?)`)
      .run(id, profileId, projectId, action, JSON.stringify(args), trigger, origin, channel,
        idempotencyKey, cronId, scheduledAt, leaseOwner, leaseUntil, now, now);
    return this.get(id);
  }

  finishExecution(id, { status, result = null, error = null, leaseOwner = null, now = Date.now() }) {
    if (!STATUSES.includes(status)) throw Object.assign(new Error(`Invalid status: ${status}`), { code: 'INVALID_ARGUMENTS' });
    const info = this._prep(`UPDATE action_executions
      SET status = ?, result_json = ?, error_json = ?, finished_at = ?
      WHERE id = ? AND (lease_owner IS NULL OR lease_owner = ?)`)
      .run(status, result === null ? null : JSON.stringify(result),
        error === null ? null : JSON.stringify(error), now, id, leaseOwner);
    return info.changes === 0 ? null : this.get(id);
  }

  // cron-service claims an occurrence (status 'claimed', lease) inside its claim
  // transaction; invokeAction later moves it to 'running'. Only the lease holder
  // can start it, and only once.
  claimExecution({ id, profileId, projectId = null, action, arguments: args = {}, idempotencyKey,
    cronId, scheduledAt, leaseOwner, leaseUntil, now = Date.now() }) {
    this._prep(`INSERT INTO action_executions
      (id, profile_id, project_id, action, arguments_json, trigger, origin, idempotency_key,
       cron_id, scheduled_at, status, lease_owner, lease_until, attempt, created_at)
      VALUES (?, ?, ?, ?, ?, 'cron', 'cron-service', ?, ?, ?, 'claimed', ?, ?, 0, ?)`)
      .run(id, profileId, projectId, action, JSON.stringify(args), idempotencyKey,
        cronId, scheduledAt, leaseOwner, leaseUntil, now);
    return this.get(id);
  }

  startClaimed(id, { leaseOwner, now = Date.now() }) {
    const info = this._prep(`UPDATE action_executions
      SET status = 'running', attempt = attempt + 1, started_at = ?
      WHERE id = ? AND status = 'claimed' AND lease_owner = ?`).run(now, id, leaseOwner);
    return info.changes === 0 ? null : this.get(id);
  }

  get(id) {
    return this._row(this._prep('SELECT * FROM action_executions WHERE id = ?').get(id));
  }

  listByScope({ profileId, projectId = undefined, limit = 50 } = {}) {
    const clauses = ['profile_id = ?'];
    const params = [profileId];
    if (projectId !== undefined) {
      clauses.push('scope_key = ?');
      params.push(projectId == null ? '' : String(projectId));
    }
    return this._prep(`SELECT * FROM action_executions WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC LIMIT ?`).all(...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500))
      .map(r => this._row(r));
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { ActionExecutions, TRIGGERS, STATUSES };
