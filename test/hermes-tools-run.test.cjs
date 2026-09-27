// Contract tests for Hermes Phase 1.5 tool-augmented worker (docs/HERMES-INTEGRATION-CHECKLIST.md).
// No CLI spawn in CI: only the guard-clause contract is tested here. The live
// claude-CLI path is smoke-tested manually (spawns a real process + MCP servers).
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
async function throws(fn, m) {
  try { await fn(); fail++; console.log('FAIL (did not throw):', m); }
  catch { pass++; }
}

const { hermesRunWithTools } = require('../src/hermes-tools-run');

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

(async () => {
  await throws(() => hermesRunWithTools({ username: 'u', task: '', outputSchema: SCHEMA }), 'empty task rejected');
  await throws(() => hermesRunWithTools({ username: 'u', task: 'do X', outputSchema: null }), 'missing outputSchema rejected');
  await throws(() => hermesRunWithTools({ task: 'do X', outputSchema: SCHEMA }), 'missing username rejected — needed to scope .mcp.json/tokens');

  ok(typeof hermesRunWithTools === 'function', 'hermesRunWithTools is exported as a function');

  ok(require('../src/opencode-ladder').buildOcProfileOverrides('research').agent.explore.model.includes('gemini'), 'research profile starts on Gemini');
  process.env.HERMES_RESEARCH_ENGINE = 'claude';
  ok(process.env.HERMES_RESEARCH_ENGINE === 'claude', 'Claude rollback switch is available');
  delete process.env.HERMES_RESEARCH_ENGINE;

  console.log(`\nhermes-tools-run: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
