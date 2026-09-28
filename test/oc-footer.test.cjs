// Regression test for the model-usage footer (#989 → #149 → owner decision 29.09.2026).
//
// Contract CHANGED 29.09.2026 (owner dictation, verbatim):
//   «ИИ натренированный на рабочие вопросы. Расход токенов: вход: X, обработка: Y, ответ: Z»
// It replaces the previous «Использование[ model]: вход всего T (новых N, из кэша R, в кэш +W) · выход O».
// Why: the internal engine/model slug ("deepseek:build") must not reach the owner's card,
// and the wording must read as plain language instead of telemetry.
//
// Mapping (pinned below so a future edit cannot silently rename the owner's words):
//   вход      = fresh input + cache write  (tokens read for the first time this step)
//   обработка = cache read                 (tokens re-read from cache every step)
//   ответ     = output                     (generated tokens)
// Three slots, always present, one line, tokens only, no money, no model name.
const { _footer } = require('../src/runner');
const { formatOcFooter, formatCostFooter } = _footer;

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const body = f => f.startsWith('\n\n') ? f.slice(2) : f;

// ── 1. The owner's own example must come out byte-identical ──────────────────
const ownerSample = {
  input_tokens: 180200, output_tokens: 2333,
  cache_read_input_tokens: 1490000, cache_creation_input_tokens: 0,
};
const ownerLine = 'ИИ натренированный на рабочие вопросы. Расход токенов: '
  + 'вход: 180.2K, обработка: 1.49M, ответ: 2.3K';
ok(formatCostFooter(ownerSample) === `\n\n${ownerLine}`, 'owner-dictated string (claude shape)');
ok(formatOcFooter({ input: 180200, output: 2333, cacheRead: 1490000, cacheWrite: 0 }) === `\n\n${ownerLine}`,
  'owner-dictated string (opencode shape)');

// ── 2. Both engines produce the SAME card for the same numbers ───────────────
const same = { input_tokens: 42, output_tokens: 20028, cache_read_input_tokens: 977500, cache_creation_input_tokens: 42900 };
ok(formatCostFooter(same)
  === formatOcFooter({ input: 42, output: 20028, cacheRead: 977500, cacheWrite: 42900 }),
  'claude and opencode footers are identical');
ok(formatCostFooter(same) === '\n\nИИ натренированный на рабочие вопросы. Расход токенов: '
  + 'вход: 42.9K, обработка: 977.5K, ответ: 20K', 'cache write folds into вход, cache read is обработка');

// ── 3. No internal model/engine identity may leak ────────────────────────────
const usage = { input: 12345, output: 67890, cacheRead: 5000, cacheWrite: 2000, cost: 0.0042 };
const withModel = formatOcFooter(usage);
for (const leak of ['deepseek', 'build', 'claude', 'opus', 'sonnet', 'haiku', 'openrouter', ':free', 'GPT']) {
  ok(!withModel.includes(leak), `no model/engine slug "${leak}"`);
  ok(!formatCostFooter(same).includes(leak), `claude card has no slug "${leak}"`);
}
ok(!withModel.includes('model'), 'no word "model"');
ok(!withModel.includes('cost') && !withModel.includes('$'), 'no money, no cost field');

// ── 4. Old telemetry wording is gone ─────────────────────────────────────────
for (const stale of ['Использование', 'вход всего', 'новых', 'из кэша', 'в кэш', 'выход ']) {
  ok(!withModel.includes(stale), `old fragment "${stale}" removed`);
}

// ── 5. Shape: single line, no icons, no code fence, three labelled slots ─────
const bodyText = body(withModel);
ok(!bodyText.includes('\n'), 'footer body is one line');
ok(!withModel.includes('📊') && !withModel.includes('💾') && !withModel.includes('```'), 'no icons/fences');
ok(bodyText.startsWith('ИИ натренированный на рабочие вопросы. Расход токенов: '), 'branding prefix first');
ok((bodyText.match(/вход: /g) || []).length === 1, 'exactly one вход slot');
ok((bodyText.match(/обработка: /g) || []).length === 1, 'exactly one обработка slot');
ok((bodyText.match(/ответ: /g) || []).length === 1, 'exactly one ответ slot');
ok(bodyText.endsWith('ответ: 67.9K'), 'ответ is the last slot');
ok(bodyText === 'ИИ натренированный на рабочие вопросы. Расход токенов: вход: 14.3K, обработка: 5K, ответ: 67.9K',
  'full opencode card text');

// ── 6. Degenerate inputs ─────────────────────────────────────────────────────
ok(formatCostFooter(null) === '' && formatOcFooter(null) === '', 'null usage → empty');
ok(formatCostFooter({}) === '\n\nИИ натренированный на рабочие вопросы. Расход токенов: вход: 0, обработка: 0, ответ: 0',
  'zero usage still shows three zero slots (no silent omission)');
ok(formatCostFooter({
  input_tokens: 72218, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
}) === '\n\nИИ натренированный на рабочие вопросы. Расход токенов: вход: 72.2K, обработка: 0, ответ: 500',
  'no-cache run reports обработка: 0 instead of hiding the slot');
ok(formatOcFooter({ input: 72218, output: 500, cacheRead: 0, cacheWrite: 0 })
  === formatCostFooter({ input_tokens: 72218, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  'no-cache run identical across engines');

// ── 7. Million-scale cache reads must not print "2500K" ──────────────────────
ok(formatCostFooter({ input_tokens: 6204, output_tokens: 100, cache_read_input_tokens: 2500000, cache_creation_input_tokens: 11000 })
  === '\n\nИИ натренированный на рабочие вопросы. Расход токенов: вход: 17.2K, обработка: 2.5M, ответ: 100',
  'M notation for multi-million cache reads');

console.log(`\noc-footer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
