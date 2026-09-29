#!/usr/bin/env node
/**
 * Credential contract (#1891, epic #1885): every env name a consumer declares in
 * config/credentials.json is really provided by the host layer it names, and core
 * never builds a token path from os.homedir().
 *
 *   node scripts/check-credential-reachability.js [--registry <file>] [--tools-dir <dir>]
 *
 *   host "mcp"    → the key is present in the object buildMcpToolEnv() (src/browser.js)
 *                   builds when the host env carries the name — the real env of every
 *                   MCP server, not a grep;
 *   host "bridge" → the name is a key of engineEnv (src/runner/claude-runner.js), which
 *                   the MCP bridge forwards to siblings. engineEnv is not a pure function
 *                   yet, so this one is read from the source.
 *   R3            → no line in the tools dir (default: core MCP tools + the core token
 *                   readers below) joins os.homedir() with 'agent-tokens'; token paths go
 *                   through src/data-paths.js (AGENT_TOKENS_DIR) / credential-store.
 *
 * Aliases are legacy names the consumer still accepts — the host is not asked for them.
 * Prints names only, never values. Exit 0 ok · 1 violation · 2 usage.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_TOOLS_DIR = path.join(ROOT, 'src', 'mcp-skills', 'tools');
// Core modules outside the tools dir that read profile token files.
const CORE_TOKEN_READERS = ['src/gtd-controller.js', 'src/site-connector.js'];
const PROBE = '__credential-contract-probe__';

function parseArgs(argv) {
  const o = { registry: null, toolsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') o.registry = argv[++i];
    else if (a === '--tools-dir') o.toolsDir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function mcpProvided(names) {
  const saved = {};
  for (const n of names) { saved[n] = process.env[n]; if (!process.env[n]) process.env[n] = PROBE; }
  try {
    const { buildMcpToolEnv } = require('../src/browser.js');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-contract-'));
    try {
      const env = buildMcpToolEnv({ userId: 'credential-contract', workDir });
      return new Set(Object.keys(env).filter(k => env[k] !== undefined && env[k] !== ''));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
}

function bridgeProvided() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'runner', 'claude-runner.js'), 'utf8');
  const start = src.indexOf('const engineEnv = {');
  if (start < 0) throw new Error('engineEnv literal not found in src/runner/claude-runner.js');
  const end = src.indexOf('\n  };', start);
  const block = src.slice(start, end < 0 ? undefined : end);
  return new Set([...block.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:/g)].map(m => m[1]));
}

const HOMEDIR_TOKENS_RE = /os\.homedir\(\)[^\n]*['"]agent-tokens['"]/;
function homedirViolations(toolsDir) {
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).map(f => path.join(toolsDir, f));
  if (!toolsDir || path.resolve(toolsDir) === DEFAULT_TOOLS_DIR) files.push(...CORE_TOKEN_READERS.map(f => path.join(ROOT, f)));
  const out = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((l, i) => { if (HOMEDIR_TOKENS_RE.test(l)) out.push(`${path.relative(ROOT, file) || file}:${i + 1}`); });
  }
  return out;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const registry = require('../src/credential-registry.js');
  let reg;
  try { reg = registry.load(opts.registry ? path.resolve(opts.registry) : undefined); } catch (e) {
    console.error(`  ❌ ${e.message}`);
    return 1;
  }

  const declared = registry.declaredEnv(reg);
  const provided = {
    mcp: mcpProvided(declared.filter(d => d.host === 'mcp').map(d => d.name)),
    bridge: bridgeProvided(),
  };
  let errors = 0;
  for (const d of declared) {
    if (provided[d.host].has(d.name)) console.log(`  ✅ ${d.consumer}: ${d.name} ← ${d.host}`);
    else { console.error(`  ❌ ${d.consumer}: ${d.name} is declared but host "${d.host}" does not provide it`); errors++; }
  }

  const toolsDir = opts.toolsDir ? path.resolve(opts.toolsDir) : DEFAULT_TOOLS_DIR;
  for (const v of homedirViolations(toolsDir)) {
    console.error(`  ❌ ${v}: token path built from os.homedir() — use data-paths tokenPath/tokensRoot (AGENT_TOKENS_DIR)`);
    errors++;
  }

  // Informational: MCP env names nobody declared (dead passthrough or a missing entry).
  const declaredNames = new Set(declared.map(d => d.name));
  const infra = new Set(['USER_ID', 'WORK_DIR', 'HOME', 'PATH', 'AGENT_USER_NAME', 'AGENT_USER_HANDLE',
    'ENGINEERING_WORKSPACE_ROOT', 'ENGINEERING_MIRRORS_ROOT', 'SKILLS_RESOLVED']);
  const orphans = [...provided.mcp].filter(n => !declaredNames.has(n) && !infra.has(n));
  if (orphans.length) console.log(`  ⚠️  MCP env without a registry entry: ${orphans.join(', ')}`);

  console.log(errors ? `\n${errors} credential contract violation(s)` : `\ncredential contract ok: ${declared.length} declared env name(s)`);
  return errors ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
