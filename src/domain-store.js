'use strict';

// Domain Store — generic, scoped JSON records for Domain Skill Servers.
// Tracked by issue #1220 (Domain Store + Domain Web Surface над action-v1).
//
// Core owns persistence; a provider only reaches this through the scoped
// capability layer (a separate slice). Scope is therefore an explicit argument
// here — the store never reads USER_ID/env itself — so the capability layer is
// the single place that maps a trusted execution context to
// { providerId, profileId, projectId } and the store cannot be confused by a
// provider forging scope in tool arguments.
//
// Storage: the existing operational SQLite (durableTaskDbPath by default), a
// plain additive table next to durable_tasks. A separate domain/state.db is the
// fallback, not the default (§3.1).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { durableTaskDbPath } = require('./data-paths');

const ERROR_CODES = ['INVALID_ARGUMENTS', 'NOT_FOUND', 'CONFLICT'];

function domainError(code, message) {
  return Object.assign(new Error(message), { code });
}

function nowMs() {
  return Date.now();
}

// project_id: NULL means profile scope, never a wildcard. '' and undefined
// collapse to NULL so callers cannot create a second, empty-string scope.
function normalizeProjectId(projectId) {
  if (projectId === undefined || projectId === null || projectId === '') return null;
  return String(projectId);
}

function scopeKeyOf(projectId) {
  return projectId === null ? '' : projectId;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw domainError('INVALID_ARGUMENTS', `${label} is required`);
  }
  return value;
}

function encodeCursor(row) {
  return Buffer.from(`${row.updated_at}:${row.record_id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const sep = raw.indexOf(':');
  if (sep <= 0) throw domainError('INVALID_ARGUMENTS', 'Invalid cursor');
  const updatedAt = Number(raw.slice(0, sep));
  const recordId = raw.slice(sep + 1);
  if (!Number.isFinite(updatedAt) || !recordId) {
    throw domainError('INVALID_ARGUMENTS', 'Invalid cursor');
  }
  return { updatedAt, recordId };
}

class DomainStore {
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_records (
        provider_id     TEXT NOT NULL,
        profile_id      TEXT NOT NULL,
        project_id      TEXT,
        scope_key       TEXT NOT NULL,
        collection      TEXT NOT NULL,
        record_id       TEXT NOT NULL,
        schema_version  INTEGER NOT NULL DEFAULT 1,
        data_json       TEXT NOT NULL CHECK(json_valid(data_json)),
        revision        INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        expires_at      INTEGER,
        PRIMARY KEY (provider_id, profile_id, scope_key, collection, record_id)
      );
      CREATE INDEX IF NOT EXISTS domain_records_scope
        ON domain_records(provider_id, profile_id, project_id, collection);
      CREATE INDEX IF NOT EXISTS domain_records_updated
        ON domain_records(updated_at);
      CREATE INDEX IF NOT EXISTS domain_records_expires
        ON domain_records(expires_at);
    `);
  }

  _prep(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  _scope(providerId, profileId, projectId) {
    const projectIdNorm = normalizeProjectId(projectId);
    return {
      provider_id: requireId(providerId, 'providerId'),
      profile_id: requireId(profileId, 'profileId'),
      project_id: projectIdNorm,
      scope_key: scopeKeyOf(projectIdNorm),
    };
  }

  _rowToRecord(row) {
    return {
      providerId: row.provider_id,
      profileId: row.profile_id,
      projectId: row.project_id,
      collection: row.collection,
      recordId: row.record_id,
      schemaVersion: row.schema_version,
      data: JSON.parse(row.data_json),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  _isExpired(row, at) {
    return row.expires_at !== null && row.expires_at <= at;
  }

  // ── Read ───────────────────────────────────────────────────────────────

  get({ providerId, profileId, projectId, collection, recordId, includeExpired = false, now = nowMs() }) {
    const s = this._scope(providerId, profileId, projectId);
    requireId(collection, 'collection');
    requireId(recordId, 'recordId');
    const row = this._prep(`
      SELECT * FROM domain_records
      WHERE provider_id = ? AND profile_id = ? AND scope_key = ? AND collection = ? AND record_id = ?
    `).get(s.provider_id, s.profile_id, s.scope_key, collection, recordId);
    if (!row) return null;
    if (this._isExpired(row, now) && !includeExpired) return null;
    return this._rowToRecord(row);
  }

  list({ providerId, profileId, projectId, collection, limit = 100, cursor, includeExpired = false, now = nowMs() }) {
    const s = this._scope(providerId, profileId, projectId);
    requireId(collection, 'collection');
    const size = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);

    const clauses = [
      'provider_id = ?', 'profile_id = ?', 'scope_key = ?', 'collection = ?',
    ];
    const params = [s.provider_id, s.profile_id, s.scope_key, collection];
    if (!includeExpired) {
      clauses.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(now);
    }
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      const c = decodeCursor(cursor);
      clauses.push('(updated_at > ? OR (updated_at = ? AND record_id > ?))');
      params.push(c.updatedAt, c.updatedAt, c.recordId);
    }

    const rows = this._prep(`
      SELECT * FROM domain_records
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at ASC, record_id ASC
      LIMIT ?
    `).all(...params, size + 1);

    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    return {
      records: page.map(r => this._rowToRecord(r)),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  // ── Write ──────────────────────────────────────────────────────────────

  /**
   * expected_revision = null (or 0) → create; must not exist.
   * expected_revision = N (>0)       → update; must exist and match, else CONFLICT.
   * ttl_ms: undefined keeps existing expiry, null clears it, number sets now+ttl.
   */
  put({ providerId, profileId, projectId, collection, recordId, data, schemaVersion = 1,
    expectedRevision = null, ttlMs = undefined, now = nowMs() }) {
    const s = this._scope(providerId, profileId, projectId);
    requireId(collection, 'collection');
    requireId(recordId, 'recordId');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw domainError('INVALID_ARGUMENTS', 'data must be a JSON object');
    }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw domainError('INVALID_ARGUMENTS', 'schemaVersion must be an integer >= 1');
    }
    const dataJson = JSON.stringify(data);

    const existing = this._prep(`
      SELECT * FROM domain_records
      WHERE provider_id = ? AND profile_id = ? AND scope_key = ? AND collection = ? AND record_id = ?
    `).get(s.provider_id, s.profile_id, s.scope_key, collection, recordId);

    const isCreate = expectedRevision === null || expectedRevision === 0 || expectedRevision === undefined;
    let expiresAt;
    if (ttlMs === undefined) {
      expiresAt = existing ? existing.expires_at : null;
    } else if (ttlMs === null) {
      expiresAt = null;
    } else if (Number.isFinite(ttlMs) && ttlMs >= 0) {
      expiresAt = now + ttlMs;
    } else {
      throw domainError('INVALID_ARGUMENTS', 'ttlMs must be a non-negative number, null, or omitted');
    }

    if (isCreate) {
      if (existing) throw domainError('CONFLICT', 'Record already exists');
      this._prep(`
        INSERT INTO domain_records
          (provider_id, profile_id, project_id, scope_key, collection, record_id,
           schema_version, data_json, revision, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(s.provider_id, s.profile_id, s.project_id, s.scope_key, collection, recordId,
        schemaVersion, dataJson, now, now, expiresAt);
      return this.get({ providerId, profileId, projectId, collection, recordId, includeExpired: true, now });
    }

    if (!existing) throw domainError('NOT_FOUND', 'Record does not exist');
    if (existing.revision !== expectedRevision) {
      throw domainError('CONFLICT', 'Revision mismatch');
    }
    this._prep(`
      UPDATE domain_records
      SET data_json = ?, schema_version = ?, revision = revision + 1, updated_at = ?, expires_at = ?
      WHERE provider_id = ? AND profile_id = ? AND scope_key = ? AND collection = ? AND record_id = ?
    `).run(dataJson, schemaVersion, now, expiresAt,
      s.provider_id, s.profile_id, s.scope_key, collection, recordId);
    return this.get({ providerId, profileId, projectId, collection, recordId, includeExpired: true, now });
  }

  delete({ providerId, profileId, projectId, collection, recordId, expectedRevision = null }) {
    const s = this._scope(providerId, profileId, projectId);
    requireId(collection, 'collection');
    requireId(recordId, 'recordId');
    const existing = this._prep(`
      SELECT * FROM domain_records
      WHERE provider_id = ? AND profile_id = ? AND scope_key = ? AND collection = ? AND record_id = ?
    `).get(s.provider_id, s.profile_id, s.scope_key, collection, recordId);
    if (!existing) throw domainError('NOT_FOUND', 'Record does not exist');
    if (expectedRevision !== null && expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw domainError('CONFLICT', 'Revision mismatch');
    }
    this._prep(`
      DELETE FROM domain_records
      WHERE provider_id = ? AND profile_id = ? AND scope_key = ? AND collection = ? AND record_id = ?
    `).run(s.provider_id, s.profile_id, s.scope_key, collection, recordId);
    return { deleted: true, recordId };
  }

  // Opportunistic TTL sweep — called during ordinary operations, not a timer.
  sweepExpired(now = nowMs()) {
    const info = this._prep('DELETE FROM domain_records WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    return { deleted: info.changes };
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { DomainStore, ERROR_CODES };
