// service-llm → llm-ladder worker: pin tests to an unroutable host + dummy token so they are
// self-contained (staging runs this file directly, outside scripts/run-cjs-tests.js) and can
// never reach the live worker via the VM's token file.
process.env.LLM_LADDER_URL = 'http://llm-ladder.invalid';
process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// src/service-llm.js — thin client of the trained-assist-llm-ladder worker (the ladder itself,
// model health and Go key rotation live in the worker; no in-process copy any more).
const s = require('../src/service-llm');
const ok = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

test('sends the ladder name + JSON mode + time budgets to the worker with the bearer token', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return ok({ model: 'opencode-go/mimo-v2.6-flash', choices: [{ message: { content: '```json\n{"a":1}\n```' } }], usage: { prompt_tokens: 3 } }); };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], json: true, maxTokens: 50, timeoutMs: 4000, totalTimeoutMs: 6000, fetchImpl });
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(r.model, 'opencode-go/mimo-v2.6-flash');
  assert.match(seen.url, /\/v1\/chat\/completions$/);
  assert.equal(seen.init.headers.Authorization, `Bearer ${process.env.LLM_LADDER_TOKEN}`);
  assert.equal(seen.body.model, 'deepseek');
  assert.equal(seen.body.response_format.type, 'json_object');
  assert.equal(seen.body.ladder_timeout_ms, 4000);
  assert.equal(seen.body.ladder_total_timeout_ms, 6000);
});

test('the worker ALWAYS gets a deadline, and the client outlives it', async () => {
  // The bug this pins: without a worker deadline the worker keeps walking rungs while the client
  // aborts, and the call is booked as `fetch_error` (a client timeout) although the worker
  // answered it — 278 of 2509 service calls over 7 days. The client signal must therefore always
  // outlive the budget we handed the worker, so the worker stops first and we read its answer.
  const bodies = [];
  const budgets = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout(ms); };
  const fetchImpl = async (u, init) => {
    bodies.push(JSON.parse(init.body));
    return ok({ choices: [{ message: { content: 'hi' } }] });
  };
  try {
    await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 4000, fetchImpl });
    await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 4000, totalTimeoutMs: 6000, fetchImpl });
  } finally { AbortSignal.timeout = realTimeout; }
  // derived from the per-rung budget when the caller gives none — this is the assertion that
  // fails on the old code, which sent no total at all and let the worker walk for ever
  assert.equal(bodies[0].ladder_total_timeout_ms, 16000);
  assert.equal(bodies[1].ladder_total_timeout_ms, 6000, 'an explicit budget wins');
  assert.deepEqual(budgets, [19000, 9000], 'the client outlives the worker budget by the headroom');
});

test('a dead call reports WHICH rungs the worker walked (x-ladder-attempts)', async () => {
  // The failure that started this: the operator saw `fetch_error` with no rung named anywhere.
  // The worker has always sent `x-ladder-attempts` on every response — we used to throw it away.
  const rungs = 'opencode-go/mimo-v2.6-flash=error, opencode-go/space-bunny-free=error, openrouter/xiaomi/mimo-v2.6-flash=ok';
  const withHeader = (status, data) => ({
    ok: status === 200, status,
    headers: new Headers({ 'x-ladder-attempts': rungs }),
    json: async () => data,
  });
  // http_error — the ladder walked rungs and gave up
  let seen = [];
  await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], source: 'input-router', onDiagnose: d => seen.push(d), fetchImpl: async () => withHeader(502, { error: { message: 'every rung failed' } }) });
  assert.equal(seen[0].reason, 'http_error');
  assert.equal(seen[0].attempts, rungs, 'the rung trace reaches the diagnostic layer → the alert');

  // empty_content — a rung answered but the guard rejected the answer
  seen = [];
  await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], onDiagnose: d => seen.push(d), fetchImpl: async () => withHeader(200, { model: 'opencode-go/mimo-v2.6-flash', choices: [{ message: { content: '' }, finish_reason: 'length' }] }) });
  assert.equal(seen[0].reason, 'empty_content');
  assert.equal(seen[0].attempts, rungs);

  // no header at all (older worker, injected fetch) must stay silent, not crash
  seen = [];
  await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], onDiagnose: d => seen.push(d), fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(seen[0].reason, 'http_error');
  assert.equal(seen[0].attempts, null, 'no header and no body attempts → null, not a crash and not an empty string');
});

test('worker failure / unreachable / non-JSON in JSON mode → null (callers are fail-soft)', async () => {
  assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => ok({ error: { type: 'ladder_error', attempts: [] } }, 502) }), null);
  assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null);
  assert.equal(await s.serviceJson({ user: 'x', fetchImpl: async () => ok({ choices: [{ message: { content: 'not json' } }] }) }), null);
  assert.equal(await s.serviceText({ user: 'x', fetchImpl: async () => ok({ choices: [{ message: { content: 'Париж' } }] }) }), 'Париж');
});

test('no ladder token → unavailable, no request', async () => {
  const saved = process.env.LLM_LADDER_TOKEN; delete process.env.LLM_LADDER_TOKEN;
  const saveDir = process.env.AGENT_TOKENS_DIR; process.env.AGENT_TOKENS_DIR = require('os').tmpdir() + '/no-tokens-' + Date.now();
  try {
    delete require.cache[require.resolve('../src/data-paths')];
    assert.equal(s.available(), false);
    let called = false;
    const seen = [];
    assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { called = true; }, onDiagnose: d => seen.push(d) }), null);
    assert.equal(called, false);
    assert.deepEqual(seen.map(d => d.reason), ['no_token'], 'a null must say WHY — no silent fallback upstream');
  } finally {
    if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved;
    if (saveDir !== undefined) process.env.AGENT_TOKENS_DIR = saveDir; else delete process.env.AGENT_TOKENS_DIR;
    delete require.cache[require.resolve('../src/data-paths')];
  }
});

test('onDiagnose reports the reason + rung/raw/status for every failure mode', async () => {
  const seen = [];
  const onDiagnose = d => seen.push(d);
  const call = (fetchImpl, json = true) => s.serviceChat({ messages: [{ role: 'user', content: 'x' }], json, fetchImpl, onDiagnose, source: 'diag-test' });

  // ok
  await call(async () => ok({ model: 'rung-a', choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }] }));
  // model answered, but not JSON → the raw answer is what the caller needs to see
  await call(async () => ok({ model: 'rung-a', choices: [{ finish_reason: 'stop', message: { content: 'Сейчас подумаю...' } }] }));
  // reasoning rung burned its whole budget → content empty
  await call(async () => ok({ model: 'rung-b', choices: [{ finish_reason: 'length', message: { content: '' } }] }));
  // worker HTTP error (with per-rung attempts)
  await call(async () => ok({ model: 'rung-a', error: { message: 'all rungs failed', attempts: [{ rung: 'go-1', error: 'timeout' }] } }, 502));
  // ladder unreachable
  await call(async () => { throw new Error('The operation was aborted due to timeout'); });

  assert.deepEqual(seen.map(d => d.reason), ['ok', 'json_parse_error', 'empty_content', 'http_error', 'fetch_error']);
  assert.equal(seen[1].model, 'rung-a');
  assert.equal(seen[1].raw, 'Сейчас подумаю...');
  assert.equal(seen[1].error, 'no JSON object found in content');
  assert.equal(seen[2].model, 'rung-b');
  assert.equal(seen[2].finishReason, 'length');
  assert.equal(seen[3].status, 502);
  assert.match(seen[3].attempts, /go-1/);
  assert.match(seen[4].error, /aborted/);
  for (const d of seen) assert.equal(d.source, 'diag-test');
});

test('a broken onDiagnose callback can never break the call', async () => {
  const r = await s.serviceChat({
    messages: [{ role: 'user', content: 'x' }],
    json: true,
    fetchImpl: async () => ok({ model: 'rung-a', choices: [{ message: { content: '{"a":1}' } }] }),
    onDiagnose: () => { throw new Error('diagnostics exploded'); },
  });
  assert.deepEqual(r.value, { a: 1 });
});

// ── #1917: D1 attribution ────────────────────────────────────────────────────
// ctx → x-ladder-* (trace/run/user/session + app), so service calls show up in
// ladder_calls (query-trace.py presets) and in OpenRouter's Application slice.

test('ctx → x-ladder-* headers on every entry point; app falls back to source', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return ok({ choices: [{ message: { content: 'ok' } }] }); };

  await s.serviceChat({
    messages: [{ role: 'user', content: 'x' }], source: 'gtd-intent', fetchImpl,
    ctx: { trace: 'alice-tg-1', run: 'exec-2', user: 'alice', session: 's-3' },
  });
  const h = seen[seen.length - 1];
  assert.equal(h['x-ladder-trace'], 'alice-tg-1');
  assert.equal(h['x-ladder-run'], 'exec-2');
  assert.equal(h['x-ladder-user'], 'alice');
  assert.equal(h['x-ladder-session'], 's-3');
  assert.equal(h['x-ladder-app'], 'gtd-intent', 'x-ladder-app = source when ctx.app is absent');
  assert.equal(h.Authorization, `Bearer ${process.env.LLM_LADDER_TOKEN}`, 'auth header untouched');

  // serviceJson/serviceText forward ctx via ...rest
  await s.serviceJson({ user: 'x', source: 'playbook-validator', fetchImpl, ctx: { trace: 'p-1', run: 'e-9', user: 'bob' } });
  const h2 = seen[seen.length - 1];
  assert.equal(h2['x-ladder-trace'], 'p-1');
  assert.equal(h2['x-ladder-run'], 'e-9');
  assert.equal(h2['x-ladder-user'], 'bob');
  assert.equal(h2['x-ladder-app'], 'playbook-validator');
  assert.ok(!('x-ladder-session' in h2), 'a field the caller has no id for is omitted, not sent empty');

  await s.serviceText({ user: 'x', source: 'session-summary', fetchImpl, ctx: { session: 's-9', user: 'alice', app: 'custom-app' } });
  const h3 = seen[seen.length - 1];
  assert.equal(h3['x-ladder-session'], 's-9');
  assert.equal(h3['x-ladder-app'], 'custom-app', 'ctx.app wins over source');
});

// CHANGED REQUIREMENT (owner, 01.10.2026): this test used to pin "no ctx → no x-ladder-* headers
// at all", which is exactly the behaviour that made 540 of 571 OpenRouter requests show up as
// «Unknown» — with no app identity there is nothing to count. Replaced by: no ctx → the tool still
// names itself via x-ladder-app (= source), while trace ids stay absent because a real run is the
// only thing that has them. The next test ("ctx → x-ladder-*") is unchanged and still passes.
test('no ctx → x-ladder-app = source, no trace ids (the tool is still identifiable)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return ok({ choices: [{ message: { content: 'ok' } }] }); };

  await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], source: 'gtd-intent', fetchImpl });
  await s.serviceJson({ user: 'x', source: 'session-summary', fetchImpl });
  await s.serviceText({ user: 'x', fetchImpl });

  assert.equal(seen.length, 3);
  assert.equal(seen[0]['x-ladder-app'], 'gtd-intent');
  assert.equal(seen[1]['x-ladder-app'], 'session-summary');
  assert.equal(seen[2]['x-ladder-app'], 'service-llm', 'default source names the generic caller');
  for (const h of seen) {
    assert.deepEqual(
      Object.keys(h).filter(k => k.startsWith('x-ladder-')), ['x-ladder-app'],
      `no ctx → app only, got ${Object.keys(h).filter(k => k.startsWith('x-ladder-')).join(', ')}`,
    );
    assert.equal(h.Authorization, `Bearer ${process.env.LLM_LADDER_TOKEN}`);
  }

  // A degenerate ctx must not fabricate trace ids either (only x-ladder-app, from source).
  await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], source: 'answer-format', fetchImpl, ctx: {} });
  const h = seen[seen.length - 1];
  assert.deepEqual(Object.keys(h).filter(k => k.startsWith('x-ladder-')), ['x-ladder-app']);
  assert.equal(h['x-ladder-app'], 'answer-format');
});

