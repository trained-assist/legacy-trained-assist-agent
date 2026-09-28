'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userWorkDir } = require('./data-paths');
const { appendBuffered, bufferedRecords } = require('./jsonl-batched-flush');

const VALID_TYPES = new Set([
  'contact', 'decision', 'config', 'url', 'error',
  'snippet', 'company', 'document', 'identifier',
]);

function getArtifactsPath(username) {
  // Per-profile operational data lives in the workspace (USERS_ROOT/<u>), not the
  // legacy SYSTEM_ROOT/sessions tree. Resolved via the canonical helper.
  const dir = path.join(userWorkDir(username), 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'artifacts.jsonl');
}

function readAll(username) {
  const p = getArtifactsPath(username);
  let records;
  try {
    records = fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { records = []; }
  return records.concat(bufferedRecords(p));
}

function appendRecord(username, record) {
  appendBuffered(getArtifactsPath(username), record);
}

/**
 * Store one artifact with deduplication.
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.type
 * @param {string} opts.content
 * @param {object} [opts.metadata]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.dedupWindowMs] - default 60_000
 * @returns {{ stored: boolean, id?: string, total?: number, reason?: string, error?: string }}
 */
function storeArtifact({ username, type, content, metadata = {}, sessionId, dedupWindowMs = 60_000 }) {
  if (!username) return { error: 'username is required' };
  if (!type || !VALID_TYPES.has(type)) return { error: `Invalid type: ${type}` };
  if (!content || typeof content !== 'string' || !content.trim()) return { error: 'content is required' };

  const now = Date.now();
  const existing = readAll(username);
  const isDuplicate = existing.some(
    a => a.type === type && a.content === content && (now - a.created_at) < dedupWindowMs
  );
  if (isDuplicate) return { stored: false, reason: 'duplicate' };

  const record = {
    id: crypto.randomUUID(),
    username,
    type,
    content: content.trim(),
    metadata,
    created_at: now,
    ...(sessionId ? { session_id: sessionId } : {}),
  };

  appendRecord(username, record);
  return { stored: true, id: record.id, total: existing.length + 1 };
}

module.exports = { VALID_TYPES, getArtifactsPath, readAll, storeArtifact };
