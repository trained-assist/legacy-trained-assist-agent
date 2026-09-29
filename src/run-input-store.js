// Per-run snapshot of the REAL model input — what the agent actually handed the
// engine for this run (system prompt + context/task), written at spawn time and
// keyed by taskId. Powers the gateway's «Посмотреть input» button: the button
// used to show only the gateway-side task text with a "the model gets more" note;
// this store is that missing "more", verifiable per run.
//
// Location: <workDir>/.run-inputs/<taskId>.txt — per-profile, survives restarts,
// pruned to the newest KEEP files. Best-effort by contract: every failure here
// must degrade to "no snapshot" (404 on the endpoint → gateway fallback), never
// to a blocked run.
//
// The document IS the input, verbatim and nothing else — no header, stats or
// per-engine commentary (that noise is what made the snapshot hard to read).
// Provenance survives outside the file: taskId in the filename, time in mtime.
//
// Web «📋 Посмотреть input» (US-INPUT-01, web channel): the web UI knows a
// session and an answer, not a taskId. So a run also drops a tiny sidecar
// <taskId>.json {sessionId, at} next to the document, and findForSession()
// picks the input of the latest run of that session that started before the
// answer. The document itself stays verbatim — the sidecar is never shown.
const fs = require('fs');
const path = require('path');
const { writeMode } = require('./data-paths');
const { atomicText } = require('./atomic-json');

// Mirrors the /run taskId grammar (username ≤32, audience ≤32, requestId ≤128,
// all [a-zA-Z0-9_-]) plus a safety margin. Doubles as the filename guard.
const TASK_ID_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const KEEP = 30;

const storeDir = workDir => path.join(workDir, '.run-inputs');

function buildDocument({ systemPrompt, prompt }) {
  const parts = [systemPrompt, prompt].filter(s => typeof s === 'string' && s.length > 0);
  return parts.join('\n\n');
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const stale of files.slice(KEEP)) {
      fs.unlinkSync(path.join(dir, stale.f));
      try { fs.unlinkSync(path.join(dir, stale.f.replace(/\.txt$/, '.json'))); } catch { /* no sidecar */ }
    }
  } catch { /* pruning is never worth failing a run over */ }
}

// meta.sessionId (optional) → sidecar that lets the web find this run by session.
function writeInput(workDir, taskId, doc, meta = {}) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId) || typeof doc !== 'string') return false;
  const dir = storeDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  atomicText(path.join(dir, `${taskId}.txt`), doc, writeMode(0o600));
  if (meta && typeof meta.sessionId === 'string' && meta.sessionId) {
    const at = Number.isFinite(meta.at) ? meta.at : Date.now();
    atomicText(path.join(dir, `${taskId}.json`), JSON.stringify({ sessionId: meta.sessionId, at }), writeMode(0o600));
  }
  prune(dir);
  return true;
}

// Input of the latest run of `sessionId` that started at or before `before`
// (the answer's timestamp; omitted → latest run). → {taskId, at, doc} | null.
function findForSession(workDir, sessionId, before = null) {
  if (!workDir || !sessionId || typeof sessionId !== 'string') return null;
  const dir = storeDir(workDir);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const taskId = f.slice(0, -5);
      if (!TASK_ID_RE.test(taskId)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!meta || meta.sessionId !== sessionId || !Number.isFinite(meta.at)) continue;
      if (Number.isFinite(before) && meta.at > before) continue;
      if (!best || meta.at > best.at) best = { taskId, at: meta.at };
    }
  } catch { return null; }
  if (!best) return null;
  const doc = readInput(workDir, best.taskId);
  return doc == null ? null : { ...best, doc };
}

function readInput(workDir, taskId) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId)) return null;
  try {
    return fs.readFileSync(path.join(storeDir(workDir), `${taskId}.txt`), 'utf8');
  } catch {
    return null;
  }
}

module.exports = { buildDocument, writeInput, readInput, findForSession, TASK_ID_RE, KEEP };
