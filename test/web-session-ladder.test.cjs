'use strict';
// «🔀 Какая модель ответила» (web channel): POST /web/session-ladder reads the
// llm-ladder worker's per-call rung trace (GET /v1/calls) so a UI can answer "which
// model wrote this, and what did the ones before it say". Before this, the only reader
// of ladder_calls was scripts/query-trace.py on a laptop holding a Cloudflare token.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'bearer-fixture';
const CALLS = { count: 1, calls: [{ ladder: 'deepseek', ok: true, model: 'opencode-go/mimo-v2.6-flash', ms: 12, attempts: [{ model: 'opencode-go/mimo-v2.6-flash', outcome: 'ok' }] }] };

// Minimal Node req/res around src/handlers/web.js's handleWeb.
function call(path, { token = SECRET, username = 'kobzevvv', id, limit, body } = {}) {
  const { handleWeb } = require('../src/handlers/web');
  const req = {
    method: 'POST',
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const handlers = {};
  let out = { status: 0, data: null };
  req.emit = (ev, arg) => { (handlers[ev] || []).forEach(fn => fn(arg)); };
  const res = {
    writeHead(status) { out.status = status; },
    end(payload) { if (payload) out.data = JSON.parse(payload); },
  };
  // readBodyBuffer reads a Node stream ('data'/'end' events), not an async iterator.
  const payload = Buffer.from(JSON.stringify(body !== undefined ? body : { username, ...(id ? { id } : {}), ...(limit ? { limit } : {}) }));
  req.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return req; };
  queueMicrotask(() => {
    for (let i = 0; i < payload.length; i += 8) req.emit('data', payload.subarray(i, i + 8));
    req.emit('end');
  });
  return handleWeb(req, new URL(`https://agent.test${path}`), res, { secrets: { WEB_VERIFY_SECRET: SECRET } })
    .then(() => out);
}

test('/web/session-ladder: bearer required', async () => {
  assert.equal((await call('/web/session-ladder', { token: null })).status, 401);
  assert.equal((await call('/web/session-ladder', { token: 'wrong' })).status, 401);
});

test('/web/session-ladder: username is validated before any upstream call', async () => {
  const saved = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return Response.json(CALLS); };
  try {
    assert.equal((await call('/web/session-ladder', { username: '../etc/passwd' })).status, 400);
    assert.equal((await call('/web/session-ladder', { username: '' })).status, 400);
    assert.equal(called, 0, 'a rejected username must never reach the worker');
  } finally { globalThis.fetch = saved; }
});

test('/web/session-ladder: delegates to the worker /v1/calls with the session and the ladder token', async (t) => {
  const savedFetch = globalThis.fetch, savedToken = process.env.LLM_LADDER_TOKEN;
  process.env.LLM_LADDER_TOKEN = 'ladder-token';
  let seen = null;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), auth: opts.headers.Authorization }; return Response.json(CALLS); };
  t.after(() => { globalThis.fetch = savedFetch; if (savedToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = savedToken; });
  const out = await call('/web/session-ladder', { id: 'sess-42' });
  assert.equal(out.status, 200);
  assert.match(seen.url, /\/v1\/calls\?/);
  assert.match(seen.url, /user=kobzevvv/, 'the profile scopes the read — never the whole log');
  assert.match(seen.url, /session=sess-42/);
  assert.equal(seen.auth, 'Bearer ladder-token');
  assert.equal(out.data.ok, true);
  assert.equal(out.data.calls[0].attempts.length, 1, 'the rung trace is passed through parsed');
});

test('/web/session-ladder: no ladder token → 503; a worker error → 502, never a throw', async (t) => {
  const savedFetch = globalThis.fetch, savedToken = process.env.LLM_LADDER_TOKEN;
  t.after(() => { globalThis.fetch = savedFetch; if (savedToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = savedToken; });
  delete process.env.LLM_LADDER_TOKEN;
  const savedDir = process.env.AGENT_TOKENS_DIR;
  process.env.AGENT_TOKENS_DIR = require('os').tmpdir() + '/no-ladder-token-' + Date.now();
  delete require.cache[require.resolve('../src/data-paths')];
  t.after(() => { if (savedDir === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = savedDir; });
  assert.equal((await call('/web/session-ladder', { id: 's' })).status, 503);

  process.env.LLM_LADDER_TOKEN = 'ladder-token';
  globalThis.fetch = async () => Response.json({ error: { message: 'nope' } }, { status: 500 });
  assert.equal((await call('/web/session-ladder', { id: 's' })).status, 502);
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal((await call('/web/session-ladder', { id: 's' })).status, 500);
});
