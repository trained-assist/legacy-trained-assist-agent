'use strict';

// Long MCP tool calls vs. the runner's 5-min inactivity kill.
// While a tool call is pending the engine prints nothing (claude/codex/opencode
// all go silent until the result comes back), so a legitimately slow tool —
// hermes_research runs a whole CLI session, 1–10 min — got the PARENT session
// SIGTERMed as "hung". The runner hands every engine (and so its MCP servers,
// which inherit the env) a per-run AGENT_KEEPALIVE_FILE; a slow tool touches it
// while it works, and the inactivity check counts a fresh mtime as activity.
// A really hung engine never touches it, so the watchdog still fires for those.

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEPALIVE_TOUCH_MS = 30_000;

function keepaliveFilePath(taskId) {
  const safe = String(taskId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(os.tmpdir(), 'agent-keepalive', safe);
}

function touch(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { fs.writeFileSync(file, ''); }
  } catch { /* best effort — never fail the tool over liveness bookkeeping */ }
}

// Last keepalive touch (ms epoch) or 0 when absent.
function lastKeepaliveAt(file) {
  if (!file) return 0;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Runs fn() while touching AGENT_KEEPALIVE_FILE every 30s. No-op wrapper when the
// env var is absent (tool called outside a runner-spawned engine).
async function withKeepalive(fn, file = process.env.AGENT_KEEPALIVE_FILE) {
  if (!file) return fn();
  touch(file);
  const timer = setInterval(() => touch(file), KEEPALIVE_TOUCH_MS);
  if (timer.unref) timer.unref();
  try { return await fn(); } finally { clearInterval(timer); }
}

module.exports = { keepaliveFilePath, lastKeepaliveAt, withKeepalive, KEEPALIVE_TOUCH_MS };
