'use strict';

// search_exa / fetch_exa — публичный Exa search-MCP (https://mcp.exa.ai/mcp), БЕЗ ключа
// и без квот на нашей стороне (эпик #1792, линия L2).
//
// Зачем: у opencode-ран нет websearch, а в trained-skills не было ни одного поискового
// тула — ru_browser_fetch/website_request фетчат только уже известный URL. Это даёт всем
// сессиям настоящий поиск в интернете плюс бесплатный fetch_exa как замену Playwright,
// когда URL уже известен и страница не гео-заблокирована.
//
// Клиент — свой минимальный JSON-RPC-over-HTTP (в репо нет MCP-клиента и зависимости от
// него, ставить SDK незачем): initialize → notifications/initialized → tools/call; тело
// ответа — SSE ("event: message" / "data: {...}"), иногда голый JSON. Одна сессия на
// процесс (mcp-session-id переиспользуется; после HTTP 400/404 сессия перевсплывает).
// Таймаут каждого запроса 15 с (конвенция репо), одна ретрая, дальше — понятная строка
// ошибки для модели: тул возвращает {error}, не молчит и не роняет процесс.
//
// Ключ не нужен. Опционально (только как аварийный обход исчерпанного анонимного
// лимита, без src/secrets.js): EXA_MCP_URL — другой эндпоинт/прокси, EXA_API_KEY —
// собственный ключ Exa (подставляется в URL сами, см. endpoint()).

const DEFAULT_ENDPOINT = 'https://mcp.exa.ai/mcp';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'trained-assist', version: '1.0' };
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2; // 1 ретрая
const OBJECTIVE_PREFIX_CHARS = 300;
const DEFAULT_NUM = 8;
const MAX_NUM = 20;
const SNIPPET_MAX = 3000;

class McpError extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = 'McpError';
    this.retryable = !!retryable;
  }
}

// --- session state (one per process) -------------------------------------------------
let sessionId = null;
let handshake = null;
let rpcSeq = 0;

function nextId() {
  rpcSeq += 1;
  return rpcSeq;
}

function resetExaSession() {
  sessionId = null;
  handshake = null;
}

function endpoint() {
  const base = process.env.EXA_MCP_URL || DEFAULT_ENDPOINT;
  const key = process.env.EXA_API_KEY;
  if (!key) return base;
  return `${base}${base.includes('?') ? '&' : '?'}exaApiKey=${encodeURIComponent(key)}`;
}

// --- transport ------------------------------------------------------------------------
function compact(text, max = 400) {
  const s = String(text == null ? '' : text)
    .replace(/^data:\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function post(payload, { sid = null, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new McpError('Exa MCP: fetch недоступен в этом окружении', false);
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) headers['Mcp-Session-Id'] = sid;

  let res;
  try {
    res = await doFetch(endpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new McpError(
      `Exa MCP недоступен: ${timedOut ? `таймаут ${TIMEOUT_MS} мс` : `сетевая ошибка (${e && e.message})`} — попробуй ещё раз позже или скажи пользователю, что поиск сейчас не работает`,
      true,
    );
  }

  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  const get = k => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  return { status: res.status || 0, sid: get('mcp-session-id'), text };
}

// SSE: блоки, разделённые пустой строкой; в блоке строки "event:" и "data:".
// Некоторые ответы приходят голым JSON — принимаем и его.
function parseSse(raw) {
  const src = String(raw == null ? '' : raw);
  const out = [];
  let data = null;
  const flush = () => {
    if (data === null) return;
    try { out.push(JSON.parse(data)); } catch { /* не JSON — игнорируем */ }
    data = null;
  };
  for (const line of src.split(/\r?\n/)) {
    if (line === '') { flush(); continue; }
    if (line.startsWith('data:')) {
      const v = line.slice(5).replace(/^ /, '');
      data = data === null ? v : `${data}\n${v}`;
    }
  }
  flush();
  if (!out.length) {
    try {
      const j = JSON.parse(src);
      if (j && typeof j === 'object') out.push(j);
    } catch { /* не JSON */ }
  }
  return out;
}

function resultText(result) {
  const content = (result && result.content) || [];
  return content.map(c => (c && c.text) || '').filter(Boolean).join('\n');
}

function handshakeError(r) {
  if (r.status === 429) return new McpError(rateLimitText(r.text), true);
  if (r.status >= 500) return new McpError(`Exa MCP: HTTP ${r.status} на initialize — сервер недоступен`, true);
  if (!r.sid) {
    return new McpError(
      `Exa MCP: initialize не вернул mcp-session-id (HTTP ${r.status}${r.text ? `: ${compact(r.text, 200)}` : ''}) — эндпоинт закрыл анонимный доступ или изменился`,
      false,
    );
  }
  return new McpError(`Exa MCP: initialize → HTTP ${r.status}${r.text ? `: ${compact(r.text, 200)}` : ''}`, false);
}

function rateLimitText(body) {
  return `Exa MCP: исчерпан лимит бесплатного анонимного доступа (HTTP 429)${body ? ` — ${compact(body, 300)}` : ''}. Это временно: повтори чуть позже или скажи пользователю, что поиск перегружен`;
}

// initialize → notifications/initialized. Одна сессия на процесс; параллельные вызовы
// делят один handshake (промис), а не плодят по сессии на каждый тул-вызов.
async function ensureSession(fetchImpl) {
  if (sessionId) return sessionId;
  if (!handshake) {
    handshake = (async () => {
      const init = await post(
        { jsonrpc: '2.0', id: nextId(), method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } },
        { fetchImpl },
      );
      if (init.status !== 200 || !init.sid) throw handshakeError(init);
      const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { sid: init.sid, fetchImpl });
      if (ack.status >= 400) {
        throw new McpError(
          `Exa MCP: notifications/initialized → HTTP ${ack.status}${ack.text ? `: ${compact(ack.text, 200)}` : ''}`,
          ack.status === 429 || ack.status >= 500,
        );
      }
      sessionId = init.sid;
      return sessionId;
    })().catch(e => {
      handshake = null;
      throw e;
    });
  }
  return handshake;
}

// tools/call с одной ретраей: сетевая ошибка/таймаут/429/5xx/протухшая сессия → ещё
// раз, дальше — ошибка модели (не тишина, не зависание).
async function callTool(name, args, { fetchImpl = null } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const sid = await ensureSession(fetchImpl);
      const r = await post(
        { jsonrpc: '2.0', id: nextId(), method: 'tools/call', params: { name, arguments: args } },
        { sid, fetchImpl },
      );

      if (r.status === 400 || r.status === 404) {
        // сессия протухла на стороне сервера — перевсплываем и пробуем ещё раз
        resetExaSession();
        last = new McpError(`Exa MCP: сессия истекла (HTTP ${r.status}) — переинициализируюсь`, true);
        continue;
      }
      if (r.status === 429) { last = new McpError(rateLimitText(r.text), true); continue; }
      if (r.status >= 500) { last = new McpError(`Exa MCP: HTTP ${r.status} на tools/call — сервер недоступен`, true); continue; }
      if (r.status !== 200) {
        last = new McpError(`Exa MCP: HTTP ${r.status}${r.text ? `: ${compact(r.text, 300)}` : ''}`, false);
        break;
      }

      const msg = parseSse(r.text).find(m => m && (m.result || m.error));
      if (!msg) { last = new McpError(`Exa MCP: непонятный ответ (не SSE/JSON): ${compact(r.text, 200)}`, true); continue; }
      if (msg.error) {
        last = new McpError(`Exa MCP: ${msg.error.message || `ошибка JSON-RPC ${msg.error.code}`}`, false);
        break;
      }
      const result = msg.result || {};
      if (result.isError) {
        last = new McpError(`Exa MCP: ${compact(resultText(result), 400) || 'тул вернул ошибку'}`, false);
        break;
      }
      return resultText(result);
    } catch (e) {
      last = e instanceof McpError ? e : new McpError(`Exa MCP: ${e && e.message}`, true);
      if (!last.retryable) break;
    }
  }
  throw last || new McpError('Exa MCP: неизвестная ошибка', false);
}

// --- search helpers --------------------------------------------------------------------
function buildObjective(query) {
  const q = String(query == null ? '' : query).replace(/\s+/g, ' ').trim();
  const head = q.length > OBJECTIVE_PREFIX_CHARS ? `${q.slice(0, OBJECTIVE_PREFIX_CHARS)}…` : q;
  return `Цель поиска: ${head}. Нужны конкретные факты: цены, цифры, даты, названия и версии с указанием источника (URL). Релевантные страницы ранжируй выше, рекламные заглушки и пустые лендинги — ниже.`;
}

function truncate(s, max) {
  const str = String(s == null ? '' : s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function clampNum(num) {
  const v = Number.parseInt(num, 10);
  if (!Number.isFinite(v)) return DEFAULT_NUM;
  return Math.min(MAX_NUM, Math.max(1, v));
}

// Ответ web_search_exa — склеенный текст блоков:
//   Title: …\nURL: …\nPublished: …\nAuthor: …\nHighlights:\n<текст>\n\n---\n\nTitle: …
// Границы блоков ищем по паре строк Title+/URL:, а не по "---": внутри highlights
// возможна своя markdown-линия "---".
function parseSearchText(raw) {
  const text = String(raw == null ? '' : raw);
  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (/^Title:\s*/.test(lines[i]) && /^URL:\s*https?:\/\//.test(lines[i + 1])) starts.push(i);
  }

  const results = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(from, to).join('\n');
    const title = lines[from].replace(/^Title:\s*/, '').trim();
    const url = lines[from + 1].replace(/^URL:\s*/, '').trim();
    const hl = block.indexOf('Highlights:');
    let body = hl >= 0 ? block.slice(hl + 'Highlights:'.length) : block;
    body = body.replace(/^\s*\n/, '').replace(/\n\s*---\s*$/, '').trim();

    const entry = { title, url };
    if (body) entry.snippet = truncate(body, SNIPPET_MAX);
    else entry.text = truncate(block, SNIPPET_MAX);
    const pub = /^Published:\s*(.*)$/m.exec(block);
    if (pub && pub[1].trim() && pub[1].trim() !== 'N/A') entry.published = pub[1].trim();
    results.push(entry);
  }

  if (!results.length) {
    const t = text.trim();
    return t ? [{ title: '', url: '', text: truncate(t, SNIPPET_MAX) }] : [];
  }
  return results;
}

// Ответ web_fetch_exa — по странице: "# <заголовок>\nURL: <url>\n\n<markdown>".
function parseFetchPages(raw, urls) {
  const src = String(raw == null ? '' : raw);
  const lines = src.split(/\r?\n/);
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^URL:\s*https?:\/\//.test(lines[i])) marks.push(i);
  }

  if (!marks.length) {
    const body = src.trim();
    return body && urls.length ? [{ url: urls[0], markdown: body }] : [];
  }

  const pages = [];
  for (let k = 0; k < marks.length; k += 1) {
    const from = marks[k] + 1;
    const to = k + 1 < marks.length ? marks[k + 1] : lines.length;
    pages.push({
      url: lines[marks[k]].replace(/^URL:\s*/, '').trim(),
      markdown: lines.slice(from, to).join('\n').replace(/^\n+/, '').replace(/\n+$/, '').trim(),
    });
  }

  if (pages.length === urls.length) {
    // порядок ответа совпадает с запросом — метим запрошенными URL (сервер мог сделать redirect)
    return pages.map((p, i) => ({ url: urls[i], markdown: p.markdown }));
  }
  const norm = u => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const byNorm = new Map(pages.map(p => [norm(p.url), p]));
  return urls.map(u => {
    const p = byNorm.get(norm(u));
    return { url: u, markdown: p ? p.markdown : '' };
  });
}

// --- tool entry points (exported for tests) --------------------------------------------
async function searchExa({ query, num, fetchImpl = null } = {}) {
  const started = Date.now();
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) {
    return { engine: 'exa', results: [], error: 'search_exa: не задан query (строка поискового запроса)', took_ms: 0 };
  }
  try {
    const text = await callTool('web_search_exa', { query: q, objective: buildObjective(q), numResults: clampNum(num) }, { fetchImpl });
    const results = parseSearchText(text);
    if (!results.length) {
      return { engine: 'exa', results: [], error: 'search_exa: Exa вернул пустую выдачу — переформулируй запрос и повтори', took_ms: Date.now() - started };
    }
    return { engine: 'exa', results, took_ms: Date.now() - started };
  } catch (e) {
    return { engine: 'exa', results: [], error: `search_exa: ${e && e.message}`, took_ms: Date.now() - started };
  }
}

async function fetchExa({ urls, maxCharacters, fetchImpl = null } = {}) {
  const started = Date.now();
  const list = (Array.isArray(urls) ? urls : [])
    .map(u => String(u == null ? '' : u).trim())
    .filter(u => /^https?:\/\//.test(u));
  if (!list.length) {
    return { engine: 'exa', error: 'fetch_exa: не задан urls (массив URL, начинающихся с http/https)', took_ms: 0 };
  }
  const mc = Number.parseInt(maxCharacters, 10);
  const args = { urls: list };
  if (Number.isFinite(mc) && mc > 0) args.maxCharacters = Math.min(mc, 50_000);

  try {
    const text = await callTool('web_fetch_exa', args, { fetchImpl });
    const pages = parseFetchPages(text, list);
    if (!pages.length) {
      return { engine: 'exa', error: 'fetch_exa: Exa вернул пустой ответ по этим URL', took_ms: Date.now() - started };
    }
    return pages;
  } catch (e) {
    return { engine: 'exa', error: `fetch_exa: ${e && e.message}`, took_ms: Date.now() - started };
  }
}

module.exports = {
  tools: {
    search_exa: {
      description:
        'Поиск в интернете через публичный Exa search-MCP (mcp.exa.ai) — БЕЗ API-ключа и без наших квот. ' +
        'Возвращает {engine:"exa", results:[{title, url, snippet|text, published?}], took_ms}: до ' +
        `${MAX_NUM} результатов с заголовком, URL и релевантным фрагментом (до ${SNIPPET_MAX} символов). ` +
        'Используй, когда нужен актуальный факт, которого нет у тебя в контексте: цены, тарифы, даты, версии, ' +
        'рейтинги, новости, сравнения, зарплаты. Для заголовков дай семантический запрос (что за страницу хочешь увидеть), ' +
        'а не набор ключевых слов. Если фрагмента мало — открой лучшие URL через fetch_exa. ' +
        'При ошибке (лимит 429, таймаут) в поле error будет понятная причина: сообщи пользователю и предложи повторить позже, не выдумывай данные.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Поисковый запрос: цель и что за страницу нужно найти (описанием, не ключевыми словами).' },
          num: { type: 'number', description: `Сколько результатов вернуть: 1–${MAX_NUM}, по умолчанию ${DEFAULT_NUM}.` },
        },
      },
      handler: async ({ query, num } = {}) => searchExa({ query, num }),
    },

    fetch_exa: {
      description:
        'Загрузить страницы по уже известным URL как чистый markdown через Exa (бесплатно, без ключа, ' +
        'обычно 0.3–3 с) — замена Playwright/ru_browser_fetch, когда страница не гео-заблокирована. ' +
        'Можно передать несколько URL сразу (батч). Ответ: [{url, markdown}]; markdown обрезается по maxCharacters ' +
        '(по умолчанию 3000 на страницу). Гео-заблокированные с RU IP (hh.ru, nalog.ru, etm.ru) сюда не лезь — ' +
        'для них есть ru_browser_fetch. При ошибке вернёт объект с полем error.',
      inputSchema: {
        type: 'object',
        required: ['urls'],
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'Массив URL для загрузки (http/https).' },
          maxCharacters: { type: 'number', description: 'Максимум символов markdown на страницу (по умолчанию 3000).' },
        },
      },
      handler: async ({ urls, maxCharacters } = {}) => fetchExa({ urls, maxCharacters }),
    },
  },

  // Тестовые швы — test/search-exa.test.cjs.
  searchExa,
  fetchExa,
  buildObjective,
  parseSearchText,
  parseFetchPages,
  resetExaSession,
};
