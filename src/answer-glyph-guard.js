'use strict';

// Перехват «иероглифов» в финальном ответе агента.
//
// Симптом (владелец, 2026-10-01): движок иногда подмешивает в русский текст
// иероглифы/полноширинные символы — «серый状态» вместо «серый статус». Для
// пользователя это выглядит как поломка бота. Редко (1 ответ примерно на
// сотни), но репутационно — правим.
//
// Что делает модуль:
//   1) ДЕТЕКТ — чистая функция countGlyphs/needsRewrite (без I/O, без сети):
//      ловим CJK-иероглифы, хирагану/кана, CJK- punctuation, полноширинные
//      формы. Эмодзи ( surrogate-пары > U+1F000) и кириллица не трогаются.
//   2) REWRITE — один headless-вызов движка по СТАНДАРТНОЙ ЛЕСТНИЦЕ
//      (src/opencode-ladder.js + runner/claude-runner.js — тот же путь, что
//      у hermes-tools-run): модель берётся из лестницы роли `general`
//      профиля юзера, при отказе — следующая ступень. Новых провайдеров и
//      новых ключей не заводим.
//   3) FALLBACK — что угодно пошло не так (движок упал, пустой ответ, в
//      ответе остались иероглифы, текст подозрительно короткий) → возвращаем
//      ИСХОДНЫЙ текст без изменений. Молчаливого обрезания/порчи ответа
//      быть не может: хуже «иероглифы в тексте», чем «пропал ответ».
//
// Побочные эффекты намеренно нулевые: не трогает model-health (побочный вызов
// не должен деградировать общую лестницу), не пишет в сессию/pending-tasks,
// не шлёт в Telegram ничего (используется тот же no-op tgEdit/tgSend, что в
// hermes). Выключается аварийно: ANSWER_GLYPH_GUARD=off.

const fs = require('fs');
const path = require('path');

const opencodeLadder = require('./opencode-ladder');
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

// Сколько ступеней лестницы пробуем. Больше двух — уже не «редкий обработчик»,
// а второй раннер задачи по цене одной ступени.
const MAX_RUNGS = 2;

// Ответ агента в Telegram обрезается до 3500 символов (MAX_MSG_LEN в
// runner/index.js), так что 8000 — заведомый потолок; выше него лучше
// оставить текст как есть, чем рискнуть переписать простыню вслепую.
const MAX_INPUT_CHARS = 8000;

// Анти-потеря: результат короче 40% исходника = движок что-то отрезал, а не
// починил. Такой ответ отбраковываем.
const MIN_OUTPUT_RATIO = 0.4;

const DEFAULT_PROFILE = 'value';
const PROFILES_DIR = path.join(__dirname, '..', '.opencode', 'profiles');

function countGlyphs(text) {
  if (!text || typeof text !== 'string') return 0;
  const hits = text.match(GLYPH_RE);
  return hits ? hits.length : 0;
}

function needsRewrite(text) {
  return countGlyphs(text) >= MIN_GLYPHS;
}

function disabled() {
  return String(process.env.ANSWER_GLYPH_GUARD || '').toLowerCase() === 'off';
}

// До двух ступеней лестницы роли `general` для профиля, минуя уже исчерпанные
// модели. resolveModel(skipModels) — тот же резолвер, что и у раннера, но
// skip передаём локально: persist не трогаем, побочный вызов не должен портить
// общее состояние лестницы (model-health).
function resolveRungs(profileName, role = 'general', max = MAX_RUNGS) {
  const rungs = [];
  const skip = [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, `${profileName}.json`), 'utf8'));
  } catch (e) {
    return rungs;
  }
  for (let i = 0; i < max; i++) {
    const model = opencodeLadder.resolveModel(raw, profileName, role, skip);
    if (!model || rungs.includes(model)) break;
    rungs.push(model);
    skip.push(model);
  }
  return rungs;
}

function buildPrompt(text) {
  return [
    'Ты — фильтр вывода агента. В текст ответа попали иероглифы (китайские/японские/корейские)',
    'и прочие посторонние символы — для пользователя это выглядит как поломка.',
    '',
    'Перепиши текст на ТОМ ЖЕ языке, сохранив: смысл, структуру и форматирование (markdown,',
    'списки, таблицы, эмодзи), все факты, цифры, имена, ссылки и форматирование кода.',
    'Иероглифы и посторонние символы замени по смыслу контекста или убери — в тексте их',
    'остаться не должно совсем.',
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
 * @returns {{text: string, action: 'clean'|'too-long'|'off'|'rewritten'|'failed', glyphs: number, model: string|null, error: string|null}}
 *          action 'rewritten'/'failed' => text всегда непустой (исходник в fallback).
 */
async function rewriteAnswer({
  text,
  user = {},
  profileName = null,
  engineRun = defaultEngineRun,
} = {}) {
  const glyphs = countGlyphs(text);
  const base = { glyphs };
  if (!text || !text.trim() || glyphs < MIN_GLYPHS) return { text: text || '', action: 'clean', model: null, error: null, ...base };
  if (disabled()) return { text, action: 'off', model: null, error: null, ...base };
  if (text.length > MAX_INPUT_CHARS) return { text, action: 'too-long', model: null, error: null, ...base };

  let profile = profileName;
  if (!profile) {
    try { profile = profiles.getOcProfile(user.workDir); } catch (e) { profile = null; }
  }
  const rungs = resolveRungs(profile || DEFAULT_PROFILE);
  if (!rungs.length) {
    return { text, action: 'failed', model: null, error: `no-ladder:${profile || DEFAULT_PROFILE}`, ...base };
  }

  const prompt = buildPrompt(text);
  let lastError = 'no-rung-attempted';
  for (const model of rungs) {
    try {
      const res = await engineRun({ prompt, model, user });
      const out = unwrapFence(String(res?.claudeResult || res?.lastAssistantMsg || res?.fullOutput?.text || '').trim());
      if (!out) { lastError = 'empty'; continue; }
      if (countGlyphs(out) >= MIN_GLYPHS) { lastError = 'still-glyphs'; continue; }
      if (out.length < Math.floor(text.length * MIN_OUTPUT_RATIO)) { lastError = 'lost-content'; continue; }
      return { text: out, action: 'rewritten', model, error: null, ...base };
    } catch (e) {
      lastError = e?.message ? String(e.message).slice(0, 160) : 'engine-error';
    }
  }
  // Ни одна ступень не дала приемлемого результата — отдаём исходник целиком.
  return { text, action: 'failed', model: rungs[0], error: lastError, ...base };
}

module.exports = {
  MIN_GLYPHS,
  MAX_RUNGS,
  countGlyphs,
  needsRewrite,
  resolveRungs,
  buildPrompt,
  rewriteAnswer,
  defaultEngineRun,
};