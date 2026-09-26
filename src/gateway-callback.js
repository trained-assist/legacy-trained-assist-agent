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
const MEDIA_GATEWAY_URL = (process.env.MEDIA_GATEWAY_URL || '').replace(/\/+$/, '');

/**
 * Notify the Telegram gateway that a run for this chat has finished.
 * No-op when the gateway URL is not configured (dev/tests) or the chat is
 * not a real Telegram chat (web/internal runs, chatId <= 0).
 *
 * @param {object} p
 * @param {number|string} p.chatId   Telegram chat the run streamed into
 * @param {number|null} [p.threadId] Forum topic, if any
 * @param {string|null} [p.requestId] Gateway dispatch id — the IntakeBuffer
 *   matches this against busyRequestId so a foreign run can't release the hold
 * @param {string|null} [p.taskId]   Agent-side task id (diagnostics)
 * @param {string} [p.outcome]       'done' | 'error' | 'stopped' | 'quick'
 * @param {string} [p.secret]        Bearer token (AGENT_SECRET)
 * @returns {Promise<boolean>} true if the gateway acknowledged
 */
async function notifyRunFinished({ chatId, threadId = null, requestId = null, taskId = null, outcome = 'done', secret = process.env.AGENT_SECRET }) {
  if (!MEDIA_GATEWAY_URL) return false;
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId) || numericChatId <= 0) return false;
  if (!secret) return false;
  try {
    const res = await fetch(`${MEDIA_GATEWAY_URL}/internal/run-finished`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        chatId: numericChatId,
        threadId: Number.isSafeInteger(Number(threadId)) && Number(threadId) > 0 ? Number(threadId) : null,
        requestId: requestId || null,
        taskId: taskId || null,
        outcome,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[gateway-callback] run-finished HTTP ${res.status} chat=${numericChatId} taskId=${taskId || '-'}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[gateway-callback] run-finished failed chat=${numericChatId} taskId=${taskId || '-'}: ${e.message}`);
    return false;
  }
}

module.exports = { notifyRunFinished };