// Read the agent's full working trace (reasoning, tool calls, steps) for a
// session. Source of truth: the engine's own durable store — opencode writes
// every part (text/reasoning/tool/step-start/step-finish/compaction) into its
// SQLite db (`~/.local/share/opencode/opencode.db`), and the runner already
// records the native session id on every s-session via engineSessions.opencode.
// So the "полный лог" the user wants in the web UI is already on disk — we
// just read it and normalize it for display. No new persistence, no duplication
// of the multi-GB logs: read-only access, grouped by the s-session's own
// message timeline so each assistant reply can show its own slice.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TOOL_INPUT = 2000;   // chars per tool input shown in the log
const MAX_TOOL_OUTPUT = 4000;  // chars per tool output shown in the log
const MAX_TEXT = 4000;         // chars per text part
const MAX_REASONING = 6000;    // chars per reasoning block
const MAX_EVENTS = 4000;       // hard cap on events returned per session
const TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // logs are ephemeral: 7 days

let DB_PATH = process.env.OPENCODE_DB_PATH || path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function setDbPath(p) { DB_PATH = p; }
function dbPath() { return DB_PATH; }

function openDb() {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch { return null; }
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    // readonly: opencode may be actively writing (WAL) — we never lock it.
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
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
  const ev = { kind: data.type, at: data.time?.created || data.time?.start || null };
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
 *   { ok:true, engine:'opencode', sessionId, events: [...], byMessage: [[...]], ttlMs }
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
  const db = openDb();
  if (!db) return { ok: false, error: 'db-unavailable' };
  try {
    const rows = db.prepare(
      'SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC LIMIT ?'
    ).all(engineId, MAX_EVENTS);
    if (!rows.length) {
      const exists = db.prepare('SELECT 1 FROM session WHERE id = ?').get(engineId);
      if (!exists) return { ok: false, error: 'session-not-found' };
    }
    const events = rows.map(r => normalizePart(JSON.parse(r.data))).filter(Boolean);
    const byMessage = groupByMessages(events, session?.messages || []);
    return { ok: true, engine: 'opencode', sessionId: engineId, events, byMessage, ttlMs: TRACE_TTL_MS };
  } catch (e) {
    console.warn('[session-trace] read:', e.message);
    return { ok: false, error: 'read-failed' };
  } finally {
    try { db.close(); } catch {}
  }
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

module.exports = { readTrace, groupByMessages, dbPath, setDbPath, truncate };