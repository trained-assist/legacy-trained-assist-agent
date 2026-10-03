'use strict';

// Перехват «иероглифов» в финальном ответе агента.
//
// Симптом (владелец, 2026-10-01): движок иногда подмешивает в русский текст
// иероглифы/полноширинные символы — «серый状态» вместо «серый статус». Для
// пользователя это выглядит как поломка бота. Редко (1 ответ примерно на
// сотни), но репутационно — правим.
//
// Второй симптом того же класса (владелец, 2026-10-01, позже в тот же день):
// «резерв��цией» вместо «резервацией». Это НЕ иероглиф, а U+FFFD REPLACEMENT
// CHARACTER — «значок вопроса в ромбике», которым декодер помечает байты,
// которые не собрались в корректный UTF-8 (обычно движок режет поток по
// границе многобайтового символа). Старый GLYPH_RE его не ловил: полноширинные
// формы кончаются на U+FFEF, а U+FFFD живёт выше — «резерв��цией» давал
// countGlyphs=0 и уходил пользователю как есть. Ловим отдельным счётчиком.
//
// Что делает модуль:
//   1) ДЕТЕКТ — чистые функции countGlyphs/countReplacements/needsRewrite
//      (без I/O, без сети): ловим CJK-иероглифы, хирагану/кана,
//      CJK- punctuation, полноширинные формы и знаки замены U+FFFD. Эмодзи
//      (surrogate-пары > U+1F000) и кириллица не трогаются. Кодовые блоки и
//      `` `скобки` `` из подсчёта вырезаны: там посторонний символ — законная
//      иллюстрация (см. stripCodeSpans), иначе любой разбор про кодировки
//      заставлял бы переписывать сам себя.
//   2) REWRITE — один headless-вызов движка по СТАНДАРТНОЙ ЛЕСТНИЦЕ:
//      `ladder/<лестница>:general` от src/opencode-ladder-provider.js — тот же
//      путь, что у hermes_research, токен подставляет runEngineProcess. Вся
//      деградация по ступеням — на worker'е (llm-ladder), поэтому здесь один
//      адрес и одна попытка: повтор того же адреса повторил бы тот же вызов.
//      Новых провайдеров и новых ключей не заводим.
//   3) FALLBACK — что угодно пошло не так (движок упал, пустой ответ, в
//      ответе остались иероглифы, текст подозрительно короткий) → возвращаем
//      ИСХОДНЫЙ текст без изменений. Молчаливого обрезания/порчи ответа
//      быть не может: хуже «иероглифы в тексте», чем «пропал ответ».
//
// Побочные эффекты намеренно нулевые: не трогает model-health и счётчики
// вызовов лестницы, не пишет в сессию/pending-tasks, не шлёт в Telegram
// ничего (тот же no-op tgEdit/tgSend, что в hermes). Выключается аварийно:
// ANSWER_GLYPH_GUARD=off.

const ocLadder = require('./opencode-ladder-provider');
const profiles = require('./profiles');
const { buildEngineCommand, runEngineProcess } = require('./runner/claude-runner');
const { loadUserTokens } = require('./user-tokens');

// Порог срабатывания. 1 символ — слишком шумно (цитата иероглифа в тексте
// проходит как 2 символа), 2 символа — это уже то, что реально прилетало от
// движков («状态», «情報»). Эмодзи лежат вне этих диапазонов.
const MIN_GLYPHS = 2;

// Ширины: CJK-радикалы и штрихи, CJK-символы и пунктуация, кана, хангыль
// (совместимые jamo), иероглифы (CJK unified + ext-A + compat + fullwidth),
// CJK-совместимые формы, полуширинные катаканы, полноширинные ASCII-формы.
// Эмодзи (U+1F300–U+1FAFF) намеренно НЕ входят — они легитимны.
const GLYPH_RE = /[\u1100-\u11FF\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;

// Знак замены U+FFFD: байты не сложились в корректный UTF-8 → «резерв��ением».
// Отдельный счётчик, потому что правило другое: иероглиф в русском тексте
// может быть цитатой (порог 2), а U+FFFD вне кодового блока в нормальном
// тексте — всегда мусор декодирования, даже в единственном экземпляре.
// Поэтому порог здесь 1, а не 2. U+FFFE/U+FFFF — тоже noncharacters, но из
// декодера они не приходят, поэтому в правило не входят.
const REPLACEMENT_RE = /�/g;
const MIN_REPLACEMENTS = 1;

// Кодовые блоки и `скобки` вырезаются перед подсчётом: посторонний символ
// там — законная иллюстрация (разбор про «значок вопроса в ромбике», японская
// строка в примере). Fenced-блок требует пары; незакрытый бэктик под шаблон
// не подходит и остаётся в тексте — считаем (fail-open в сторону детекта,
// а не в сторону тихого пропуска).
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// Ответ агента в Telegram обрезается до 3500 символов (MAX_MSG_LEN в
// runner/index.js), так что 8000 — заведомый потолок; выше него лучше
// оставить текст как есть, чем рискнуть переписать простыню вслепую.
const MAX_INPUT_CHARS = 8000;

// Анти-потеря: результат короче 40% исходника = движок что-то отрезал, а не
// починил. Такой ответ отбраковываем.
const MIN_OUTPUT_RATIO = 0.4;


function stripCodeSpans(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(CODE_SPAN_RE, ' ');
}

function countGlyphs(text) {
  if (!text || typeof text !== 'string') return 0;
  const hits = stripCodeSpans(text).match(GLYPH_RE);
  return hits ? hits.length : 0;
}

function countReplacements(text) {
  if (!text || typeof text !== 'string') return 0;
  const hits = stripCodeSpans(text).match(REPLACEMENT_RE);
  return hits ? hits.length : 0;
}

function needsRewrite(text) {
  return countGlyphs(text) >= MIN_GLYPHS || countReplacements(text) >= MIN_REPLACEMENTS;
}

function disabled() {
  return String(process.env.ANSWER_GLYPH_GUARD || '').toLowerCase() === 'off';
}

// Профиля дефолта нет: profiles.getOcProfile сам отдаёт 'service' (дефолт
// владельца 2026-09-27), а ocLadder.ladderFor на неизвестное имя тоже ведёт в
// 'service' — левый путь не должен давать «лестницу не найдена».
const DEFAULT_ROLE = 'general';

// Модель и вся дальнейшая деградация по ступеням — на стороне worker'а
// (llm-ladder): локального списка моделей в репо больше нет
// (src/opencode-ladder-provider.js, #1687). Поэтому здесь ровно ОДИН адрес
// вида `ladder/<лестница>:general` — «стандартная лестница» целиком, со всей
// её внутренней деградацией, ротацией ключей и платным хвостом. Свою вторую
// ступень не изобретаем: повтор того же адреса просто повторил бы тот же
// вызов (и ту же ошибку).
function resolveRung(profileName, role = DEFAULT_ROLE) {
  return ocLadder.modelFor(profileName || 'service', role);
}

function buildPrompt(text) {
  return [
    'Ты — фильтр вывода агента. В текст ответа попали посторонние символы:',
    'а) иероглифы (китайские/японские/корейские), б) знаки замены U+FFFD —',
    '«значок вопроса в ромбике», которым помечены байты, не собравшиеся в корректный',
    'UTF-8 (��). Для пользователя это выглядит как поломка.',
    '',
    'Перепиши текст на ТОМ ЖЕ языке, сохранив: смысл, структуру и форматирование (markdown,',
    'списки, таблицы, эмодзи), все факты, цифры, имена, ссылки и форматирование кода.',
    'Иероглифы замени по смыслу контекста или убери.',
    'Знак замены U+FFFD — это НЕ буква, а испорченный символ: буквы, которые он закрывал,',
    'уже нет. Восстанови САМО СЛОВО целиком по контексту и русскому языку',
    '(например «резерв��ением» → «резервацией», а не «резервением» и не «резервением» с',
    'прочерком). Не заменяй его на заглушку, не оставляй ни одного U+FFFD в тексте.',
    'Сами кодовые блоки и примеры в `обратных кавычках` оставь как есть, если они там.',
    '',
    'Верни ТОЛЬКО итоговый текст ответа: без пояснений, без комментариев, без обрамляющих',
    'кавычек и без ```-блоков вокруг всего текста.',
    '',
    'ТЕКСТ:',
    text,
  ].join('\n');
}

// Модель иногда оборачивает ответ в fenced-блок — это мусор в Telegram, снимаем.
function unwrapFence(s) {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1] : s;
}

// Один headless-вызов движка. Отдельная функция (и через opts) — чтобы тест
// подменял запуск, а не подменял fs/spawn.
async function defaultEngineRun({ prompt, model, user }) {
  const [engineBin, engineArgs] = buildEngineCommand({
    engine: 'opencode',
    prompt,
    opencodeModel: model,
    user,
    cwd: user.workDir,
  });
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
  const res = await runEngineProcess({
    engine: 'opencode',
    taskId: `glyph-guard-${Date.now()}`,
    chatId: 'glyph-guard',
    thinkingStart: Date.now(),
    msgId: null, // ничего не редактируем в Telegram — вызов полностью headless
    BOT_TOKEN: '',
    secrets: {},
    user,
    cleanEnv,
    userTokens: loadUserTokens(user.username, user.id),
    sessionFilePath: null,
    restartShutdown: () => false,
    activeTimers: new Map(),
    tgEdit: async () => {},
    tgSend: async () => {},
    outputCallback: null,
    engineBin,
    engineArgs,
    cwd: user.workDir,
    env: cleanEnv,
    timeoutMs: Number(process.env.ANSWER_GLYPH_GUARD_TIMEOUT_MS) || 90_000,
  });
  return res;
}

/**
 * rewriteAnswer — точка входа для раннера.
 * @returns {{text: string, action: 'clean'|'too-long'|'off'|'rewritten'|'failed', glyphs: number, replacements: number, model: string|null, error: string|null}}
 *          action 'rewritten'/'failed' => text всегда непустой (исходник в fallback).
 */
async function rewriteAnswer({
  text,
  user = {},
  profileName = null,
  engineRun = defaultEngineRun,
} = {}) {
  const glyphs = countGlyphs(text);
  const replacements = countReplacements(text);
  const base = { glyphs, replacements };
  const dirty = glyphs >= MIN_GLYPHS || replacements >= MIN_REPLACEMENTS;
  if (!text || !text.trim() || !dirty) return { text: text || '', action: 'clean', model: null, error: null, ...base };
  if (disabled()) return { text, action: 'off', model: null, error: null, ...base };
  if (text.length > MAX_INPUT_CHARS) return { text, action: 'too-long', model: null, error: null, ...base };

  let profile = profileName;
  if (!profile) {
    try { profile = profiles.getOcProfile(user.workDir); } catch (e) { profile = null; }
  }
  const model = resolveRung(profile);
  const prompt = buildPrompt(text);

  try {
    const res = await engineRun({ prompt, model, user });
    const out = unwrapFence(String(res?.claudeResult || res?.lastAssistantMsg || res?.fullOutput?.text || '').trim());
    // Каждый отказ — в исходный текст. Причины видно в логе, пользователю —
    // его же ответ без изменений: хуже «иероглифы в тексте», чем «пропал ответ».
    if (!out) return { text, action: 'failed', model, error: 'empty', ...base };
    if (countGlyphs(out) >= MIN_GLYPHS) return { text, action: 'failed', model, error: 'still-glyphs', ...base };
    // Проверяем оба вида мусора: модель могла вычистить иероглифы, но оставить
    // U+FFFD (или наоборот) — такой ответ пользователю не показываем.
    if (countReplacements(out) >= MIN_REPLACEMENTS) return { text, action: 'failed', model, error: 'still-replacements', ...base };
    if (out.length < Math.floor(text.length * MIN_OUTPUT_RATIO)) return { text, action: 'failed', model, error: 'lost-content', ...base };
    return { text: out, action: 'rewritten', model, error: null, ...base };
  } catch (e) {
    return { text, action: 'failed', model, error: e?.message ? String(e.message).slice(0, 160) : 'engine-error', ...base };
  }
}

module.exports = {
  MIN_GLYPHS,
  MIN_REPLACEMENTS,
  countGlyphs,
  countReplacements,
  stripCodeSpans,
  needsRewrite,
  resolveRung,
  buildPrompt,
  rewriteAnswer,
  defaultEngineRun,
};
