'use strict';
// Guard against the orphaned-server CPU-burn loop (observed 2026-09-27).
//
// When an agent session starts `node src/server.js` for testing and the parent
// later dies, stdout/stderr pipes close. The next console.error throws EPIPE;
// the uncaughtException handler then logs again -> EPIPE again -> infinite loop
// that pins a core at ~90% for days.
//
// Fix: an error on stdout/stderr, or an uncaught exception whose code means the
// stream is gone (EPIPE / ERR_STREAM_DESTROYED), must exit immediately without
// routing through console again.

const STREAM_GONE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

function isStreamGone(err) {
  return !!err && STREAM_GONE_CODES.has(err.code);
}

// Log writes are best-effort: a failing log must never re-throw into the handler.
function safeLog(fn) {
  try { fn(); } catch { /* ignore — stream is gone */ }
}

// Install the process-level safety net. `exit` is injectable for tests.
function installCrashGuards({ proc = process, exit = (code) => proc.exit(code) } = {}) {
  proc.stdout.on('error', (err) => { if (isStreamGone(err)) exit(0); });
  proc.stderr.on('error', (err) => { if (isStreamGone(err)) exit(0); });

  proc.on('unhandledRejection', (reason, promise) => {
    if (isStreamGone(reason)) return exit(0);
    safeLog(() => console.error('[unhandledRejection] at:', promise, 'reason:', reason));
    // Log but do NOT crash — a single bad request should not kill the server.
  });

  proc.on('uncaughtException', (err) => {
    if (isStreamGone(err)) return exit(0);
    safeLog(() => console.error('[uncaughtException]', err));
    // Same: log and keep running unless it's a startup error.
  });
}

module.exports = { isStreamGone, safeLog, installCrashGuards, STREAM_GONE_CODES };
