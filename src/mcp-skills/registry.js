'use strict';

const fs = require('fs');
const path = require('path');

const toolsDir = process.env.TOOLS_DIR || path.join(__dirname, 'tools');
const handlers = {};
const defs = [];
// Every declared tool, regardless of isReady(). The server process has no USER_ID,
// so its listTools() is only setup tools; name gates in core (mcp-action) use this
// static catalog and leave readiness to the per-user child (#1530).
const allDefs = [];
// Profile skills (#1537 PR-B): writeMcpConfig sets SKILLS_RESOLVED only for a profile with
// workDir/skills.json; modules of its switched-off sections are not registered at all.
// Unset/unreadable → null → legacy (every module, gated only by isReady()).
const skillsHidden = require('../skills/enforce').readHidden(process.env.SKILLS_RESOLVED, { warn: console.error });

// Anti-recursion floor, module level (triage 2026-09-28, issue #1792). hermes_web_research spawns
// a headless engine and stamps HERMES_DEPTH into that run's MCP env (hermes-tools-run.js →
// browser.js extraEnv). Hiding the whole module beats refusing per call: a nested engine never
// sees `hermes_web_research` in its tool list at all, so there is nothing to recurse into. Read at
// load time — the MCP server process is started per run, so it always inherits the current flag.
// The per-call refusal in 100-hermes.js stays as the second line of defence (a stale config).
const HERMES_MODULE = '100-hermes.js';

// Exported for the contract test (test/hermes-nested-guard.test.cjs). `depth` defaults to
// the env this server process was started with — that is the value production reads.
function moduleHidden(file, { depth = process.env.HERMES_DEPTH } = {}) {
  if (file !== HERMES_MODULE) return false;
  return (Number.parseInt(depth || '0', 10) || 0) >= 1;
}

// Auto-discover all tool files in tools/
// Each module may export:
//   isReady()    — returns bool; if false, only setupTools are registered (default: true)
//   setupTools   — tool names always registered even when !isReady (for configure/status tools)
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  const mod = require(path.join(toolsDir, file));
  const hidden = moduleHidden(file) || !!(skillsHidden && skillsHidden.modules.has(file));
  const ready = typeof mod.isReady === 'function' ? mod.isReady() : true;
  const setupSet = new Set(mod.setupTools || []);

  for (const [name, tool] of Object.entries(mod.tools || {})) {
    if (!allDefs.some(d => d.name === name)) {
      // `module` (issue #76): which file declared it — lets a consumer of the static
      // catalog (prompt-audit's prompt_prefix_tokens, mcp-action's section filter)
      // apply SKILLS_RESOLVED-style module hiding without spawning the child.
      allDefs.push({ name, description: tool.description, module: file,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} } });
    }
    if (hidden) continue;
    if (!ready && !setupSet.has(name)) continue;
    if (handlers[name]) {
      console.error(`[registry] duplicate tool name: ${name} in ${file}`);
      continue;
    }
    handlers[name] = tool.handler;
    defs.push({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    });
  }
}

module.exports = {
  listTools: () => defs,
  listAllTools: () => allDefs,
  moduleHidden,
  callTool: (name, args) => {
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown tool: ${name}`);
    const ctx = { userId: process.env.USER_ID };
    return fn(args, ctx);
  },
};
