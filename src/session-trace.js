// Read the agent's full working trace (reasoning, tool calls, steps) for a
// session. Source of truth: the engine's own durable store — opencode writes
// every part (text/reasoning/tool/step-start/step-finish/compaction) into its
// SQLite db, and the runner already records the native session id on every
// s-session via engineSessions.opencode. So the "полный лог" the user wants in
// the web UI is already on disk — we just read it and normalize it for display.
// Read-only access, grouped by the s-session's own message timeline so each
// assistant reply can show its own slice.
//
// Fallback (#1893): the engine db is ephemeral — rotated or recreated, it takes
// the log with it. The runner therefore also appends every streamed part to a
// durable per-profile store (session-trace-store.js); when no engine db knows
// the session, readTrace answers from that store with source:'store' and
// reasoning:false (reasoning never reaches the stream). The two sources are
// never merged: the engine db, when present, is the richer one.
//
// WHERE the db lives follows the engine's HOME:
//   isolated runs (agent-isolation): HOME=<workDir>/.agent-home → the profile's
//     own `.agent-home/.local/share/opencode/opencode.db`;
//   pre-isolation / legacy runs: the SERVICE home's `.local/share/opencode/opencode.db`.
// Both are read-only candidates, most specific first: a session written before
// the isolation migration still resolves, and one written after it is not lost
// just because the service home has its own (stale) db. Reading the service home
// ONLY — the pre-migration default — is what silently broke «Полный лог» in the
// web UI: the button kept rendering, the reader looked in an empty db.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TOOL_INPUT = 2000;   // chars per tool input shown in the log
const MAX_TOOL_OUTPUT = 4000;  // chars per tool output shown in the log
const MAX_TEXT = 4000;         // chars per text part
const MAX_REASONING = 6000;    // chars per reasoning block
const MAX_EVENTS = 4000;       // hard cap on events returned per session
const TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // logs are ephemeral: 7 days

// Relative to an engine HOME: where opencode keeps its SQLite file.
const ENGINE_DB_REL = path.join('.local', 'share', 'opencode', 'opencode.db');
// Relative to a profile workDir: the per-profile engine home (agent-isolation.js
// engineHomeDir — the same resolver, so this file can never drift from it).
const ENGINE_HOME_REL = '.agent-home';

// Legacy default: the service home's db (pre-isolation) — also the last candidate.
let DB_PATH = process.env.OPENCODE_DB_PATH || path.join(os.homedir(), ENGINE_DB_REL);

function setDbPath(p) { DB_PATH = p; }
function dbPath() { return DB_PATH; }

/**
 * Engine db files to search for this session, most specific first.
 *   1. OPENCODE_DB_PATH — explicit pin (ops/tests), nothing else is consulted;
 *   2. the profile's own engine home, when that db exists on disk;
 *   3. the legacy service-home db.
 */
function candidateDbPaths(workDir) {
  if (process.env.OPENCODE_DB_PATH) return [process.env.OPENCODE_DB_PATH];
  const out = [];
  if (workDir) out.push(path.join(workDir, ENGINE_HOME_REL, ENGINE_DB_REL));
  if (!out.includes(DB_PATH)) out.push(DB_PATH);
  return out;
}

function openDb(file) {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch { return null; }
  try {
    if (!file || !fs.existsSync(file)) return null;
    // readonly: opencode may be actively writing (WAL) — we never lock it.
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.warn('[session-trace] open db:', e.message);
    return null;
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `… [обрезано ${s.length - n} симв]`;
}

/** Normalize one opencode `part` into a display-friendly event. */
function normalizePart(data) {
  if (!data || typeof data !== 'object') return null;
  // Tool parts carry their time in state.time.start, not in a top-level `time`.
  const ev = { kind: data.type, at: data.time?.created || data.time?.start || data.state?.time?.start || null };
  switch (data.type) {
    case 'reasoning':
      ev.text = truncate(data.text || '', MAX_REASONING);
      break;
    case 'text':
      ev.text = truncate(data.text || '', MAX_TEXT);
      break;
    case 'tool':
      ev.tool = data.tool || 'tool';
      ev.state = data.state?.status || null;
      ev.input = truncate(stringifyInput(data.state?.input), MAX_TOOL_INPUT);
      ev.output = truncate(stringifyOutput(data.state?.output), MAX_TOOL_OUTPUT);
      break;
    case 'step-start':
    case 'step-finish':
      ev.reason = data.reason || null;
      ev.tokens = data.tokens || null;
      ev.cost = data.cost ?? null;
      break;
    case 'compaction':
      ev.auto = !!data.auto;
      break;
    default:
      // Unknown types are kept with their raw keys so the UI never silently
      // loses something new the engine starts emitting.
      ev.raw = Object.keys(data).filter(k => !['type', 'time', 'metadata'].includes(k));
      break;
  }
  return ev;
}

function stringifyInput(input) {
  if (input == null) return '';
  try { return typeof input === 'string' ? input : JSON.stringify(input, null, 2); }
  catch { return String(input); }
}

function stringifyOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    const s = JSON.stringify(output);
    return s && s.length > 0 && s !== '{}' ? s : '';
  } catch { return String(output); }
}

/**
 * Read the full trace for an s-session. Returns:
 *   { ok:true, engine:'opencode', source:'engine-db'|'store', reasoning:bool,
 *     sessionId, events: [...], byMessage: [[...]], ttlMs }
 *   { ok:false, error } — engine not opencode / db missing / session not found.
 * Events are chronological. byMessage groups events into the s-session's own
 * message windows (event.at between message[i-1].at and message[i].at) so the
 * UI can attach each assistant reply its own slice.
 */
function readTrace(workDir, session) {
  const engineId = session?.engineSessions?.opencode;
  if (!engineId) {
    return { ok: false, error: 'no-opencode-session', engine: session?.engineSessions?.claude ? 'claude' : null };
  }
  // The engine session may live in this profile's engine home (isolated runs) or
  // in the legacy service-home db (pre-isolation runs) — try them in order and
  // keep the first one that actually knows this session.
  let lastError = null;
  for (const file of candidateDbPaths(workDir)) {
    const db = openDb(file);
    if (!db) { lastError = lastError || 'db-unavailable'; continue; }
    try {
      const rows = db.prepare(
        'SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC LIMIT ?'
      ).all(engineId, MAX_EVENTS);
      if (!rows.length) {
        const exists = db.prepare('SELECT 1 FROM session WHERE id = ?').get(engineId);
        // Not this db's session — a different HOME may hold it.
        if (!exists) { lastError = 'session-not-found'; continue; }
      }
      const events = rows.map(r => normalizePart(JSON.parse(r.data))).filter(Boolean);
      const byMessage = groupByMessages(events, session?.messages || []);
      if (!events.length) { lastError = lastError || 'session-empty'; continue; }
      return { ok: true, engine: 'opencode', source: 'engine-db', reasoning: true, sessionId: engineId, events, byMessage, ttlMs: TRACE_TTL_MS };
    } catch (e) {
      console.warn('[session-trace] read:', e.message);
      lastError = 'read-failed';
    } finally {
      try { db.close(); } catch {}
    }
  }
  const stored = require('./session-trace-store').readEvents(workDir, 'opencode', engineId);
  if (stored.found) {
    const byMessage = groupByMessages(stored.events, session?.messages || []);
    return { ok: true, engine: 'opencode', source: 'store', reasoning: false, sessionId: engineId, events: stored.events, byMessage, ttlMs: TRACE_TTL_MS };
  }
  if (lastError === 'session-empty') {
    return { ok: true, engine: 'opencode', source: 'engine-db', reasoning: true, sessionId: engineId, events: [], byMessage: groupByMessages([], session?.messages || []), ttlMs: TRACE_TTL_MS };
  }
  return { ok: false, error: lastError || 'db-unavailable', engine: null };
}

/** Bucket events into the s-session message windows by timestamp. An event
 *  belongs to the window of the FIRST message whose `at` is >= the event's —
 *  i.e. the reasoning/tools that produced that reply. Events older than every
 *  message land in window 0 (pre-history). */
function groupByMessages(events, messages) {
  const bounds = [];
  for (const m of messages) {
    if (typeof m.at === 'number') bounds.push(m.at);
  }
  if (!bounds.length) return [events]; // no timestamps — return as one block
  const buckets = [];
  let bi = 0;
  for (const ev of events) {
    while (bi < bounds.length - 1 && ev.at != null && ev.at > bounds[bi]) bi++;
    if (!buckets[bi]) buckets[bi] = [];
    buckets[bi].push(ev);
  }
  return buckets;
}

module.exports = { readTrace, normalizePart, groupByMessages, dbPath, setDbPath, truncate, candidateDbPaths };