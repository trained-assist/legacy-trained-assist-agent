'use strict';

const fs = require('fs');
const { sessionsDirPath } = require('../../data-paths');
const chatHistory = require('../../chat-history');
const groupHistory = require('../../group-history-store');
const { threadOf } = require('../../session-store');

// get_group_history window when the caller passes no since_hours (the store keeps 7 days).
const DEFAULT_GROUP_HISTORY_HOURS = 6;

/**
 * get_chat_history — retrieve conversation history from previous sessions
 * in the same Telegram chat (by liveChatId).
 *
 * Designed for lightweight context loading: the agent can peek at what was
 * discussed before the current session without bloating the main prompt.
 *
 * Scope: only the current user's own sessions (AGENT_DATA_DIR / cwd).
 * No cross-user access possible.
 */

function resolveSessionsDir() {
  const username = process.env.AGENT_USER_ID;
  if (!username) return null;
  // Session store lives in the profile workspace (USERS_ROOT/<u>/sessions).
  return sessionsDirPath(username);
}

function readSession(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function resolveCurrentChatId() {
  const sessionFile = process.env.AGENT_SESSION_FILE;
  if (!sessionFile) return null;
  const session = readSession(sessionFile);
  if (!session) return null;
  return session.liveChatId ?? session.ownerChatId ?? null;
}

// Forum topic of the current session (#1409): history stays inside this topic.
// undefined = unknown (legacy session / no session file) → no topic filter.
function resolveCurrentThreadId() {
  const sessionFile = process.env.AGENT_SESSION_FILE;
  if (!sessionFile) return undefined;
  return threadOf(readSession(sessionFile));
}

function resolveCurrentSessionId() {
  const sessionFile = process.env.AGENT_SESSION_FILE;
  if (!sessionFile) return null;
  const session = readSession(sessionFile);
  return session?.id || null;
}

function formatTime(ts) {
  if (!ts) return undefined;
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

module.exports = {
  tools: {
    get_chat_history: {
      description:
        'Load conversation history from PREVIOUS sessions in the same Telegram chat ' +
        '(and the same forum topic, when the chat is a forum group). ' +
        'Returns sessions and messages from earlier conversations with this user in this chat, ' +
        'excluding the current session. Use when the user references something from a past conversation ' +
        'or you need context that predates the current session. Sessions are returned most-recent first; ' +
        'use since_hours (6/24) to get "what was said in this chat in the last N hours".',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description:
              'Telegram chat ID to look up. If omitted, uses the current session\'s chat.',
          },
          sessions_limit: {
            type: 'number',
            description: 'Max number of previous sessions to return (default 3, max 10).',
          },
          msg_limit: {
            type: 'number',
            description:
              'Max messages per session to return (default 20, max 100). ' +
              'Returns the most recent messages within each session.',
          },
          since_hours: {
            type: 'number',
            description:
              'Only messages from the last N hours (e.g. 6 or 24), across ALL sessions of this chat. ' +
              'Sessions with no messages in the window are skipped.',
          },
          include_current: {
            type: 'boolean',
            description:
              'If true, also include the current session in results (default false).',
          },
        },
      },
      handler: async ({
        chat_id,
        sessions_limit = 3,
        msg_limit = 20,
        include_current = false,
        since_hours,
      } = {}) => {
        const sessionsDir = resolveSessionsDir();
        if (!sessionsDir) return { error: 'AGENT_USER_ID not set' };

        // Determine which chat to look up
        const targetChatId = chat_id || resolveCurrentChatId();
        if (!targetChatId) {
          return {
            error: 'No chat_id provided and current session has no liveChatId. ' +
              'Pass chat_id explicitly.',
          };
        }
        const targetChatStr = String(targetChatId);
        const currentChatId = resolveCurrentChatId();
        // Topic filter only for the current conversation's own chat; an explicit other
        // chat_id has no known topic.
        const threadId = currentChatId != null && String(currentChatId) === targetChatStr
          ? resolveCurrentThreadId() : undefined;
        if (!fs.existsSync(sessionsDir)) {
          return { sessions: [], total: 0, chat_id: targetChatStr, note: 'No sessions directory' };
        }

        // Most-recently-active first; the limit applies AFTER sorting (see chat-history.js).
        const found = chatHistory.chatSessions(sessionsDir, targetChatStr, {
          sinceHours: Number(since_hours) > 0 ? Number(since_hours) : null,
          threadId,
          excludeSessionId: include_current ? null : resolveCurrentSessionId(),
          sessionsLimit: Math.min(Math.max(1, Number(sessions_limit) || 3), 10),
          msgLimit: Math.min(Math.max(1, Number(msg_limit) || 20), 100),
        });
        const matched = found.map(s => ({
          session_id: s.id,
          topic: s.topic,
          created_at: formatTime(s.createdAt),
          last_at: formatTime(s.lastAt),
          total_messages: s.totalMessages,
          returned_messages: s.messages.length,
          messages: s.messages.map(m => ({ role: m.role, text: m.content, at: formatTime(m.at) })),
        }));

        return {
          chat_id: targetChatStr,
          since_hours: Number(since_hours) > 0 ? Number(since_hours) : undefined,
          sessions: matched,
          total: matched.length,
          note: matched.length === 0
            ? 'No previous sessions found for this chat.'
            : undefined,
        };
      },
    },

    get_group_history: {
      description:
        'Messages group participants wrote while the bot stayed quiet (NOT addressed to the bot), ' +
        'for the current group chat / forum topic. Default window: last 6 hours; pass since_hours ' +
        '(up to 168 = 7 days kept) for older. Each run\'s prompt only includes ' +
        'the ones that are NEW since the previous task; use this tool for earlier ones ' +
        '(«что обсуждали вчера», «что Петя писал утром»). Oldest first.',
      inputSchema: {
        type: 'object',
        properties: {
          since_hours: { type: 'number', description: 'Only messages from the last N hours (default 6; history is kept 7 days = 168).' },
          limit: { type: 'number', description: 'Max messages, newest kept (default 100, max 1000).' },
        },
      },
      handler: async ({ since_hours = DEFAULT_GROUP_HISTORY_HOURS, limit = 100 } = {}) => {
        const username = process.env.AGENT_USER_ID;
        if (!username) return { error: 'AGENT_USER_ID not set' };
        const chatId = resolveCurrentChatId();
        if (chatId == null) return { error: 'Current session has no chat.' };
        if (!(Number(chatId) < 0)) return { chat_id: String(chatId), messages: [], total: 0, note: 'Not a group chat.' };
        const threadId = resolveCurrentThreadId();
        const sinceHours = Number(since_hours) > 0 ? Number(since_hours) : DEFAULT_GROUP_HISTORY_HOURS;
        const entries = groupHistory.readGroupHistory(username, chatId, threadId ?? null, {
          sinceHours,
          limit,
        });
        return {
          chat_id: String(chatId),
          since_hours: sinceHours,
          messages: entries.map(e => ({ from: e.from, text: e.text, at: formatTime(e.ts) })),
          total: entries.length,
          note: entries.length ? undefined : 'No group history kept for this chat (or /history_off).',
        };
      },
    },
  },
};
