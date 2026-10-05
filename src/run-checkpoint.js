'use strict';

// #143 rule 5 / #136 — durable save checkpoints during a run.
//
// An end-of-run check cannot help if the process crashes mid-run (a restart, an OOM, a
// killed container): the last known save-state must already be on disk. This writes one
// JSONL line per run to `<AGENT_DATA_DIR>/run-checkpoints/<profile>.jsonl` — branch,
// HEAD, modified count and unpushed count — deduplicated so an idle run does not grow
// the file, and append-only so a crash can only lose the tail.
//
// Read-only with respect to git: it observes (via src/run-end-save-check.js), never
// commits or pushes. Checkpoints are observations, not a delivery claim.

const fs = require('fs');
const path = require('path');
const { SYSTEM_ROOT } = require('./data-paths');
const { gitSaveState, planWorkspaceSaveState } = require('./run-end-save-check');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_LINES = 500; // per profile — a long-lived run set stays bounded

function checkpointDir(root = SYSTEM_ROOT) {
  return path.join(root, 'run-checkpoints');
}

function checkpointFile(profileId, root = SYSTEM_ROOT) {
  const safe = String(profileId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(checkpointDir(root), `${safe}.jsonl`);
}

// The save-state to record: the plan workspace when this run is a durable step (its
// identity is known via resumeSink), else the run's own code cwd.
function checkpointState({ profileId, planTaskId = null, codeCwd = null, workspacesDir = null, run = null } = {}) {
  if (planTaskId) {
    const st = planWorkspaceSaveState(profileId, planTaskId, { workspacesDir, run });
    if (st) return { kind: 'plan-workspace', ...st };
  }
  return { kind: 'cwd', ...gitSaveState(codeCwd, { run }) };
}

function sameState(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.dir === b.dir && a.head === b.head && a.branch === b.branch
    && a.modifiedCount === b.modifiedCount && a.ahead === b.ahead;
}

function readCheckpoints(profileId, { root = SYSTEM_ROOT, taskId = null } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(checkpointFile(profileId, root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!taskId || rec.taskId === taskId) out.push(rec);
    } catch { /* a torn tail line after a crash is expected — skip it */ }
  }
  return out;
}

function lastCheckpoint(profileId, taskId, opts = {}) {
  const list = readCheckpoints(profileId, { ...opts, taskId });
  return list.length ? list[list.length - 1] : null;
}

// Append one checkpoint, skipping when nothing changed since this task's last one.
// Never throws; a checkpoint must not take a run down.
function recordCheckpoint({ profileId, taskId = null, sessionId = null, state, at = Date.now(), root = SYSTEM_ROOT } = {}) {
  try {
    if (!state || !state.isRepo) return null;
    const last = lastCheckpoint(profileId, taskId, { root });
    if (sameState(last, state)) return null;
    const rec = {
      at, taskId, sessionId,
      kind: state.kind, dir: state.dir, branch: state.branch, head: state.head,
      modifiedCount: state.modifiedCount, ahead: state.ahead, hasUpstream: state.hasUpstream,
      unsaved: !!state.unsaved,
    };
    fs.mkdirSync(checkpointDir(root), { recursive: true, mode: 0o700 });
    const file = checkpointFile(profileId, root);
    // Trim oldest lines so the file stays bounded (best-effort, append-first).
    let existing = [];
    try { existing = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { existing = []; }
    if (existing.length >= MAX_LINES) existing = existing.slice(existing.length - MAX_LINES + 1);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, [...existing, JSON.stringify(rec)].join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return rec;
  } catch (e) {
    console.warn('[run-checkpoint] record failed:', e.message);
    return null;
  }
}

// Start the periodic loop: one checkpoint immediately (so even a crash with zero output
// leaves a baseline), then every intervalMs while the engine runs. Returns {stop, take}.
// The timer is unref'd so it never keeps the process alive by itself; the caller MUST
// call stop() when the engine returns.
function startCheckpointLoop({
  profileId, taskId = null, sessionId = null, planTaskId = null, codeCwd = null,
  intervalMs = DEFAULT_INTERVAL_MS, root = SYSTEM_ROOT, workspacesDir = null, run = null, now = Date.now,
  // Injectable for tests; defaults to the real git observation.
  stateFn = null,
} = {}) {
  const take = () => {
    try {
      const state = (stateFn || checkpointState)({ profileId, planTaskId, codeCwd, workspacesDir, run });
      return recordCheckpoint({ profileId, taskId, sessionId, state, at: now(), root });
    } catch (e) { console.warn('[run-checkpoint] take failed:', e.message); return null; }
  };
  // The baseline is scheduled, NOT awaited inline: it must not sit on the run's critical
  // path (the engine spawn is next), while still landing before any real work happens.
  const baseline = setTimeout(take, 0);
  if (baseline.unref) baseline.unref();
  const timer = setInterval(take, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop() { clearTimeout(baseline); clearInterval(timer); },
    take,
  };
}

module.exports = {
  checkpointDir, checkpointFile, checkpointState, recordCheckpoint,
  readCheckpoints, lastCheckpoint, startCheckpointLoop,
  DEFAULT_INTERVAL_MS, MAX_LINES,
};
