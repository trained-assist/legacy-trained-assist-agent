// mainstream-decider: the LLM step of the mainstream test driver must never fail
// silently and never repeat itself. Regression for the 2026-09-28 incident where
// 10–12 of 12 decider actions were the identical fallback text and nothing in the
// run log said why.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../src/service-llm');
const DECIDER_PATH = require.resolve('../src/mainstream-tester/mainstream-decider');
const originalServiceChat = llm.serviceChat;

// Fresh module instance per test — the fallback rotation counter lives in module state.
function freshDecider() {
  delete require.cache[DECIDER_PATH];
  return require(DECIDER_PATH);
}

function captureWarns() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  return { lines, restore: () => { console.warn = original; } };
}

function baseArgs(overrides = {}) {
  return {
    conversation: [{ role: 'agent', text: 'Привет! Чем помочь?' }],
    latestText: 'Привет! Чем помочь?',
    buttons: [],
    stepNumber: 2,
    alternativeMode: false,
    openrouterKey: 'test-key',
    previousActions: [],
    ...overrides,
  };
}

test.afterEach(() => { llm.serviceChat = originalServiceChat; });

test('valid LLM action is returned as-is, no fallback, no retry', async () => {
  const decider = freshDecider();
  let calls = 0;
  llm.serviceChat = async (opts) => {
    calls++;
    opts.onDiagnose?.({ reason: 'ok', model: 'rung-a' });
    return { content: '{"type":"text","content":"что умеешь?"}', value: { type: 'text', content: 'что умеешь?' } };
  };
  const cap = captureWarns();
  try {
    const action = await decider.decideNextAction(baseArgs());
    assert.deepEqual(action, { type: 'text', content: 'что умеешь?' });
  } finally { cap.restore(); }
  assert.equal(calls, 1);
  assert.equal(cap.lines.length, 0);
});

test('null LLM answer logs the exact reason (rung/raw/parse error) and retries once', async () => {
  const decider = freshDecider();
  let calls = 0;
  llm.serviceChat = async (opts) => {
    calls++;
    opts.onDiagnose?.({
      reason: 'json_parse_error', model: 'opencode-go/mimo-v2.6-flash',
      error: 'Unexpected token', raw: 'Сейчас подумаю...',
    });
    return null;
  };
  const cap = captureWarns();
  try {
    const action = await decider.decideNextAction(baseArgs());
    assert.equal(action.type, 'text');
    assert.equal(calls, 2, 'timeout/null must be retried once before falling back');
    const joined = cap.lines.join('\n');
    assert.match(joined, /json_parse_error/);
    assert.match(joined, /rung=opencode-go\/mimo-v2\.6-flash/);
    assert.match(joined, /raw="Сейчас подумаю\.\.\."/);
    assert.match(joined, /retrying once/);
    assert.match(joined, /deterministic fallback/);
  } finally { cap.restore(); }
});

test('no_token is not retried (deterministic) but is still logged', async () => {
  const decider = freshDecider();
  let calls = 0;
  llm.serviceChat = async (opts) => {
    calls++;
    opts.onDiagnose?.({ reason: 'no_token', message: 'no ladder token' });
    return null;
  };
  const cap = captureWarns();
  try {
    const action = await decider.decideNextAction(baseArgs());
    assert.equal(action.type, 'text');
    assert.equal(calls, 1, 'a missing token will not fix itself — do not spend a retry');
    assert.match(cap.lines.join('\n'), /no_token/);
    assert.doesNotMatch(cap.lines.join('\n'), /retrying once/);
  } finally { cap.restore(); }
});

test('LLM throwing (e.g. abort/timeout) is caught, logged and retried', async () => {
  const decider = freshDecider();
  let calls = 0;
  llm.serviceChat = async () => {
    calls++;
    throw new Error('The operation was aborted due to timeout');
  };
  const cap = captureWarns();
  try {
    const action = await decider.decideNextAction(baseArgs());
    assert.equal(action.type, 'text');
    assert.equal(calls, 2);
    assert.match(cap.lines.join('\n'), /The operation was aborted due to timeout/);
  } finally { cap.restore(); }
});

test('parsed JSON of the wrong shape is rejected, not forwarded as an action', async () => {
  const decider = freshDecider();
  const cap = captureWarns();
  try {
    llm.serviceChat = async (opts) => {
      opts.onDiagnose?.({ reason: 'ok', model: 'rung-a' });
      return { content: '{"ok":true}', value: { ok: true } };
    };
    assert.equal((await decider.decideNextAction(baseArgs())).type, 'text');
    assert.match(cap.lines.join('\n'), /invalid action shape/);

    // a button without buttonText would reach the agent as "[button:undefined]"
    llm.serviceChat = async (opts) => {
      opts.onDiagnose?.({ reason: 'ok', model: 'rung-a' });
      return { content: '{}', value: { type: 'button', callbackData: 'menu:hh' } };
    };
    assert.equal((await decider.decideNextAction(baseArgs())).type, 'text');
  } finally { cap.restore(); }
});

test('fallbacks are deterministic and diverse — never the same phrase 12 times', async () => {
  const decider = freshDecider();
  llm.serviceChat = async (opts) => { opts.onDiagnose?.({ reason: 'no_token' }); return null; };
  const previousActions = [];
  const contents = [];
  for (let step = 1; step <= 12; step++) {
    const action = await decider.decideNextAction(baseArgs({ stepNumber: step, previousActions: [...previousActions] }));
    previousActions.push(action);
    contents.push(action.type === 'text' ? action.content : `button:${action.buttonText}`);
  }
  assert.equal(new Set(contents).size, 5, `expected the whole phrase pool, got: ${JSON.stringify(contents)}`);
  assert.ok(contents.filter(c => c === 'расскажи подробнее').length <= 3, 'the old single fallback must not dominate');
});

test('every third fallback presses an unused button instead of typing', () => {
  const decider = freshDecider();
  const buttons = [{ text: 'HH', callback_data: 'menu:hh' }, { text: 'Компании по ИНН', callback_data: 'menu:inn' }];
  assert.equal(decider.fallbackAction({ buttons, previousActions: [] }).type, 'text');
  assert.equal(decider.fallbackAction({ buttons, previousActions: [] }).type, 'text');
  assert.deepEqual(
    decider.fallbackAction({ buttons, previousActions: [] }),
    { type: 'button', callbackData: 'menu:hh', buttonText: 'HH' },
  );
  // all buttons pressed already → back to text
  const pressed = [{ type: 'button', buttonText: 'HH' }, { type: 'button', buttonText: 'Компании по ИНН' }];
  for (let i = 0; i < 3; i++) {
    assert.equal(decider.fallbackAction({ buttons, previousActions: pressed }).type, 'text');
  }
});
