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
const fs = require('fs');
const path = require('path');
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
    for (const stale of files.slice(KEEP)) fs.unlinkSync(path.join(dir, stale.f));
  } catch { /* pruning is never worth failing a run over */ }
}

function writeInput(workDir, taskId, doc) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId) || typeof doc !== 'string') return false;
  const dir = storeDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  atomicText(path.join(dir, `${taskId}.txt`), doc, { mode: 0o600 });
  prune(dir);
  return true;
}

function readInput(workDir, taskId) {
  if (!workDir || !taskId || !TASK_ID_RE.test(taskId)) return null;
  try {
    return fs.readFileSync(path.join(storeDir(workDir), `${taskId}.txt`), 'utf8');
  } catch {
    return null;
  }
}

module.exports = { buildDocument, writeInput, readInput, TASK_ID_RE, KEEP };
