'use strict';

// Unit tests for search_serp_free (epic #1792, L3 keyless SERP scraping).
// CI has no network: every live call goes through an injected fetchImpl.
// The real-network run is gated behind SMOKE_FREE_SEARCH=1 (see the bottom of this file).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tool = require('../src/mcp-skills/tools/99c-search-searxng').tools.search_serp_free;

const ENV_KEYS = ['FREE_SEARCH_BACKEND', 'SEARXNG_URL', 'SMOKE_FREE_SEARCH'];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, overrides);
  const done = (v) => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    return v;
  };
  return Promise.resolve()
    .then(fn)
    .then(done, (e) => {
      done();
      throw e;
    });
}

function res(status, body, contentType = 'text/html; charset=utf-8') {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

const SEARX_JSON = JSON.stringify({
  query: 'x',
  results: [
    { url: 'https://a.example/one', title: 'First <em>result</em>', content: 'Snippet &amp; more' },
    { url: 'https://b.example/two', title: 'Second', content: 'Another snippet' },
    { url: 'https://a.example/one', title: 'dup', content: 'dup' },
    { url: 'not-a-url', title: 'skip', content: 'skip' },
  ],
});

const BRAVE_HTML = `<!doctype html><html><body><section id="mixed-main">
<div class="snippet svelte" data-pos="0" data-type="web"><div class="result-body">
<a href="https://www.assemblyai.com/blog/assemblyai-vs-deepgram" target="_self" class="svelte">
<div class="site-name-wrapper">AssemblyAI</div>
<div class="title search-snippet-title line-clamp-1">AssemblyAI vs <mark>Deepgram</mark></div>
<div class="generic-snippet svelte">Speech-to-text comparison &amp; pricing guide</div>
</a></div></div>
<div class="snippet svelte" data-pos="1" data-type="web"><div class="result-body">
<a href="https://example.org/b"><div class="title search-snippet-title">Second result</div>
<div class="content desktop-default-regular t-primary">Snippet two</div></a></div></div>
</section></body></html>`;

const CHALLENGE_HTML = `<!doctype html><html><head><title>Verifying your browser…</title></head>
<body><div class="anomaly-modal__box">Making sure you're not a bot</div></body></html>`;

test('searxng format=json → normalized results, dedup, entity decoding, positions', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    let seenUrl = null;
    const out = await tool.handler(
      { query: 'Deepgram vs AssemblyAI', num: 10 },
      { fetchImpl: async (url) => { seenUrl = url; return res(200, SEARX_JSON, 'application/json'); } }
    );
    assert.equal(out.error, undefined);
    assert.equal(out.engine, 'searxng');
    assert.equal(out.source, 'https://sx.test');
    assert.match(seenUrl, /^https:\/\/sx\.test\/search\?q=Deepgram(%20|\+)vs(%20|\+)AssemblyAI&format=json$/);
    assert.equal(out.results.length, 2); // dedup + non-http url dropped
    assert.deepEqual(out.results[0], {
      title: 'First result',
      url: 'https://a.example/one',
      snippet: 'Snippet & more',
      position: 1,
    });
    assert.equal(out.results[1].position, 2);
    assert.equal(typeof out.took_ms, 'number');
  });
});

test('num caps the result list', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const out = await tool.handler({ query: 'x', num: 1 }, { fetchImpl: async () => res(200, SEARX_JSON, 'application/json') });
    assert.equal(out.results.length, 1);
  });
});

test('429 on every instance → one retry each, then falls through to the next configured backend', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng,brave' }, async () => {
    const calls = [];
    const out = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async (url) => {
          calls.push(url);
          if (url.startsWith('https://sx.test')) return res(429, 'Too Many Requests', 'text/plain');
          return res(200, BRAVE_HTML);
        },
      }
    );
    assert.equal(calls.filter((u) => u.startsWith('https://sx.test')).length, 2, 'searxng retried exactly once');
    assert.equal(out.engine, 'brave');
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].title, 'AssemblyAI vs Deepgram');
    assert.equal(out.results[0].url, 'https://www.assemblyai.com/blog/assemblyai-vs-deepgram');
    assert.equal(out.results[0].snippet, 'Speech-to-text comparison & pricing guide');
    assert.equal(out.results[1].snippet, 'Snippet two');
  });
});

test('challenge page with HTTP 200 is treated as a block, not as a result', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const out = await tool.handler(
      { query: 'x' },
      { fetchImpl: async () => res(200, CHALLENGE_HTML) }
    );
    assert.equal(out.error, 'search_failed');
    assert.match(out.message, /challenge page/);
    assert.match(out.message, /every configured backend failed/);
    assert.equal(out.attempts.length, 1);
  });
});

test('non-JSON response (format=json disabled) reports the reason instead of hanging', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const out = await tool.handler(
      { query: 'x' },
      { fetchImpl: async () => res(200, '<html><body>nope</body></html>', 'text/html') }
    );
    assert.equal(out.error, 'search_failed');
    assert.match(out.message, /format=json disabled/);
  });
});

test('all backends failing → explicit error object, never a throw', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test,https://sx2.test', FREE_SEARCH_BACKEND: 'searxng,brave' }, async () => {
    const out = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async (url) => {
          if (url.startsWith('https://sx')) return res(429, 'Too Many Requests', 'text/plain');
          throw Object.assign(new Error('connect ETIMEDOUT'), { name: 'Error' });
        },
      }
    );
    assert.equal(out.error, 'search_failed');
    assert.equal(out.attempts.length, 3);
    assert.match(out.message, /HTTP 429 rate-limited/);
    assert.match(out.message, /network error/);
    assert.match(out.message, /FREE_SEARCH_BACKEND/);
  });
});

test('network error on the first try is retried once and can succeed', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    let n = 0;
    const out = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async () => {
          n++;
          if (n === 1) throw new Error('socket hang up');
          return res(200, SEARX_JSON, 'application/json');
        },
      }
    );
    assert.equal(n, 2);
    assert.equal(out.results.length, 2);
  });
});

test('timeout is reported as a timeout, with the 15s budget in the message', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const out = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async (url, init) => {
          assert.ok(init.signal instanceof AbortSignal, 'per-request AbortSignal is passed');
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        },
      }
    );
    assert.equal(out.error, 'search_failed');
    assert.match(out.message, /timeout after 15000ms/);
  });
});

test('FREE_SEARCH_BACKEND=brave never touches searxng', async () => {
  await withEnv({ SEARXNG_URL: 'https://sx.test', FREE_SEARCH_BACKEND: 'brave' }, async () => {
    const urls = [];
    const out = await tool.handler(
      { query: 'x' },
      { fetchImpl: async (url) => { urls.push(url); return res(200, BRAVE_HTML); } }
    );
    assert.deepEqual(urls, ['https://search.brave.com/search?q=x']);
    assert.equal(out.engine, 'brave');
  });
});

test('unknown-only backend list is rejected before any network call', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: 'google,bing' }, async () => {
    let called = false;
    const out = await tool.handler({ query: 'x' }, { fetchImpl: async () => { called = true; return res(200, ''); } });
    assert.equal(out.error, 'bad_backend');
    assert.equal(called, false);
  });
});

test('bad input is rejected without touching the network', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return res(200, ''); };
  assert.equal((await tool.handler({}, { fetchImpl })).error, 'bad_request');
  assert.equal((await tool.handler({ query: '   ' }, { fetchImpl })).error, 'bad_request');
  assert.equal(called, false);
});

const DDG_HTML = `<!DOCTYPE html><html><head><title>q at DuckDuckGo</title></head><body>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/a">First <b>DDG</b> result</a></h2>
  <a class="result__snippet" href="https://example.com/a">Snippet <b>one</b> &amp; more</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=abc">Wrapped result</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb&amp;rut=abc">Second snippet</a>
</div>
</body></html>`;

test('duckduckgo html via POST is the default first backend and parses result__a blocks', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: '' }, async () => {
    let seen = null;
    const out = await tool.handler(
      { query: 'Deepgram vs AssemblyAI' },
      {
        fetchImpl: async (url, init) => {
          seen = { url, init };
          return res(200, DDG_HTML);
        },
      }
    );
    assert.equal(seen.url, 'https://html.duckduckgo.com/html/');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.body, 'q=Deepgram%20vs%20AssemblyAI');
    assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(out.engine, 'duckduckgo');
    assert.equal(out.source, 'html.duckduckgo.com');
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].title, 'First DDG result');
    assert.equal(out.results[0].snippet, 'Snippet one & more');
    assert.equal(out.results[0].url, 'https://example.com/a');
    assert.equal(out.results[1].url, 'https://example.org/b', 'uddg redirect wrapper is decoded');
    assert.equal(out.results[1].snippet, 'Second snippet');
  });
});

test('duckduckgo HTTP 202 anomaly challenge → named as rate-limit, chain falls through to searxng', async () => {
  await withEnv({ FREE_SEARCH_BACKEND: 'duckduckgo,searxng', SEARXNG_URL: 'https://sx.test' }, async () => {
    const calls = [];
    const out = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async (url, init) => {
          calls.push(`${init.method} ${url}`);
          if (url.includes('duckduckgo')) return res(202, '<html>anomaly-modal</html>');
          return res(200, SEARX_JSON, 'application/json');
        },
      }
    );
    assert.equal(calls.length, 2, 'the 202 is not retried');
    assert.equal(out.engine, 'searxng');
    assert.equal(out.results.length, 2);
  });
});

test('pool rotation spreads calls across instances', async () => {
  await withEnv({ SEARXNG_URL: 'https://a.test,https://b.test,https://c.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const firsts = [];
    for (let i = 0; i < 3; i++) {
      const urls = [];
      await tool.handler(
        { query: 'x' },
        {
          fetchImpl: async (url) => {
            urls.push(url);
            return res(429, 'Too Many Requests', 'text/plain');
          },
        }
      );
      firsts.push(new URL(urls[0]).host);
    }
    assert.equal(new Set(firsts).size, 3, `rotation should start at a different instance each call, got ${firsts}`);
  });
});

test('the instance that answered last time is tried first on the next call', async () => {
  await withEnv({ SEARXNG_URL: 'https://p1.test,https://p2.test', FREE_SEARCH_BACKEND: 'searxng' }, async () => {
    const tried = [];
    const first = await tool.handler(
      { query: 'x' },
      {
        fetchImpl: async (url) => {
          tried.push(new URL(url).host);
          return url.startsWith('https://p1.test')
            ? res(429, 'Too Many Requests', 'text/plain')
            : res(200, SEARX_JSON, 'application/json');
        },
      }
    );
    assert.equal(first.engine, 'searxng');
    const winner = first.source; // p1.test or p2.test, depending on where rotation started
    const second = [];
    await tool.handler(
      { query: 'y' },
      {
        fetchImpl: async (url) => {
          second.push(new URL(url).host);
          return res(200, SEARX_JSON, 'application/json');
        },
      }
    );
    assert.equal(second[0], new URL(winner).host, 'the previously successful instance goes first');
  });
});

// ---------------------------------------------------------------------------
// Live network smoke — never runs in CI. Usage:
//   SMOKE_FREE_SEARCH=1 node --test test/search-searxng.test.cjs
// ---------------------------------------------------------------------------
const SMOKE = process.env.SMOKE_FREE_SEARCH === '1';
const SMOKE_QUERIES = [
  'сколько стоит домен ru 2026',
  'лучшие ATS для рекрутинга 2026',
  'Deepgram vs AssemblyAI диаризация русский',
  'стоимость разработки ПО оценка COCOMO II',
  'зарплата рекрутера Россия 2026',
];

test('live smoke: 5 control queries', { skip: !SMOKE, timeout: 300_000 }, async () => {
  const rows = [];
  for (const q of SMOKE_QUERIES) {
    const t0 = Date.now();
    const out = await tool.handler({ query: q, num: 10 }, {});
    rows.push({
      q,
      engine: out.engine || '-',
      source: out.source || '-',
      n: Array.isArray(out.results) ? out.results.length : 0,
      ms: out.took_ms || Date.now() - t0,
      blocked: out.error ? 'yes' : 'no',
      err: out.error || '',
      msg: out.message ? out.message.replace(/\|/g, '/').slice(0, 220) : '',
    });
  }
  for (const r of rows) {
    console.log(`SMOKE|${r.q}|${r.engine}|${r.source}|${r.n}|${r.ms}|${r.blocked}|${r.err}|${r.msg}`);
  }
  const nonEmpty = rows.filter((r) => r.n > 0).length;
  const avg = Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length);
  const engines = [...new Set(rows.map((r) => r.engine))].join(',');
  console.log(`SMOKE_SUMMARY|${nonEmpty}/${rows.length} non-empty|avg_ms=${avg}|blocked=${rows.filter((r) => r.blocked === 'yes').length}|engines=${engines}`);
});
