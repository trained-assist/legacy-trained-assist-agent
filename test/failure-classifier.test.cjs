// service-llm → llm-ladder worker: pin tests to an unroutable host + dummy token so they are
// self-contained (staging runs this file directly, outside scripts/run-cjs-tests.js) and can
// never reach the live worker via the VM's token file.
process.env.LLM_LADDER_URL = 'http://llm-ladder.invalid';
process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyDeterministic, classifyWithLLM, classify } = require('../src/failure-classifier');

test('deterministic: AUTH/CONFIG/QUOTA/RATE_LIMIT/CONTEXT/TRANSIENT/MODEL_ERROR/TOOL_ERROR all match', () => {
  assert.equal(classifyDeterministic('Error: not logged in').class, 'AUTH');
  assert.equal(classifyDeterministic('This model requires Global Regions').class, 'CONFIG');
  assert.equal(classifyDeterministic('quota exceeded for this month').class, 'QUOTA');
  assert.equal(classifyDeterministic('429 rate limit hit').class, 'RATE_LIMIT');
  assert.equal(classifyDeterministic('maximum context length exceeded').class, 'CONTEXT');
  assert.equal(classifyDeterministic('service temporarily overloaded').class, 'TRANSIENT');
  // #1311 C5: opencode shared SQLite contention between concurrent runs (real stderr).
  assert.equal(classifyDeterministic('Error: Unexpected error\n\ndatabase is locked').class, 'TRANSIENT');
  assert.equal(classifyDeterministic('SQLITE_BUSY: database is locked').retryable, true);
  assert.equal(classifyDeterministic('500 internal server error').class, 'MODEL_ERROR');
  assert.equal(classifyDeterministic('tool call failed: ENOENT').class, 'TOOL_ERROR');
});

test('deterministic: CONFIG and USER_STOP are marked not retryable on the same target', () => {
  assert.equal(classifyDeterministic('insufficient account funds').retryable, false);
  assert.equal(classifyDeterministic('anything', { userStop: true }).retryable, false);
});

test('deterministic: other classes are retryable', () => {
  assert.equal(classifyDeterministic('429 rate limit').retryable, true);
  assert.equal(classifyDeterministic('quota exceeded').retryable, true);
});

test('deterministic: userStop signal wins even over a matching text pattern', () => {
  const r = classifyDeterministic('not logged in', { userStop: true });
  assert.equal(r.class, 'USER_STOP');
});

test('deterministic: unrecognized text returns null (falls through to Stage B)', () => {
  assert.equal(classifyDeterministic('something completely unexpected happened'), null);
  assert.equal(classifyDeterministic(''), null);
});

test('classifyWithLLM: no API key → safe UNKNOWN, no throw', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const r = await classifyWithLLM('some unclassified error text');
  if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
  assert.equal(r.class, 'UNKNOWN');
  assert.equal(r.source, 'llm');
});

test('classifyWithLLM: valid structured response is used as-is', async () => {
  const prevFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ class: 'TOOL_ERROR', retryable: true, confidence: 0.9 }) } }],
    }),
  });
  const r = await classifyWithLLM('weird tool failure text', { apiKey: 'test-key' });
  global.fetch = prevFetch;
  assert.equal(r.class, 'TOOL_ERROR');
  assert.equal(r.retryable, true);
  assert.equal(r.source, 'llm');
});

test('classifyWithLLM: malformed/invalid-enum LLM output → safe UNKNOWN, never throws', async () => {
  const prevFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'not even json' } }] }),
  });
  const r1 = await classifyWithLLM('x', { apiKey: 'test-key' });
  assert.equal(r1.class, 'UNKNOWN');

  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ class: 'USER_STOP' }) } }] }),
  });
  const r2 = await classifyWithLLM('x', { apiKey: 'test-key' });
  assert.equal(r2.class, 'UNKNOWN'); // USER_STOP is signal-only, LLM is not allowed to invent it

  global.fetch = async () => { throw new Error('network down'); };
  const r3 = await classifyWithLLM('x', { apiKey: 'test-key' });
  assert.equal(r3.class, 'UNKNOWN');

  global.fetch = prevFetch;
});

test('classify(): Stage A short-circuits Stage B (no network call when a rule matches)', async () => {
  const prevFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  const r = await classify('401 authentication failed', { apiKey: 'test-key' });
  global.fetch = prevFetch;
  assert.equal(r.class, 'AUTH');
  assert.equal(fetchCalled, false);
});

test('classify(): falls through to Stage B when Stage A finds nothing', async () => {
  const prevFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ class: 'MODEL_ERROR', retryable: true, confidence: 0.6 }) } }] }),
  });
  const r = await classify('bizarre unclassifiable stack trace', { apiKey: 'test-key' });
  global.fetch = prevFetch;
  assert.equal(r.class, 'MODEL_ERROR');
  assert.equal(r.source, 'llm');
});
