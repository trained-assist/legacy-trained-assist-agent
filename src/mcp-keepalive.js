'use strict';

// Long MCP tool calls vs. the runner's 5-min inactivity kill.
// While a tool call is pending the engine prints nothing (claude/codex/opencode
// all go silent until the result comes back), so a legitimately slow tool got the
// PARENT session SIGTERMed as "hung". The runner hands every engine (and so its MCP
// servers, which inherit the env) a per-run AGENT_KEEPALIVE_FILE; a slow tool touches
// it while it works, and the inactivity check counts a fresh mtime as activity.
// A really hung engine never touches it, so the watchdog still fires for those.
// First needed by hermes_web_research (a whole nested CLI session, 1–10 min, removed
// 2026-10-05); still load-bearing for any slow tool — a deep web_research, a Playwright
// fetch, a batched company/INN lookup. The touch interval is 30s against a 5-min
// watchdog, so the margin is 8x — test/slow-tool-longrun.test.cjs pins the wiring, and
// test/web-research.test.cjs pins that the handler actually wraps its work in it.
//
// Where the file lives (issue #1791): writer (the MCP server) and reader (the
// runner) are both the service user — MCP servers run service-side through the
// bridge, and AGENT_KEEPALIVE_FILE is server-only, never handed to a slot. So the
// dir is private to the service (0700) under the data dir, never the shared /tmp:
// there a slot could create `agent-keepalive` first (after a reboot), the service
// could no longer write it, and slow hermes runs would be killed as hung again
// with nothing in the log (#1582). AGENT_KEEPALIVE_DIR overrides it (tests).

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEPALIVE_TOUCH_MS = 30_000;
const KEEPALIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function keepaliveDir() {
  if (process.env.AGENT_KEEPALIVE_DIR) return process.env.AGENT_KEEPALIVE_DIR;
  const root = process.env.AGENT_DATA_DIR || path.join(process.env.HOME || os.homedir(), 'agent-data');
  return path.join(root, 'agent-keepalive');
}

function keepaliveFilePath(taskId, dir = keepaliveDir()) {
  const safe = String(taskId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dir, safe);
}

// Never fail the tool over liveness bookkeeping — but say so, once per file:
// a keepalive that silently stops working means slow tools get killed as hung.
const warned = new Set();
function touch(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { fs.writeFileSync(file, '', { mode: 0o600 }); }
  } catch (e) {
    if (warned.has(file)) return;
    warned.add(file);
    console.warn(`[keepalive] cannot touch ${file}: ${e.message} — slow tool calls may be killed as hung`);
  }
}

// Files whose run never reached the runner's unlink (crash, restart). The dir is
// persistent, so without this they would pile up forever. Called at service start.
function sweepKeepalive(dir = keepaliveDir(), maxAgeMs = KEEPALIVE_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      if (now - fs.lstatSync(f).mtimeMs > maxAgeMs) { fs.rmSync(f, { force: true }); removed++; }
    } catch { /* gone meanwhile */ }
  }
  return removed;
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

module.exports = { keepaliveDir, keepaliveFilePath, lastKeepaliveAt, withKeepalive, sweepKeepalive, KEEPALIVE_TOUCH_MS, KEEPALIVE_MAX_AGE_MS };
