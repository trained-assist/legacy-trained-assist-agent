'use strict';
// Task admission for the runner: scoped admission (Telegram dialog lane +
// session writer guard, src/core/admission.js, epic #1365 PR2) + the global
// RAM-aware concurrency semaphore. This module is the one place runner.js
// reaches for queue/admission primitives.
//
// There is intentionally NO per-profile / per-project / per-workDir locking:
// different dialogs and sessions of one profile run in parallel.

const os = require('os');
const admission = require('../core/admission').createAdmission();

// Global concurrency cap on live `claude` processes (across all profiles).
// RAM is cheap and monitored externally, so this is deliberately generous;
// tune via env without a code change.
const MAX_CONCURRENT_TASKS = Math.max(1, Number(process.env.MAX_CONCURRENT_TASKS) || 6);
// Soft free-RAM floor (MB). Below this we hold off spawning new tasks.
// MIN_FREE_RAM_MB=0 disables the watchdog (tests, dev machines — macOS os.freemem()
// excludes page cache and reads far below 512MB even when RAM is plentiful).
// `Number(x) || 512` used to turn an explicit 0 back into 512.
const MIN_FREE_RAM_MB = (() => {
  const raw = process.env.MIN_FREE_RAM_MB;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : 512;
})();
const RAM_POLL_MS = 2000;
const RAM_WAIT_MAX_MS = 60000; // never deadlock — proceed after this even if low

let _runningTasks = 0;
const _slotWaiters = [];

function _acquireSlot() {
  return new Promise(resolve => {
    const grab = () => {
      if (_runningTasks < MAX_CONCURRENT_TASKS) { _runningTasks++; resolve(); }
      else _slotWaiters.push(grab);
    };
    grab();
  });
}

function _releaseSlot() {
  _runningTasks = Math.max(0, _runningTasks - 1);
  const next = _slotWaiters.shift();
  if (next) next();
}

// Wait until free RAM is above the floor, or RAM_WAIT_MAX_MS elapses (backstop,
// os.freemem() undercounts reclaimable page cache — this is a soft guard, not a
// hard admission controller; external monitoring is the primary control).
async function _waitForRam() {
  if (MIN_FREE_RAM_MB <= 0) return;
  const start = Date.now();
  for (;;) {
    const freeMb = os.freemem() / (1024 * 1024);
    if (freeMb >= MIN_FREE_RAM_MB) return;
    if (Date.now() - start >= RAM_WAIT_MAX_MS) {
      console.warn(`[runner] RAM watchdog: proceeding after ${RAM_WAIT_MAX_MS}ms, free=${Math.round(freeMb)}MB < ${MIN_FREE_RAM_MB}MB`);
      return;
    }
    await new Promise(r => setTimeout(r, RAM_POLL_MS));
  }
}

module.exports = {
  admission,
  MAX_CONCURRENT_TASKS,
  MIN_FREE_RAM_MB,
  _acquireSlot,
  _releaseSlot,
  _waitForRam,
  // exposed for tests only
  _runningTasks: () => _runningTasks,
  _slotWaiters,
};
