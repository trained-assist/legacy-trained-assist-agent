const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCompleteness, loadLastAssistant, DELAY_CONTINUE_MS, DELAY_STANDARD_MS } = require('../src/intake-gate');

function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

test('holds when text or key is missing', async () => {
  assert.deepEqual(await checkCompleteness('', 'key'), { level: 'insufficient', complete: false, delayMs: null, announce: null });
  assert.deepEqual(await checkCompleteness('hi', ''), { level: 'insufficient', complete: false, delayMs: null, announce: null });
});

test('propagates API errors to the fail-closed HTTP boundary', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(() => checkCompleteness('do the thing', 'key', { fetchImpl }));
});

test('maps clear to an understandable request with the standard delay + announcement', async () => {
  const result = await checkCompleteness('запусти отчёт по кандидатам', 'key', { fetchImpl: fakeFetch('clear') });
  assert.equal(result.level, 'clear');
  assert.equal(result.complete, true);
  assert.equal(result.delayMs, DELAY_STANDARD_MS);
  assert.match(result.announce, /3 минуты/);
});

test('maps likely to actionable after the gateway quiet period', async () => {
  const result = await checkCompleteness('наверное готово', 'key', { fetchImpl: fakeFetch('likely') });
  assert.equal(result.level, 'likely');
  assert.equal(result.complete, true);
  assert.equal(result.delayMs, DELAY_STANDARD_MS);
});

test('maps model answer "insufficient" to a hold with the "недосказана" notice', async () => {
  const result = await checkCompleteness('сделай так чтобы', 'key', { fetchImpl: fakeFetch('insufficient') });
  assert.equal(result.level, 'insufficient');
  assert.equal(result.complete, false);
  assert.equal(result.delayMs, null);
  assert.match(result.announce, /недосказана/);
});

test('an unrecognised answer holds the buffer', async () => {
  const result = await checkCompleteness('что-то', 'key', { fetchImpl: fakeFetch('maybe???') });
  assert.equal(result.level, 'insufficient');
  assert.equal(result.complete, false);
  assert.equal(result.delayMs, null);
});

// Owner 2026-09-29: a short «продолжай» may only auto-launch when the previous
// assistant answer makes the continuation obvious — otherwise it is underspecified.
test('a short continuation fast-path needs the previous assistant message', async () => {
  const withContext = await checkCompleteness('давай дальше', 'key', {
    fetchImpl: fakeFetch('continue'), lastAssistant: 'План: 1) собрать данные 2) построить отчёт. Продолжить?',
  });
  assert.equal(withContext.level, 'continue');
  assert.equal(withContext.delayMs, DELAY_CONTINUE_MS);
  assert.match(withContext.announce, /30 секунд/);

  const noContext = await checkCompleteness('давай дальше', 'key', { fetchImpl: fakeFetch('continue') });
  assert.equal(noContext.level, 'insufficient');
  assert.equal(noContext.delayMs, null);
});

test('the assistant context reaches the classifier prompt', async () => {
  let prompt;
  await checkCompleteness('продолжай', 'key', {
    lastAssistant: 'ASSISTANT-SAID-THIS', fetchImpl: async (_, options) => {
      prompt = JSON.parse(options.body).messages[0].content; return fakeFetch('continue')();
    },
  });
  assert.ok(prompt.includes('ASSISTANT-SAID-THIS'));
});

// The exact voice transcript must be actionable even if the model would refuse it.
test('named link recall bypasses model ambiguity without a paid request', async () => {
  for (const text of [
    'Слушай, напомни пожалуйста мне ссылку для холодного поиска, где там кандидат?',
    'Пришли ссылку на отчёт',
    'дай мне ссылку на результаты',
  ]) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: () => { throw new Error('must not call model'); } });
    assert.equal(result.level, 'clear');
    assert.equal(result.delayMs, DELAY_STANDARD_MS);
  }
});
test('unfinished link requests remain subject to the gate', async () => {
  for (const text of ['напомни ссылку', 'дай ссылку на', 'пришли ссылку на отчёт и', 'пришли ссылку на отчёт\nи сделай так чтобы']) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: fakeFetch('insufficient') });
    assert.equal(result.level, 'insufficient');
  }
});

test('wait instructions dominate named-link shortcuts and optimistic model answers', async () => {
  for (const text of ['пришли ссылку на отчёт, подожди, ещё допишу', 'я ещё пишу', 'не запускай', 'сейчас пришлю файл']) {
    const result = await checkCompleteness(text, 'key', { fetchImpl: () => { throw Error('must not call'); } });
    assert.equal(result.level, 'insufficient');
    assert.equal(result.delayMs, null);
    assert.equal(result.announce, null); // explicit «подожди» → do not nag
  }
});
test('keeps the end of long input where waiting instructions or task details arrive', async () => {
  let prompt;
  await checkCompleteness('a'.repeat(7000) + ' LAST DETAIL', 'key', { fetchImpl: async (_, options) => {
    prompt = JSON.parse(options.body).messages[0].content; return fakeFetch('likely')();
  } });
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

test('loadLastAssistant reads the newest assistant line and tolerates missing input', () => {
  assert.equal(loadLastAssistant({}), null);
  assert.equal(loadLastAssistant({ username: 'u' }), null);
});
