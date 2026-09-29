// Durable copy of the working trace the runner streams from the engine (#1893).
// «Полный лог» used to read ONLY the engine's own SQLite (session-trace.js); when
// that db was rotated/recreated the log vanished although every part had already
// passed through the runner's stream parser. The runner now appends each streamed
// part here, and readTrace falls back to this file when the engine db has nothing.
//
// Location: <workDir>/.session-traces/<engine>-<engineSessionId>.jsonl — one line
// per streamed part {v:1, id, taskId, ev} where ev is the display-normalized
// event (session-trace normalizePart). One file per ENGINE session: a resumed run
// appends to the same file; a part re-sent on resume collapses by id on read.
// The key carries the engine so claude/codex writers can join later unchanged;
// today only opencode writes (reasoning is not in the stream, so never here).
//
// Best-effort by contract (same as run-input-store): any failure degrades to
// "no durable trace", never to a failed run. Bounded: MAX_EVENTS lines per file
// (further appends are dropped), files untouched for TTL_MS are pruned.
const fs = require('fs');
const path = require('path');
const { writeMode } = require('./data-paths');

const ENGINE_RE = /^[a-z]{1,16}$/;
const SESSION_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const MAX_EVENTS = 4000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const storeDir = workDir => path.join(workDir, '.session-traces');
const lineCounts = new Map(); // file → lines written (avoids re-reading on the hot path)

function traceFile(workDir, engine, engineSessionId) {
  if (!workDir || !ENGINE_RE.test(engine || '') || !SESSION_RE.test(engineSessionId || '')) return null;
  return path.join(storeDir(workDir), `${engine}-${engineSessionId}.jsonl`);
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

/** Append one streamed engine part. → true when written, false otherwise. Never throws. */
function appendEvent(workDir, engine, engineSessionId, part, meta = {}) {
  try {
    const file = traceFile(workDir, engine, engineSessionId);
    if (!file || !part || typeof part !== 'object') return false;
    const { normalizePart } = require('./session-trace');
    const ev = normalizePart(part);
    if (!ev) return false;
    let n = lineCounts.get(file);
    if (n == null) n = countLines(file);
    if (n >= MAX_EVENTS) return false;
    const fresh = !fs.existsSync(file);
    if (fresh) { fs.mkdirSync(storeDir(workDir), { recursive: true }); prune(workDir); }
    const line = JSON.stringify({ v: 1, id: typeof part.id === 'string' ? part.id : null, taskId: meta.taskId || null, ev });
    fs.appendFileSync(file, line + '\n', writeMode(0o600));
    lineCounts.set(file, n + 1);
    return true;
  } catch {
    return false;
  }
}

/** → {found:false} | {found:true, events:[...]} — chronological, one event per part id. */
function readEvents(workDir, engine, engineSessionId) {
  const file = traceFile(workDir, engine, engineSessionId);
  if (!file) return { found: false };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { found: false }; }
  const byId = new Map();
  const anon = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // torn/garbled line: skip it
    if (!rec || !rec.ev || typeof rec.ev !== 'object') continue;
    // Later copy wins: a re-sent part carries the more complete state.
    if (rec.id) byId.set(rec.id, rec.ev); else anon.push(rec.ev);
  }
  const events = [...byId.values(), ...anon]
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => (a.ev.at ?? Infinity) - (b.ev.at ?? Infinity) || a.i - b.i)
    .map(x => x.ev)
    .slice(0, MAX_EVENTS);
  return { found: events.length > 0, events };
}

/** Drop trace files not written for TTL_MS. Never throws. */
function prune(workDir, now = Date.now()) {
  try {
    const dir = storeDir(workDir);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      if (now - fs.statSync(fp).mtimeMs > TTL_MS) { fs.unlinkSync(fp); lineCounts.delete(fp); }
    }
  } catch { /* pruning is never worth failing a run over */ }
}

module.exports = { appendEvent, readEvents, prune, traceFile, MAX_EVENTS, TTL_MS };
