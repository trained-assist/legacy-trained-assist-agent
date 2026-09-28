'use strict';

// content_rewrite — платформенный контент-примитив (дизайн:
// https://instant-publish.trainedassist.store/p/content-rewrite-step-design).
// Живёт рядом с hermes_run, но заточен под КОНТРАКТ ПОЛЕЙ: диапазоны длины,
// жанровые роли, машинная валидация и честный ретрай, а не «свободная проза».
//
// Отличия от hermes_run, которые важны:
//  1) НЕ уходит в GigaChat при наличии ключа — модель выбирает вызывающий,
//     вызов идёт напрямую в OpenRouter (иначе дефолт Gemini молча подменялся бы
//     на GigaChat — известный баг hermes_run).
//  2) Сильная (дорогая) модель по умолчанию, но вход/выход маленькие → дёшево.
//  3) Ретрай уходит на дешёвую модель, хорошо пишущую по-русски (deepseek-flash
//     на OpenRouter — тот же класс, что «go»-ладдер).
//  4) style_guard (анти-slop) включён по умолчанию и ЯВНО параметризован —
//     никаких скрытых режимов: пользователь видит флаг во входе и в выходе.

const { llmCall, parseLlmJson, readOrKey } = require('./llm-client');

const DEFAULT_MODEL = 'google/gemini-2.5-pro';
const DEFAULT_RETRY_MODEL = 'deepseek/deepseek-v4-flash-0731';
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TEMPERATURE = 0.7;

// Жанровые роли поля — дают модели правила жанра, а не только «напиши текст».
const ROLE_RULES = {
  title: 'заголовок: без точки в конце, коротко и конкретно, без кликбейта',
  subtitle: 'подзаголовок: раскрывает заголовок, одна мысль',
  body: 'основной текст: связные предложения, деловой тон',
  bullet: 'пункт списка: одна мысль, без точки в конце при короткой длине',
  cta: 'призыв к действию: императив, конкретное действие («Оставьте заявку»)',
  caption: 'подпись: поясняет объект рядом, без воды',
  meta: 'мета-текст (SEO/описание): информативно, без рекламных клише',
};

const ROLES = Object.keys(ROLE_RULES);

// ─── Анти-slop (LLM-стиль) ────────────────────────────────────────────────────
// Эвристика, честно отдаётся в ответ как style_warnings — НЕ вырезается молча.
// Паттерны: узнаваемые штампы AI-текста RU+EN.

const SLOP_PATTERNS = [
  { id: 'world_where', re: /в мире,?\s+где|\bв современном мире\b/i },
  { id: 'not_just', re: /(?:это\s+)?не просто\s+[^,.!?—-]{1,60}[,—-]?\s*(?:а|это)\b/i },
  { id: 'it_is_not_just', re: /it'?s not just\b/i },
  { id: 'delve', re: /\bдавайте\s+(?:погрузимся|разберёмся|заглянем)\b|\bdelve into\b/i },
  { id: 'key_role', re: /играет\s+(?:ключевую|важную)\s+роль|plays?\s+a\s+(?:key|vital)\s+role/i },
  { id: 'seamless', re: /\b(?:бесшовн\w+|неотъемлем\w+)\b|\bseamless(?:ly)?\b/i },
  { id: 'game_changer', re: /меняет правила игры|game[- ]?changer/i },
  { id: 'in_todays_world', re: /in today'?s (?:fast[- ]paced )?world/i },
  { id: 'unlock_potential', re: /раскры(?:ть|вает)\s+потенциал|unlock(?:ing)? the (?:full )?potential/i },
  { id: 'worth_noting', re: /стоит отметить|важно отметить|it'?s worth noting/i },
];

// Цепочка из двух и более тире в одном предложении — частый признак LLM-ритма.
function emDashRun(text) {
  const sentence = text.split(/[.!?…]/).find((s) => (s.match(/—/g) || []).length >= 2);
  return !!sentence;
}

function detectSlop(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const hits = [];
  for (const p of SLOP_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ marker: p.id, match: m[0] });
  }
  if (emDashRun(text)) hits.push({ marker: 'em_dash_run', match: '—' });
  return hits;
}

// ─── Контракт полей ───────────────────────────────────────────────────────────

function countChars(text) {
  if (typeof text !== 'string') return 0;
  return [...text].length; // code points, чтобы эмодзи считались за 1
}

function normalizeFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('contentRewrite: fields обязателен и непуст');
  }
  const seen = new Set();
  return fields.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`contentRewrite: fields[${i}] не объект`);
    if (!f.key || typeof f.key !== 'string') throw new Error(`contentRewrite: fields[${i}].key обязателен`);
    if (seen.has(f.key)) throw new Error(`contentRewrite: дубликат key «${f.key}»`);
    seen.add(f.key);
    if (f.role && !ROLES.includes(f.role)) throw new Error(`contentRewrite: неизвестная role «${f.role}»`);
    if (f.min_chars != null && f.max_chars != null && f.min_chars > f.max_chars) {
      throw new Error(`contentRewrite: fields[${i}] min_chars > max_chars`);
    }
    return { ...f };
  });
}

// Output-схема собирается из fields — модель сразу видит контракт.
function buildOutputSchema(fields) {
  const properties = {};
  for (const f of fields) {
    const bits = [f.role && ROLE_RULES[f.role] ? ROLE_RULES[f.role] : 'текст'];
    if (f.max_chars != null) bits.push(`до ${f.max_chars} символов`);
    if (f.min_chars != null) bits.push(`не короче ${f.min_chars} символов`);
    properties[f.key] = { type: 'string', description: bits.join(', ') };
  }
  return {
    type: 'object',
    properties,
    required: fields.map((f) => f.key),
    additionalProperties: false,
  };
}

function validateFields(fields, out) {
  const violations = [];
  const keys = new Set(fields.map((f) => f.key));
  for (const f of fields) {
    const v = out ? out[f.key] : undefined;
    if (typeof v !== 'string' || !v.trim()) {
      violations.push({ key: f.key, kind: 'missing', message: 'поле отсутствует или пустое' });
      continue;
    }
    const chars = countChars(v);
    if (f.min_chars != null && chars < f.min_chars) {
      violations.push({ key: f.key, kind: 'too_short', chars, min_chars: f.min_chars });
    }
    if (f.max_chars != null && chars > f.max_chars) {
      violations.push({ key: f.key, kind: 'too_long', chars, max_chars: f.max_chars });
    }
  }
  for (const k of Object.keys(out || {})) {
    if (!keys.has(k)) violations.push({ key: k, kind: 'extra', message: 'лишний ключ вне контракта' });
  }
  return violations;
}

// ─── Промпты ──────────────────────────────────────────────────────────────────

function buildSystemPrompt({ language, tone, styleGuard }) {
  const langName = language === 'ru' ? 'русском' : language === 'en' ? 'английском' : String(language);
  const parts = [
    'Ты — редактор сильного контента внутри trained-assist.',
    `Пиши на ${langName} языке.`,
    tone ? `Тон: ${tone}.` : 'Тон: деловой, живой, без канцелярита.',
    'Верни ТОЛЬКО валидный JSON по схеме — без markdown-обёртки и пояснений.',
  ];
  if (styleGuard) {
    parts.push(
      'СТИЛЬ (анти-slop): пиши как человек, а не как LLM. Запрещено:',
      '«в мире, где…», «в современном мире», «это не просто X, это Y», «играет ключевую роль»,',
      '«бесшовный», «неотъемлемый», «меняет правила игры», «раскрыть потенциал», «стоит отметить»,',
      '«давайте погрузимся», цепочки из двух и более тире в одном предложении, пустые усилители.',
      'Конкретика вместо клише; если факта нет — не выдумывай.',
    );
  }
  return parts.join(' ');
}

function describeConstraint(f) {
  const bits = [];
  if (f.min_chars != null) bits.push(`мин ${f.min_chars}`);
  if (f.max_chars != null) bits.push(`макс ${f.max_chars}`);
  return bits.length ? ` [${f.role || 'text'}, ${bits.join(', ')} симв.]` : ` [${f.role || 'text'}]`;
}

function buildUserPrompt({ audience, description, fields }, priorViolations) {
  const lines = [];
  if (audience) lines.push(`Аудитория: ${audience}`);
  if (description) lines.push(`Описание/бриф: ${description}`);
  lines.push('', 'Поля:');
  for (const f of fields) {
    lines.push(`- «${f.key}»${describeConstraint(f)}: черновик: ${f.draft != null ? `«${f.draft}»` : '(нет)'}`);
  }
  if (priorViolations && priorViolations.length) {
    lines.push('', 'Предыдущая попытка нарушила контракт — исправь:');
    for (const v of priorViolations) {
      if (v.kind === 'too_long') lines.push(`- ${v.key} = ${v.chars}, максимум ${v.max_chars} — сократи`);
      else if (v.kind === 'too_short') lines.push(`- ${v.key} = ${v.chars}, минимум ${v.min_chars} — дополни`);
      else if (v.kind === 'missing') lines.push(`- ${v.key} отсутствует — добавь`);
      else if (v.kind === 'extra') lines.push(`- лишний ключ ${v.key} — убери`);
      else if (v.kind === 'style') lines.push(`- ${v.key}: убери штамп «${v.match}» (${v.marker})`);
      else if (v.kind === 'error') lines.push(`- предыдущий вызов упал: ${v.message}`);
    }
  }
  return lines.join('\n');
}

function buildMessages(opts, outputSchema, priorViolations) {
  return [
    { role: 'system', content: buildSystemPrompt(opts) },
    {
      role: 'user',
      content:
        `${buildUserPrompt(opts, priorViolations)}\n\n` +
        `Схема ответа (JSON Schema):\n${JSON.stringify(outputSchema, null, 2)}`,
    },
  ];
}

function maxTokensFor(fields) {
  const total = fields.reduce((s, f) => s + (f.max_chars || 120), 0);
  return Math.min(4000, Math.max(500, total * 3 + 300));
}

// ─── Основной вход ────────────────────────────────────────────────────────────

/**
 * contentRewrite — единственная точка входа. deps (llmCall, readOrKey, apiKey)
 * инжектируются для офлайн-тестов; в проде берутся платформенные.
 */
async function contentRewrite(params = {}, deps = {}) {
  const {
    username,
    language = 'ru',
    audience = '',
    description = '',
    tone = '',
    fields,
    style_guard = true,
    model = DEFAULT_MODEL,
    retry_model = DEFAULT_RETRY_MODEL,
    max_attempts = DEFAULT_MAX_ATTEMPTS,
    temperature = DEFAULT_TEMPERATURE,
    schema,
  } = params;

  const normFields = normalizeFields(fields);
  const outputSchema = schema || buildOutputSchema(normFields);
  const styleGuard = !!style_guard;
  const attemptsLimit = Math.max(1, Number(max_attempts) || DEFAULT_MAX_ATTEMPTS);

  const callLlm = deps.llmCall || llmCall;
  let apiKey = deps.apiKey;
  if (!apiKey) {
    const read = deps.readOrKey || readOrKey;
    apiKey = read(username);
  }
  if (!apiKey) throw new Error('contentRewrite: нет OpenRouter ключа для этого пользователя');

  const opts = { language, tone, styleGuard, audience, description, fields: normFields };
  const maxTokens = maxTokensFor(normFields);

  let attempts = 0;
  let parsed = null;
  let violations = [];
  let styleWarnings = [];
  let prior = null;
  const models = [];
  let lastError = null;

  while (attempts < attemptsLimit) {
    attempts += 1;
    const useModel = attempts === 1 ? model : retry_model;
    models.push(useModel);
    try {
      const raw = await callLlm(apiKey, useModel, buildMessages(opts, outputSchema, prior), maxTokens, temperature);
      parsed = parseLlmJson(raw);
      lastError = null;
    } catch (e) {
      lastError = e;
      parsed = null;
    }

    violations = validateFields(normFields, parsed);
    styleWarnings = styleGuard && parsed ? collectStyleWarnings(normFields, parsed) : [];
    const feedable = violations.concat(styleWarnings);

    if (!lastError && feedable.length === 0) break; // контракт соблюдён
    prior = lastError
      ? [{ key: '(all)', kind: 'error', message: String(lastError.message || lastError) }]
      : feedable;
  }

  if (lastError && !parsed) {
    return {
      fields: normFields.map((f) => ({ key: f.key, text: null, chars: 0 })),
      violations: [{ key: '(all)', kind: 'error', message: String(lastError.message || lastError) }],
      style_warnings: [],
      attempts,
      models,
      style_guard: styleGuard,
      ok: false,
    };
  }

  return {
    fields: normFields.map((f) => {
      const text = parsed && typeof parsed[f.key] === 'string' ? parsed[f.key] : null;
      return { key: f.key, text, chars: countChars(text || '') };
    }),
    violations,
    style_warnings: styleWarnings,
    attempts,
    models,
    style_guard: styleGuard,
    ok: violations.length === 0,
  };
}

function collectStyleWarnings(fields, out) {
  const warnings = [];
  for (const f of fields) {
    const hits = detectSlop(out[f.key]);
    for (const h of hits) warnings.push({ key: f.key, kind: 'style', ...h });
  }
  return warnings;
}

module.exports = {
  contentRewrite,
  buildOutputSchema,
  validateFields,
  detectSlop,
  countChars,
  normalizeFields,
  DEFAULT_MODEL,
  DEFAULT_RETRY_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  ROLES,
};
