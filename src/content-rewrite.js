'use strict';

// content_rewrite — платформенный контент-примитив (дизайн:
// https://instant-publish.trainedassist.store/p/content-rewrite-step-design).
// Живёт рядом с hermes_run, но заточен под КОНТРАКТ КОНТЕНТА: машинная
// валидация, честный ретрай и анти-slop, а не «свободная проза».
//
// ДВА РЕЖИМА — ровно один инпут на вызов:
//  - mode=fields   — набор полей: роль + min_chars/max_chars по каждому полю
//    (hero_title, cta, описания `b` на сайте и т.п.).
//  - mode=document — один длинный markdown-документ целиком (deck.md, отчёт,
//    лендинг): проверяется длина всего документа и СОХРАННОСТЬ ЗАГОЛОВКОВ
//    (preserve_headings), плюс тот же style_guard и ретрай.
// Режимы не смешиваются: у них разная форма выхода (fields[] vs text).
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

// ─── Общее ────────────────────────────────────────────────────────────────────

function countChars(text) {
  if (typeof text !== 'string') return 0;
  return [...text].length; // code points, чтобы эмодзи считались за 1
}

// ─── Контракт полей (mode=fields) ─────────────────────────────────────────────

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

// ─── Контракт документа (mode=document) ──────────────────────────────────────

function normalizeDoc(markdown, opts = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new Error('contentRewrite: markdown обязателен и непуст');
  }
  const min = opts.min_chars != null ? Number(opts.min_chars) : null;
  const max = opts.max_chars != null ? Number(opts.max_chars) : null;
  if (min != null && max != null && min > max) {
    throw new Error('contentRewrite: min_chars > max_chars');
  }
  return {
    markdown,
    min_chars: min,
    max_chars: max,
    // Сохранность заголовков — главная машинная гарантия «документ не развалился».
    preserve_headings: opts.preserve_headings !== false,
  };
}

// Заголовки markdown любого уровня — маркер структуры документа (слайды, разделы).
function extractHeadings(md) {
  return String(md)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /^#{1,6}\s+\S/.test(l));
}

// Разница мультимножеств: элементы a, которых не хватает в b, и лишние из b.
function multisetDiff(a, b) {
  const counts = new Map();
  for (const x of b) counts.set(x, (counts.get(x) || 0) + 1);
  const missing = [];
  for (const x of a) {
    const c = counts.get(x) || 0;
    if (c > 0) counts.set(x, c - 1);
    else missing.push(x);
  }
  const extra = [];
  for (const [x, c] of counts) for (let i = 0; i < c; i += 1) extra.push(x);
  return { missing, extra };
}

function validateDocument(doc, out) {
  const violations = [];
  const text = out && typeof out.text === 'string' ? out.text : null;
  if (!text || !text.trim()) {
    violations.push({ key: 'text', kind: 'missing', message: 'документ отсутствует или пуст' });
    return violations;
  }
  const chars = countChars(text);
  if (doc.min_chars != null && chars < doc.min_chars) {
    violations.push({ key: 'text', kind: 'too_short', chars, min_chars: doc.min_chars });
  }
  if (doc.max_chars != null && chars > doc.max_chars) {
    violations.push({ key: 'text', kind: 'too_long', chars, max_chars: doc.max_chars });
  }
  if (doc.preserve_headings) {
    const draftH = extractHeadings(doc.markdown);
    const outH = extractHeadings(text);
    const { missing, extra } = multisetDiff(draftH, outH);
    for (const h of missing) violations.push({ key: 'text', kind: 'missing_heading', heading: h });
    for (const h of extra) violations.push({ key: 'text', kind: 'extra_heading', heading: h });
    const structureOk = missing.length === 0 && extra.length === 0;
    if (structureOk && draftH.some((h, i) => h !== outH[i])) {
      violations.push({ key: 'text', kind: 'heading_order', message: 'заголовки переставлены относительно черновика' });
    }
  }
  for (const k of Object.keys(out)) {
    if (k !== 'text') violations.push({ key: k, kind: 'extra', message: 'лишний ключ вне контракта' });
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

function formatViolation(v) {
  switch (v.kind) {
    case 'too_long':
      return v.key === 'text'
        ? `документ = ${v.chars}, максимум ${v.max_chars} — сократи`
        : `${v.key} = ${v.chars}, максимум ${v.max_chars} — сократи`;
    case 'too_short':
      return v.key === 'text'
        ? `документ = ${v.chars}, минимум ${v.min_chars} — дополни`
        : `${v.key} = ${v.chars}, минимум ${v.min_chars} — дополни`;
    case 'missing':
      return v.key === 'text' ? 'документ пуст — верни переписанный текст' : `${v.key} отсутствует — добавь`;
    case 'extra':
      return `лишний ключ ${v.key} — убери`;
    case 'missing_heading':
      return `заголовок «${v.heading}» потерян — восстанови дословно`;
    case 'extra_heading':
      return `лишний заголовок «${v.heading}» — убери, новых разделов не добавляй`;
    case 'heading_order':
      return 'заголовки переставлены — восстанови порядок как в черновике';
    case 'style':
      return `${v.key}: убери штамп «${v.match}» (${v.marker})`;
    case 'error':
      return `предыдущий вызов упал: ${v.message}`;
    default:
      return JSON.stringify(v);
  }
}

function violationLines(priorViolations) {
  if (!priorViolations || !priorViolations.length) return [];
  const lines = ['', 'Предыдущая попытка нарушила контракт — исправь:'];
  for (const v of priorViolations) lines.push(`- ${formatViolation(v)}`);
  return lines;
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
  lines.push(...violationLines(priorViolations));
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

function buildDocUserPrompt({ audience, description, doc }, priorViolations) {
  const lines = [];
  if (audience) lines.push(`Аудитория: ${audience}`);
  if (description) lines.push(`Описание/бриф: ${description}`);
  const cons = [];
  if (doc.min_chars != null) cons.push(`не короче ${doc.min_chars} символов`);
  if (doc.max_chars != null) cons.push(`не длиннее ${doc.max_chars} символов`);
  if (cons.length) lines.push(`Длина итогового документа: ${cons.join(', ')}.`);
  if (doc.preserve_headings) {
    lines.push('Заголовки (строки «#»…«######») сохрани ДОСЛОВНО и в том же порядке — не добавляй новых и не убирай существующие.');
  }
  lines.push('', 'Перепиши черновик, улучшив текст, но сохранив markdown-структуру (заголовки, списки, блоки, ссылки).', '', 'Черновик (markdown):', '<<<', doc.markdown, '>>>');
  lines.push(...violationLines(priorViolations));
  return lines.join('\n');
}

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Переписанный документ целиком (markdown), без пояснений.' },
  },
  required: ['text'],
  additionalProperties: false,
};

function buildDocMessages(opts, priorViolations) {
  return [
    { role: 'system', content: buildSystemPrompt(opts) },
    {
      role: 'user',
      content:
        `${buildDocUserPrompt(opts, priorViolations)}\n\n` +
        `Схема ответа (JSON Schema):\n${JSON.stringify(DOC_SCHEMA, null, 2)}\n` +
        'Верни JSON {"text": "..."} — весь переписанный документ одной строкой.',
    },
  ];
}

// max_tokens должен покрывать НЕ ТОЛЬКО сам JSON, но и reasoning-бюджет
// thinking-моделей: google/gemini-2.5-pro тратит на «размышление» 0.5–1.5k токенов
// ДО контента, и при узком бюджете content возвращается пустым (parseLlmJson бросает
// «LLM returned empty content» — выглядит как отказ модели, хотя модель ответила).
// Живой смоук 28.09: floor 500/825 → обе попытки пустые; 4000 → ok с первой попытки.
// Нерасходуемая часть бюджета не оплачивается, поэтому запас широкий.
function maxTokensFor(fields) {
  const total = fields.reduce((s, f) => s + (f.max_chars || 120), 0);
  return Math.min(8000, Math.max(4000, total * 4 + 2000));
}

// Документ: выход ≈ вход, поэтому бюджет растёт от длины черновика (кириллица
// ~2–3 символа на токен; берём с запасом 1.5 и reasoning-floor).
function maxTokensForDoc(doc) {
  const chars = Math.max(countChars(doc.markdown), doc.max_chars || 0);
  return Math.min(64000, Math.max(4000, Math.ceil(chars * 1.5) + 3000));
}

function collectStyleWarnings(fields, out) {
  const warnings = [];
  for (const f of fields) {
    const hits = detectSlop(out[f.key]);
    for (const h of hits) warnings.push({ key: f.key, kind: 'style', ...h });
  }
  return warnings;
}

// ─── Основной вход ────────────────────────────────────────────────────────────

/**
 * contentRewrite — единственная точка входа. deps (llmCall, readOrKey, apiKey)
 * инжектируются для офлайн-тестов; в проде берутся платформенные.
 *
 * Режим выбирается инпутом: fields (режим полей) ИЛИ markdown (режим документа).
 * Оба сразу или ни одного — ошибка.
 */
async function contentRewrite(params = {}, deps = {}) {
  const {
    username,
    language = 'ru',
    audience = '',
    description = '',
    tone = '',
    fields,
    markdown,
    style_guard = true,
    model = DEFAULT_MODEL,
    retry_model = DEFAULT_RETRY_MODEL,
    max_attempts = DEFAULT_MAX_ATTEMPTS,
    temperature = DEFAULT_TEMPERATURE,
    schema,
    min_chars,
    max_chars,
    preserve_headings,
  } = params;

  const hasFields = fields != null;
  const hasDoc = markdown != null;
  if (hasFields && hasDoc) {
    throw new Error('contentRewrite: заданы и fields, и markdown — за вызов используй ровно один режим');
  }
  if (!hasFields && !hasDoc) {
    throw new Error('contentRewrite: нужен один из инпутов — fields (режим полей) или markdown (режим документа)');
  }

  const styleGuard = !!style_guard;
  const attemptsLimit = Math.max(1, Number(max_attempts) || DEFAULT_MAX_ATTEMPTS);

  const callLlm = deps.llmCall || llmCall;
  let apiKey = deps.apiKey;
  if (!apiKey) {
    const read = deps.readOrKey || readOrKey;
    apiKey = read(username);
  }
  if (!apiKey) throw new Error('contentRewrite: нет OpenRouter ключа для этого пользователя');

  // strategy инкапсулирует всё, что различает режимы; цикл валидации общий.
  let flow;
  if (hasDoc) {
    const doc = normalizeDoc(markdown, { min_chars, max_chars, preserve_headings });
    flow = {
      mode: 'document',
      maxTokens: maxTokensForDoc(doc),
      buildMessages: (prior) => buildDocMessages({ language, tone, styleGuard, audience, description, doc }, prior),
      validate: (parsed) => validateDocument(doc, parsed),
      collectStyle: (parsed) =>
        styleGuard && parsed ? detectSlop(parsed.text).map((h) => ({ key: 'text', kind: 'style', ...h })) : [],
      success: (parsed, violations, styleWarnings, attempts, models) => ({
        mode: 'document',
        text: parsed && typeof parsed.text === 'string' ? parsed.text : null,
        chars: countChars(parsed && typeof parsed.text === 'string' ? parsed.text : ''),
        violations,
        style_warnings: styleWarnings,
        attempts,
        models,
        style_guard: styleGuard,
        ok: violations.length === 0,
      }),
      failure: (violations, attempts, models) => ({
        mode: 'document',
        text: null,
        chars: 0,
        violations,
        style_warnings: [],
        attempts,
        models,
        style_guard: styleGuard,
        ok: false,
      }),
    };
  } else {
    const normFields = normalizeFields(fields);
    const outputSchema = schema || buildOutputSchema(normFields);
    flow = {
      mode: 'fields',
      maxTokens: maxTokensFor(normFields),
      buildMessages: (prior) => buildMessages({ language, tone, styleGuard, audience, description, fields: normFields }, outputSchema, prior),
      validate: (parsed) => validateFields(normFields, parsed),
      collectStyle: (parsed) => (styleGuard && parsed ? collectStyleWarnings(normFields, parsed) : []),
      success: (parsed, violations, styleWarnings, attempts, models) => ({
        mode: 'fields',
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
      }),
      failure: (violations, attempts, models) => ({
        mode: 'fields',
        fields: normFields.map((f) => ({ key: f.key, text: null, chars: 0 })),
        violations,
        style_warnings: [],
        attempts,
        models,
        style_guard: styleGuard,
        ok: false,
      }),
    };
  }

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
      const raw = await callLlm(apiKey, useModel, flow.buildMessages(prior), flow.maxTokens, temperature);
      parsed = parseLlmJson(raw);
      lastError = null;
    } catch (e) {
      lastError = e;
      parsed = null;
    }

    violations = flow.validate(parsed);
    styleWarnings = flow.collectStyle(parsed);
    const feedable = violations.concat(styleWarnings);

    if (!lastError && feedable.length === 0) break; // контракт соблюдён
    prior = lastError
      ? [{ key: '(all)', kind: 'error', message: String(lastError.message || lastError) }]
      : feedable;
  }

  if (lastError && !parsed) {
    return flow.failure(
      [{ key: '(all)', kind: 'error', message: String(lastError.message || lastError) }],
      attempts,
      models,
    );
  }

  return flow.success(parsed, violations, styleWarnings, attempts, models);
}

module.exports = {
  contentRewrite,
  buildOutputSchema,
  validateFields,
  validateDocument,
  normalizeDoc,
  extractHeadings,
  detectSlop,
  countChars,
  normalizeFields,
  DEFAULT_MODEL,
  DEFAULT_RETRY_MODEL,
  DEFAULT_MAX_ATTEMPTS,
  ROLES,
};
