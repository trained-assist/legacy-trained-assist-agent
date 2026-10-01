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
 *   host "secrets"→ the name is in the boot secret loader (src/secrets.js REQUIRED/OPTIONAL),
 *                   which fetches it from Secret Manager / the host env into memory. It never
 *                   travels as env, so the check is the loader list itself.
 *   R3            → no line in the tools dir (default: core MCP tools + the core token
 *                   readers below) joins os.homedir() with 'agent-tokens'; token paths go
 *                   through src/data-paths.js (AGENT_TOKENS_DIR) / credential-store.
 *
 * The direction that one-way checks miss — a consumer the HOST enables whose credential
 * nobody declared or the loader never fetches (SALES_BOT_TOKEN, 01.10.2026) — is covered
 * by the host-registry pass below: every enabled bots.registry entry must have its
 * token_secret_name declared here AND provided. That a *value* really resolves is the
 * host-side half: scripts/check-bot-secrets.js, run by the pre-deploy gate.
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

// Consumers the HOST switches on (infra/env-manifest.json), as opposed to skills the
// agent spawns. One line per registry; the credential is whatever the entry names.
const HOST_REGISTRIES = [
  {
    id: 'bots.registry',
    manifest: require(path.join(ROOT, 'infra', 'env-manifest.json')),
    requiredHost: 'secrets',
    token: b => b.token_secret_name,
    consumer: b => `core:bot-${b.botId}`,
    isOn: b => b.enabled !== false,
  },
];

function parseArgs(argv) {
  const o = { registry: null, toolsDir: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') o.registry = argv[++i];
    else if (a === '--tools-dir') o.toolsDir = argv[++i];
    else if (a === '--manifest') o.manifest = argv[++i];
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

// The boot secret loader's own list — the module the agent requires at startup, so the
// check cannot drift from what actually fetches. Loading it is side-effect free.
function secretsProvided() {
  const { REQUIRED, OPTIONAL } = require('../src/secrets.js');
  return new Set([...REQUIRED, ...OPTIONAL]);
}

function manifestPath(opts) {
  return opts.manifest ? path.resolve(opts.manifest) : path.join(ROOT, 'infra', 'env-manifest.json');
}

// Host-enabled consumer → its credential is declared AND provided. The mirror image of
// the loop in main(); without it an enabled bot with an undeclared token is invisible.
function hostRegistryGaps(opts, declared, provided) {
  const file = manifestPath(opts);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const reg of HOST_REGISTRIES) {
    const list = reg.id.split('.').reduce((o, k) => (o ? o[k] : undefined),
      opts.manifest ? manifest : reg.manifest);
    if (!Array.isArray(list)) continue; // registry absent = nothing the host switched on
    for (const e of list) {
      if (!reg.isOn(e)) continue;
      const name = reg.token(e);
      const who = `${reg.id}: ${reg.consumer(e)} (audience ${e.audience})`;
      if (!name) { out.push(`${who} is enabled but names no credential`); continue; }
      const decl = declared.find(d => d.name === name);
      if (!decl) {
        out.push(`${who} is enabled but ${name} has no config/credentials.json entry — the host switched a consumer on whose key nobody declared`);
        continue;
      }
      if (decl.host !== reg.requiredHost) {
        out.push(`${who} needs ${name} from host "${reg.requiredHost}", but the registry declares host "${decl.host}"`);
        continue;
      }
      if (!provided[decl.host].has(decl.name)) out.push(`${who} is enabled but host "${decl.host}" does not provide ${name}`);
    }
  }
  return out;
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
    secrets: secretsProvided(),
  };
  let errors = 0;
  for (const d of declared) {
    if (provided[d.host]?.has(d.name)) console.log(`  ✅ ${d.consumer}: ${d.name} ← ${d.host}`);
    else { console.error(`  ❌ ${d.consumer}: ${d.name} is declared but host "${d.host}" does not provide it`); errors++; }
  }

  for (const gap of hostRegistryGaps(opts, declared, provided)) {
    console.error(`  ❌ ${gap}`);
    errors++;
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
