'use strict';
// Uses a cheap LLM (DeepSeek via OpenRouter) to decide the most common
// next action a naive user would take given the current conversation state.

// Varied first steps — cycle through them across runs to get different starting paths.
const FIRST_STEP_MESSAGES = [
  'привет',
  'ты работаешь?',
  'что умеешь?',
  'помоги мне',
  'привет! кто ты?',
];

let _firstStepIdx = 0;

async function decideFirstAction(alternativeMode = false) {
  // Happy path always starts with "привет"; alternative cycles through other greetings.
  if (!alternativeMode) return { type: 'text', content: FIRST_STEP_MESSAGES[0] };
  const msg = FIRST_STEP_MESSAGES[(_firstStepIdx++ % (FIRST_STEP_MESSAGES.length - 1)) + 1];
  return { type: 'text', content: msg };
}

async function decideNextAction({ conversation, latestText, buttons, stepNumber, alternativeMode, openrouterKey, previousActions = [] }) {
  const buttonsDesc = buttons?.length
    ? buttons.map((b, i) => `${i + 1}. "${b.text}" → callback_data="${b.callback_data}"`).join('\n')
    : 'нет кнопок';

  const conversationText = conversation
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'Пользователь' : 'Агент'}: ${m.text.slice(0, 400)}`)
    .join('\n\n');

  const modeNote = alternativeMode
    ? 'Ты должен выбрать ВТОРОЙ по вероятности вариант (не самый очевидный первый, но тоже распространённый).'
    : 'Выбери САМЫЙ банальный, самый ожидаемый вариант — то, что сделает большинство новых пользователей.';

// Build "don't repeat" hint from already-taken actions.
  const alreadyTaken = previousActions.length
    ? `\nУЖЕ СДЕЛАННЫЕ действия (не повторяй их):\n${previousActions.map(a =>
        a.type === 'text' ? `- написал текст: "${a.content}"` : `- нажал кнопку: "${a.buttonText}"`
      ).join('\n')}\n`
    : '';
  const prompt = `Ты — среднестатистический новый пользователь Telegram-бота (AI-помощник для рекрутинга и задач). Ты не технарь, просто обычный человек, который первый раз пользуется ботом.

ШАГ ${stepNumber}/7 тест-сессии.

История разговора (последние сообщения):
${conversationText}

Агент только что ответил:
${latestText.slice(0, 600)}

Доступные кнопки:
${buttonsDesc}
${alreadyTaken}
${modeNote}

Правила:
- Если есть кнопки — скорее всего нажмёшь на самую понятную/первую (если не нажимал уже)
- Если все кнопки уже нажимал — напиши что-то другое (задай вопрос, попробуй другую тему)
- Не задавай сложных вопросов, не пиши длинные тексты
- Действуй как любопытный, но ленивый пользователь
- НЕ повторяй то, что уже делал

Ответь ТОЛЬКО JSON (без markdown, без пояснений):
Если напишешь текст: {"type":"text","content":"..."}
Если нажмёшь кнопку: {"type":"button","callbackData":"...","buttonText":"..."}`;

  // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
  const r = await require('../service-llm').serviceChat({
    messages: [{ role: 'user', content: prompt }],
    json: true, maxTokens: 120, temperature: 0.4, timeoutMs: 20_000, apiKey: openrouterKey, source: 'mainstream-decider',
  });
  if (r && r.value && typeof r.value === 'object') return r.value;
  // Fallback: send generic follow-up
  return { type: 'text', content: 'расскажи подробнее' };
}

module.exports = { decideFirstAction, decideNextAction };
