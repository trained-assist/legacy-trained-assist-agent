'use strict';
// search_serper (issue #1792) — contract tests. No network in CI: fetch is always
// injected via fetchImpl. The live path (real Serper key, real Google SERP) is opt-in
// under SMOKE_SERPER=1 and never runs in CI.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { tools, searchSerper, ENDPOINT, TIMEOUT_MS, ATTEMPTS } = require('../src/mcp-skills/tools/99-search-serper');

const KEY = 'test-serper-key';
const ORGANIC = {
  organic: [
    { title: 'Результат 1', link: 'https://example.com/one', snippet: 'Сниппет один', position: 1 },
    { title: 'Результат 2', link: 'https://example.com/two', snippet: 'Сниппет два', position: 2 },
  ],
};

function recorder(response) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (typeof response === 'function') return response(calls.length, opts);
    return response;
  };
  return { calls, fetchImpl };
}

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('registration', () => {
  test('exposes search_serper with query required', () => {
    const t = tools.search_serper;
    assert.ok(t, 'search_serper exported');
    assert.equal(typeof t.handler, 'function');
    assert.deepEqual(t.inputSchema.required, ['query']);
    assert.ok(Object.keys(t.inputSchema.properties).includes('num'));
    assert.ok(Object.keys(t.inputSchema.properties).includes('gl'));
    assert.ok(Object.keys(t.inputSchema.properties).includes('hl'));
  });

  test('always registered (no isReady gate) so a missing key surfaces as a readable error', () => {
    assert.equal(tools.isReady, undefined, 'module has no isReady — the tool must stay callable');
  });

  test('repo conventions: 15s timeout, one retry, real endpoint', () => {
    assert.equal(TIMEOUT_MS, 15_000, 'AbortSignal.timeout budget is the repo-standard 15s');
    assert.equal(ATTEMPTS, 2, 'one retry means 2 attempts total');
    assert.equal(ENDPOINT, 'https://google.serper.dev/search');
  });
});

describe('input validation', () => {
  test('missing query → readable error, no throw', async () => {
    const r = await searchSerper({ apiKey: KEY, fetchImpl: async () => res(ORGANIC) });
    assert.match(r.error, /query/);
  });

  test('blank query → readable error, no network call', async () => {
    const { calls, fetchImpl } = recorder(res(ORGANIC));
    const r = await searchSerper({ query: '   ', apiKey: KEY, fetchImpl });
    assert.match(r.error, /query/);
    assert.equal(calls.length, 0);
  });
});

describe('configuration', () => {
  test('no SERPER_API_KEY → "serper не сконфигрирован", never throws, never calls network', async () => {
    const saved = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    try {
      const { calls, fetchImpl } = recorder(res(ORGANIC));
      const r = await searchSerper({ query: 'x', fetchImpl });
      assert.equal(r.error, 'serper не сконфигрирован: нужен SERPER_API_KEY');
      assert.match(r.hint, /SERPER_API_KEY/);
      assert.equal(calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.SERPER_API_KEY = saved;
    }
  });

  test('key is read from process.env.SERPER_API_KEY and sent as X-API-KEY', async () => {
    const saved = process.env.SERPER_API_KEY;
    process.env.SERPER_API_KEY = 'from-env';
    try {
      const { calls, fetchImpl } = recorder(res(ORGANIC));
      await searchSerper({ query: 'квота', fetchImpl });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].opts.headers['X-API-KEY'], 'from-env');
    } finally {
      if (saved === undefined) delete process.env.SERPER_API_KEY;
      else process.env.SERPER_API_KEY = saved;
    }
  });
});

describe('request shape', () => {
  test('POST body {q,num,gl,hl} with a 15s abort signal', async () => {
    const { calls, fetchImpl } = recorder(res(ORGANIC));
    await searchSerper({ query: 'сколько стоит домен ru 2026', num: 5, gl: 'ru', hl: 'ru', apiKey: KEY, fetchImpl });

    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.ok(calls[0].opts.signal instanceof AbortSignal, 'hard timeout signal attached');
    assert.ok(!calls[0].opts.signal.aborted, 'signal starts live');

    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body, { q: 'сколько стоит домен ru 2026', num: 5, gl: 'ru', hl: 'ru' });
  });

  test('num is clamped to 1..100 and junk params are dropped', async () => {
    const { calls, fetchImpl } = recorder(res(ORGANIC));
    await searchSerper({ query: 'q', num: 5000, gl: 7, hl: null, apiKey: KEY, fetchImpl });
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.num, 100);
    assert.ok(!('gl' in body) && !('hl' in body), 'non-string gl/hl are not sent');
  });
});

describe('normalization', () => {
  test('organic → {engine, results:[{title,url,snippet,position}], took_ms}', async () => {
    const { fetchImpl } = recorder(res(ORGANIC));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });

    assert.equal(r.engine, 'serper');
    assert.equal(typeof r.took_ms, 'number');
    assert.ok(r.took_ms >= 0);
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results[0], {
      title: 'Результат 1',
      url: 'https://example.com/one',
      snippet: 'Сниппет один',
      position: 1,
    });
    assert.equal(r.results[1].url, 'https://example.com/two');
  });

  test('missing position falls back to ordinal; missing organic → empty results, not an error', async () => {
    const { fetchImpl } = recorder(res({ organic: [{ title: 'T', link: 'https://a.b', snippet: 'S' }] }));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(r.results[0].position, 1);

    const empty = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl: async () => res({}) });
    assert.equal(empty.engine, 'serper');
    assert.deepEqual(empty.results, []);
    assert.equal(empty.error, undefined, 'a legit empty SERP is not an error');
  });
});

describe('failure handling', () => {
  test('500 → retried once, then succeeds', async () => {
    const { calls, fetchImpl } = recorder(n => (n === 1 ? res({ error: 'boom' }, 500) : res(ORGANIC)));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(calls.length, 2, 'exactly one retry');
    assert.equal(r.engine, 'serper');
    assert.equal(r.results.length, 2);
  });

  test('persistent 5xx → explicit error after 2 attempts, not silence', async () => {
    const { calls, fetchImpl } = recorder(res({ error: 'boom' }, 503));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(calls.length, 2);
    assert.match(r.error, /HTTP 503/);
    assert.match(r.error, /2\/2/);
  });

  test('429 → retried, then explicit rate-limit error', async () => {
    const { calls, fetchImpl } = recorder(res({ message: 'quota' }, 429));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(calls.length, 2);
    assert.match(r.error, /HTTP 429/);
    assert.match(r.detail, /quota/);
  });

  test('401/403 → bad key error with NO retry (the key will not heal)', async () => {
    const { calls, fetchImpl } = recorder(res({ message: 'Invalid API key' }, 401));
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(calls.length, 1, 'auth failures are not retried');
    assert.match(r.error, /HTTP 401/);
    assert.match(r.error, /SERPER_API_KEY/);
    assert.match(r.detail, /Invalid API key/);
  });

  test('network failure twice → readable error naming the attempt', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; throw new Error('ECONNREFUSED'); };
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.equal(n, 2);
    assert.match(r.error, /сетевая ошибка/);
    assert.match(r.error, /ECONNREFUSED/);
  });

  test('abort signal fires → таймаут error, never a hang', async () => {
    const fetchImpl = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl, timeoutMs: 30, attempts: 1 });
    assert.match(r.error, /таймаут 30 мс/);
  });

  test('200 with a non-JSON body → explicit error', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('Unexpected token <'); },
      text: async () => '<html>nope</html>',
    });
    const r = await searchSerper({ query: 'q', apiKey: KEY, fetchImpl });
    assert.match(r.error, /не JSON/);
  });
});

test('handler forwards its schema args into searchSerper (real env-driven path)', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = KEY;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return res(ORGANIC); };
  try {
    const r = await tools.search_serper.handler({ query: 'зарплата рекрутера Россия 2026', num: 3, gl: 'ru' });
    assert.equal(r.engine, 'serper');
    assert.equal(r.results.length, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].opts.body), { q: 'зарплата рекрутера Россия 2026', num: 3, gl: 'ru' });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = savedKey;
  }
});

// ── Live smoke (opt-in, never in CI): SMOKE_SERPER=1 SERPER_API_KEY=... ──────────
test('live Serper smoke', { skip: !process.env.SMOKE_SERPER }, async () => {
  const r = await searchSerper({ query: 'сколько стоит домен ru 2026', num: 5, gl: 'ru', hl: 'ru' });
  console.log('smoke:', JSON.stringify({ engine: r.engine, n: r.results && r.results.length, took_ms: r.took_ms, error: r.error }));
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.results.length > 0, 'live SERP returned no results');
  assert.ok(r.results.every(x => /^https?:\/\//.test(x.url)), 'every result has a URL');
}, 30_000);
