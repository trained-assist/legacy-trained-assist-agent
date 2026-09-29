// Agent → gateway run-finished callback (epic #1527 PR1).
//
// The gateway's IntakeBuffer marks a chat `busy` when it dispatches a run and
// must keep that hold for the REAL lifetime of the run — /run returns 202 right
// after journaling, so the enqueue is not an end signal. This module is the
// primary end signal: the runner fires it when an admitted run settles
// (success, error, stop, quick answer). The gateway keeps two safety nets for
// the paths this push cannot cover (process death mid-run, lost packet):
// BUSY_MAX_MS and the /tasks/running?chatId= poll on the IntakeBuffer alarm.
//
// Delivery is fire-and-forget: a failed callback must never fail the run —
// the gateway self-heals via its safety nets.
//
// BUT a server restart is exactly the case this push exists for: `shutdown()`
// calls `process.exit(0)` right after `interruptForRestart()`, which settles
// every running task's promise and fires this fetch — with no chance to flush.
// The restart therefore dropped the release for every in-flight run, and each
// chat stayed `busy` until the gateway's own poll/hard cap caught up. Every
// notification is tracked here so shutdown can await the in-flight ones
// (`flushRunFinished`) before exiting — see `drainRunFinished` in server.js.
const { gatewayUrl } = require('./bot-registry');
const inflight = new Set();

/**
 * Await every run-finished notification still in flight. Called on shutdown
 * (server.js) before process.exit so a restart releases its chats promptly
 * instead of relying on the gateway's slow safety nets.
 * Never throws and never waits longer than the fetches' own 5s timeout.
 * @returns {Promise<void>}
 */
function flushRunFinished() {
  if (!inflight.size) return Promise.resolve();
  return Promise.allSettled([...inflight]).then(() => undefined);
}

/** @returns {number} notifications currently in flight (diagnostics/tests). */
function pendingRunFinished() {
  return inflight.size;
}


/**
 * Notify the Telegram gateway that a run for this chat has finished.
 * No-op when the gateway URL is not configured (dev/tests) or the chat is
 * not a real Telegram chat (web/internal runs use the chatId 0 sentinel).
 * Telegram group/supergroup ids are NEGATIVE and must be delivered too.
 *
 * @param {object} p
 * @param {number|string} p.chatId   Telegram chat the run streamed into
 * @param {number|null} [p.threadId] Forum topic, if any
 * @param {string|null} [p.requestId] Gateway dispatch id — the IntakeBuffer
 *   matches this against busyRequestId so a foreign run can't release the hold
 * @param {string|null} [p.taskId]   Agent-side task id (diagnostics)
 * @param {string} [p.outcome]       'done' | 'error' | 'stopped' | 'quick'
 * @param {number[]} [p.consumed]   Telegram message ids the model took in mid-run
 *   via get_new_messages (src/live-inbox.js) — the gateway drops them from its collector
 * @param {string} [p.audience]      Bot the run came through — picks its gateway
 *   (bot-registry gateway_url); 'default' = env MEDIA_GATEWAY_URL
 * @param {string} [p.secret]        Bearer token (AGENT_SECRET)
 * @returns {Promise<boolean>} true if the gateway acknowledged
 */
async function notifyRunFinished({ chatId, threadId = null, requestId = null, taskId = null, outcome = 'done', consumed = [], audience = 'default', secret = process.env.AGENT_SECRET }) {
  const base = gatewayUrl(audience);
  if (!base) return false;
  const numericChatId = Number(chatId);
  // 0 is the web/internal sentinel; any other safe integer is a real chat,
  // including NEGATIVE group/supergroup ids.
  if (!Number.isSafeInteger(numericChatId) || numericChatId === 0) return false;
  if (!secret) return false;
  // Track the request so a shutdown that races it can still await delivery.
  // The caller (runTask's side chain) does not hold this promise, so nothing
  // else would keep the event loop alive for it.
  const request = (async () => {
    try {
      const res = await fetch(`${base}/internal/run-finished`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          chatId: numericChatId,
          threadId: Number.isSafeInteger(Number(threadId)) && Number(threadId) > 0 ? Number(threadId) : null,
          requestId: requestId || null,
          taskId: taskId || null,
          outcome,
          ...(Array.isArray(consumed) && consumed.length ? { consumed } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`[gateway-callback] run-finished HTTP ${res.status} audience=${audience || 'default'} chat=${numericChatId} taskId=${taskId || '-'}`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`[gateway-callback] run-finished failed audience=${audience || 'default'} chat=${numericChatId} taskId=${taskId || '-'}: ${e.message}`);
      return false;
    }
  })();
  inflight.add(request);
  try {
    return await request;
  } finally {
    inflight.delete(request);
  }
}

module.exports = { notifyRunFinished, flushRunFinished, pendingRunFinished };