'use strict';

// content_rewrite — платформенный контент-примитив (дизайн:
// instant-publish.trainedassist.store/p/content-rewrite-step-design).
// Используется разными доменами (презентация, сайт/лендинг, отчёт, описания
// на выставочном сайте) — поэтому лежит в core, а не в documents-skill.
// Логика — в src/content-rewrite.js (офлайн-тестируемая, минует GigaChat-
// ветку hermes_run и вызывает OpenRouter напрямую с выбранной моделью).

const { contentRewrite } = require('../../content-rewrite');

const USER_ID = process.env.USER_ID || '';

const FIELD_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Уникальный ключ поля в ответе.' },
    role: {
      type: 'string',
      enum: ['title', 'subtitle', 'body', 'bullet', 'cta', 'caption', 'meta'],
      description: 'Жанр поля — задаёт правила модели (заголовок, CTA и т.п.).',
    },
    draft: { type: 'string', description: 'Черновик/сырьё для этого поля (опционально).' },
    min_chars: { type: 'number', description: 'Минимум символов (проверяется машинно).' },
    max_chars: { type: 'number', description: 'Максимум символов (проверяется машинно).' },
  },
  required: ['key'],
};

module.exports = {
  isReady: () => true,

  tools: {
    content_rewrite: {
      description:
        'Контент-примитив: переписать текст по ЖЁСТКОМУ контракту сильной моделью с машинной валидацией ' +
        'и честным ретраем. ДВА режима — ровно один инпут за вызов: ' +
        '(1) fields — поля JSON (роль + min_chars/max_chars по каждому); ' +
        '(2) markdown — один длинный документ целиком (deck.md, отчёт, лендинг), проверяются длина ' +
        'документа и сохранность заголовков (preserve_headings). ' +
        'Возвращает text/поля с фактической длиной, violations (нарушения диапазона/структуры/пропуски/лишние ключи), ' +
        'style_warnings (AI-slop) и attempts. Не обрезает молча: если после ретрая контракт не соблюдён — ' +
        'отдаёт violations как есть. По умолчанию модель google/gemini-2.5-pro, ретрай — дешёвая ' +
        'deepseek/deepseek-v4-flash-0731 (хорошо пишет по-русски). style_guard (анти-slop, «не LLM-стиль») ' +
        'включён по умолчанию — отключи style_guard:false, если нужен сырой вывод.',
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'Язык текста: ru | en | … (по умолчанию ru).' },
          audience: { type: 'string', description: 'Целевая аудитория (для тона и конкретики).' },
          description: { type: 'string', description: 'Краткий бриф: что за продукт/контекст.' },
          tone: { type: 'string', description: 'Тон (по умолчанию «деловой, живой, без канцелярита»).' },
          fields: {
            type: 'array',
            items: FIELD_SCHEMA,
            description:
              'Режим полей. Поля контракта: key уникальны; min_chars/max_chars проверяются машинно. ' +
              'Ровно одно из fields|markdown.',
          },
          markdown: {
            type: 'string',
            description:
              'Режим документа: весь текст целиком (markdown). Заголовки сохраняются дословно ' +
              '(preserve_headings). Ровно одно из fields|markdown.',
          },
          min_chars: {
            type: 'number',
            description: 'Режим документа: минимум символов на весь документ (машинная проверка).',
          },
          max_chars: {
            type: 'number',
            description: 'Режим документа: максимум символов на весь документ (машинная проверка).',
          },
          preserve_headings: {
            type: 'boolean',
            description:
              'Режим документа: сохранять заголовки черновика дословно и в том же порядке. По умолчанию true.',
          },
          style_guard: {
            type: 'boolean',
            description:
              'Анти-slop / «не LLM-стиль»: запрет штампов AI-текста + проверка style_warnings. ' +
              'По умолчанию true. false — отключить для собственных задач.',
          },
          model: { type: 'string', description: 'Основная модель (дефолт google/gemini-2.5-pro).' },
          retry_model: {
            type: 'string',
            description: 'Модель ретрая при нарушениях/ошибке (дефолт deepseek/deepseek-v4-flash-0731).',
          },
          max_attempts: { type: 'number', description: 'Сколько попыток (дефолт 2).' },
          temperature: { type: 'number', description: 'Температура (дефолт 0.7).' },
          schema: { type: 'object', description: 'Опц.: override JSON Schema (только режим полей).' },
        },
      },
      handler: async (args, ctx) => {
        const username = (ctx && ctx.userId) || USER_ID;
        const result = await contentRewrite({ ...args, username });
        return result;
      },
    },
  },
};
