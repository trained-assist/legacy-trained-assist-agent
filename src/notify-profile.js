'use strict';

// Audience-aware notify to a profile's most recent chat (#1754).
//
// The chat id comes from .chatid (the chat that last ran a task); the audience
// comes from that chat's session record (session ids embed the chat id:
// s-<chatId>-…) and the bot token is resolved per-audience via bot-delivery —
// an audience never falls back to another bot (#1302). Same semantics as
// gtd-controller's resolveOwnerTarget, without a durable store/task.
//
// Consumed by the recruiting hub launch push: server.js wires it into
// hhCtx.notifyProfile (secrets/readChatId/userWorkDir injected there).

const fs = require('fs');
const path = require('path');
const { deliverySecrets } = require('./bot-delivery');

async function notifyProfile(username, text, {
  secrets = {},
  readChatId,
  userWorkDir,
  threadId = null,
  fetchImpl = globalThis.fetch,
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
    const payload = { chat_id: chatId, text, disable_web_page_preview: true };
    if (thread != null) payload.message_thread_id = thread;
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.warn(`[notifyProfile] ${username} → chat ${chatId} (${audience}): HTTP ${r.status}`);
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = notifyProfile;
