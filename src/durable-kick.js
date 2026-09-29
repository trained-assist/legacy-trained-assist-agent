'use strict';

// Immediate wake-up for the durable executor (durable-wait-latency design §2.2).
//
// A wait resolved by an event that happened OUTSIDE the 30s wait tick — the user
// answered (`task_item_wake`), a credential was written — must start the plan
// now, not at the next tick. Two callers, two transports:
//   • in the server process: `useInProcess()` (server.js scheduleGtdController)
//     registers the direct `kickDurable()` — no HTTP at all;
//   • in another process (the MCP tool process, a credential write): best-effort
//     `POST /internal/durable/kick`. Errors are swallowed on purpose — a missed
//     kick degrades to the wait tick (≤ ~60s, still inside the DW-05 budget).
// Kill-switch: DURABLE_KICK=0 (design §6).

const KICK_PATH = '/internal/durable/kick';

let inProcess = null;

/** Register the server-process fast path (fn → kick now). fn null/invalid clears it. */
function useInProcess(fn) {
  inProcess = typeof fn === 'function' ? fn : null;
}

/**
 * Nudge the executor to run a durable pass now.
 * @param {string} reason why ('wake' | 'credential' | …) — logging only
 * @returns {Promise<boolean>} true when the kick was handed over
 */
async function notify(reason = 'kick') {
  if (process.env.DURABLE_KICK === '0') return false;
  if (inProcess) {
    try { inProcess(reason); return true; }
    catch (e) { console.warn('[durable-kick] in-process %s: %s', reason, e.message); return false; }
  }
  // AGENT_SECRET is the /internal gate's credential (present in the MCP process —
  // bridge-spawned MCP servers keep the full service env). A run token is the
  // fallback for envs without it: the gate accepts it for THIS route only.
  const secret = process.env.AGENT_SECRET || process.env.AGENT_RUN_TOKEN;
  if (!secret) return false;
  const port = Number(process.env.PORT) || 3001; // same default as src/server.js
  try {
    const res = await fetch(`http://127.0.0.1:${port}${KICK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(1500),
    });
    return !!res.ok;
  } catch { return false; }
}

module.exports = { notify, useInProcess, KICK_PATH };
