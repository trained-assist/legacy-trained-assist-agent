'use strict';
// Live inbox (owner idea 2026-09-29): the running model sees messages the user sent
// AFTER its run started — a password, a file, a «да» — and takes them into the SAME
// turn instead of ending with «жду от тебя…».
//
// Pull model. While a run holds a chat, the gateway's IntakeBuffer keeps new
// messages in `buf` (GET /internal/held-messages). The MCP tool get_new_messages
// asks this server (run-scoped token → only its own task), this module resolves
// the task's chat/topic/requestId (the engine never supplies them, so it can't read
// another chat), pulls from the gateway, and remembers what it handed out. At
// run-finished those ids go back as `consumed`, so the collector doesn't re-offer
// input the model already handled.
//
// Direction of error: keep the message. Anything lost here (server restart, failed
// pull, missing registry entry) only means the gateway re-offers it after the run.
const { gatewayUrl } = require('./bot-registry');

const runs = new Map(); // taskId -> { chatId, threadId, requestId, given:Set<number>, consumed:Set<number> }

/** Register an accepted Telegram run (sync, from runTask). Web/internal runs (chatId 0) are skipped. */
function registerInboxRun({ taskId, chatId, threadId = null, requestId = null, audience = 'default' }) {
  const cid = Number(chatId);
  if (!taskId || !Number.isSafeInteger(cid) || cid === 0) return false;
  runs.set(taskId, {
    chatId: cid,
    threadId: Number.isSafeInteger(Number(threadId)) && Number(threadId) > 0 ? Number(threadId) : null,
    requestId: requestId || null,
    audience: audience || 'default', // held messages live in THIS bot's gateway
    given: new Set(),
    consumed: new Set(),
  });
  return true;
}

/** Drop the run and return the message ids the model took in (for run-finished). */
function takeConsumed(taskId) {
  const run = runs.get(taskId);
  runs.delete(taskId);
  return run ? [...run.consumed] : [];
}

const fmtAt = (unixSec) => unixSec
  ? new Date(unixSec * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК'
  : null;

/**
 * Messages the user sent after this run started that the model hasn't seen yet.
 * @returns {Promise<{ok:boolean, messages?:Array, pending?:number, note?:string, error?:string}>}
 */
async function fetchNewMessages(taskId, { secret = process.env.AGENT_SECRET, limit = 20 } = {}) {
  const run = runs.get(taskId);
  if (!run) return { ok: true, messages: [], note: 'Живой ящик недоступен для этого запуска (веб/внутренний запуск или задача уже завершилась). Новые сообщения придут отдельно после ответа.' };
  const base = gatewayUrl(run.audience);
  if (!base || !secret) return { ok: false, error: 'Источник новых сообщений не настроен на этом сервере.' };
  const qs = new URLSearchParams({ chatId: String(run.chatId) });
  if (run.threadId) qs.set('threadId', String(run.threadId));
  if (run.requestId) qs.set('requestId', run.requestId);
  let body;
  try {
    const res = await fetch(`${base}/internal/held-messages?${qs}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `Шлюз ответил HTTP ${res.status} — новые сообщения не прочитаны, они не потеряны и придут после ответа.` };
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `Шлюз недоступен (${e.message}) — новые сообщения не прочитаны, они не потеряны и придут после ответа.` };
  }
  if (!body?.busy || body.mismatch) return { ok: true, messages: [] };
  const items = Array.isArray(body.items) ? body.items : [];
  const fresh = items.filter(i => Number.isSafeInteger(i?.message_id) && !run.given.has(i.message_id));
  const pending = fresh.filter(i => i.ready === false).length;
  const out = [];
  for (const i of fresh) {
    if (i.ready === false) continue; // still downloading — next call
    if (out.length >= Math.max(1, Math.min(Number(limit) || 20, 50))) break;
    run.given.add(i.message_id);
    // A file the engine can't open from here stays in the collector for the next task;
    // text and voice (transcript) are fully delivered — mark them done.
    if (i.kind !== 'file') run.consumed.add(i.message_id);
    out.push({
      at: fmtAt(i.date),
      text: i.text || '',
      ...(i.files?.length ? { files: i.files, note: 'Файл пришёл, но в этот ход его не передать — он останется в чате и придёт следующей задачей.' } : {}),
    });
  }
  return { ok: true, messages: out, ...(pending ? { pending, note: `Ещё ${pending} вложени(я) загружаются — вызови позже.` } : {}) };
}

module.exports = { registerInboxRun, takeConsumed, fetchNewMessages, _runs: runs };
