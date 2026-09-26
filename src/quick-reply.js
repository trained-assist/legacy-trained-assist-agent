'use strict';
// Quick-answer invariants (owner, 2026-09-26):
//   1. A quick answer is never empty. An empty/blank reply from any intent handler is a
//      bug; the guard turns it into «no quick answer» so the task falls through to the
//      agent instead of the user getting a bare ⚡.
//   2. Every ⚡ reply carries «🔎 Разобраться подробнее» (qa_more|<sessionId>, tg-bot
//      callbacks.js). A quick answer that missed the point is then one tap from the
//      agent, never a dead end. Utility / pre-queue replies used to go out button-less
//      because they were not logged to any session; recordQuickExchange gives them a
//      side session to escalate from without replacing the chat's current session.
const crypto = require('crypto');
const fs = require('fs');
const sessions = require('./session-store');

function isEmptyQuickReply(reply) {
  if (reply == null) return true;
  if (typeof reply === 'string') return !reply.trim();
  if (typeof reply === 'object' && 'hint' in reply) return !String(reply.hint || '').trim();
  return false;
}

// null for «no quick answer»; logs when a handler matched but produced nothing.
function nonEmptyQuickReply(reply, task) {
  if (reply == null) return null;
  if (!isEmptyQuickReply(reply)) return reply;
  console.warn('[quick-answer] EMPTY reply suppressed, falling through to the agent, task=%j', String(task || '').slice(0, 120));
  return null;
}

// Deterministic per (profile, chat, topic, text): repeating /ping reuses one side session
// instead of pushing real dialogs out of the 50-entry session index.
function quickExchangeSessionId(username, chatId, threadId, task) {
  const key = `${username}:${chatId}:${threadId ?? ''}:${String(task || '').trim()}`;
  return 'qa-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

// Stores task+reply in a side session and returns its id (null if it can't be stored).
// No chatId on create: the chat's current session must stay the user's real dialog.
// sideSession: kept out of the session index until escalated (session-store.promoteSideSession).
function recordQuickExchange(workDir, { username, chatId, threadId = null, audience, projectId = null, task, reply }) {
  if (!workDir || !String(task || '').trim() || isEmptyQuickReply(reply)) return null;
  try {
    if (!fs.existsSync(workDir)) return null;
    const id = quickExchangeSessionId(username, chatId, threadId, task);
    if (sessions.getSession(workDir, id)) sessions.appendUserMessage(workDir, id, task);
    else sessions.createSession(workDir, { task, id, projectId, audience, sideSession: true });
    sessions.appendReply(workDir, id, typeof reply === 'string' ? reply : String(reply.hint || ''));
    return id;
  } catch (e) {
    console.warn('[quick-answer] record exchange:', e.message);
    return null;
  }
}

function escalateRows(sessionId) {
  return sessionId ? [[{ text: '🔎 Разобраться подробнее', callback_data: `qa_more|${sessionId}` }]] : [];
}

module.exports = { isEmptyQuickReply, nonEmptyQuickReply, quickExchangeSessionId, recordQuickExchange, escalateRows };
