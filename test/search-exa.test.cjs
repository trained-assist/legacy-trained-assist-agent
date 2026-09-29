'use strict';
// search_exa / fetch_exa (эпик #1792, линия L2): MCP-тул на публичный Exa search-MCP
// (https://mcp.exa.ai/mcp), без ключа. В CI нет сети — весь HTTP мокается инъекцией
// fetchImpl (как в test/hermes-run.test.cjs / hermes-tools-run.test.cjs). Живой прогон
// только за env-гейтом: SMOKE_EXA=1 node --test test/search-exa.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  tools, searchExa, fetchExa, buildObjective, parseSearchText, parseFetchPages, resetExaSession,
} = require('../src/mcp-skills/tools/99b-search-exa');

const SEARCH_TEXT = [
  'Title: Цены на домены .ru',
  'URL: https://www.reg.ru/company/prices/domain',
  'Published: 2026-09-01',
  'Author: N/A',
  'Highlights:',
  '.RU 169 ₽ за первый год',
  '',
  '---',
  '',
  'Title: Регламент Руцентра',
  'URL: https://www.nic.ru/news/2026/0318-izmeneniia/',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'С 1 апреля 2026 стоимость меняется',
  '',
  '---',
  '',
  '| --- | --- |',
  '',
].join('\n');

function sse(obj) {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}

function resp(status, body = '', headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { status, headers: { get: k => h[String(k).toLowerCase()] ?? null }, text: async () => body };
}

// Роутер: handler(method, body, callIndex) → Response-подобный объект.
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const call = { url, method: body.method, body, headers: opts.headers, signal: opts.signal };
    calls.push(call);
    return handler(body, calls.length - 1, call);
  };
  fn.calls = calls;
  return fn;
}

function handshakeRoutes(body, idx, searchPayload) {
  if (body.method === 'initialize') {
    return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }),
      { 'mcp-session-id': `sess-${idx}` });
  }
  if (body.method === 'notifications/initialized') return resp(202, '');
  if (body.method === 'tools/call') return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: searchPayload }] } }));
  return resp(400, 'unexpected method');
}

test.beforeEach(() => resetExaSession());

test('tool contract: search_exa/fetch_exa declared with required schema', () => {
  assert.ok(tools.search_exa, 'search_exa declared');
  assert.ok(tools.fetch_exa, 'fetch_exa declared');
  assert.deepEqual(tools.search_exa.inputSchema.required, ['query']);
  assert.deepEqual(tools.fetch_exa.inputSchema.required, ['urls']);
  assert.ok(tools.search_exa.description.length > 40);
  assert.equal(typeof tools.search_exa.handler, 'function');
  assert.equal(typeof tools.fetch_exa.handler, 'function');
});

test('search: one reusable session, SSE parsed, results structured', async () => {
  const fetchImpl = mockFetch((body, idx) => handshakeRoutes(body, idx, SEARCH_TEXT));

  const out = await searchExa({ query: 'сколько стоит домен ru 2026', num: 5, fetchImpl });

  assert.equal(out.engine, 'exa');
  assert.equal(typeof out.took_ms, 'number');
  assert.equal(out.results.length, 2, 'both blocks parsed');
  assert.equal(out.results[0].title, 'Цены на домены .ru');
  assert.equal(out.results[0].url, 'https://www.reg.ru/company/prices/domain');
  assert.match(out.results[0].snippet, /169 ₽/);
  assert.equal(out.results[0].published, '2026-09-01');
  assert.equal(out.results[1].url, 'https://www.nic.ru/news/2026/0318-izmeneniia/');
  // "---" внутри highlights не рвёт блок: второй результат остаётся цельным
  assert.match(out.results[1].snippet, /\| --- \| --- \|/);

  const methods = fetchImpl.calls.map(c => c.method);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call'], 'handshake then call');
  assert.equal(fetchImpl.calls[0].headers['Mcp-Session-Id'], undefined, 'initialize carries no session');
  assert.equal(fetchImpl.calls[1].headers['Mcp-Session-Id'], 'sess-0', 'ack carries the issued session id');
  assert.equal(fetchImpl.calls[2].headers['Mcp-Session-Id'], 'sess-0', 'session id reused on the call');
  assert.equal(fetchImpl.calls[2].headers.Authorization, undefined, 'no Authorization header — keyless by design');
  assert.ok(fetchImpl.calls[0].signal instanceof AbortSignal, 'hard timeout wired via AbortSignal');

  // objective обязателен для Exa и собирается из запроса
  const args = fetchImpl.calls[2].body.params.arguments;
  assert.ok(args.objective && args.objective.length > 0, 'objective auto-generated');
  assert.ok(args.objective.includes('сколько стоит домен ru 2026'), 'objective carries the query');
  assert.equal(args.numResults, 5, 'num mapped to numResults');

  // Второй вызов переиспользует сессию — initialize больше не нужен
  await searchExa({ query: 'лучшие ATS для рекрутинга 2026', fetchImpl });
  assert.equal(fetchImpl.calls.filter(c => c.method === 'initialize').length, 1, 'one session per process');
  assert.equal(fetchImpl.calls.length, 4);
});

test('search: expired session (HTTP 400) re-initializes instead of failing', async () => {
  let calls = 0;
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') {
      calls += 1;
      if (calls === 1) return resp(400, '{"error":"session expired"}');
      return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: SEARCH_TEXT }] } }));
    }
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });

  const out = await searchExa({ query: 'зарплата рекрутера Россия 2026', fetchImpl });
  assert.equal(out.results.length, 2, 'recovered after re-handshake');
  assert.equal(fetchImpl.calls.filter(c => c.method === 'initialize').length, 2);
  assert.equal(fetchImpl.calls.at(-1).headers['Mcp-Session-Id'], 'sess-3', 'second call rides the fresh session');
});

test('search: one retry on 429, then a readable error — no throw, no hang', async () => {
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') return resp(429, `You've hit Exa's free MCP rate limit. Try later.`);
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });

  const out = await searchExa({ query: 'Deepgram vs AssemblyAI диаризация русский', fetchImpl });
  assert.ok(out.results.length === 0);
  assert.match(out.error, /^search_exa: /, 'error prefixed for the model');
  assert.match(out.error, /429/, 'rate limit surfaced');
  assert.match(out.error, /лимит/i, 'readable reason');
  const calls = fetchImpl.calls.filter(c => c.method === 'tools/call');
  assert.equal(calls.length, 2, 'exactly one retry');
});

test('search: 5xx is retried once and then reported', async () => {
  let n = 0;
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') {
      n += 1;
      if (n === 1) return resp(503, 'upstream down');
      if (n === 2) return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: SEARCH_TEXT }] } }));
    }
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });
  const out = await searchExa({ query: 'стоимость разработки ПО оценка COCOMO II', fetchImpl });
  assert.equal(out.results.length, 2, 'recovered on retry');
});

test('search: network failure → clear error string, process alive', async () => {
  const fetchImpl = async () => { const e = new TypeError('fetch failed'); throw e; };
  const out = await searchExa({ query: 'тест недоступности', fetchImpl });
  assert.ok(out.results.length === 0);
  assert.match(out.error, /^search_exa: Exa MCP недоступен/);
  assert.match(out.error, /сетевая ошибка/);
});

test('search: timeout → clear error string (AbortSignal path)', async () => {
  // Симулируем срабатывание AbortSignal.timeout(15_000): fetchImpl сразу падает
  // с TimeoutError, не дожидаясь реальных 15 с (иначе тест висел бы 2×15 с на ретрае).
  const fetchImpl = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const out = await searchExa({ query: 'тест таймаута', fetchImpl });
  assert.match(out.error, /таймаут 15000 мс/, '15s hard timeout reported');
  assert.match(out.error, /search_exa: /);
});

test('search: empty query never touches the network', async () => {
  const fetchImpl = mockFetch(() => { throw new Error('must not be called'); });
  const out = await searchExa({ query: '   ', fetchImpl });
  assert.match(out.error, /не задан query/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('search: unparseable body still returns text, not nothing', async () => {
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'что-то неожиданное' }] } }));
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });
  const out = await searchExa({ query: 'нестандартный ответ', fetchImpl });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].text, 'что-то неожиданное');
});

test('search: tools/call isError → readable error, not silent empty', async () => {
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') {
      return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool web_search_exa not found' }] } }));
    }
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });
  const out = await searchExa({ query: 'инструмент пропал', fetchImpl });
  assert.match(out.error, /not found/);
});

test('fetch_exa: batch of URLs → [{url, markdown}]', async () => {
  const pageText = [
    '# Example Domain',
    'URL: https://example.com',
    '',
    'Example Domain — это страница-заглушка.',
    '',
    '# IANA',
    'URL: https://www.iana.org/help/example-domains',
    '',
    'Домены для документации RFC 2606.',
    '',
  ].join('\n');
  const fetchImpl = mockFetch((body, idx) => {
    if (body.method === 'tools/call') return resp(200, sse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: pageText }] } }));
    return handshakeRoutes(body, idx, SEARCH_TEXT);
  });

  const out = await fetchExa({ urls: ['https://example.com', 'https://www.iana.org/help/example-domains'], fetchImpl });
  assert.ok(Array.isArray(out), 'success shape is an array');
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://example.com');
  assert.match(out[0].markdown, /заглушка/);
  assert.equal(out[1].url, 'https://www.iana.org/help/example-domains');
  assert.match(out[1].markdown, /RFC 2606/);

  const args = fetchImpl.calls.find(c => c.method === 'tools/call').body.params.arguments;
  assert.deepEqual(args.urls, ['https://example.com', 'https://www.iana.org/help/example-domains']);
});

test('fetch_exa: bad input and network failure return an error object', async () => {
  let out = await fetchExa({ urls: ['ftp://nope', ''] });
  assert.match(out.error, /не задан urls/);

  out = await fetchExa({ urls: ['https://example.com'], fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.match(out.error, /^fetch_exa: /);
  assert.match(out.error, /сетевая ошибка/);
});

test('helpers: objective, block parser, page parser', () => {
  const long = 'ы'.repeat(400);
  const obj = buildObjective(long);
  assert.ok(obj.length <= 4096, 'Exa objective limit');
  assert.ok(obj.includes('ы'.repeat(300)), 'first ~300 chars of the query');
  assert.ok(obj.includes('URL'), 'asks for sourced facts');

  const parsed = parseSearchText(SEARCH_TEXT);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].published, undefined, 'N/A published is dropped');

  assert.deepEqual(parseFetchPages('', ['https://a']), []);
  assert.deepEqual(parseFetchPages('просто текст', ['https://a']), [{ url: 'https://a', markdown: 'просто текст' }]);
  assert.equal(parseSearchText('').length, 0);
});

test('LIVE: one search + one fetch against mcp.exa.ai', { skip: !process.env.SMOKE_EXA }, async () => {
  const s = await searchExa({ query: 'сколько стоит домен ru 2026', num: 3 });
  assert.equal(s.engine, 'exa');
  assert.ok(s.results.length > 0, `no results: ${s.error || ''}`);
  assert.ok(s.results.every(r => /^https?:\/\//.test(r.url)), 'real URLs');
  console.log(`  live search: ${s.results.length} results in ${s.took_ms}ms`);

  const tw = Date.now();
  const f = await fetchExa({ urls: ['https://example.com'] });
  assert.ok(Array.isArray(f) && f[0].markdown.length > 0, `fetch failed: ${JSON.stringify(f)}`);
  console.log(`  live fetch: ${f[0].markdown.length} chars in ${Date.now() - tw}ms`);
});
