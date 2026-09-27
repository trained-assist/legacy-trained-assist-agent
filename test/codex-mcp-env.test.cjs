'use strict';
// Run identity must reach MCP servers on EVERY engine. codex spawns MCP servers with only
// a fixed env whitelist + the configured `env` (verified live on codex-cli 0.154), so the
// engine env's names are forwarded via `env_vars`. And the shared per-profile .mcp.json must
// never carry a per-run session file (parallel sessions of a profile would race on it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withCodexMcpEnvForwarding, buildEngineCommand } = require('../src/runner/claude-runner');
const { writeMcpConfig } = require('../src/browser');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-env-'));
  const fp = path.join(dir, '.mcp.json');
  fs.writeFileSync(fp, JSON.stringify({ mcpServers: {
    'trained-skills': { command: 'node', args: ['/x/index.js'], env: { USER_ID: 'u1' } },
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
  } }));
  return { dir, fp };
}

function envVarsOf(args, server) {
  const a = args.find(x => x.startsWith(`mcp_servers.${server}.env_vars=`));
  assert.ok(a, `env_vars override for ${server}`);
  return JSON.parse(a.slice(a.indexOf('=') + 1));
}

test('codex: every MCP server gets the engine env names; prompt stays last; values not in argv', () => {
  const { fp, dir } = fixture();
  const [, args] = buildEngineCommand({ engine: 'codex', prompt: 'THE PROMPT', mcpConfig: fp, user: { cwd: dir } });
  const env = { AGENT_USER_ID: 'u1', AGENT_SESSION_FILE: '/s/x.json', GITHUB_TOKEN: 'secret-value', 'bad name': 'x' };
  const out = withCodexMcpEnvForwarding(args, fp, Object.keys(env));
  assert.equal(out[out.length - 1], 'THE PROMPT', 'prompt stays the trailing positional arg');
  for (const server of ['trained-skills', 'playwright']) {
    assert.deepEqual(envVarsOf(out, server), ['AGENT_USER_ID', 'AGENT_SESSION_FILE', 'GITHUB_TOKEN'], `${server}: names forwarded, junk dropped`);
  }
  assert.ok(!out.join(' ').includes('secret-value'), 'values never land in argv');
  assert.deepEqual(out.slice(0, args.length - 1), args.slice(0, -1), 'existing args untouched');
});

test('no MCP config / no names → args unchanged', () => {
  const { fp } = fixture();
  assert.deepEqual(withCodexMcpEnvForwarding(['exec', 'P'], fp, []), ['exec', 'P']);
  assert.deepEqual(withCodexMcpEnvForwarding(['exec', 'P'], '/nonexistent/.mcp.json', ['A']), ['exec', 'P']);
});

test('shared per-profile .mcp.json carries no per-run session file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-'));
  const cfgPath = writeMcpConfig(dir, 'u1', { userName: 'U', userHandle: 'u1', sessionFilePath: '/tmp/s-1.json' });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const [name, srv] of Object.entries(cfg.mcpServers)) {
    assert.ok(!srv.env || !('AGENT_SESSION_FILE' in srv.env), `${name}: no AGENT_SESSION_FILE in shared config`);
  }
});

test('runEngineProcess wires the forwarding for codex (source contract)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'claude-runner.js'), 'utf8');
  assert.match(src, /engine === 'codex' && mcpConfig\s*\?\s*withCodexMcpEnvForwarding\(engineArgs, mcpConfig, Object\.keys\(spawnEnv\)\)/);
  // Forwarded names = the env the process is actually spawned with (the allowlisted one
  // under isolation, issue #1649), and the spawn args carry the forwarding.
  assert.match(src, /isolation\.wrap\(engineBin, spawnArgs\)/);
  assert.match(src, /spawn\(spawnBin, spawnArgv, \{[\s\S]{0,40}env: spawnEnv/);
});

// All user-facing times are МСК (card + session context use Europe/Moscow). Without an
// explicit TZ the engine shell inherits the VM clock (UTC on GCP), so plain `date` disagrees
// with every displayed time and the agent mixes a МСК target with `date -u` (2026-09-27).
test('engine env pins TZ=Europe/Moscow to match the МСК UI', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'claude-runner.js'), 'utf8');
  assert.match(src, /TZ:\s*process\.env\.TZ\s*\|\|\s*'Europe\/Moscow'/);
});
