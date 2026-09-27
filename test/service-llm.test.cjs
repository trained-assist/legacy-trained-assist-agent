const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// src/service-llm.js — small service calls on the deepseek ladder (Go rungs → OpenRouter last).
// All state isolated; upstream is a fake fetch keyed by model.
function fresh({ keys = 'oc_a,oc_b', orKey = 'or_key' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-llm-test-'));
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(dir, 'model-health.json');
  process.env.OPENCODE_GO_KEYS_STATE_FILE = path.join(dir, 'go-keys-state.json');
  process.env.OPENCODE_GO_AUTH_FILE = path.join(dir, 'auth.json');
  if (keys) process.env.OPENCODE_GO_API_KEYS = keys; else delete process.env.OPENCODE_GO_API_KEYS;
  delete process.env.OPENCODE_GO_API_KEY;
  if (orKey) process.env.OPENROUTER_API_KEY = orKey; else delete process.env.OPENROUTER_API_KEY;
  if (keys) fs.writeFileSync(process.env.OPENCODE_GO_AUTH_FILE, JSON.stringify({ 'opencode-go': { type: 'api', key: keys.split(',')[0] } }));
  for (const m of ['../src/service-llm', '../src/model-health', '../src/opencode-go-keys', '../src/opencode-ladder']) delete require.cache[require.resolve(m)];
  return require('../src/service-llm');
}

const ladder = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-routing.json'), 'utf8')).ladders.deepseek.build;

// behaviour: model (without provider prefix) → function(req) → {status, body} | 'throw'
function fakeFetch(behaviour, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, model: body.model, auth: init.headers.Authorization, session: init.headers['x-opencode-session'], body });
    const b = behaviour[body.model] || (() => ({ status: 200, content: 'ok' }));
    const r = b({ url, body, auth: init.headers.Authorization });
    if (r === 'throw') throw new Error('network down');
    const data = r.status === 200 ? { choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 3 } } : null;
    return { ok: r.status === 200, status: r.status, json: async () => data, text: async () => (data ? JSON.stringify(data) : (r.error || "err")) };
  };
}
const short = (m) => m.replace(/^opencode-go\/|^openrouter\//, '');

test('answers from the first Go rung; Go gets the session header and a reasoning-safe max_tokens', async () => {
  const s = fresh();
  const calls = [];
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5, fetchImpl: fakeFetch({}, calls) });
  assert.equal(r.model, ladder()[0]);
  assert.equal(r.content, 'ok');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/chat\/completions$/);
  assert.ok(calls[0].session, 'x-opencode-session header set for Go');
  assert.ok(calls[0].body.max_tokens >= 1000, 'tiny budgets are raised so reasoning models still answer');
  assert.equal(calls[0].body.stream, false);
});

test('a failing rung degrades to the next one and is skipped for the next call', async () => {
  const s = fresh();
  const [first, second] = ladder();
  const calls = [];
  const beh = { [short(first)]: () => ({ status: 500, error: 'boom' }) };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, second);
  const calls2 = [];
  await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch(beh, calls2) });
  assert.equal(calls2[0].model, short(second), 'the failed rung is in backoff');
});

test('json:true — non-JSON answer fails the rung, fenced/prose-wrapped JSON is accepted', async () => {
  const s = fresh();
  const [first, second] = ladder();
  const calls = [];
  const beh = {
    [short(first)]: () => ({ status: 200, content: 'sure, here you go' }),
    [short(second)]: () => ({ status: 200, content: 'Вот:\n```json\n{"kind":"none"}\n```' }),
  };
  const v = await s.serviceJson({ system: 's', user: 'u', fetchImpl: fakeFetch(beh, calls) });
  assert.deepEqual(v, { kind: 'none' });
  assert.equal(calls[0].body.response_format.type, 'json_object');
});

test('Go key limit → rotates to the spare key and retries the SAME rung', async () => {
  const s = fresh();
  const [first] = ladder();
  const calls = [];
  const beh = { [short(first)]: ({ auth }) => (auth === 'Bearer oc_a' ? { status: 429, error: 'Go usage limit exceeded' } : { status: 200, content: 'ok' }) };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, first);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer oc_a', 'Bearer oc_b']);
});

test('both Go keys limited → every Go rung parked, OpenRouter last rung answers', async () => {
  const s = fresh();
  const calls = [];
  const goLimited = () => ({ status: 429, error: 'Go usage limit exceeded' });
  const beh = {};
  for (const m of ladder()) if (m.startsWith('opencode-go/')) beh[short(m)] = goLimited;
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch(beh, calls) });
  assert.equal(r.model, ladder()[ladder().length - 1]);
  assert.ok(r.model.startsWith('openrouter/'));
  assert.equal(calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(calls.filter(c => c.url.includes('opencode.ai')).length, 2, 'only the first Go rung, once per key — the rest were parked');
  assert.equal(calls[calls.length - 1].auth, 'Bearer or_key');
});

test('no Go keys → straight to OpenRouter; no keys at all → unavailable, null', async () => {
  let s = fresh({ keys: '' });
  const calls = [];
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch({}, calls) });
  assert.ok(r.model.startsWith('openrouter/'));
  s = fresh({ keys: '', orKey: '' });
  assert.equal(s.available(), false);
  assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], fetchImpl: fakeFetch({}, []) }), null);
});

test('totalTimeoutMs stops walking the ladder once the budget is spent', async () => {
  const s = fresh();
  const calls = [];
  const slowFail = () => ({ status: 500, error: 'boom' });
  const beh = {};
  for (const m of ladder()) beh[short(m)] = slowFail;
  const t0 = Date.now();
  const fetchImpl = async (url, init) => { await new Promise(r => setTimeout(r, 300)); return fakeFetch(beh, calls)(url, init); };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], totalTimeoutMs: 700, fetchImpl });
  assert.equal(r, null);
  assert.ok(calls.length < ladder().length, `stopped early (${calls.length} calls)`);
  assert.ok(Date.now() - t0 < 1500);
});

// ── Primary path: the llm-ladder Cloudflare Worker, in-process ladder as the fallback ──────────
function withWorker(fn) {
  return async () => {
    const saved = { d: process.env.LLM_LADDER_DISABLED, t: process.env.LLM_LADDER_TOKEN, f: global.fetch };
    delete process.env.LLM_LADDER_DISABLED;
    process.env.LLM_LADDER_TOKEN = 'ladder_tok';
    try { await fn(); } finally {
      if (saved.d === undefined) delete process.env.LLM_LADDER_DISABLED; else process.env.LLM_LADDER_DISABLED = saved.d;
      if (saved.t === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = saved.t;
      global.fetch = saved.f;
    }
  };
}
const okJson = (data, status = 200) => ({ ok: status === 200, status, json: async () => data, text: async () => JSON.stringify(data) });

test('worker answers → used as-is (model = rung that answered), no in-process call', withWorker(async () => {
  const s = fresh();
  const urls = [];
  global.fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer ladder_tok');
    assert.equal(JSON.parse(init.body).response_format.type, 'json_object');
    return okJson({ model: 'opencode-go/mimo-v2.6-flash', choices: [{ message: { content: '{"a":1}' } }] });
  };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }], json: true });
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(r.model, 'opencode-go/mimo-v2.6-flash');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /llm-ladder\.trainedassist\.store\/v1\/chat\/completions$/);
}));

test('worker says every rung failed → final null, no duplicate in-process attempt', withWorker(async () => {
  const s = fresh();
  const urls = [];
  global.fetch = async (url) => { urls.push(url); return okJson({ error: { type: 'ladder_error', attempts: [] } }, 502); };
  assert.equal(await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(urls.length, 1);
}));

test('worker unreachable → the same ladder runs in-process', withWorker(async () => {
  const s = fresh();
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (url.includes('llm-ladder')) throw new Error('connect ECONNREFUSED');
    return okJson({ choices: [{ message: { content: 'local ok' } }] });
  };
  const r = await s.serviceChat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.content, 'local ok');
  assert.match(urls[1], /opencode\.ai\/zen\/go/);
}));
