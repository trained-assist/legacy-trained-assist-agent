'use strict';

// search_serper — интернет-поиск через Serper (https://serper.dev), официальный
// Google SERP API. Бесплатный тир — 2 500 запросов, карта не требуется (issue #1792).
//
// Чем это отличается от остальных «веб»-тулов репо: ru_browser_fetch /
// website_request фетчат УЖЕ известный URL, search_serper — единственный способ
// НАЙТИ URL (настоящий Google SERP, а не угадывание домена).
//
// Отказоустойчивость (конвенция репо): AbortSignal.timeout(15_000) на каждый вызов,
// один ретрай на сетевые сбои / 429 / 5xx, дальше — явная строка ошибки для модели.
// Ни тишины, ни зависания: любой путь завершается объектом с полем `error`.
// Ключ — process.env.SERPER_API_KEY; его отсутствие тоже ошибка в ответе, а не throw
// (процесс MCP не должен падать из-за незаполненного env).
//
// Тесты: test/search-serper.test.cjs (fetch мокается инъекцией fetchImpl, живой
// прогон — только под SMOKE_SERPER=1).

const ENDPOINT = 'https://google.serper.dev/search';
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 2; // 1 вызов + 1 ретрай
const MAX_NUM = 100;

function notConfigured() {
  return {
    error: 'serper не сконфигрирован: нужен SERPER_API_KEY',
    hint:
      'В окружении этого MCP-процесса нет переменной SERPER_API_KEY (ключи приходят через ' +
      'mcpToolEnv, см. src/browser.js). Не выдумывай выдачу и не притворяйся, что искал: скажи ' +
      'пользователю, что поиск в интернете не настроен, и попроси передать серпер-ключ ' +
      'администратору.',
  };
}

function describeAbort(e, attempt, attempts, timeoutMs) {
  const name = e && e.name;
  if (name === 'TimeoutError' || name === 'AbortError' || (e && /timeout|aborted/i.test(String(e.message)))) {
    return `serper: таймаут ${timeoutMs} мс (попытка ${attempt}/${attempts})`;
  }
  return `serper: сетевая ошибка: ${(e && e.message) || e} (попытка ${attempt}/${attempts})`;
}

function normalize(data, tookMs) {
  const organic = data && Array.isArray(data.organic) ? data.organic : [];
  return {
    engine: 'serper',
    results: organic.map((r, i) => ({
      title: typeof (r && r.title) === 'string' ? r.title : '',
      url: typeof (r && r.link) === 'string' ? r.link : '',
      snippet: typeof (r && r.snippet) === 'string' ? r.snippet : '',
      position: Number.isFinite(r && r.position) ? r.position : i + 1,
    })),
    took_ms: tookMs,
  };
}

async function bodySnippet(res) {
  try {
    const text = await res.text();
    return text ? text.slice(0, 300) : '';
  } catch {
    return '';
  }
}

/**
 * Search Google via Serper. Resolves (never rejects) with either
 * {engine, results, took_ms} or {error, ...} — the model must always get text to read.
 *
 * @param {object}   p
 * @param {string}   p.query     search query (required)
 * @param {number}  [p.num]      results to return (1..100, default 10)
 * @param {string}  [p.gl]       country code, e.g. "ru"
 * @param {string}  [p.hl]       interface language, e.g. "ru" / "en"
 * @param {string}  [p.apiKey]   defaults to process.env.SERPER_API_KEY
 * @param {Function}[p.fetchImpl] injectable fetch (tests)
 * @param {number}  [p.timeoutMs] per-attempt timeout, default 15_000
 * @param {number}  [p.attempts]  total attempts, default 2 (1 retry)
 */
async function searchSerper(p = {}) {
  const { query, num, gl, hl, fetchImpl = globalThis.fetch } = p;
  const timeoutMs = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : TIMEOUT_MS;
  const attempts = Number.isFinite(p.attempts) && p.attempts > 0 ? p.attempts : ATTEMPTS;
  const apiKey = 'apiKey' in p ? p.apiKey : process.env.SERPER_API_KEY;

  if (typeof query !== 'string' || !query.trim()) {
    return { error: 'serper: нужен query — непустая строка поискового запроса' };
  }
  if (!apiKey) return notConfigured();
  if (typeof fetchImpl !== 'function') {
    return { error: 'serper: fetch недоступен в этом окружении' };
  }

  const body = { q: query.trim() };
  const n = Number(num);
  if (Number.isFinite(n) && n > 0) body.num = Math.min(Math.trunc(n), MAX_NUM);
  if (typeof gl === 'string' && gl.trim()) body.gl = gl.trim();
  if (typeof hl === 'string' && hl.trim()) body.hl = hl.trim();

  const t0 = Date.now();
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      last = { error: describeAbort(e, attempt, attempts, timeoutMs) };
      continue;
    }

    if (res && res.ok) {
      let data;
      try {
        data = await res.json();
      } catch (e) {
        return { error: `serper: неожиданный ответ (HTTP ${res.status}, не JSON): ${e.message}` };
      }
      return normalize(data, Date.now() - t0);
    }

    const status = res ? res.status : 0;
    const snippet = await bodySnippet(res);

    if (status === 401 || status === 403) {
      return {
        error: `serper: ключ отклонён (HTTP ${status}) — проверь SERPER_API_KEY`,
        detail: snippet || undefined,
      };
    }
    if (status === 429 || status >= 500) {
      last = {
        error: `serper: HTTP ${status} (попытка ${attempt}/${attempts})`,
        detail: snippet || undefined,
      };
      continue;
    }
    return {
      error: `serper: HTTP ${status} — запрос отклонён`,
      detail: snippet || undefined,
    };
  }

  return last || { error: `serper: запрос не удался после ${attempts} попыток` };
}

const tools = {
  search_serper: {
    description:
      'Поиск в интернете через Google (Serper — официальный Google SERP API). ' +
      'Используй, когда нужен актуальный факт, цена, рейтинг, сравнение, новости или перечень ' +
      'вариантов, которых нет в контексте сессии и в файлах пользователя — например «сколько стоит ' +
      'домен ru 2026», «лучшие ATS для рекрутинга 2026», «зарплата рекрутера Россия 2026». ' +
      'Возвращает органическую выдачу: title, url, snippet, position. Дальше выбирай наиболее ' +
      'релевантные результаты; если нужны детали со страницы — открой url через ru_browser_fetch / ' +
      'website_request, а не угадывай содержимое. ' +
      'Если в ответе есть поле error (нет ключа, таймаут, лимит) — не подменяй выдачу выдумками: ' +
      'скажи пользователю, что поиск сейчас не работает и почему.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Поисковый запрос на любом языке, например "лучшие ATS для рекрутинга 2026"',
        },
        num: {
          type: 'integer',
          description: 'Сколько результатов вернуть, 1–100 (по умолчанию 10)',
          minimum: 1,
          maximum: 100,
        },
        gl: {
          type: 'string',
          description: 'Код страны выдачи (например "ru", "ae") — сузить географию результатов',
        },
        hl: {
          type: 'string',
          description: 'Язык интерфейса выдачи (например "ru", "en")',
        },
      },
      required: ['query'],
    },
    handler: async ({ query, num, gl, hl } = {}) => searchSerper({ query, num, gl, hl }),
  },
};

module.exports = { tools, searchSerper, ENDPOINT, TIMEOUT_MS, ATTEMPTS };
