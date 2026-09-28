'use strict';

// Audience-aware notify to a profile's most recent chat (#1754).
//
// The chat id comes from .chatid (the chat that last ran a task); the audience
// comes from that chat's session record (session ids embed the chat id:
// s-<chatId>-…) and the bot token is resolved per-audience via bot-delivery —
// an audience never falls back to another bot (#1302). Same semantics as
// gtd-controller's resolveOwnerTarget, without a durable store/task.
//
// The send itself goes through the shared sendChatReply (94-tg-send) — the same
// non-run delivery hermes-delivery.js uses — so this file adds no direct
// Telegram call site (ratchet test/ratchet-telegram-senders.test.cjs).
//
// Consumed by the recruiting hub launch push: server.js wires it into
// hhCtx.notifyProfile (secrets/readChatId/userWorkDir injected there).

const fs = require('fs');
const path = require('path');
const { deliverySecrets } = require('./bot-delivery');
const { sendChatReply } = require('./mcp-skills/tools/94-tg-send');

async function notifyProfile(username, text, {
  secrets = {},
  readChatId,
  userWorkDir,
  threadId = null,
  fetchImpl = undefined,
} = {}) {
  const chatId = typeof readChatId === 'function' ? readChatId(username) : null;
  if (!chatId) return { sent: false, reason: 'no_chat_id' };

  let audience = 'default';
  let thread = threadId;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(userWorkDir(username), 'sessions.json'), 'utf8'));
    const rec = (Array.isArray(idx) ? idx : [])
      .filter(s => s && typeof s.id === 'string' && s.id.startsWith(`s-${chatId}-`))
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
    if (rec) {
      audience = rec.audience || 'default';
      if (thread == null) {
        try {
          const full = JSON.parse(fs.readFileSync(path.join(userWorkDir(username), 'sessions', `${rec.id}.json`), 'utf8'));
          thread = full.messageThreadId ?? null;
        } catch { /* no full record — plain chat */ }
      }
    }
  } catch { /* legacy profile without an index — default audience */ }

  let token;
  try {
    const routed = deliverySecrets(secrets, audience);
    token = routed?.TELEGRAM_BOT_TOKEN || routed?.BOT_TOKEN;
  } catch (e) {
    return { sent: false, reason: `bot_unavailable: ${e.message}` };
  }
  if (!token) return { sent: false, reason: 'no_bot_token' };

  try {
    const opts = { target: { chatId, token, ...(thread != null ? { threadId: thread } : {}) } };
    if (fetchImpl) opts.fetchImpl = fetchImpl;
    await sendChatReply({ text: String(text) }, opts);
    return { sent: true };
  } catch (e) {
    console.warn(`[notifyProfile] ${username} → chat ${chatId} (${audience}): ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = notifyProfile;
