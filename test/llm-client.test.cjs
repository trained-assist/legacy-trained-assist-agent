// Epic #1470 P1.3-hermes-scoring: platform LLM client extracted from hh-scoring.js.
// Hermes must reach OpenRouter/GigaChat without importing HH domain code; the
// legacy core hh-scoring.js reuses the same functions (no third copy to drift).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-client-'));
process.env.AGENT_TOKENS_DIR = tmp;
const llm = require('../src/llm-client');

test('readOrKey / readGigachatKey: per-user file wins over env, env is fallback', () => {
  process.env.OPENROUTER_API_KEY = 'env-or';
  process.env.GIGACHAT_API_KEY = 'env-gc';
  assert.strictEqual(llm.readOrKey('u1'), 'env-or');
  assert.strictEqual(llm.readGigachatKey('u1'), 'env-gc');
  fs.mkdirSync(path.join(tmp, 'u1'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'u1', 'openrouter'), ' file-or \n');
  fs.writeFileSync(path.join(tmp, 'u1', 'gigachat'), 'file-gc');
  assert.strictEqual(llm.readOrKey('u1'), 'file-or');
  assert.strictEqual(llm.readGigachatKey('u1'), 'file-gc');
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GIGACHAT_API_KEY;
  assert.strictEqual(llm.readOrKey('nobody'), null);
  assert.strictEqual(llm.readGigachatKey('nobody'), null);
});

test('parseLlmJson strips code fences and rejects empty', () => {
  assert.deepStrictEqual(llm.parseLlmJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(llm.parseLlmJson(' {"b":2} '), { b: 2 });
  assert.throws(() => llm.parseLlmJson(''), /empty/);
});

test('legacy core hh-scoring re-exports the platform functions (single copy)', () => {
  const hh = require('../src/hh-scoring');
  for (const k of ['llmCall', 'gcCall', 'parseLlmJson', 'readOrKey', 'readGigachatKey']) {
    assert.strictEqual(hh[k], llm[k], `hh-scoring.${k} must be llm-client.${k}`);
  }
});

test('hermes platform workers do not import HH domain modules', () => {
  for (const f of ['src/hermes-run.js', 'src/hermes-tools-run.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"][^'"]*hh-[^'"]*['"]\)/, `${f} imports hh-*`);
  }
});
