// Anti-recursion contract for hermes_web_research (triage 2026-09-28).
//
// hermes_web_research spawns a headless engine that receives THIS SAME MCP toolset, so
// without a floor the chain reproduces itself: engine -> hermes_web_research -> engine -> ...
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
      () => hermes.tools.hermes_web_research.handler({ task: 'x', output_schema: SCHEMA }),
      'nested hermes_web_research is rejected before any engine is spawned'
    );
    ok(!!err && /Вложенный Гермес/.test(err.message), 'refusal message reaches the caller');

    // Only the spawn-capable tool is floored; hermes_run_task/hermes_candidate_report are a
    // single raw LLM call and cannot start a chain.
    ok(!/nestedRefusal/.test(hermes.tools.hermes_run_task.handler.toString()),
      'hermes_run_task is not floored (it spawns no engine)');
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

    // ── Module-level floor: a nested run never even SEES hermes_web_research ────────
    // Refusing per call still leaves the tool in the model's tool list, where it will be
    // tried (and retried). Hiding the module removes the temptation entirely.
    // The registry is loaded through the TOOLS_DIR seam with a two-file fixture: the real
    // one pulls in every tool module and its deps, which this test has no business needing.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tools-'));
    fs.writeFileSync(path.join(fixtureDir, '100-hermes.js'),
      'module.exports = { isReady: () => true, tools: { ' +
      'hermes_web_research: { description: "d", inputSchema: { type: "object" } }, ' +
      'hermes_run_task: { description: "d", inputSchema: { type: "object" } } } };');
    fs.writeFileSync(path.join(fixtureDir, '97-publish.js'),
      'module.exports = { isReady: () => true, tools: { ' +
      'publish_page: { description: "d", inputSchema: { type: "object" } } } };');
    const regPath = require.resolve('../src/mcp-skills/registry');
    const prevDepth = process.env.HERMES_DEPTH;   // '1' inside this block
    const prevToolsDir = process.env.TOOLS_DIR;
    const loadRegistry = (depth) => {
      if (depth === undefined) delete process.env.HERMES_DEPTH;
      else process.env.HERMES_DEPTH = depth;
      process.env.TOOLS_DIR = fixtureDir;
      delete require.cache[regPath];
      return require(regPath);
    };
    try {
      const registry = loadRegistry(prevDepth);
      ok(registry.moduleHidden('100-hermes.js', { depth: '1' }) === true,
        'moduleHidden: depth>=1 hides the whole hermes module');
      ok(registry.moduleHidden('100-hermes.js', { depth: '0' }) === false,
        'moduleHidden: depth=0 keeps the hermes tools');
      ok(registry.moduleHidden('97-publish.js', { depth: '1' }) === false,
        'moduleHidden: only the hermes module is affected');
      // Production reads the env, not an argument — check the default path too.
      delete process.env.HERMES_DEPTH;
      ok(registry.moduleHidden('100-hermes.js') === false,
        'moduleHidden default: an unset HERMES_DEPTH is a top-level run');
      process.env.HERMES_DEPTH = prevDepth;
      ok(registry.moduleHidden('100-hermes.js') === true,
        'moduleHidden default: a set HERMES_DEPTH is a nested run');

      // The full registry loop, not just the predicate.
      const nestedReg = loadRegistry('1');
      const nestedNames = nestedReg.listTools().map(t => t.name);
      ok(!nestedNames.some(n => n.startsWith('hermes_')),
        'a nested run sees no hermes_* tool at all');
      ok(nestedNames.includes('publish_page'),
        'other tools still mount for a nested run (only the hermes module is dropped)');
      ok(nestedReg.listAllTools().some(t => t.name === 'hermes_web_research'),
        'the static catalog still knows the tool (mcp-action name gating keeps working)');

      const topLevelReg = loadRegistry(undefined);
      ok(topLevelReg.listTools().some(t => t.name === 'hermes_web_research'),
        'a top-level run still gets hermes_web_research');
    } finally {
      delete require.cache[regPath];
      if (prevDepth === undefined) delete process.env.HERMES_DEPTH;
      else process.env.HERMES_DEPTH = prevDepth;
      if (prevToolsDir === undefined) delete process.env.TOOLS_DIR;
      else process.env.TOOLS_DIR = prevToolsDir;
    }

    // ── Read-only toolset: no domain siblings for the researcher ────────────────
    // The nested run must not see engineering's github_create_pr / spawn_workspace:
    // measured 2026-09-28, a nested Hermes did open 2 PRs (issue #1792).
    const { buildMcpConfig } = require('../src/browser');
    const fakeSibling = path.join(tmp, 'fake-sibling-index.js');
    fs.writeFileSync(fakeSibling, 'module.exports = {};');
    const full = buildMcpConfig(tmp, 'nest-guard', { siblingPaths: { 'fake-sibling': fakeSibling } });
    ok(!!full.mcpServers['fake-sibling'], 'sibling servers mount by default (seam works)');
    const researcher = buildMcpConfig(tmp, 'nest-guard', { siblingPaths: { 'fake-sibling': fakeSibling }, siblings: false });
    ok(Object.keys(researcher.mcpServers).sort().join(',') === 'playwright,trained-skills',
      'siblings:false mounts only playwright + trained-skills');
    const hermesRunSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'hermes-tools-run.js'), 'utf8');
    ok(/siblings:\s*false/.test(hermesRunSrc), 'hermes-tools-run asks for the researcher toolset');
  } finally {
    if (prev === undefined) delete process.env.HERMES_DEPTH;
    else process.env.HERMES_DEPTH = prev;
  }

  console.log(`\nhermes-nested-guard: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
