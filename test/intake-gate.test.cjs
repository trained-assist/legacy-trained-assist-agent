const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCompleteness, loadLastAssistant, DELAY_CONTINUE_MS, DELAY_STANDARD_MS } = require('../src/intake-gate');
const serviceLlm = require('../src/service-llm');

// Прямого обращения к openrouter.ai больше нет (#2092): судья полноты ввода идёт
// через llm-ladder, поэтому мокаем serviceChat, а не fetch.
function withLadder(content, fn) {
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  // В CI нет файла токена — без этого сработает fail-closed и судья не позовётся.
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async () => ({ content });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      serviceLlm.serviceChat = real;
      serviceLlm.available = realAvailable;
    });
}
function fakeFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  });
}

test('empty text holds, missing service token is retryable', async () => {
  assert.deepEqual(await checkCompleteness(''), { level: 'insufficient', complete: false, delayMs: null, announce: null });
  // Короткий ввод без токена лестницы: судья не зовётся, буфер держится.
  const realChat = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => false;
  serviceLlm.serviceChat = async () => { throw new Error('must not call'); };
  try {
    assert.deepEqual(await checkCompleteness('hi'), { level: 'error', complete: false, delayMs: null, announce: null });
  } finally {
    serviceLlm.serviceChat = realChat;
    serviceLlm.available = realAvailable;
  }
});

test('propagates ladder errors to the fail-closed HTTP boundary', async () => {
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async () => { throw new Error('boom'); };
  try {
    await assert.rejects(() => checkCompleteness('do the thing'));
  } finally {
    serviceLlm.serviceChat = real;
    serviceLlm.available = realAvailable;
  }
});

test('maps clear to an understandable request with the standard delay + announcement', async () => {
  const result = await withLadder('clear', () => checkCompleteness('запусти отчёт по кандидатам'));
  assert.equal(result.level, 'clear');
  assert.equal(result.complete, true);
  assert.equal(result.delayMs, DELAY_STANDARD_MS);
  assert.match(result.announce, /3 минуты/);
});

test('maps likely to actionable after the gateway quiet period', async () => {
  const result = await withLadder('likely', () => checkCompleteness('наверное готово'));
  assert.equal(result.level, 'likely');
  assert.equal(result.complete, true);
  assert.equal(result.delayMs, DELAY_STANDARD_MS);
});

test('maps model answer "insufficient" to a hold with the "недосказана" notice', async () => {
  const result = await withLadder('insufficient', () => checkCompleteness('сделай так чтобы'));
  assert.equal(result.level, 'insufficient');
  assert.equal(result.complete, false);
  assert.equal(result.delayMs, null);
  assert.match(result.announce, /недосказана/);
});

test('an unrecognised answer keeps the buffer retryable', async () => {
  const result = await withLadder('maybe???', () => checkCompleteness('что-то'));
  assert.equal(result.level, 'error');
  assert.equal(result.complete, false);
  assert.equal(result.delayMs, null);
});

// Owner 2026-09-29: a short «продолжай» may only auto-launch when the previous
// assistant answer makes the continuation obvious — otherwise it is underspecified.
test('a short continuation fast-path needs the previous assistant message', async () => {
  const withContext = await withLadder('continue', () => checkCompleteness('давай дальше', {
    lastAssistant: 'План: 1) собрать данные 2) построить отчёт. Продолжить?',
  }));
  assert.equal(withContext.level, 'continue');
  assert.equal(withContext.delayMs, DELAY_CONTINUE_MS);
  assert.match(withContext.announce, /30 секунд/);

  const noContext = await withLadder('continue', () => checkCompleteness('давай дальше'));
  assert.equal(noContext.level, 'insufficient');
  assert.equal(noContext.delayMs, null);
});

test('the assistant context reaches the classifier prompt', async () => {
  let prompt;
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async (args) => {
    prompt = args.messages[0].content;
    return { content: 'continue' };
  };
  try {
    await checkCompleteness('продолжай', { lastAssistant: 'ASSISTANT-SAID-THIS' });
  } finally {
    serviceLlm.serviceChat = real;
    serviceLlm.available = realAvailable;
  }
  assert.ok(prompt.includes('ASSISTANT-SAID-THIS'));
});

// The exact voice transcript must be actionable even if the model would refuse it.
test('named link recall bypasses model ambiguity without a paid request', async () => {
  for (const text of [
    'Слушай, напомни пожалуйста мне ссылку для холодного поиска, где там кандидат?',
    'Пришли ссылку на отчёт',
    'дай мне ссылку на результаты',
  ]) {
    const result = await checkCompleteness(text);
    assert.equal(result.level, 'clear');
    assert.equal(result.delayMs, DELAY_STANDARD_MS);
  }
});
test('unfinished link requests remain subject to the gate', async () => {
  for (const text of ['напомни ссылку', 'дай ссылку на', 'пришли ссылку на отчёт и', 'пришли ссылку на отчёт\nи сделай так чтобы']) {
    const result = await withLadder('insufficient', () => checkCompleteness(text));
    assert.equal(result.level, 'insufficient');
  }
});

test('wait instructions dominate named-link shortcuts and optimistic model answers', async () => {
  for (const text of ['пришли ссылку на отчёт, подожди, ещё допишу', 'я ещё пишу', 'не запускай', 'сейчас пришлю файл']) {
    const result = await checkCompleteness(text);
    assert.equal(result.level, 'insufficient');
    assert.equal(result.delayMs, null);
    assert.equal(result.announce, null); // explicit «подожди» → do not nag
  }
});
test('keeps the end of long input where waiting instructions or task details arrive', async () => {
  let prompt;
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async (args) => {
    prompt = args.messages[0].content;
    return { content: 'likely' };
  };
  try {
    await checkCompleteness('a'.repeat(7000) + ' LAST DETAIL');
  } finally {
    serviceLlm.serviceChat = real;
    serviceLlm.available = realAvailable;
  }
  assert.ok(prompt.includes('LAST DETAIL'));
});

// Regression: a model that adds stray text/punctuation (or a leading "Ответ:")
// must still map to the label. Exact-match parsing made a chatty-but-correct
// model silently hold the buffer forever.
test('parses the label when the model adds stray text', async () => {
  assert.equal((await withLadder('Ответ: clear.', () => checkCompleteness('сделай отчёт'))).level, 'clear');
  assert.equal((await withLadder('likely\n', () => checkCompleteness('сделай отчёт'))).level, 'likely');
  assert.equal((await withLadder('  insufficient, похоже', () => checkCompleteness('сделай отчёт'))).level, 'insufficient');
});

// Regression: the gate must not be pointed at a reasoning model that leaves
// content null under a tiny max_tokens (that silently held every batch).
test('gate request is a small, non-reasoning completion with a sane token budget', async () => {
  let args;
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  // В CI нет файла токена — без этого сработает fail-closed и судья не позовётся.
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async (a) => { args = a; return { content: 'clear' }; };
  try {
    await checkCompleteness('сделай отчёт');
  } finally {
    serviceLlm.serviceChat = real;
    serviceLlm.available = realAvailable;
  }
  assert.ok(args.maxTokens >= 8, 'maxTokens must allow a label to be emitted');
  assert.equal(args.source, 'intake-gate');
});

test('loadLastAssistant reads the newest assistant line and tolerates missing input', () => {
  assert.equal(loadLastAssistant({}), null);
  assert.equal(loadLastAssistant({ username: 'u' }), null);
});

// Exercise the actual service client too: failures must not become a judgement
// that a perfectly complete request is incomplete.
test('provider failure, empty output and recovery keep the retry contract', async () => {
  const realAvailable = serviceLlm.available;
  const realFetch = global.fetch;
  const token = process.env.LLM_LADDER_TOKEN;
  serviceLlm.available = () => true;
  process.env.LLM_LADDER_TOKEN = 'test-only-token';
  let request;
  let response = { ok: false, status: 502, json: async () => ({ error: { message: 'fixture outage' } }) };
  global.fetch = async (_url, init) => { request = JSON.parse(init.body); return response; };
  try {
    const failed = await checkCompleteness('сделай отчёт');
    assert.equal(failed.level, 'error');
    assert.equal(failed.complete, false);
    assert.equal(failed.announce, null);
    assert.equal(request.ladder_total_timeout_ms, 32000);
    assert.ok(request.ladder_total_timeout_ms + 3000 < 40000, 'core must finish before gateway deadline');
    response = { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
    assert.equal((await checkCompleteness('сделай отчёт')).level, 'error');
    response = { ok: true, json: async () => ({ choices: [{ message: { content: 'clear' } }] }) };
    assert.equal((await checkCompleteness('сделай отчёт')).level, 'clear');
  } finally {
    global.fetch = realFetch;
    serviceLlm.available = realAvailable;
    if (token === undefined) delete process.env.LLM_LADDER_TOKEN;
    else process.env.LLM_LADDER_TOKEN = token;
  }
});

test('HTTP boundary preserves context and retryable errors without starting server', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const start = source.indexOf('    // POST /intake-gate');
  const end = source.indexOf('    // POST /webhooks/weeek-session', start);
  assert.ok(start > 0 && end > start);
  const route = source.slice(start, end);
  let shouldThrow = false;
  const context = {
    req: { method: 'POST' }, url: { pathname: '/intake-gate' }, res: {},
    readBody: async () => JSON.stringify({ text: 'продолжай', username: 'fixture', chatId: 42 }),
    json: (_res, status, body) => ({ status, body }), secrets: {},
    startInputRouterShadow: () => ({ record() {} }),
    loadLastAssistant: () => 'CONTEXT-FROM-THIS-CHAT',
    checkCompleteness: async (text, options) => {
      assert.equal(options.lastAssistant, 'CONTEXT-FROM-THIS-CHAT');
      if (shouldThrow) throw new Error('fixture timeout');
      return checkCompleteness(text, options);
    },
    console: { error() {} },
  };
  const run = () => vm.runInNewContext('(async () => {' + route + '})()', context);
  const answer = await withLadder('continue', run);
  assert.equal(answer.body.level, 'continue');
  assert.equal(answer.body.delayMs, DELAY_CONTINUE_MS);
  shouldThrow = true;
  const failed = await run();
  assert.equal(failed.status, 200);
  assert.equal(failed.body.level, 'error');
  assert.equal(failed.body.complete, false);
});
