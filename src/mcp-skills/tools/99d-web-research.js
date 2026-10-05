'use strict';

// web_research — собрать сырой материал для исследования из интернета, БЕЗ вложенного движка.
//
// Замена hermes_web_research (удалён 2026-10-05). Тот тул спавнил второй opencode/claude
// («Hermes»), чтобы тот сам сходил в сеть. Слой не стоил своей цены: из ~10 вызовов
// hermes_web_research в трейсах 5 упали, и ВСЕ с одинаковой сигнатурой — `state:"error"`,
// `output:""`, т.е. оборванный MCP-вызов с съеденной мостом причиной (agent-mcp-bridge.js
// рвёт дочерний сервер на закрытии сокета). Выигрыш вложенного движка — отдельный контекст
// и отдельная доставка — не окупал второго процесса, второго MCP-моста и взаимодействия с
// keepalive; хрупкий был именно вложенный spawn, а не сама идея research.
//
// Теперь research — обычный инструмент: SERP (наш keyless search_serp_free, фолбэк
// search_exa) + markdown лучших страниц (fetch_exa). Никакого LLM внутри, никакого spawn:
// вызывающий движок получает материал и сам синтезирует выводы. Побочный плюс — тул
// укладывается в секунды, а не минуты, поэтому родительский 5-минутный watchdog
// (claude-runner.js INACTIVITY_TIMEOUT_MS) рядом не стоит.
//
// Что осталось от старого контракта: grounded (есть настоящие http(s)-URL), сохранение
// на диск (research/) и отдельное сообщение в Telegram — обе вещи нужны, потому что
// сессия может умереть, не успев пересказать результат (hermes-delivery.js).
// Что ушло: output_schema и синтез findings — их делает вызывающий движок.
//
// fetch_exa не годится для гео-заблокированных с RU IP (hh.ru, nalog.ru, etm.ru) —
// для них у движка есть ru_browser_fetch. Русские запросы search_serp_free отдаёт
// SearXNG-инстанс search.lumy.live (Yandex-бэкенд, единственный из пула, кто отвечает
// на русском) — см. 99c-search-searxng.js.

const { withKeepalive } = require('../../mcp-keepalive');
const { persistAndDeliver } = require('../../hermes-delivery');
const { searchExa, fetchExa } = require('./99b-search-exa');

const DEFAULT_NUM = 8;
const MAX_NUM = 20;
const DEFAULT_PAGES = 3;
const MAX_PAGES = 6;
const DEFAULT_MAX_CHARS = 3000;
const HARD_MAX_CHARS = 8000;

function clampInt(value, dflt, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// A research task is free text, not a query — take its first sentence and cap it,
// so «исследуй типовое УНФ 3.0.14 для заявки на комплектацию. Ответь по пунктам: …»
// ищет по существу, а не по всему заданию сразу.
function queryFromTask(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const first = flat.split(/(?<=[.!?…])\s+/)[0] || flat;
  return first.slice(0, 160).trim();
}

// SERP from our own keyless chain, falling back to Exa. Never throws: a blocked
// upstream comes back as {results: [], reason} so the model gets a stated reason
// instead of silence. `fetchImpl` is a test seam (see test/web-research.test.cjs).
async function collectSerp(query, num, { fetchImpl } = {}) {
  const { tools: searxngTools } = require('./99c-search-searxng');
  const handler = searxngTools && searxngTools.search_serp_free && searxngTools.search_serp_free.handler;
  let reason = null;
  if (typeof handler === 'function') {
    const out = await handler({ query, num }, fetchImpl ? { fetchImpl } : {});
    if (out && Array.isArray(out.results) && out.results.length) {
      return { engine: out.engine || 'searxng', results: out.results };
    }
    reason = (out && (out.message || out.error)) || 'пустая выдача';
  } else {
    reason = 'search_serp_free недоступен';
  }

  const exa = await searchExa({ query, num });
  if (exa && Array.isArray(exa.results) && exa.results.length) {
    return { engine: 'exa', results: exa.results, fallback_reason: reason };
  }
  return { engine: null, results: [], reason: `${reason}; search_exa: ${(exa && exa.error) || 'пусто'}` };
}

// Grounded ⇔ at least one real link: either a SERP hit or a page we actually opened.
// «Источник»-подпись без адреса не считается — именно из-за этого research раньше
// возвращал выдуманные ссылки.
function isGrounded(bundle) {
  const urls = [
    ...(Array.isArray(bundle?.results) ? bundle.results.map(r => r?.url) : []),
    ...(Array.isArray(bundle?.pages) ? bundle.pages.map(p => p?.url) : []),
  ];
  return urls.some(u => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()));
}

/**
 * The tool body — exported for the contract test. `searchImpl`/`fetchPagesImpl` are
 * test seams (the repo convention, see test/search-exa.test.cjs) so the test never
 * touches the network; production passes neither and gets the real backends.
 */
async function gather({ query, num, pages, maxChars, fetchImpl, searchImpl, fetchPagesImpl }) {
  const serp = typeof searchImpl === 'function'
    ? await searchImpl(query, num)
    : await collectSerp(query, num, { fetchImpl });
  const urls = serp.results.map(r => r.url).filter(u => /^https?:\/\//i.test(String(u || '')));
  const wanted = urls.slice(0, pages);

  let fetched = [];
  if (wanted.length) {
    const out = typeof fetchPagesImpl === 'function'
      ? await fetchPagesImpl(wanted, maxChars)
      : await fetchExa({ urls: wanted, maxCharacters: maxChars, fetchImpl: fetchImpl || null });
    if (Array.isArray(out)) fetched = out;
    else if (out && out.error) fetched = [{ url: wanted.join(' '), error: out.error }];
  }

  return {
    query,
    engine: serp.engine,
    ...(serp.fallback_reason ? { search_note: serp.fallback_reason } : {}),
    ...(serp.reason ? { search_error: serp.reason } : {}),
    results: serp.results.map(r => ({ title: r.title || '', url: r.url, snippet: r.snippet || r.text || '' })),
    pages: fetched.map(p => ({
      url: p.url,
      ...(p.markdown ? { markdown: p.markdown } : {}),
      ...(p.error ? { error: p.error } : {}),
    })),
  };
}

module.exports = {
  isReady: () => true,
  // Exported for the contract test (test/web-research.test.cjs).
  isGrounded,
  queryFromTask,
  gather,
  collectSerp,

  tools: {
    web_research: {
      description:
        'Собрать сырой материал из интернета по одной теме: поисковая выдача (без ключей и квот) ' +
        '+ markdown лучших страниц. Используй, когда задаче нужно САМОЙ сходить в сеть — найти, открыть, ' +
        'свести несколько источников. НЕ пересказывает и не делает выводы за тебя: возвращает результаты ' +
        'поиска и тексты страниц, а формулировать ответ с опорой на них (со ссылками в sources) ты ' +
        'должен сам этим же запуском. Если задаче нужно только обработать текст, который уже дан в ' +
        'context — тебе не сюда. Быстро: обычно секунды, максимум десятки секунд на несколько страниц. ' +
        'Результат сохраняется в research/ (поле saved_to) и отдельным сообщением уходит юзеру в ' +
        'Telegram (delivered) — не пересылай его целиком повторно, дай выводы. Проверяй grounded: ' +
        'true = есть настоящие http(s)-ссылки; false = поиск не сработал — тогда НЕ опирайся ни на что ' +
        'как на факты и скажи юзеру, что проверить не удалось. Для гео-заблокированных сайтов (hh.ru, ' +
        'nalog.ru, etm.ru) страницы этим тулом не откроются — используй ru_browser_fetch.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Тема одной строкой: что ищем. Если тема длинная — только первое предложение будет использовано как запрос.' },
          pages: { type: 'integer', description: `Сколько лучших страниц загрузить целиком: 0–${MAX_PAGES}, по умолчанию ${DEFAULT_PAGES}. 0 = только выдача.` },
          num: { type: 'integer', description: `Размер выдачи: 1–${MAX_NUM}, по умолчанию ${DEFAULT_NUM}.` },
          max_chars: { type: 'integer', description: `Лимит markdown на страницу, по умолчанию ${DEFAULT_MAX_CHARS}.` },
        },
        required: ['query'],
      },
      handler: async ({ query, pages, num, max_chars: maxChars, fetchImpl } = {}) => {
        const q = queryFromTask(query);
        if (!q) return { error: 'bad_request', message: 'web_research: нужен непустой query' };

        const bundle = await withKeepalive(() => gather({
          query: q,
          num: clampInt(num, DEFAULT_NUM, 1, MAX_NUM),
          pages: clampInt(pages, DEFAULT_PAGES, 0, MAX_PAGES),
          maxChars: clampInt(maxChars, DEFAULT_MAX_CHARS, 500, HARD_MAX_CHARS),
          fetchImpl,
        }));

        const grounded = isGrounded(bundle);
        if (!grounded) console.warn(`[web_research] not grounded: ${q.slice(0, 100)}`);
        // Save + notify best-effort: a durable artifact matters more than the push, and
        // neither is allowed to fail the call — the bundle is already in the parent's hands.
        const delivery = await persistAndDeliver({ task: q, result: bundle });
        return { ...bundle, grounded, ...delivery };
      },
    },
  },
};