// service-llm → llm-ladder worker: pin tests to an unroutable host + dummy token so they are
// self-contained (staging runs this file directly, outside scripts/run-cjs-tests.js) and can
// never reach the live worker via the VM's token file.
process.env.LLM_LADDER_URL = 'http://llm-ladder.invalid';
process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCompleteness } = require('../src/intake-gate');

function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

test('holds when text or key is missing', async () => {
  assert.deepEqual(await checkCompleteness('', 'key'), { level: 'insufficient', complete: false });
  const saved = process.env.LLM_LADDER_TOKEN; delete process.env.LLM_LADDER_TOKEN; // no ladder token
  try { assert.deepEqual(await checkCompleteness('hi', ''), { level: 'insufficient', complete: false }); }
  finally { if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved; }
});

test('propagates API errors to the fail-closed HTTP boundary', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => checkCompleteness('do the thing', 'key', { fetchImpl }));
});

test('maps clear to actionable after the gateway quiet period', async () => {
  const result = await checkCompleteness('запусти отчёт по кандидатам', 'key', { fetchImpl: fakeFetch('clear') });
  assert.deepEqual(result, { level: 'clear', complete: true });
});

test('maps likely to actionable after the gateway quiet period', async () => {
  const result = await checkCompleteness('наверное готово', 'key', { fetchImpl: fakeFetch('likely') });
  assert.deepEqual(result, { level: 'likely', complete: true });
});

test('maps model answer "insufficient" to complete=false', async () => {
  const result = await checkCompleteness('сделай так чтобы', 'key', { fetchImpl: fakeFetch('insufficient') });
  assert.deepEqual(result, { level: 'insufficient', complete: false });
});

test('an unrecognised answer holds the buffer', async () => {
  const result = await checkCompleteness('что-то', 'key', { fetchImpl: fakeFetch('maybe???') });
  assert.deepEqual(result, { level: 'insufficient', complete: false });
});

// The exact voice transcript must be actionable even if the model would refuse it.
test('named link recall bypasses model ambiguity without a paid request', async () => {
  for (const text of [
    'Слушай, напомни пожалуйста мне ссылку для холодного поиска, где там кандидат?',
    'Пришли ссылку на отчёт',
    'дай мне ссылку на результаты',
  ]) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: () => { throw new Error('must not call model'); } });
    assert.deepEqual(result, { level: 'clear', complete: true });
  }
});
test('unfinished link requests remain subject to the gate', async () => {
  for (const text of ['напомни ссылку', 'дай ссылку на', 'пришли ссылку на отчёт и', 'пришли ссылку на отчёт\nи сделай так чтобы']) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: fakeFetch('insufficient') });
    assert.deepEqual(result, { level: 'insufficient', complete: false });
  }
});

test('wait instructions dominate named-link shortcuts and optimistic model answers', async () => {
  for (const text of ['пришли ссылку на отчёт, подожди, ещё допишу', 'я ещё пишу', 'не запускай', 'сейчас пришлю файл']) {
    assert.deepEqual(await checkCompleteness(text, 'key', {fetchImpl: () => {throw Error('must not call');}}), {level:'insufficient',complete:false});
  }
});
test('keeps the end of long input where waiting instructions or task details arrive', async () => {
  let prompt;
  await checkCompleteness('a'.repeat(7000)+' LAST DETAIL', 'key', {fetchImpl: async (_, options) => {
    prompt=JSON.parse(options.body).messages[0].content; return fakeFetch('likely')();
  }});
  assert.ok(prompt.includes('LAST DETAIL'));
});

// Regression: a model that adds stray text/punctuation (or a leading "Ответ:")
// must still map to the label. Exact-match parsing made a chatty-but-correct
// model silently hold the buffer forever.
test('parses the label when the model adds stray text', async () => {
  assert.equal((await checkCompleteness('сделай отчёт', 'key', { fetchImpl: fakeFetch('Ответ: clear.') })).level, 'clear');
  assert.equal((await checkCompleteness('сделай отчёт', 'key', { fetchImpl: fakeFetch('likely\n') })).level, 'likely');
  assert.equal((await checkCompleteness('сделай отчёт', 'key', { fetchImpl: fakeFetch('  insufficient, похоже') })).level, 'insufficient');
});

// Regression: the gate must not be pointed at a reasoning model that leaves
// content null under a tiny max_tokens (that silently held every batch).
test('gate request is a small, non-reasoning completion with a sane token budget', async () => {
  let body;
  await checkCompleteness('сделай отчёт', 'key', { fetchImpl: async (_, options) => { body = JSON.parse(options.body); return fakeFetch('clear')(); } });
  assert.ok(body.max_tokens >= 8, 'max_tokens must allow a label to be emitted');
  assert.ok(!/glm-5\.3-flash/.test(body.model), 'must not use the reasoning model that returns content:null');
});
