// Contract tests for Hermes Phase 1.
// No network in CI: only the guard-clause contract is tested here. The live
// GigaChat/OpenRouter path is smoke-tested manually on a live key.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
async function throws(fn, m) {
  try { await fn(); fail++; console.log('FAIL (did not throw):', m); }
  catch { pass++; }
}

// Isolate token lookup from the real machine's agent-tokens/env before requiring.
const tmpTokens = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-tokens-'));
process.env.AGENT_TOKENS_DIR = tmpTokens;
delete process.env.GIGACHAT_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const { hermesRun } = require('../src/hermes-run');

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

(async () => {
  await throws(() => hermesRun({ task: '', outputSchema: SCHEMA }), 'empty task rejected');
  await throws(() => hermesRun({ task: 'do X', outputSchema: null }), 'missing outputSchema rejected');
  await throws(
    () => hermesRun({ username: 'no-such-user', task: 'do X', outputSchema: SCHEMA }),
    'no GigaChat/OpenRouter key configured → rejected before any network call'
  );

  ok(typeof hermesRun === 'function', 'hermesRun is exported as a function');

  fs.rmSync(tmpTokens, { recursive: true, force: true });
  console.log(`\nhermes-run: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
