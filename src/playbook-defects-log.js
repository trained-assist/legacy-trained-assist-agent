'use strict';

// Append-only log of playbook "defects" — the places where a plan went through with
// something NOT confirmed (owner 2026-09-28: soften the checklist, but log every
// soft pass so the checklist can be improved from real data):
//   exception   — the agent closed its current step as an exception, with a reason
//   skip        — the agent skipped a not-started step, with a reason
//   unconfirmed — a semantic (yellow) check was not confirmed at finalization
//   blocked     — a deterministic (red) check was not met after all steps finished
// One JSON object per line in $AGENT_DATA_DIR/playbook-defects.jsonl.

const fs = require('fs');
const path = require('path');
const { SYSTEM_ROOT } = require('./data-paths');

function defectsLogPath() {
  return path.join(SYSTEM_ROOT, 'playbook-defects.jsonl');
}

function logDefect(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(path.dirname(defectsLogPath()), { recursive: true });
    fs.appendFileSync(defectsLogPath(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (e) {
    console.error('[playbook-defects] append failed:', e.message);
  }
  return row;
}

function readDefects({ profileId = null, taskId = null, kind = null, limit = 500 } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(defectsLogPath(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const rows = [];
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (profileId && r.profile_id !== profileId) continue;
    if (taskId && r.task_id !== taskId && !String(r.task_id || '').startsWith(taskId)) continue;
    if (kind && r.kind !== kind) continue;
    rows.push(r);
  }
  return rows.slice(-limit);
}

module.exports = { logDefect, readDefects, defectsLogPath };
