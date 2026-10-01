'use strict';
// Tool-schema weight of one run's mounted MCP servers — the «schemas» half of
// prompt-audit's prompt_prefix_tokens (architecture issue #76 L1: 60–85k of the
// 112k prefix is tool schemas, so the metric must move when the mount set moves).
//
// Sources are the STATIC catalogs the server process already loads for the headless
// transport (src/mcp-action.js requires core + every present sibling at startup), so
// this is pure arithmetic over already-resolved data — no spawn, no network.
//
// Deliberate approximations (documented, not bugs):
//   - readiness is NOT filtered: an unconfigured section's tools are counted, so the
//     number is an upper bound. It is identical before/after on the same profile,
//     which is exactly what the before/after comparison needs;
//   - a sibling's tools are counted whole when its server is mounted (per-module
//     hiding inside a sibling needs attribution only core ships — see registry.js);
//   - playwright is an npx package we don't introspect: constant from the measured
//     token-economy/05-live-tool-catalog.json (25 tools, 20102 bytes).
// Estimate = chars / 4 on compact JSON of the defs — same heuristic as the rest of
// prompt-audit (src/prompt-audit.js estimateTokens).
const { estimateTokens } = require('./prompt-audit');
const { SKILL_SIBLINGS, siblingPaths } = require('./skill-siblings');

const PLAYWRIGHT_BYTES = 20102;
const PLAYWRIGHT_TOOL_TOKENS = estimateTokens('x'.repeat(PLAYWRIGHT_BYTES));

function coreStaticTools() {
  try { return require('./mcp-skills/registry').listAllTools(); } catch { return []; }
}

function siblingStaticTools(serverId) {
  const sib = SKILL_SIBLINGS.find(s => s.mcpServerId === serverId);
  if (!sib) return null;
  try {
    const paths = siblingPaths(sib);
    if (!paths.indexPath || !require('fs').existsSync(paths.indexPath)) return null;
    const reg = require(paths.registryPath);
    return typeof reg.listAllTools === 'function' ? reg.listAllTools() : reg.listTools();
  } catch { return null; }
}

/**
 * @param {object} mcpServers the `mcpServers` map of this run's config
 * @param {object} [opts.plan] skills plan (computePlan/planFor) — its `hidden.modules`
 *   is what the child registry will skip; legacy/no plan → nothing hidden.
 * @returns {{total: number, per: Record<string, number>}}
 */
function estimateToolTokens(mcpServers, { plan } = {}) {
  const hidden = new Set(plan && Array.isArray(plan.hidden?.modules) ? plan.hidden.modules : []);
  const per = {};
  let total = 0;
  for (const serverId of Object.keys(mcpServers || {})) {
    let tokens = null;
    if (serverId === 'playwright') {
      tokens = PLAYWRIGHT_TOOL_TOKENS;
    } else if (serverId === 'trained-skills') {
      // Core defs carry `module`; hidden entries for core are bare file names.
      const tools = coreStaticTools().filter(t => !t.module || !hidden.has(t.module));
      tokens = estimateTokens(JSON.stringify(tools));
    } else {
      const tools = siblingStaticTools(serverId);
      if (tools) tokens = estimateTokens(JSON.stringify(tools));
    }
    if (tokens == null) continue;
    per[serverId] = tokens;
    total += tokens;
  }
  return { total, per };
}

module.exports = { estimateToolTokens, PLAYWRIGHT_TOOL_TOKENS };
