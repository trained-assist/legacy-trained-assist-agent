'use strict';

// Core admission (epic #1365 §2.3, PR2) — replaces the per-chat queue.
//
// An execution holds a SET of scopes for its whole run (see admissionScopes):
//   lane:<conversationKey>          — Telegram dialog lane (endpoint+chat+topic):
//                                     ≤1 interactive run per dialog, even across
//                                     different sessions;
//   session:<profile>:<sessionId>   — session writer guard, every channel incl.
//                                     Web: one writer per history.
// Profile / project / workDir are never scopes — different dialogs and
// sessions of one profile/folder run in parallel.
//
// The profile-wide gate that DOES exist is not a scope: the maintenance lock
// (src/profile-lock.js, epic #1784) is a file held by a separate process (the
// migrator), so it cannot be granted through this process-local table. The
// runner checks it before a run is journaled — see runner/index.js.
//
// Grant is all-or-nothing (no partial holds → no deadlock) and FIFO per scope:
// a waiter is skipped while any EARLIER waiter still wants one of its scopes,
// so a later request can never overtake an earlier one on a shared scope
// (no starvation). Waiting happens BEFORE the caller takes the global RAM/slot
// semaphore, so a busy dialog never holds a resource slot.
//
// Process-local by design: execution-owner-lock.js guarantees exactly one
// process owns agent-data, and accepted work is journaled (pending-tasks)
// before it waits here, so a restart re-admits it rather than losing it.

function createAdmission() {
  const holders = new Map(); // scope → grant token
  const waiters = [];        // { scopes, grant }

  function pump() {
    const wanted = new Set();
    for (let i = 0; i < waiters.length;) {
      const w = waiters[i];
      if (w.scopes.some(s => holders.has(s) || wanted.has(s))) {
        w.scopes.forEach(s => wanted.add(s));
        i++;
        continue;
      }
      waiters.splice(i, 1);
      w.grant();
    }
  }

  function run(scopes, fn) {
    const uniq = [...new Set((scopes || []).filter(Boolean))];
    if (!uniq.length) return Promise.resolve().then(fn);
    return new Promise((resolve, reject) => {
      waiters.push({
        scopes: uniq,
        grant() {
          const token = {};
          uniq.forEach(s => holders.set(s, token));
          const release = () => {
            uniq.forEach(s => { if (holders.get(s) === token) holders.delete(s); });
            pump();
          };
          Promise.resolve().then(fn).then(
            v => { release(); resolve(v); },
            e => { release(); reject(e); },
          );
        },
      });
      pump();
    });
  }

  // True if any scope is held or already awaited — the new request will wait.
  function isBusy(scopes) {
    const list = (scopes || []).filter(Boolean);
    return list.some(s => holders.has(s) || waiters.some(w => w.scopes.includes(s)));
  }

  function isHeld(scope) { return holders.has(scope); }

  // Drop a holder whose owner is PROVEN gone (no live process). Never call it
  // as a substitute for stopping a running owner: clearChat/timeout are not
  // proof of stop (§2.3), a second owner would then write the same history.
  function forceRelease(scope) {
    if (!holders.delete(scope)) return false;
    pump();
    return true;
  }

  return { run, isBusy, isHeld, forceRelease, _holders: holders, _waiters: waiters };
}

module.exports = { createAdmission };
