'use strict';

// search_serp_free — epic #1792, line L3: the keyless third way to search the web.
// No API key, no account, no third-party quota spent under our name: we ask for the SERP
// ourselves and parse it (DuckDuckGo html via POST, SearXNG format=json, Brave HTML).
//
// Recon, 2026-09-28 (GCP 136.65.7.197 + Moscow), full table in the PR body:
//   * DuckDuckGo html/lite   → GET is HTTP 202 + anomaly-modal puzzle from BOTH egresses, but
//                              POST (form-encoded q=) returns a real SERP: 10 result__a blocks,
//                              ~0.6s, relevant. It flips back to 202 after a handful of rapid
//                              requests (cooldown of minutes) — so 202 is detected as a rate-limit
//                              and the chain falls through, it is never mistaken for "no results".
//   * SearXNG public pool    → 3 of 95 searx.space instances answer `format=json` with real
//                              organic results from GCP: search.lumy.live (Yandex engine — the only
//                              one that answers Russian queries, 2-8s but sometimes >15s), sx.xo.st
//                              and search.mectov.my.id (both have ONLY a working Bing engine: fine
//                              for English, 0 results for Russian). The rest: 429 (47), 403 (7),
//                              418/5xx, or an antibot/HTML page with JSON disabled.
//   * Brave Search HTML      → real, relevant results from the Moscow IP; HTTP 429 captcha from
//                              GCP.
//   * Bing HTML + `format=rss` → 200 with 10 `b_algo` blocks, but the blocks are DECOYS (results
//                              never match the query) from a datacenter IP — silently wrong, so
//                              Bing is deliberately NOT wired in as a backend.
//   * Mojeek/Ecosia/Startpage/Qwant/Yandex/Google/yep/4get → 403 / captcha / JS-wall.
//   * Marginalia (old-search) → answers, but with a bot-delay interstitial ("Wait For A Moment")
//                              and a tiny index — not wired in.
//
// Backends (FREE_SEARCH_BACKEND, comma-separated; default "duckduckgo,searxng,brave"):
//   duckduckgo — POST https://html.duckduckgo.com/html/ (GET would be challenged), regex-parsed.
//   searxng    — pool from SEARXNG_URL (comma-separated instance base URLs), default = the three
//                instances verified live above, best first. The last instance that answered is
//                remembered and tried first on the next call (sticky), the rest are the fallback.
//   brave      — search.brave.com HTML, parsed with regexes.
// A backend that is blocked returns a clear reason and the chain moves on; only when every
// configured candidate failed does the tool return an error object (never a hang, never silence).

const TIMEOUT_MS = 15_000; // per HTTP request (repo convention)
const BUDGET_MS = 30_000; // whole call — a pool of dead instances must not stall a chat turn
const RETRY_DELAY_MS = 250;
const MAX_ATTEMPTS = 6; // hard cap on candidates probed per call
const DEFAULT_NUM = 10;
const MAX_NUM = 20;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BRAVE_URL = 'https://search.brave.com/search';
// POST only — the same URL as GET returns the 202 anomaly challenge.
const DDG_URL = 'https://html.duckduckgo.com/html/';

// Verified live from the GCP host (organic results, format=json) on 2026-09-28, best first:
// lumy.live is Yandex-backed and is the only one that answers Russian queries.
const DEFAULT_SEARXNG_POOL = [
  'https://search.lumy.live',
  'https://sx.xo.st',
  'https://search.mectov.my.id',
];

const CHALLENGE_RE =
  /anomaly-modal|captcha|are you a robot|verifying your browser|unusual traffic|just a moment|attention required|making sure you.{0,5}re not a bot|iq test has been enabled/i;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', copy: '©',
};

function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    const key = ent.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' || key[1] === 'X' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
    }
    return m;
  });
}

function stripTags(html) {
  return decodeEntities(
    String(html == null ? '' : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The instance that answered last call is tried first (a fast path once we know which one
// works from this IP); otherwise rotate the start index so load is not pinned on one instance.
let rotation = 0;
let lastGood = null;
function orderPool(pool) {
  if (pool.length < 2) return pool.slice();
  if (lastGood && pool.includes(lastGood)) return [lastGood, ...pool.filter((u) => u !== lastGood)];
  const off = rotation++ % pool.length;
  return pool.slice(off).concat(pool.slice(0, off));
}

function searxngUrls() {
  const env = splitList(process.env.SEARXNG_URL);
  return orderPool(env.length ? env : DEFAULT_SEARXNG_POOL);
}

function backendChain() {
  const raw = splitList(process.env.FREE_SEARCH_BACKEND).map((s) => s.toLowerCase());
  return raw.length ? raw : ['duckduckgo', 'searxng', 'brave'];
}

function parseSearxng(body, contentType) {
  const looksJson = /json/i.test(contentType || '') || /^\s*[[{]/.test(body || '');
  if (!looksJson) {
    if (CHALLENGE_RE.test(body || '')) return { fail: 'challenge page (captcha/antibot) — instance refuses this IP' };
    return { fail: `non-JSON response (content-type "${String(contentType || 'unknown').slice(0, 40)}") — instance has format=json disabled` };
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { fail: 'invalid JSON body' };
  }
  const raw = Array.isArray(data && data.results) ? data.results : [];
  const results = [];
  const seen = new Set();
  for (const r of raw) {
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: clip(stripTags(r.title), 200),
      url,
      snippet: clip(stripTags(r.content), 400),
    });
  }
  if (!results.length) return { fail: 'empty SERP (0 organic results)' };
  return { results };
}

// DuckDuckGo sometimes wraps links as //duckduckgo.com/l/?uddg=<urlencoded target>&rut=…
function ddgFinalUrl(href) {
  const url = decodeEntities(String(href || ''));
  if (!/[?&]uddg=/.test(url)) return url;
  try {
    const target = new URL(url.startsWith('//') ? `https:${url}` : url).searchParams.get('uddg');
    if (target) return target;
  } catch { /* unparseable wrapper — hand back as-is */ }
  return url;
}

function parseDdg(body) {
  const html = String(body || '');
  if (!html.includes('result__a')) {
    if (CHALLENGE_RE.test(html)) return { fail: 'challenge page (captcha/antibot)' };
    return { fail: 'no result markup in the DuckDuckGo response' };
  }
  const results = [];
  const snippets = new Map();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1] || '';
    const hrefM = /href="([^"]+)"/i.exec(attrs);
    const classM = /class="([^"]+)"/i.exec(attrs);
    if (!hrefM || !classM) continue;
    const cls = classM[1];
    if (/\bresult__snippet\b/.test(cls)) {
      snippets.set(ddgFinalUrl(hrefM[1]), clip(stripTags(m[2]), 400));
    } else if (/\bresult__a\b/.test(cls)) {
      const url = ddgFinalUrl(hrefM[1]);
      if (!/^https?:\/\//i.test(url) || results.some((r) => r.url === url)) continue;
      results.push({ url, title: clip(stripTags(m[2]), 200), snippet: '' });
    }
  }
  if (!results.length) return { fail: 'result markers present but no extractable results' };
  for (const r of results) r.snippet = snippets.get(r.url) || '';
  return { results };
}

function parseBrave(body) {
  const marker = 'data-type="web"';
  if (!String(body || '').includes(marker)) {
    if (CHALLENGE_RE.test(body || '')) return { fail: 'challenge page (429 captcha) — Brave blocks this IP' };
    return { fail: 'no organic-result markup in response' };
  }
  const segments = String(body).split(marker).slice(1);
  const results = [];
  const seen = new Set();
  for (const seg of segments) {
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"/i.exec(seg);
    if (!href) continue;
    const url = decodeEntities(href[1]);
    if (seen.has(url)) continue;
    const titleM = /<div class="title search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
    const snipM =
      /<div class="(?:generic-snippet|content desktop-default-regular)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
    seen.add(url);
    results.push({
      title: clip(stripTags(titleM ? titleM[1] : ''), 200),
      url,
      snippet: clip(stripTags(snipM ? snipM[1] : ''), 400),
    });
  }
  if (!results.length) return { fail: 'organic markers present but no extractable results' };
  return { results };
}

async function fetchOnce(req, fetchImpl, timeoutMs) {
  const res = await fetchImpl(req.url, {
    method: req.method || 'GET',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      ...(req.headers || {}),
    },
    ...(req.body ? { body: req.body } : {}),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers = res && res.headers;
  const contentType =
    headers && typeof headers.get === 'function'
      ? headers.get('content-type') || ''
      : (res && res.contentType) || '';
  const text = typeof res.text === 'function' ? await res.text() : String((res && res.body) || '');
  return { status: (res && res.status) || 0, contentType, text };
}

// One retry, and only for failures that a retry can plausibly fix (network/timeout, 429, 5xx).
// 403/bans/challenge pages and parse failures are definitive — retrying them just burns the budget.
// `deadline` caps the per-request timeout at what is left of the whole call, so a pool of dead
// instances can never push a single call past BUDGET_MS (each request is still ≤ TIMEOUT_MS).
async function attempt(req, kind, fetchImpl, deadline) {
  let last = 'unknown failure';
  for (let n = 0; n < 2; n++) {
    if (n) await sleep(RETRY_DELAY_MS);
    const remaining = deadline - Date.now();
    if (remaining < 500) {
      last = last === 'unknown failure' ? `time budget of ${BUDGET_MS}ms exhausted` : last;
      break;
    }
    const timeoutMs = Math.min(TIMEOUT_MS, remaining);
    let r;
    try {
      r = await fetchOnce(req, fetchImpl, timeoutMs);
    } catch (e) {
      last = `network error: ${e && e.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : ((e && e.message) || 'fetch failed')}`;
      continue;
    }
    if (r.status === 429) {
      last = 'HTTP 429 rate-limited';
      continue;
    }
    if (r.status === 202) {
      // DuckDuckGo's anomaly challenge: fast, and a retry will not clear it.
      return { fail: 'HTTP 202 anti-bot challenge (upstream rate-limited this IP)' };
    }
    if (r.status >= 500) {
      last = `HTTP ${r.status}`;
      continue;
    }
    if (r.status >= 400) {
      return { fail: CHALLENGE_RE.test(r.text) ? `HTTP ${r.status} + challenge page (captcha)` : `HTTP ${r.status}` };
    }
    const parsed =
      kind === 'searxng' ? parseSearxng(r.text, r.contentType)
        : kind === 'duckduckgo' ? parseDdg(r.text)
          : parseBrave(r.text);
    if (parsed.results) return { results: parsed.results };
    return { fail: parsed.fail };
  }
  return { fail: last };
}

function buildRequest(backend, base, query) {
  const q = encodeURIComponent(query);
  if (backend === 'duckduckgo') {
    return { url: DDG_URL, method: 'POST', body: `q=${q}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  }
  if (backend === 'searxng') {
    return { url: `${String(base).replace(/\/+$/, '')}/search?q=${q}&format=json`, method: 'GET' };
  }
  return { url: `${BRAVE_URL}?q=${q}`, method: 'GET' };
}

function buildFailure(attempts) {
  const seen = [];
  for (const a of attempts) {
    const line = `${a.backend}(${a.source}): ${a.reason}`;
    if (!seen.includes(line)) seen.push(line);
  }
  return (
    'search_serp_free: every configured backend failed — ' +
    seen.join('; ') +
    '. Nothing is broken in this process; the upstream SERP is blocking/rate-limiting us. ' +
    'Try a rephrased query later, or set FREE_SEARCH_BACKEND / SEARXNG_URL to another keyless backend.'
  );
}

const tools = {
  search_serp_free: {
    description:
      'Search the web WITHOUT any API key or account (keyless SERP scraping). ' +
      'Returns organic results {engine, results:[{title,url,snippet,position}], took_ms}. ' +
      'Chain (first that answers wins): DuckDuckGo html (POST, no key), a pool of public SearXNG ' +
      'instances (format=json), then Brave Search HTML. Use it for research/fact-finding when no ' +
      'other search tool is available. It can fail with an explicit error when every upstream ' +
      'rate-limits our IP — in that case read the message, do not retry blindly in a loop, and say ' +
      'plainly that search is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "сколько стоит домен ru 2026"' },
        num: { type: 'integer', description: 'How many results to return (1-20, default 10)' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const input = args || {};
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return { error: 'bad_request', message: 'search_serp_free: "query" (non-empty string) is required' };
      let num = parseInt(input.num, 10);
      if (!Number.isFinite(num)) num = DEFAULT_NUM;
      num = Math.min(MAX_NUM, Math.max(1, num));

      const fetchImpl = ctx && typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        return { error: 'no_fetch', message: 'search_serp_free: fetch is not available in this runtime' };
      }

      const chain = backendChain();
      if (!chain.length) {
        return { error: 'bad_backend', message: 'search_serp_free: FREE_SEARCH_BACKEND names no known backend' };
      }
      const known = ['duckduckgo', 'searxng', 'brave'];
      const unknown = chain.filter((b) => !known.includes(b));
      if (unknown.length && unknown.length === chain.length) {
        return {
          error: 'bad_backend',
          message: `search_serp_free: unknown backend(s) ${unknown.join(', ')} — known: ${known.join(', ')}`,
        };
      }

      const started = Date.now();
      const deadline = started + BUDGET_MS;
      const attempts = [];
      let probed = 0;

      for (const backend of chain) {
        if (!known.includes(backend)) {
          attempts.push({ backend, source: '-', reason: 'unknown backend, skipped' });
          continue;
        }
        // one job per candidate: single-URL backends carry base=null, searxng carries the instance
        const jobs =
          backend === 'searxng'
            ? searxngUrls().map((base) => ({ base, source: base }))
            : [{ base: null, source: backend === 'duckduckgo' ? 'html.duckduckgo.com' : 'search.brave.com' }];
        for (const job of jobs) {
          if (probed >= MAX_ATTEMPTS || Date.now() >= deadline) break;
          probed++;
          const out = await attempt(buildRequest(backend, job.base, query), backend, fetchImpl, deadline);
          if (out.results) {
            if (backend === 'searxng') lastGood = job.base;
            return {
              engine: backend,
              source: job.source,
              results: out.results.slice(0, num).map((r, i) => ({ ...r, position: i + 1 })),
              took_ms: Date.now() - started,
            };
          }
          attempts.push({ backend, source: job.source, reason: out.fail });
        }
      }

      return { error: 'search_failed', message: buildFailure(attempts), attempts, took_ms: Date.now() - started };
    },
  },
};

module.exports = { tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v])) };
