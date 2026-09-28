'use strict';
// Uses a cheap LLM (DeepSeek via OpenRouter) to decide the most common
// next action a naive user would take given the current conversation state.
//
// Fail-soft by design — but never SILENTLY fail-soft: every step that could not be
// decided by the LLM logs why (ladder rung, HTTP status, raw answer, parse error)
// and falls back to a deterministic, non-repeating action instead of feeding the
// agent the same phrase 12 times in a row (2026-09-28 incident).

// Varied first steps — cycle through them across runs to get different starting paths.
const FIRST_STEP_MESSAGES = [
  'привет',
  'ты работаешь?',
  'что умеешь?',
  'помоги мне',
  'привет! кто ты?',
];

// Deterministic fallback pool used when the LLM cannot decide (no ladder answer).
// Indexed by a rotating counter — no randomness, but also no 12 identical steps.
const FALLBACK_MESSAGES = [
  'расскажи подробнее',
  'а что ещё умеешь?',
  'ок, а как это работает?',
  'интересно, продолжай',
  'а есть примеры?',
];

let _firstStepIdx = 0;
let _fallbackIdx = 0;

async function decideFirstAction(alternativeMode = false) {
  // Happy path always starts with "привет"; alternative cycles through other greetings.
  if (!alternativeMode) return { type: 'text', content: FIRST_STEP_MESSAGES[0] };
  const msg = FIRST_STEP_MESSAGES[(_firstStepIdx++ % (FIRST_STEP_MESSAGES.length - 1)) + 1];
  return { type: 'text', content: msg };
}

// A decider answer is only usable if it is a well-formed action — a parsed JSON of the
// wrong shape ("ok": true, prose, a list) is as useless as no answer at all.
function _isAction(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.type === 'text') return typeof v.content === 'string' && v.content.trim().length > 0;
  if (v.type === 'button') {
    return typeof v.callbackData === 'string' && v.callbackData.length > 0
      && typeof v.buttonText === 'string' && v.buttonText.length > 0;
  }
  return false;
}

// One compact line describing why the LLM answer was rejected.
function _diagDetail(d) {
  if (!d) return 'no diagnostics';
  const parts = [d.reason || 'unknown'];
  if (d.status) parts.push(`HTTP ${d.status}`);
  if (d.model) parts.push(`rung=${d.model}`);
  if (d.finishReason) parts.push(`finish=${d.finishReason}`);
  if (d.message) parts.push(String(d.message).slice(0, 160));
  if (d.error) parts.push(`err=${String(d.error).slice(0, 160)}`);
  if (d.attempts) parts.push(`attempts=${String(d.attempts).slice(0, 200)}`);
  if (d.raw !== undefined) parts.push(`raw=${JSON.stringify(String(d.raw).slice(0, 200))}`);
  return parts.join(' | ');
}

// Deterministic diversity when the LLM is unavailable: rotate through the phrase pool
// (skipping phrases already sent in this path) and, every third fallback, press the
// first not-yet-pressed button instead of typing — a button step keeps the test from
// degenerating into a text-only loop.
function fallbackAction({ buttons = [], previousActions = [] }) {
  const idx = _fallbackIdx++;
  const pressed = new Set(previousActions.filter(a => a.type === 'button').map(a => a.buttonText));
  const unusedButton = (buttons || []).find(b => b?.text && !pressed.has(b.text));
  if (unusedButton && idx % 3 === 2) {
    return { type: 'button', callbackData: unusedButton.callback_data, buttonText: unusedButton.text };
  }
  const usedTexts = new Set(previousActions.filter(a => a.type === 'text').map(a => a.content));
  for (let i = 0; i < FALLBACK_MESSAGES.length; i++) {
    const msg = FALLBACK_MESSAGES[(idx + i) % FALLBACK_MESSAGES.length];
    if (!usedTexts.has(msg)) return { type: 'text', content: msg };
  }
  return { type: 'text', content: FALLBACK_MESSAGES[idx % FALLBACK_MESSAGES.length] };
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
  // maxTokens must leave room for reasoning: a reasoning rung that spends its whole
  // budget on thinking returns content="" with finish=length, which reads as "no answer".
  const ladder = require('../service-llm');
  let lastDiag = null;
  const attempt = async (n, total) => {
    let r;
    try {
      r = await ladder.serviceChat({
        messages: [{ role: 'user', content: prompt }],
        json: true, maxTokens: 300, temperature: 0.4, timeoutMs: 20_000,
        apiKey: openrouterKey, source: 'mainstream-decider',
        onDiagnose: (d) => { lastDiag = d; },
      });
    } catch (e) {
      lastDiag = { reason: 'throw', error: e.message };
      console.warn(`[mainstream-decider] step ${stepNumber} attempt ${n}/${total}: threw: ${e.message}`);
      return null;
    }
    if (r && _isAction(r.value)) return r.value;
    const why = r ? `invalid action shape: ${JSON.stringify(r.value)?.slice(0, 200)}` : _diagDetail(lastDiag);
    console.warn(`[mainstream-decider] step ${stepNumber} attempt ${n}/${total}: rejected — ${why} | ladder=${ladder.available() ? 'token ok' : 'NO TOKEN'}`);
    return null;
  };

  // One retry before falling back: a ladder timeout / transient HTTP miss is worth a
  // second try — a timeout used to kill the whole step (bugs.jsonl decider_error).
  // no_token is deterministic (nothing will change in 100 ms) → no retry.
  let action = await attempt(1, 2);
  if (!action && lastDiag?.reason !== 'no_token') {
    console.warn(`[mainstream-decider] step ${stepNumber}: retrying once after "${lastDiag?.reason || 'null'}"`);
    action = await attempt(2, 2);
  }
  if (action) return action;

  const fb = fallbackAction({ buttons, previousActions });
  console.warn(`[mainstream-decider] step ${stepNumber}: LLM unavailable → deterministic fallback ${JSON.stringify(fb)}`);
  return fb;
}

module.exports = { decideFirstAction, decideNextAction, fallbackAction, FALLBACK_MESSAGES };
