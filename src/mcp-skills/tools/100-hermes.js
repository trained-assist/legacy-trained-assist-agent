'use strict';

// Hermes Phase 1 MCP tools.
// hermes_run_task — общий stateless-примитив: task + context + output_schema → JSON.
// candidate_report_json — пилот №3 (самый показательный): сводит
// резюме + вакансию + (опц.) разбор интервью в один CandidateReport JSON,
// который дальше можно скормить существующему HTML-генератору отчётов.
// Никакой памяти/инструментов/cron на этом этапе (Phase 1).

const { hermesRun } = require('../../hermes-run');
const { hermesRunWithTools } = require('../../hermes-tools-run');
const { persistAndDeliver } = require('../../hermes-delivery');
const { withKeepalive } = require('../../mcp-keepalive');

const USER_ID = process.env.USER_ID || '';

// Anti-recursion floor for hermes_web_research (triage 2026-09-28).
// hermes_web_research spawns a headless engine that gets THIS SAME MCP toolset, so without a
// floor the chain reproduces itself: engine → hermes_web_research → engine → hermes_web_research
// → … (measured: a new engine every ~15–20 s until the service was restarted). The depth
// travels in the MCP server env of the nested run (hermes-tools-run.js → browser.js
// extraEnv), because config env wins over the engine's env. Read at call time, not load
// time, so a server that inherits the flag rejects without a restart.
// Only hermes_web_research is floored: hermes_run_task/candidate_report_json are a single raw
// LLM call that cannot spawn anything.
function nestedRefusal() {
  const depth = Number.parseInt(process.env.HERMES_DEPTH || '0', 10) || 0;
  if (depth < 1) return null;
  return (
    `Вложенный Гермес (depth=${depth}) не запускается: этот движок уже работает внутри ` +
    'hermes_web_research, и повторный запуск плодит бесконечную цепочку движков. ' +
    'Выполни задачу сам этим же запуском: сходи в сеть через доступные инструменты ' +
    'и собери результат, а наружу отдай JSON по схеме.'
  );
}

const CANDIDATE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    candidate_name: { type: 'string' },
    summary: { type: 'string', description: '2-3 предложения: кто это и подходит ли' },
    strengths: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    fit_score: { type: 'number', description: '0-100, соответствие вакансии' },
    verdict: { type: 'string', enum: ['advance', 'maybe', 'reject'] },
    reasoning: { type: 'string' },
  },
  required: ['candidate_name', 'summary', 'fit_score', 'verdict'],
};

// ── Обязательные источники для research ───────────────────────────────────────
// До 2026-09-28 research возвращал выдуманные подписи вместо ссылок: «source: Deepgram
// documentation, pricing page» — не URL, проверить нечего (замер по проду, issue #1792).
// Причина была в обещании поиска, которого у движка не было; теперь поиск есть, но форма
// всё равно нужна — иначе «источник» снова превратится в строку без ссылки.
const SOURCES_PROP = {
  type: 'array',
  description:
    'Реальные источники утверждений. url — полный http(s)-адрес страницы ИЗ ВЫДАЧИ или ' +
    'страницы, которую ты реально открыл. Пустой массив или подпись вместо адреса = research не состоялся.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      url: { type: 'string', description: 'Полный http(s)-URL, не название сайта и не описание.' },
      quote: { type: 'string', description: 'Фрагмент со страницы, подтверждающий утверждение.' },
    },
    required: ['title', 'url'],
  },
};

// Adds `sources` to the caller's schema when it does not declare one of its own.
// Guarded on shape: a non-object root (array) is passed through untouched.
function withSources(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return schema;
  if (schema.properties.sources) return schema;
  return {
    ...schema,
    properties: { ...schema.properties, sources: SOURCES_PROP },
    required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), 'sources'])],
  };
}

// Grounded ⇔ at least one source AND every url is a real link. A prose label like
// "Deepgram documentation" fails the regex, which is exactly the point.
function isGrounded(result) {
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  if (!sources.length) return false;
  return sources.every(s => typeof s?.url === 'string' && /^https?:\/\/\S+$/i.test(s.url.trim()));
}

module.exports = {
  isReady: () => true,
  // Exported for the contract tests (test/hermes-nested-guard.test.cjs, test/hermes-sources.test.cjs).
  nestedRefusal,
  withSources,
  isGrounded,

  tools: {
    hermes_run_task: {
      description:
        'Hermes (Phase 1) — общий stateless-воркер для сложной исследовательской подзадачи. ' +
        'Дай ограниченную задачу + контекст + JSON Schema желаемого ответа — вернётся структурный JSON. ' +
        'Работает ТОЛЬКО с текстом, который уже дан в context — в интернет не ходит; если задаче нужно ' +
        'самой сходить в сеть, это hermes_web_research. ' +
        'НЕ для «пообщайся с пользователем и сам реши, чем заниматься» — только для одной конкретной ' +
        'задачи с известным форматом ответа. Для типовых задач (оценка кандидата, отчёт по кандидату) ' +
        'используй специализированные тулы, например candidate_report_json.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Формулировка задачи для Hermes.' },
          context: { type: 'string', description: 'Весь нужный контекст текстом (резюме, вакансия, транскрипт и т.п.).' },
          output_schema: { type: 'object', description: 'JSON Schema ожидаемого ответа.' },
          model: { type: 'string', description: 'Опц.: модель OpenRouter-фолбэка. Дефолт google/gemini-2.5-flash.' },
        },
        required: ['task', 'output_schema'],
      },
      handler: async ({ task, context, output_schema, model }) => {
        const result = await hermesRun({ username: USER_ID, task, context, outputSchema: output_schema, model });
        return { result };
      },
    },

    candidate_report_json: {
      description:
        'Hermes (Phase 1), пилот: собрать единый CandidateReport из резюме кандидата, текста вакансии и ' +
        '(опционально) разбора интервью. Возвращает структурный JSON (summary/strengths/concerns/fit_score/' +
        'verdict) — не верстает HTML, только содержание. Это JSON-версия; для HTML-отчёта клиенту используй candidate_report_html, для markdown — candidate_report_markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_text: { type: 'string', description: 'Резюме/профиль кандидата текстом.' },
          vacancy_text: { type: 'string', description: 'Текст вакансии / критерии.' },
          interview_summary: { type: 'string', description: 'Опц.: разбор интервью (например, из interview_analyze).' },
          model: { type: 'string', description: 'Опц.: модель OpenRouter-фолбэка. Дефолт google/gemini-2.5-flash.' },
        },
        required: ['candidate_text', 'vacancy_text'],
      },
      handler: async ({ candidate_text, vacancy_text, interview_summary, model }) => {
        if (!candidate_text?.trim()) throw new Error('candidate_text пустой');
        if (!vacancy_text?.trim()) throw new Error('vacancy_text пустой');

        const context =
          `=== ВАКАНСИЯ ===\n${vacancy_text}\n\n` +
          `=== РЕЗЮМЕ КАНДИДАТА ===\n${candidate_text}` +
          (interview_summary?.trim() ? `\n\n=== РАЗБОР ИНТЕРВЬЮ ===\n${interview_summary}` : '');

        const report = await hermesRun({
          username: USER_ID,
          task: 'Изучи вакансию, резюме кандидата и (если есть) разбор интервью. Составь CandidateReport: ' +
            'насколько кандидат подходит, ключевые сильные стороны, риски/красные флаги, оценку 0-100 и вердикт.',
          context,
          outputSchema: CANDIDATE_REPORT_SCHEMA,
          model,
        });
        return { report };
      },
    },

    hermes_web_research: {
      description:
        'Hermes (Phase 1.5) — исследование в интернете: отдельная headless-сессия с веб-поиском, ' +
        'загрузкой страниц, Playwright-браузером и внутренними MCP-скилами. Используй, когда задаче ' +
        'нужно САМОЙ сходить в сеть (найти, открыть, свести несколько источников) — не просто обработать ' +
        'текст, который уже дан в context (для этого hermes_run_task). Медленнее и дороже hermes_run_task (реальная CLI-сессия, не один ' +
        'LLM-вызов) — не гоняй на задачах без реальной потребности в интернете. ДОЛГИЙ: обычно 1–10 минут, ' +
        'просто дождись ответа, не перезапускай и не дублируй вызов. Результат сохраняется в research/ ' +
        '(поле saved_to) и отдельным сообщением уходит юзеру в Telegram (delivered) — не пересылай его ' +
        'целиком повторно, дай выводы. Проверяй поле grounded: true = в ответе есть sources с настоящими ' +
        'http(s)-URL; false = источников нет (поиск не сработал или ответ из памяти) — тогда НЕ опирайся ' +
        'на эти цифры как на факты и скажи юзеру, что проверить не удалось.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Формулировка исследовательской задачи для Hermes.' },
          context: { type: 'string', description: 'Известный контекст текстом (что уже есть, что не нужно искать заново).' },
          output_schema: { type: 'object', description: 'JSON Schema ожидаемого ответа.' },
        },
        required: ['task', 'output_schema'],
      },
      handler: async ({ task, context, output_schema }) => {
        const refusal = nestedRefusal();
        if (refusal) throw new Error(refusal);
        const result = await withKeepalive(() =>
          hermesRunWithTools({
            username: USER_ID, task, context,
            outputSchema: withSources(output_schema),
            engine: process.env.HERMES_RESEARCH_ENGINE || 'opencode', ocProfile: 'research',
          }));
        // Never fail a run that did produce something — a non-grounded answer is still
        // worth reading, it just must not be mistaken for a verified one.
        const grounded = isGrounded(result);
        if (!grounded) console.warn(`[hermes_web_research] not grounded: ${String(task).slice(0, 100)}`);
        const delivery = await persistAndDeliver({ task, result });
        return { result, grounded, ...delivery };
      },
    },
  },
};
