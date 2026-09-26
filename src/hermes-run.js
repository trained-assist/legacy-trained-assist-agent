'use strict';

// Hermes Phase 1 (docs/HERMES-INTEGRATION-CHECKLIST.md) — «тупой worker»:
// один LLM-вызов со structured-output контрактом, без памяти/инструментов/cron.
// Переиспользует GigaChat(primary)+OpenRouter(fallback), уже проверенные в
// hh-scoring.js (теперь платформенный src/llm-client.js) — отдельный провайдер не нужен.

const { llmCall, gcCall, parseLlmJson, readGigachatKey, readOrKey } = require('./llm-client');

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_TEMPERATURE = 0.2;

function buildMessages(task, context, outputSchema) {
  const schemaHint = JSON.stringify(outputSchema, null, 2);
  return [
    {
      role: 'system',
      content:
        'Ты — Hermes, исследовательский воркер внутри trained-assist. ' +
        'Тебе дают ограниченную задачу и схему ответа. Верни ТОЛЬКО валидный JSON ' +
        'по этой схеме — без markdown-обёртки, без пояснений вне JSON.',
    },
    {
      role: 'user',
      content: `Задача:\n${task}\n\nКонтекст:\n${context || '(не задан)'}\n\nСхема ответа (JSON Schema):\n${schemaHint}`,
    },
  ];
}

/**
 * hermesRun — единственная точка входа Phase 1. Всегда возвращает объект,
 * провалидированный только на уровне "это распарсился JSON" (полноценная
 * JSON-Schema валидация — за рамками Phase 1, см. чеклист).
 */
async function hermesRun({ username, task, context = '', outputSchema, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, temperature = DEFAULT_TEMPERATURE }) {
  if (!task || !task.trim()) throw new Error('hermesRun: task обязателен');
  if (!outputSchema) throw new Error('hermesRun: outputSchema обязателен — Hermes всегда возвращает структурированный JSON');

  const gigachatKey = readGigachatKey(username);
  const apiKey = readOrKey(username);
  if (!gigachatKey && !apiKey) {
    throw new Error('hermesRun: нет ни GigaChat, ни OpenRouter ключа для этого пользователя');
  }

  const messages = buildMessages(task, context, outputSchema);

  let raw;
  if (gigachatKey) {
    try {
      raw = await gcCall(gigachatKey, messages, maxTokens, temperature);
    } catch (e) {
      if (!apiKey) throw e;
      raw = await llmCall(apiKey, model, messages, maxTokens, temperature);
    }
  } else {
    raw = await llmCall(apiKey, model, messages, maxTokens, temperature);
  }

  return parseLlmJson(raw);
}

module.exports = { hermesRun, DEFAULT_MODEL, DEFAULT_MAX_TOKENS };
