'use strict';

// Live-bot QA MCP tools (epic #1851 S1, issue #1878).
//
// Three tools the agent calls to PROVE a feature works on the live bot without ever
// seeing a secret:
//   prod_status   — is the release deployed (agent commit / gateway buildSha / merge-base
//                   vs an expected SHA) and are there errors in the journal;
//   qa_user_send  — send a message AS the derived test profile `qa-<caller>` and get back
//                   the bot's answer, its sessionId and the buttons it attached;
//   qa_trace      — a compact follow-up trace for a sessionId (messages, buttons, journal,
//                   execution history).
//
// Transport: the tools POST to the server-side route `${AGENT_PUBLIC_URL}/web/qa-bearer`
// with the shared bearer. The route does the privileged work (journalctl, git, profile
// creation) — the isolated agent slot never needs the secret or localhost access. The
// caller (the calling profile's USER_ID) is passed as `caller`; the server derives the
// test profile and enforces the rate limit. AGENT_SECRET is read from the environment and
// sent ONLY in the request header — it never appears in a tool result.

const CALLER_RE = /^[a-zA-Z0-9_-]{1,48}$/;

function agentUrl() {
  return (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/+$/, '');
}

function agentSecret() {
  return process.env.AGENT_SECRET || '';
}

function callerOf(ctx) {
  const c = String((ctx && ctx.userId) || process.env.USER_ID || '');
  return CALLER_RE.test(c) ? c : '';
}

async function callQa(payload, { timeoutMs = 15000 } = {}) {
  const res = await fetch(`${agentUrl()}/web/qa-bearer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentSecret()}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 1000) }; }
}

function parseSse(text) {
  const events = [];
  const re = /data:\s*(\{[^\n]*\})/g;
  let m;
  while ((m = re.exec(text))) {
    try { events.push(JSON.parse(m[1])); } catch { /* partial line */ }
  }
  return events;
}

function sessionIdFrom(events) {
  const withSid = events.find((e) => e && e.sessionId);
  return withSid ? withSid.sessionId : null;
}

const tools = {
  prod_status: {
    description:
      'Check whether a release is live and healthy: the agent /health commit, the Telegram-gateway ' +
      'buildSha, whether an expected SHA is already an ancestor of the live release (merge-base), ' +
      'and error lines from the agent journal for the last N minutes. Runs server-side; returns no secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        expectSha: { type: 'string', description: 'SHA that must be deployed (e.g. the merge commit of the PR). Optional.' },
        sinceMinutes: { type: 'number', description: 'Journal lookback window in minutes (default 30).' },
      },
    },
    handler: async (args = {}, ctx) => {
      const caller = callerOf(ctx);
      const r = await callQa({ op: 'status', caller: caller || undefined, expectSha: args.expectSha, sinceMinutes: args.sinceMinutes });
      const j = await safeJson(r);
      return { ok: r.status === 200, status: r.status, ...j };
    },
  },

  qa_user_send: {
    description:
      'Send a message to the live bot AS a test profile (qa-<caller>, created automatically) and return the ' +
      'answer: {sessionId, text, buttons}. Never writes as a real client — the profile is derived server-side. ' +
      'Rate-limited to 20 sends/hour per caller; each send is a real model run.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Message to send to the bot as the test profile.' },
        sessionId: { type: 'string', description: 'Continue an existing test session instead of starting a new one. Optional.' },
      },
    },
    handler: async (args = {}, ctx) => {
      const caller = callerOf(ctx);
      if (!caller) return { ok: false, error: 'cannot derive caller (no USER_ID)' };
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) return { ok: false, error: 'text required' };
      const r = await callQa({ op: 'send', caller, text, sessionId: args.sessionId }, { timeoutMs: 150000 });
      const sse = await r.text();
      if (r.status !== 200) {
        let j = null;
        try { j = JSON.parse(sse); } catch { /* SSE-ish body on an error is unlikely */ }
        return { ok: false, status: r.status, error: (j && j.error) || `HTTP ${r.status}`, ...(j && j.resetsIn ? { resetsIn: j.resetsIn } : {}) };
      }
      const events = parseSse(sse);
      const sessionId = sessionIdFrom(events);
      const text_ = events.filter((e) => e.type === 'chunk').map((e) => e.text).join('');
      const error = events.find((e) => e.type === 'error') ? events.find((e) => e.type === 'error').error : null;
      let buttons = null;
      if (sessionId) {
        try {
          const tr = await callQa({ op: 'trace', caller, sessionId });
          const tj = await safeJson(tr);
          buttons = tj.buttons || null;
        } catch { /* trace is best-effort */ }
      }
      return { ok: !error, status: r.status, sessionId, text: text_, buttons, ...(error ? { error } : {}) };
    },
  },

  qa_trace: {
    description:
      'Compact trace for a live-bot QA session: recent messages, the buttons the bot attached ' +
      '(labels + callbacks), journal lines for that session, and execution-history attempts. ' +
      'Only the qa-<caller> test profile is readable — a foreign session id returns 404.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by qa_user_send.' },
        sinceMinutes: { type: 'number', description: 'Journal lookback window in minutes (default 30).' },
      },
    },
    handler: async (args = {}, ctx) => {
      const caller = callerOf(ctx);
      if (!caller) return { ok: false, error: 'cannot derive caller (no USER_ID)' };
      const r = await callQa({ op: 'trace', caller, sessionId: args.sessionId, sinceMinutes: args.sinceMinutes });
      const j = await safeJson(r);
      return { ok: r.status === 200, status: r.status, ...j };
    },
  },
};

module.exports = { tools, _internals: { parseSse, sessionIdFrom, callerOf } };
