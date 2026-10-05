'use strict';

// Hermes Phase 1 MCP tools — оба Stateless, оба ОДИН сырой LLM-вызов.
// hermes_run_task — общий примитив: task + context + output_schema → JSON.
// candidate_report_json — пилот №3 (самый показательный): сводит
// резюме + вакансию + (опц.) разбор интервью в один CandidateReport JSON,
// который дальше можно скормить существующему HTML-генератору отчётов.
// Никакой памяти/инструментов/cron на этом этапе (Phase 1).
//
// hermes_web_research УДАЛЁН (2026-10-05) вместе с вложенным движком и всем
// src/hermes-tools-run.js. Он был единственным тулом, который спавнил второй
// opencode/claude ради поиска по сети, и он давал ~50% отказов с пустой ошибкой
// (оборванный MCP-вызов, причина съедена мостом). Исследование из интернета
// теперь делает тул web_research (99d-web-research.js) — SERP + markdown страниц
// без единого spawn; синтез выводов делает вызывающий движок.
//
// Из-за удаления spawn-а вся анти-рекурсия (HERMES_DEPTH, nestedRefusal, скрытие
// модуля в registry.js) стала мёртвым кодом и тоже удалена: тул, который ничего
// не запускает, не может воспроизвести себя.

const { hermesRun } = require('../../hermes-run');

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
    hermes_run_task: {
      description:
        'Hermes (Phase 1) — общий stateless-воркер для сложной исследовательской подзадачи. ' +
        'Дай ограниченную задачу + контекст + JSON Schema желаемого ответа — вернётся структурный JSON. ' +
        'Работает ТОЛЬКО с текстом, который уже дан в context — в интернет не ходит; если задаче нужно ' +
        'самой сходить в сеть, это web_research. ' +
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
  },
};
