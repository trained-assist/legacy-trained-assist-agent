// Offline contract tests for content_rewrite (src/content-rewrite.js).
// No network: the LLM call is injected via deps.llmCall, so we assert the
// validation loop, anti-slop guard, retry-on-cheap-model and no-silent-truncation
// contract deterministically.

const {
  contentRewrite,
  buildOutputSchema,
  validateFields,
  detectSlop,
  countChars,
  normalizeFields,
  DEFAULT_MODEL,
  DEFAULT_RETRY_MODEL,
} = require('../src/content-rewrite');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
async function throws(fn, m) {
  try { await fn(); fail++; console.log('FAIL (did not throw):', m); }
  catch { pass++; }
}

const FIELDS = [
  { key: 'title', role: 'title', draft: 'Хочешь продавать на выставках', min_chars: 10, max_chars: 40 },
  { key: 'sub', role: 'subtitle', draft: 'Мы делаем автоматизацию', min_chars: 10, max_chars: 60 },
];

function fakeLlm(responses) {
  const calls = [];
  const fn = async (_key, model, messages) => {
    calls.push({ model, messages });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next(messages) : next;
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ── normalize / errors ──────────────────────────────────────────────────────
  await throws(() => normalizeFields([]), 'empty fields rejected');
  await throws(() => normalizeFields([{ key: 'a' }, { key: 'a' }]), 'duplicate key rejected');
  await throws(() => normalizeFields([{ key: 'a', role: 'bogus' }]), 'unknown role rejected');
  await throws(() => normalizeFields([{ key: 'a', min_chars: 5, max_chars: 1 }]), 'min>max rejected');
  await throws(
    () => contentRewrite({ username: 'u', fields: FIELDS }, { llmCall: fakeLlm(['{}']), apiKey: null, readOrKey: () => null }),
    'no OpenRouter key → rejected'
  );

  // ── countChars: code points, not UTF-16 units ───────────────────────────────
  ok(countChars('abc') === 3, 'countChars ascii');
  ok(countChars('тест') === 4, 'countChars cyrillic');
  ok(countChars('a🎯b') === 3, 'countChars counts emoji as one');

  // ── schema generated from fields ────────────────────────────────────────────
  const schema = buildOutputSchema(FIELDS);
  ok(JSON.stringify(schema.required) === JSON.stringify(['title', 'sub']), 'schema required = field keys');
  ok(schema.additionalProperties === false, 'schema forbids extra props');
  ok(/40 символов/.test(schema.properties.title.description), 'schema title carries max_chars');

  // ── validateFields ──────────────────────────────────────────────────────────
  const GOOD = { title: 'Продажи на выставках', sub: 'Автоматизируем сбор контактов' };
  ok(validateFields(FIELDS, GOOD).length === 0, 'valid output → no violations');
  const vLong = validateFields(FIELDS, { ...GOOD, title: 'x'.repeat(41) });
  ok(vLong.length === 1 && vLong[0].kind === 'too_long' && vLong[0].max_chars === 40, 'too_long detected');
  const vShort = validateFields(FIELDS, { ...GOOD, sub: 'корот' });
  ok(vShort.length === 1 && vShort[0].kind === 'too_short', 'too_short detected');
  const vMiss = validateFields(FIELDS, { title: 'Продажи на выставках' });
  ok(vMiss.some((v) => v.kind === 'missing' && v.key === 'sub'), 'missing detected');
  const vExtra = validateFields(FIELDS, { ...GOOD, boom: 'x' });
  ok(vExtra.some((v) => v.kind === 'extra'), 'extra detected');

  // ── anti-slop ───────────────────────────────────────────────────────────────
  ok(detectSlop('В мире, где всё меняется').some((h) => h.marker === 'world_where'), 'RU slop detected');
  ok(detectSlop("It's not just a tool, it's a movement").some((h) => h.marker === 'it_is_not_just'), 'EN slop detected');
  ok(detectSlop('Это не просто сервис — это платформа — для всех').some((h) => h.marker === 'em_dash_run'), 'em-dash run detected');
  ok(detectSlop('Конкретное предложение без штампов.').length === 0, 'clean text → no slop');

  // ── happy path: first attempt clean ─────────────────────────────────────────
  {
    const llm = fakeLlm([JSON.stringify({ title: 'Продажи на выставках', sub: 'Автоматизируем сбор контактов' })]);
    const r = await contentRewrite({ fields: FIELDS }, { llmCall: llm, apiKey: 'k' });
    ok(r.ok === true && r.violations.length === 0, 'clean first attempt → ok');
    ok(r.attempts === 1, 'clean first attempt → 1 attempt');
    ok(r.models[0] === DEFAULT_MODEL, 'primary model used first');
    ok(r.style_guard === true, 'style_guard default on and reported');
    ok(r.fields.find((f) => f.key === 'title').chars === countChars('Продажи на выставках'), 'reported chars match');
  }

  // ── retry on violation goes to the cheap model ──────────────────────────────
  {
    const long = 'x'.repeat(41);
    const llm = fakeLlm([
      JSON.stringify({ title: long, sub: 'короткий' }),
      JSON.stringify({ title: 'Коротко и по делу', sub: 'Автоматизируем сбор контактов' }),
    ]);
    const r = await contentRewrite({ fields: FIELDS }, { llmCall: llm, apiKey: 'k' });
    ok(r.attempts === 2, 'violation forces a retry');
    ok(r.models[1] === DEFAULT_RETRY_MODEL, 'retry uses the cheap model');
    ok(r.violations.length === 0 && r.ok === true, 'retry fixed the violation');
    ok(llm.calls[1].messages[1].content.includes('максимум 40'), 'retry prompt states the max_chars');
    ok(llm.calls[1].messages[1].content.includes('title = 41'), 'retry prompt states the actual char count');
  }

  // ── honest failure: never truncate, report violations ───────────────────────
  {
    const long = 'y'.repeat(41);
    const llm = fakeLlm([JSON.stringify({ title: long, sub: 'ок' })]); // always same
    const r = await contentRewrite({ fields: FIELDS, max_attempts: 2 }, { llmCall: llm, apiKey: 'k' });
    ok(r.ok === false, 'still-violating → ok false');
    ok(r.violations.some((v) => v.kind === 'too_long'), 'violations reported honestly');
    ok(r.fields.find((f) => f.key === 'title').chars === 41, 'no silent truncation — text kept as returned');
  }

  // ── style_guard on: slop triggers retry ─────────────────────────────────────
  {
    const slop = 'В мире, где всё меняется, продажи — это просто — поток';
    const llm = fakeLlm([
      JSON.stringify({ title: slop, sub: 'Автоматизируем сбор контактов' }),
      JSON.stringify({ title: 'Продажи на выставках', sub: 'Автоматизируем сбор контактов' }),
    ]);
    const r = await contentRewrite({ fields: FIELDS }, { llmCall: llm, apiKey: 'k' });
    ok(r.attempts === 2, 'slop triggers retry when style_guard on');
    ok(r.style_warnings.length === 0, 'slop cleared after retry');
  }

  // ── style_guard off: slop tolerated, no warnings, no extra attempt ──────────
  {
    const slop = 'В мире, где всё меняется, мы рядом';
    const llm = fakeLlm([JSON.stringify({ title: slop, sub: 'Автоматизируем сбор контактов' })]);
    const r = await contentRewrite({ fields: FIELDS, style_guard: false }, { llmCall: llm, apiKey: 'k' });
    ok(r.attempts === 1, 'style_guard off → no slop-driven retry');
    ok(r.style_warnings.length === 0, 'style_guard off → no style warnings');
    ok(r.style_guard === false, 'style_guard reported as off');
  }

  // ── primary error → retry on cheap model ────────────────────────────────────
  {
    let n = 0;
    const llm = async () => {
      n += 1;
      if (n === 1) throw new Error('openrouter timeout');
      return JSON.stringify({ title: 'Продажи на выставках', sub: 'Автоматизируем сбор контактов' });
    };
    const r = await contentRewrite({ fields: FIELDS }, { llmCall: llm, apiKey: 'k' });
    ok(r.ok === true && r.attempts === 2, 'primary error → retry recovered');
    ok(r.models[1] === DEFAULT_RETRY_MODEL, 'recovery uses cheap model');
  }

  // ── thinking-model budget: max_tokens must cover reasoning, not only the JSON ─
  // Live smoke 28.09: gemini-2.5-pro spent 0.5–1.5k tokens on reasoning before the
  // content; a narrow budget returned empty content (looked like a model failure).
  {
    const seen = [];
    const llm = async (_k, model, messages, maxTokens) => {
      seen.push(maxTokens);
      return JSON.stringify({ title: 'Продажи на выставках', sub: 'Автоматизируем сбор контактов' });
    };
    await contentRewrite({ fields: FIELDS }, { llmCall: llm, apiKey: 'k' });
    ok(seen[0] >= 4000, `max_tokens covers the reasoning budget (got ${seen[0]})`);
  }

  console.log(`\ncontent-rewrite: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
