'use strict';

// Hermes Phase 1 MCP tools (docs/HERMES-INTEGRATION-CHECKLIST.md).
// hermes_run — общий stateless-примитив: task + context + output_schema → JSON.
// hermes_candidate_report — пилот №3 из roadmap (самый показательный): сводит
// резюме + вакансию + (опц.) разбор интервью в один CandidateReport JSON,
// который дальше можно скормить существующему HTML-генератору отчётов.
// Никакой памяти/инструментов/cron на этом этапе — см. Phase 1 в чеклисте.

const { hermesRun } = require('../../hermes-run');
const { hermesRunWithTools } = require('../../hermes-tools-run');
const { persistAndDeliver } = require('../../hermes-delivery');
const { withKeepalive } = require('../../mcp-keepalive');

const USER_ID = process.env.USER_ID || '';

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

module.exports = {
  isReady: () => true,

  tools: {
    hermes_run: {
      description:
        'Hermes (Phase 1) — общий stateless-воркер для сложной исследовательской подзадачи. ' +
        'Дай ограниченную задачу + контекст + JSON Schema желаемого ответа — вернётся структурный JSON. ' +
        'НЕ для «пообщайся с пользователем и сам реши, чем заниматься» — только для одной конкретной ' +
        'задачи с известным форматом ответа. Для типовых задач (оценка кандидата, отчёт по кандидату) ' +
        'используй специализированные тулы, например hermes_candidate_report.',
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

    hermes_candidate_report: {
      description:
        'Hermes (Phase 1), пилот: собрать единый CandidateReport из резюме кандидата, текста вакансии и ' +
        '(опционально) разбора интервью. Возвращает структурный JSON (summary/strengths/concerns/fit_score/' +
        'verdict) — не верстает HTML, только содержание.',
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

    hermes_research: {
      description:
        'Hermes (Phase 1.5) — как hermes_run, но с реальным доступом в интернет: Playwright-браузер, ' +
        'встроенный веб-поиск, внутренние MCP-скилы (ru_browser_fetch, website_request и т.п.). ' +
        'Используй, когда задаче нужно САМОЙ сходить в сеть (найти сайт, открыть страницу, свести ' +
        'несколько источников) — не просто обработать текст, который ты уже дал в context. Медленнее и ' +
        'дороже hermes_run (реальная CLI-сессия, не один LLM-вызов) — не гоняй его на задачах без реальной ' +
        'потребности в интернете. ДОЛГИЙ: обычно 1–10 минут — это нормально, просто дождись ответа, не ' +
        'перезапускай и не дублируй вызов. Результат сам сохраняется в research/ (поле saved_to) и отдельным ' +
        'сообщением уходит юзеру в Telegram (delivered) — не пересылай его целиком повторно, дай выводы.',
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
        const result = await withKeepalive(() =>
          hermesRunWithTools({ username: USER_ID, task, context, outputSchema: output_schema }));
        const delivery = await persistAndDeliver({ task, result });
        return { result, ...delivery };
      },
    },
  },
};
