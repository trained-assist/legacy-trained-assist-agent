// Anti-recursion contract for hermes_research (triage 2026-09-28).
//
// hermes_research spawns a headless engine that receives THIS SAME MCP toolset, so
// without a floor the chain reproduces itself: engine -> hermes_research -> engine -> ...
// The floor is HERMES_DEPTH stamped into the nested run's MCP config (browser.js extraEnv),
// and the tool refuses to recurse when it sees depth >= 1. No engine is spawned here.
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
async function rejects(fn, m) {
  try { await fn(); fail++; console.log('FAIL (did not reject):', m); return null; }
  catch (e) { pass++; return e; }
}

const fs = require('fs');
const os = require('os');
const path = require('path');

const hermes = require('../src/mcp-skills/tools/100-hermes');
const { writeRunMcpConfig } = require('../src/browser');
const { isolationConfig } = require('../src/agent-isolation');

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

(async () => {
  const prev = process.env.HERMES_DEPTH;
  try {
    delete process.env.HERMES_DEPTH;
    ok(hermes.nestedRefusal() === null, 'no HERMES_DEPTH -> top-level run is not refused');

    process.env.HERMES_DEPTH = '1';
    const refusal = hermes.nestedRefusal();
    ok(typeof refusal === 'string' && refusal.includes('Вложенный Гермес'),
      'depth=1 -> clear refusal message');

    const err = await rejects(
      () => hermes.tools.hermes_research.handler({ task: 'x', output_schema: SCHEMA }),
      'nested hermes_research is rejected before any engine is spawned'
    );
    ok(!!err && /Вложенный Гермес/.test(err.message), 'refusal message reaches the caller');

    // Only the spawn-capable tool is floored; hermes_run/hermes_candidate_report are a
    // single raw LLM call and cannot start a chain.
    ok(!/nestedRefusal/.test(hermes.tools.hermes_run.handler.toString()),
      'hermes_run is not floored (it spawns no engine)');
    ok(!/nestedRefusal/.test(hermes.tools.hermes_candidate_report.handler.toString()),
      'hermes_candidate_report is not floored (it spawns no engine)');

    // Wiring contract: the run config that the nested engine reads must carry the depth.
    // The real spawn path is not exercised in CI (same policy as hermes-tools-run.test.cjs).
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'hermes-tools-run.js'), 'utf8');
    ok(/extraEnv:\s*\{\s*HERMES_DEPTH:/.test(src), 'hermes-tools-run stamps HERMES_DEPTH into the run MCP config');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-nest-'));
    const { mcpConfig, servers } = writeRunMcpConfig(
      tmp, 'nest-guard', { extraEnv: { HERMES_DEPTH: '1' } }, { bridged: !!isolationConfig().envAllowlist });
    const env = servers
      ? servers['trained-skills'].env
      : JSON.parse(fs.readFileSync(mcpConfig, 'utf8')).mcpServers['trained-skills'].env;
    ok(!!env && env.HERMES_DEPTH === '1', 'buildMcpConfig merges extraEnv into the trained-skills server env');
  } finally {
    if (prev === undefined) delete process.env.HERMES_DEPTH;
    else process.env.HERMES_DEPTH = prev;
  }

  console.log(`\nhermes-nested-guard: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
