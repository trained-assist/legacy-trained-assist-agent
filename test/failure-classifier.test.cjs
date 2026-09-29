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

// 2026-09-29: Go weekly limit + OpenRouter credits at zero → llm-ladder answered "every rung
// failed". Unclassified, it went down the quality path (UNKNOWN) and retried the dead ladder;
// as CONFIG the durable executor moves the step to the level's fallback (the free ladder).
test('deterministic: exhausted llm-ladder is CONFIG (engine switch, not a retry)', () => {
  assert.equal(classifyDeterministic('no DURABLE terminal marker in reply: ⚠️ OpenCode завершился с ошибкой: every rung failed').class, 'CONFIG');
  assert.equal(classifyDeterministic('ladder_exhausted: 502 ladder_error').class, 'CONFIG');
  assert.equal(classifyDeterministic('⛔ Вся лестница моделей «deepseek» временно недоступна (все ступени отказали в llm-ladder)').class, 'CONFIG');
});

// Owner requirement #1899: cheap models exhausted → free ladder, NEVER Claude/Codex as insurance
// (Claude credit is reserved for critical work). Do not relax this test to make a fallback pass.
test('#1899: OpenCode levels/roles never fall back to Claude/Codex by default', () => {
  const { resolveStepExecution, DEFAULT_LEVEL_MAP, DEFAULT_ROLE_MAP } = require('../src/playbook-executor');
  for (const [role, level] of [['developer', 'bachelor'], ['reviewer', 'master'], ['researcher', 'bachelor'], ['verifier', 'master']]) {
    const r = resolveStepExecution({ executor_role: role, minimum_model_level: level }, { roleMap: {} });
    assert.equal(r.engine, 'opencode', `${role}/${level} primary`);
    assert.deepEqual(r.fallbacks.map(f => `${f.engine}/${f.ocProfile}`), ['opencode/free'], `${role}/${level} fallback`);
  }
  for (const m of [DEFAULT_LEVEL_MAP, DEFAULT_ROLE_MAP]) {
    for (const [k, v] of Object.entries(m)) {
      if (v.engine !== 'opencode') continue;
      const fbs = [].concat(v.fallback || []);
      assert.ok(fbs.every(f => f.engine === 'opencode'), `${k}: OpenCode entry must not fall back to ${fbs.map(f => f.engine)}`);
    }
  }
});

// #1899: automatic quality/model escalation never lands a step on Claude/Codex.
test('#1899: nextDistinctLevel never escalates onto Claude/Codex', () => {
  const { nextDistinctLevel, DEFAULT_LEVEL_MAP } = require('../src/playbook-executor');
  for (const lvl of ['bachelor', 'master']) {
    const item = { executor_role: 'developer', minimum_model_level: lvl, current_model_level: lvl };
    assert.equal(nextDistinctLevel(item, DEFAULT_LEVEL_MAP), null, `${lvl} must not escalate to doctor/claude`);
  }
  const map = { ...DEFAULT_LEVEL_MAP, master: { engine: 'opencode', ocProfile: 'max' } };
  const item = { executor_role: 'developer', minimum_model_level: 'bachelor', current_model_level: 'bachelor' };
  assert.equal(nextDistinctLevel(item, map), 'master', 'escalation between OpenCode rungs still works');
});

test('#1899: QUOTA/model recovery never bumps a step onto the Claude level', async () => {
  const { recoverDurableItem } = require('../src/durable-recovery');
  const item = { id: 'i1', task_id: 't1', executor_role: 'developer', minimum_model_level: 'master', current_model_level: 'master', attempt_count: 1, max_attempts: 3 };
  let bumped = false;
  const store = {
    getTaskItem: () => item, bumpModelLevel: () => { bumped = true; },
    updateTaskItem: (id, patch) => Object.assign(item, patch), escalateItem: () => {},
  };
  const task = { profile_id: 'p', acceptance_criteria_json: '{}' };
  await recoverDurableItem({ store, task, itemId: 'i1', errorText: 'x', classifier: () => ({ class: 'QUOTA' }) });
  assert.equal(bumped, false, 'master → doctor (Claude) must not happen automatically');
  assert.equal(item.current_model_level, 'master');
});
