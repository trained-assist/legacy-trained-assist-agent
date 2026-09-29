'use strict';

// Run identity accessor — the single reader of "which chat/session is this run in"
// (epic #1365 §6). Generic feature code must NOT read the raw Telegram chat-id env var
// from the runner: that legacy coupling is frozen by the telegram-sender ratchet
// (test/ratchet-telegram-senders.test.cjs). The channel-neutral source of the current
// dialog is the session record the runner stamped — AGENT_SESSION_FILE → liveChatId —
// the same source get_chat_history uses (tools/02-chat-history.js).
//
// A run is an interactive Telegram dialog when its session is attached to a real chat
// (never Web's chat 0) and it is a live session, not a durable plan step (s-plan-*).
// Everything else — Web, background plan steps, cron/internal calls with no session —
// is non-interactive.

const fs = require('fs');

// Chat id from a session record file, or null. Numeric ids only; Web's 0 (and a
// missing/legacy record) → null, so callers can never mistake "no chat" for a dialog.
function sessionChatId(sessionFile) {
  if (!sessionFile) return null;
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const chat = session && (session.liveChatId ?? session.ownerChatId); // ownerChatId: read-compat pre-rename
    const trimmed = chat == null ? '' : String(chat).trim();
    if (!/^-?\d+$/.test(trimmed) || Number(trimmed) === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function currentRunIdentity(env = process.env) {
  const chatId = sessionChatId(env.AGENT_SESSION_FILE);
  const sessionId = String(env.AGENT_SESSION_ID || '').trim();
  const interactive = !!chatId && !!sessionId && !sessionId.startsWith('s-plan-');
  return { chatId, sessionId: sessionId || null, interactive };
}

module.exports = { sessionChatId, currentRunIdentity };
