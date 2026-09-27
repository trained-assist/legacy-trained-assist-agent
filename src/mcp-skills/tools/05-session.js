'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  tools: {
    last_messages: {
      description: 'Get recent conversation history from the current session. ' +
        'Use when the user refers to something said earlier, or when you need context from previous messages in this chat.',
      inputSchema: {
        type: 'object',
        properties: {
          n: {
            type: 'number',
            description: 'Number of recent messages to return (default 8, max 20)',
          },
        },
      },
      handler: async ({ n = 8 } = {}) => {
        const sessionFile = process.env.AGENT_SESSION_FILE;
        if (!sessionFile) return { error: 'No active session' };

        let session;
        try {
          session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        } catch {
          return { error: 'Session not found or unreadable' };
        }

        const limit = Math.min(Math.max(1, n), 20);
        const messages = (session.messages || []).slice(-limit);

        if (!messages.length) return { messages: [], topic: session.topic || '' };

        return {
          topic: session.topic || '',
          total: session.messages?.length || 0,
          messages: messages.map(m => ({
            role: m.role,
            text: m.content,
            at: m.at ? new Date(m.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : undefined,
          })),
        };
      },
    },

    session_search: {
      description:
        'Search through all past conversation sessions using a RegExp pattern. ' +
        'Returns matching messages with session topic and surrounding context. ' +
        'Use when the user asks "remember when we discussed X", "find where I mentioned Y", ' +
        '"what did you tell me about Z last time".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'RegExp pattern to search for (e.g. "вакансия|vacancy", "nalog", "ошибка")',
          },
          flags: {
            type: 'string',
            description: 'RegExp flags (default "i" for case-insensitive). E.g. "i", "gi", ""',
          },
          limit: {
            type: 'number',
            description: 'Max number of matching messages to return (default 10, max 50)',
          },
          role: {
            type: 'string',
            enum: ['user', 'assistant', 'any'],
            description: 'Filter by message role (default "any")',
          },
        },
        required: ['pattern'],
      },
      handler: async ({ pattern, flags = 'i', limit = 10, role = 'any' } = {}) => {
        const username = process.env.AGENT_USER_ID;
        if (!username) return { error: 'AGENT_USER_ID not set' };

        const sessionsDir = require('../../data-paths').sessionsDirPath(username);

        let re;
        try {
          re = new RegExp(pattern, flags);
        } catch (e) {
          return { error: `Invalid RegExp: ${e.message}` };
        }

        let files;
        try {
          files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        } catch {
          return { matches: [], total: 0, note: 'No sessions found' };
        }

        const cap = Math.min(Math.max(1, limit), 50);
        const matches = [];

        for (const file of files) {
          if (matches.length >= cap) break;
          let session;
          try {
            session = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          } catch {
            continue;
          }

          const msgs = session.messages || [];
          for (let i = 0; i < msgs.length && matches.length < cap; i++) {
            const m = msgs[i];
            if (role !== 'any' && m.role !== role) continue;
            if (!re.test(m.content)) continue;

            const snippet = m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
            const prev = i > 0 ? (msgs[i - 1].content.slice(0, 100) + (msgs[i - 1].content.length > 100 ? '…' : '')) : null;
            const next = i < msgs.length - 1 ? (msgs[i + 1].content.slice(0, 100) + (msgs[i + 1].content.length > 100 ? '…' : '')) : null;

            matches.push({
              sessionId: session.id,
              topic: session.topic || '',
              at: m.at ? new Date(m.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : undefined,
              role: m.role,
              text: snippet,
              context: { prev, next },
            });
          }
        }

        return { matches, total: matches.length, searched: files.length };
      },
    },

    session_extend_timeout: {
      description:
        'Extend the current Claude session timeout by 15 minutes. ' +
        'Call this at the START of a long batch operation (inn_enrich_batch, expo_pipeline_run, etc.) ' +
        'to prevent the 15-min hard limit from killing the task mid-run. ' +
        'Max 8 extensions (2 hours total runtime). ' +
        'Returns extensionsLeft — stop extending when it reaches 0.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const taskId = process.env.AGENT_TASK_ID;
        const port   = process.env.PORT || '3000';
        // Run-scoped token first (issue #1649) — valid only for this run's own task.
        const secret = process.env.AGENT_RUN_TOKEN || process.env.AGENT_SECRET || '';

        if (!taskId) return { ok: false, error: 'AGENT_TASK_ID not set — not running inside agent session' };
        if (!secret) return { ok: false, error: 'no run token / AGENT_SECRET available' };

        try {
          const res = await fetch(`http://localhost:${port}/tasks/${encodeURIComponent(taskId)}/extend-timeout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${secret}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5000),
          });
          return await res.json();
        } catch (err) {
          return { ok: false, error: `Failed to reach agent server: ${err.message}` };
        }
      },
    },
  },
};
