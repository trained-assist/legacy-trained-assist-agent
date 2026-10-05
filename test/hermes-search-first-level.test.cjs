'use strict';

// hermes_web_research search ladder (#1792): level 1 must be OUR keyless `search_serp_free`,
// prefetched in the server process and handed to the model in the prompt — so a research
// run starts from a real SERP even when the engine's built-in search is missing/blocked.
// No network here: the tool is driven through the injected fetchImpl.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPrompt, prefetchLevel1, searchQueryFromTask } = require('../src/hermes-tools-run');

const SCHEMA = { type: 'object', properties: { sources: { type: 'array' } } };

const SERP = JSON.stringify({
  results: [
    { url: 'https://a.example/one', title: 'First', content: 'Snippet one' },
    { url: 'https://b.example/two', title: 'Second', content: 'Snippet two' },
  ],
});

function withEnv(overrides, fn) {
  // Cooldowns (search_serp_free) are module state that outlives one test — keep them off so a
  // blocked upstream in one test never makes a later test skip the backend.
  const keys = [
    'FREE_SEARCH_BACKEND', 'SEARXNG_URL', 'HERMES_PREFETCH_SEARCH',
    'FREE_SEARCH_DDG_COOLDOWN_MS', 'FREE_SEARCH_SEARXNG_COOLDOWN_MS', 'FREE_SEARCH_BRAVE_COOLDOWN_MS',
  ];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, overrides);
  for (const k of keys.slice(3)) if (process.env[k] === undefined) process.env[k] = '0';
  const done = (v) => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    return v;
  };
  return Promise.resolve().then(fn).then(done, (e) => { done(); throw e; });
}

function res(status, body, contentType = 'application/json') {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

test('searchQueryFromTask: first sentence only, capped', () => {
  assert.equal(
    searchQueryFromTask('Сколько стоит домен ru 2026? Расскажи подробно про цены.\nВторой абзац.'),
    'Сколько стоит домен ru 2026?'
  );
  assert.equal(searchQueryFromTask('x'.repeat(500)).length, 160);
  assert.equal(searchQueryFromTask(''), '');
});

test('prefetchLevel1 returns the SERP for the prompt (level 1 actually ran)', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: 'searxng', SEARXNG_URL: 'https://sx.test' }, async () => {
    let seen = null;
    const l1 = await prefetchLevel1('Сколько стоит домен ru 2026?', {
      fetchImpl: async (url) => { seen = url; return res(200, SERP); },
    });
    assert.match(seen, /q=%D0%A1%D0%BA%D0%BE%D0%BB%D1%8C%D0%BA%D0%BE/);
    assert.equal(l1.results.length, 2);
    assert.equal(l1.query, 'Сколько стоит домен ru 2026?');
    assert.equal(l1.results[0].url, 'https://a.example/one');
  });
});

test('prefetchLevel1 never throws: a blocked upstream comes back as {results:[], reason}', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: 'searxng,brave', SEARXNG_URL: 'https://sx.test' }, async () => {
    const l1 = await prefetchLevel1('любая задача', {
      fetchImpl: async () => res(429, 'Too Many Requests', 'text/plain'),
    });
    assert.deepEqual(l1.results, []);
    assert.match(l1.reason, /every configured backend failed|HTTP 429/);
  });
});

test('prefetchLevel1 is off behind HERMES_PREFETCH_SEARCH=0', async () => {
  await withEnv({ HERMES_PREFETCH_SEARCH: '0' }, async () => {
    let called = false;
    const l1 = await prefetchLevel1('задача', { fetchImpl: async () => { called = true; return res(200, SERP); } });
    assert.equal(l1, null);
    assert.equal(called, false);
  });
});

test('buildPrompt: level ladder names search_serp_free first, built-in websearch second', () => {
  const p = buildPrompt('task', '', SCHEMA);
  const lvl = p.indexOf('search_serp_free');
  const builtIn = p.indexOf('websearch/WebSearch');
  assert.ok(lvl > 0 && builtIn > 0, 'both levels are named');
  assert.ok(lvl < builtIn, 'search_serp_free is level 1, built-in search is level 2');
  assert.match(p, /1\) search_serp_free/);
  assert.match(p, /2\) Встроенный веб-поиск/);
  assert.match(p, /3\) Загрузка страниц и браузер/);
  assert.ok(!/УРОВЕНЬ 1 — предварительный/.test(p), 'no prefetched block without level1');
});

test('buildPrompt: the prefetched SERP is injected verbatim as level 1', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: 'searxng', SEARXNG_URL: 'https://sx.test' }, async () => {
    const l1 = await prefetchLevel1('Сколько стоит домен ru 2026?', { fetchImpl: async () => res(200, SERP) });
    const p = buildPrompt('Сколько стоит домен ru 2026?', '', SCHEMA, l1);
    assert.match(p, /УРОВЕНЬ 1 — предварительный поиск уже сделан за тебя/);
    assert.match(p, /1\. First — https:\/\/a\.example\/one/);
    assert.match(p, /Snippet two/);
    assert.ok(p.indexOf('https://a.example/one') < p.indexOf('Задача:'), 'SERP lands before the task block');
  });
});

test('buildPrompt: a failed level 1 is stated with the reason instead of silence', () => {
  const p = buildPrompt('task', '', SCHEMA, { query: 'q', results: [], reason: 'HTTP 429 rate-limited' });
  assert.match(p, /предварительный поиск search_serp_free не дал результатов: HTTP 429 rate-limited/);
  assert.match(p, /переходи на УРОВЕНЬ 2/);
});
