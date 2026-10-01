'use strict';
// session-materialize.js — PR-C of epic #1784 M2 (issue #1916): the READ side of
// the session archive. Red-team B6 (#1808): between runs the VM holds no session
// bodies and no engine transcripts — only the index (sessions.json) and the
// current-session pointers — so every reader must either work off the index or
// bring the body back first, and it must NEVER quietly conclude "no such
// session" and spawn a blind replacement.
//
// Two ways of coming back, chosen by WHERE the reader needs the bytes:
//
//   · ON DISK — materializeSessionForRun / materializeRunSessions (the admission
//     hook, before the first body read of a run), materializeTranscriptForResume
//     (native `claude --resume`), materializeRecentArchivedSessions (the run's
//     chat-history warm-up). The run then works on a normal local file, and the
//     PR-D post-run sweep moves it back to GCS.
//
//   · IN MEMORY — readSessionMaybeArchived / readArchivedSessionBody: download →
//     verify the marker's gz sha → gunzip → JSON.parse, nothing ever written to
//     the VM. This is what the web/API/digest/session_search readers use, and it
//     is how "reading a session leaves no body behind" holds even mid-flight
//     (owner contract: между ранами на VM нет тел сессий).
//
// Failure is always loud and typed (SessionArchiveError): a reader either gets a
// body or an honest ARCHIVE_UNAVAILABLE / ARCHIVE_MISSING — never `null` that
// looks like "this session never existed". Callers map those onto a user-facing
// error (503 / «архив недоступен, сессия не пересоздана»), except the two
// documented degrade points: a transcript whose object simply is not in the
// archive (never archived / different cwd) and the chat-history warm-up.
//
// Blob store: created lazily and memoised (constructing the real client reads
// ADC; tests point GCS_FAKE_DIR at a temp dir before first use). `_resetBlob`
// exists for tests that swap the environment between cases.
const fs = require('fs');
const path = require('path');
const archive = require('./session-archive');
const sessions = require('./session-store');
const { slugCwd, transcriptKey, isSafeSegment, sessionKey } = require('./session-blob-store');

// Bound for every read-path fetch: a hung GCS call must surface as an honest
// error the user can retry, never as a run that waits forever at admission.
const DEFAULT_TIMEOUT_MS = 20_000;
// Run-start chat-history warm-up: the top-N most recently active sessions that
// exist only in GCS (index order, 24h window = the lookback buildRecentChatBlock
// uses).
const WARMUP_LIMIT = 5;
const WARMUP_WINDOW_MS = 24 * 60 * 60 * 1000;

class SessionArchiveError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SessionArchiveError';
    this.code = code; // ARCHIVE_UNAVAILABLE | ARCHIVE_MISSING
    if (cause) this.cause = cause;
  }
}

let cachedBlob = null;
function blob() {
  if (!cachedBlob) cachedBlob = archive.createBlobStore();
  return cachedBlob;
}
function _resetBlob() { cachedBlob = null; } // tests only

async function withDeadline(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new SessionArchiveError('ARCHIVE_UNAVAILABLE', `${label} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  // Promise.race attaches handlers to `promise` immediately, so a late rejection
  // after the deadline has already won is still handled (no unhandledRejection).
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapArchiveError(e, what) {
  if (e instanceof SessionArchiveError) return e;
  const code = e && e.code;
  if (code === 'BLOB_NOT_FOUND') {
    return new SessionArchiveError('ARCHIVE_MISSING', `${what}: not in the archive (${e.message})`, e);
  }
  return new SessionArchiveError('ARCHIVE_UNAVAILABLE', `${what}: ${e && e.message || e}`, e);
}

function sessionBodyPath(workDir, sessionId) {
  return path.join(workDir, archive.SESSIONS_DIR, `${sessionId}.json`);
}

/** Index record (no body read) or null. */
function recordFor(workDir, sessionId) {
  return sessions.getSessionRecord(workDir, sessionId);
}

/** True when the index says this session's body lives in GCS. */
function isArchived(workDir, sessionId) {
  const record = recordFor(workDir, sessionId);
  return !!(record && record.archived && typeof record.archived.key === 'string');
}

/**
 * Bring one session body back ON DISK (the canonical path session-store reads).
 *
 * Idempotent and safe to call concurrently: an existing local copy is reported,
 * never clobbered — the archived bytes and the local file are the same content
 * by construction (archive only unlinks after a confirmed upload).
 *
 * @returns {{status:'written'|'exists', destPath, ...}}
 * @throws {SessionArchiveError} ARCHIVE_MISSING (marker/object gone) or
 *   ARCHIVE_UNAVAILABLE (GCS down, timeout, corrupt object).
 */
async function materializeSessionForRun({ workDir, profile, sessionId, marker, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const destPath = sessionBodyPath(workDir, sessionId);
  if (fs.existsSync(destPath)) return { status: 'exists', destPath };
  if (!marker || typeof marker.key !== 'string') {
    throw new SessionArchiveError('ARCHIVE_MISSING', `session ${sessionId}: no archived marker in the index`);
  }
  try {
    return await withDeadline(
      archive.materializeSessionBody({ blob: blob(), profileRoot: workDir, sessionId, marker, mode: 0o600 }),
      timeoutMs,
      `materialize session ${sessionId}`,
    );
  } catch (e) {
    throw wrapArchiveError(e, `session ${sessionId}`);
  }
}

/**
 * The admission hook (issue #1916 PR-C): everything the run is about to resolve
 * must have a body before the first getSession() call, or resolveChatSession's
 * `getSession → null` turns an archived session into a brand-new blank one and
 * the accumulated context is lost (red-team B6).
 *
 * Candidates: the explicitly requested session and the chat's current-session
 * pointer — exactly the two ids resolveRunSession can pick. `forceNew` means the
 * caller wants a FRESH session under that id, so nothing is resurrected for it.
 *
 * Two shapes of "archived", both brought back the same way:
 *   · indexed  — the record carries `archived: {key, sha256, size}`, so the
 *     download is integrity-checked against the marker (the normal case);
 *   · marker-less — a ⚡ side session (`recordQuickExchange`, `sideSession:true`)
 *     is deliberately NOT in the index and therefore can carry no marker, yet
 *     the post-run sweep (PR-D) archives it exactly like any other body — the
 *     same thing the `archive-sessions` CLI phase already does to them. Its blob
 *     key is derivable from the id alone, so the body is fetched without a
 *     marker (best effort: a miss or an outage here must never fail the run —
 *     the id may simply never have existed, and GCS being down says nothing
 *     about that). Without this probe the escalation button on an old ⚡ reply
 *     (`qa_more` → forceClaude) would resolve `getSession → null` and silently
 *     continue in ANOTHER session — red-team B6 one level down.
 *
 * @returns {{materialized: string[], checked: string[]}}
 * @throws {SessionArchiveError} — for the INDEXED shape only. The caller MUST
 *   surface it to the user and stop; falling through would create the blind
 *   session this exists to prevent.
 */
async function materializeRunSessions({
  workDir, profile, sessionId = null, chatId = null, audience = null,
  threadId = null, forceNew = false, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const out = { materialized: [], checked: [] };
  if (!workDir || forceNew) return out;
  const ids = [];
  if (sessionId) ids.push(sessionId);
  if (chatId) {
    const pointerId = sessions.getCurrentSessionId(workDir, chatId, audience, threadId);
    if (pointerId) ids.push(pointerId);
  }
  for (const id of [...new Set(ids)]) {
    if (!isSafeSegment(id)) continue;
    out.checked.push(id);
    const record = recordFor(workDir, id);
    if (record && record.archived && typeof record.archived.key === 'string') {
      const res = await materializeSessionForRun({ workDir, profile, sessionId: id, marker: record.archived, timeoutMs });
      if (res.status === 'written') out.materialized.push(id);
      continue;
    }
    if (record) continue; // indexed and never archived → local or genuinely gone, nothing to fetch
    if (fs.existsSync(sessionBodyPath(workDir, id))) continue;
    const res = await materializeMarkerlessSession({ workDir, profile, sessionId: id, timeoutMs });
    if (res.status === 'written') out.materialized.push(id);
  }
  return out;
}

/** Fetch one body whose key is derivable from the id alone (no index marker).
 *  Best effort by contract — see the marker-less case in materializeRunSessions. */
async function materializeMarkerlessSession({ workDir, profile, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let key;
  try {
    key = sessionKey(profile, sessionId);
  } catch {
    return { status: 'skipped' };
  }
  try {
    return await withDeadline(
      archive.materializeBlob({ blob: blob(), key, destPath: sessionBodyPath(workDir, sessionId), mode: 0o600 }),
      timeoutMs,
      `materialize session ${sessionId}`,
    );
  } catch (e) {
    if (e && e.code === 'BLOB_NOT_FOUND') return { status: 'missing' };
    console.warn('[session-materialize] marker-less probe for %s failed: %s', sessionId, e && e.message);
    return { status: 'error' };
  }
}

/**
 * One session body IN MEMORY: local file first, otherwise the archived object.
 * Nothing is written to the VM — this is the reader contract for HTTP/MCP paths
 * that must not leave a body behind.
 *
 * `profile` is not needed: the blob key comes from the index marker itself.
 *
 * @returns {object|null} the parsed session, or null when the session does not
 *   exist at all (no local file AND no index record).
 * @throws {SessionArchiveError} when the index says archived but the object
 *   cannot be fetched/verified — never a silent null.
 */
async function readSessionMaybeArchived({ workDir, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!sessionId) return null;
  const local = sessions.getSession(workDir, sessionId);
  if (local) return local;
  const record = recordFor(workDir, sessionId);
  if (!record || !record.archived || typeof record.archived.key !== 'string') return null;
  return readArchivedSessionBody({ sessionId, marker: record.archived, timeoutMs });
}

/** Fetch + verify + parse one archived body. In-memory only (see above). */
async function readArchivedSessionBody({ sessionId, marker, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let res;
  try {
    res = await withDeadline(
      archive.fetchArchivedBlob({ blob: blob(), key: marker.key }),
      timeoutMs,
      `fetch session ${sessionId}`,
    );
  } catch (e) {
    throw wrapArchiveError(e, `session ${sessionId}`);
  }
  if (res.status === 'missing') {
    throw new SessionArchiveError('ARCHIVE_MISSING', `session ${sessionId}: ${res.message}`);
  }
  if (res.status !== 'ok') {
    throw new SessionArchiveError('ARCHIVE_UNAVAILABLE', `session ${sessionId}: ${res.message}`);
  }
  // fetchArchivedBlob only re-hashes content when the caller hands it a raw sha;
  // the index marker carries the STORED object's sha, so check it here — a body
  // must never be served from an object the marker does not describe.
  if (marker.sha256 && res.gzSha256 !== marker.sha256) {
    throw new SessionArchiveError('ARCHIVE_UNAVAILABLE', `session ${sessionId}: archived object sha256 mismatch`);
  }
  try {
    return JSON.parse(res.raw.toString('utf8'));
  } catch (e) {
    throw new SessionArchiveError('ARCHIVE_UNAVAILABLE', `session ${sessionId}: archived body is not valid JSON (${e.message})`);
  }
}

/**
 * Native `--resume` support: if the engine transcript is not on disk, pull it
 * back into the project directory Claude will look in. Claude names that
 * directory from the cwd (claudeProjectSlug), while the blob KEY uses slugCwd —
 * see session-archive.transcriptArchiveKey.
 *
 * @returns {{status:'written'|'exists'|'missing'|'skipped'}}
 *   'missing' = the object is simply not in the archive (never archived, or the
 *   session ran from another cwd) → the caller proceeds exactly as before PR-C;
 *   an infrastructure failure throws ARCHIVE_UNAVAILABLE instead, because
 *   silently starting a fresh engine session while GCS is merely down would drop
 *   the context the user is owed.
 */
async function materializeTranscriptForResume({
  workDir, profile, cwd, engineSessionId, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!workDir || !engineSessionId || !isSafeSegment(engineSessionId)) return { status: 'skipped' };
  const existing = findLocalTranscript(workDir, engineSessionId);
  if (existing) return { status: 'exists', destPath: existing };
  if (!cwd) return { status: 'skipped', reason: 'no cwd' };
  let key;
  try {
    key = transcriptKey(profile, slugCwd(cwd), engineSessionId);
  } catch (e) {
    return { status: 'skipped', reason: e.message };
  }
  const destPath = path.join(workDir, archive.transcriptDestRel(cwd, engineSessionId));
  try {
    return await withDeadline(
      archive.materializeBlob({ blob: blob(), key, destPath, mode: 0o644 }),
      timeoutMs,
      `materialize transcript ${engineSessionId}`,
    );
  } catch (e) {
    if (e && e.code === 'BLOB_NOT_FOUND') return { status: 'missing', key };
    throw wrapArchiveError(e, `transcript ${engineSessionId}`);
  }
}

// Any local copy of this engine transcript, whatever directory slug it sits in.
// Claude derives the directory from the cwd of THAT run, so a project folder
// renamed in the meantime leaves the file elsewhere — finding it first means we
// never download bytes that are already here (and never write a second copy).
function findLocalTranscript(workDir, engineSessionId) {
  const root = path.join(workDir, archive.TRANSCRIPTS_DIR);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(root, e.name, `${engineSessionId}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* raced away / not a file */ }
  }
  return null;
}

/**
 * Run-start warm-up for chat-history readers (buildRecentChatBlock and the
 * get_chat_history MCP tool both scan the sessions directory): the last few
 * sessions a chat may ask about live only in GCS between runs. Best-effort by
 * design — a failure never blocks the run (the run's OWN session was already
 * materialised at admission and is reported to the user there); failures come
 * back as `failed` so the caller can log them.
 *
 * The candidates come from the index in recency order, profile-wide: the index
 * carries no liveChatId, so a chat-scoped pre-filter is impossible without the
 * body (see the PR-C audit — that is exactly why an index-only fallback for the
 * chat block was rejected: it would leak another chat's lines into this one).
 *
 * @returns {{materialized: string[], failed: {sessionId, code, message}[]}}
 */
async function materializeRecentArchivedSessions({
  workDir, profile, limit = WARMUP_LIMIT, withinMs = WARMUP_WINDOW_MS,
  now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const out = { materialized: [], failed: [] };
  if (!workDir) return out;
  const cutoff = Number.isFinite(withinMs) && withinMs > 0 ? now - withinMs : 0;
  const candidates = sessions.listSessions(workDir, 50, null)
    .filter(r => r && r.archived && typeof r.archived.key === 'string')
    .filter(r => (Number(r.lastAt) || Number(r.createdAt) || 0) >= cutoff)
    .slice(0, Math.max(0, limit));
  for (const record of candidates) {
    if (fs.existsSync(sessionBodyPath(workDir, record.id))) continue;
    try {
      const res = await materializeSessionForRun({ workDir, profile, sessionId: record.id, marker: record.archived, timeoutMs });
      if (res.status === 'written') out.materialized.push(record.id);
    } catch (e) {
      out.failed.push({ sessionId: record.id, code: e.code, message: e.message });
    }
  }
  return out;
}

/**
 * Every session a search should consider: the index (recency order — archived
 * bodies included, since their record carries `archived`) plus any local body
 * the index does not know (⚡ side sessions are written with sideSession:true and
 * never indexed until they are promoted).
 */
function sessionIdsForSearch(workDir) {
  const ids = [];
  const seen = new Set();
  for (const record of sessions.listSessions(workDir, Infinity, null)) {
    if (record?.id && !seen.has(record.id)) { seen.add(record.id); ids.push(record.id); }
  }
  let files = [];
  try { files = fs.readdirSync(path.join(workDir, archive.SESSIONS_DIR)); } catch { return ids; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    if (!id || id.startsWith('current-session') || id.endsWith('.digest')) continue;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

module.exports = {
  SessionArchiveError,
  DEFAULT_TIMEOUT_MS,
  WARMUP_LIMIT,
  WARMUP_WINDOW_MS,
  isArchived,
  materializeSessionForRun,
  materializeRunSessions,
  materializeTranscriptForResume,
  materializeRecentArchivedSessions,
  readSessionMaybeArchived,
  readArchivedSessionBody,
  sessionIdsForSearch,
  findLocalTranscript,
  _resetBlob,
};
