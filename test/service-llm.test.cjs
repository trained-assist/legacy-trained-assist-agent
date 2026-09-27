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
    assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { called = true; } }), null);
    assert.equal(called, false);
  } finally {
    if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved;
    if (saveDir !== undefined) process.env.AGENT_TOKENS_DIR = saveDir; else delete process.env.AGENT_TOKENS_DIR;
    delete require.cache[require.resolve('../src/data-paths')];
  }
});
