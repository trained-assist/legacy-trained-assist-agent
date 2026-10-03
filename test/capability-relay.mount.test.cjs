'use strict';
// Issue #2061 PR1, slice T5 — mounting and the boundary.
// SR-01: default-off (no endpoint → config unchanged) and the relay's own minimal env.
// R14: the relay must not import core internals — a require-graph check, not a review note.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildMcpConfig } = require('../src/browser.js');
const { RELAY_ENV_ALLOW, FORBIDDEN_ENV_PATTERNS, relayEnvFrom, leaksForbidden } = require('../src/capability-relay/env.js');

const RELAY_ID = 'capability-relay';
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mount-'));
// The server list is environmental (staging checks out the domain skill siblings),
// so the invariant is "the relay changes nothing else" — measured against the config
// built here with the feature off, never against a hard-coded whitelist.
const saved = {};
for (const key of ['CAPABILITY_RELAY_ENDPOINT', 'CAPABILITY_RELAY_TOKEN', 'CAPABILITY_RELAY_CONTRACT_VERSION', 'CAPABILITY_RELAY_TIMEOUT_MS', 'USER_ID', 'AGENT_RUN_ID', 'CF_API_TOKEN', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'AGENT_SECRET', 'DEEPGRAM_API_KEY']) {
  saved[key] = process.env[key];
  delete process.env[key];
}
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('without an endpoint the mount is absent and the config keeps its previous shape', () => {
  const config = buildMcpConfig(workDir, 'tester');
  assert.equal(RELAY_ID in config.mcpServers, false, 'feature is default-off');
  const baselineKeys = Object.keys(config.mcpServers).sort();
  assert.equal(baselineKeys.includes(RELAY_ID), false, 'the baseline itself must not carry the relay');
  assert.deepEqual(Object.keys(buildMcpConfig(workDir, 'tester').mcpServers).sort(), baselineKeys);
  assert.equal(config.mcpServers['trained-skills'].command, 'node');
});

test('a fat service env alone does not switch the feature on', () => {
  process.env.CF_API_TOKEN = 'cf-secret';
  process.env.OPENROUTER_API_KEY = 'sk-or';
  const config = buildMcpConfig(workDir, 'tester');
  assert.equal(RELAY_ID in config.mcpServers, false);
  delete process.env.CF_API_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
});

test('with an endpoint the relay mounts with exactly the allowlisted env and no service secret', () => {
  // The baseline is rebuilt here, not shared with the previous test: each test must
  // stand on its own (it may be run alone, and the server list is environmental).
  const baselineKeys = Object.keys(buildMcpConfig(workDir, 'tester').mcpServers).sort();
  assert.equal(baselineKeys.includes(RELAY_ID), false, 'the baseline itself must not carry the relay');
  process.env.CAPABILITY_RELAY_ENDPOINT = 'http://127.0.0.1:8787';
  process.env.CAPABILITY_RELAY_TOKEN = 'relay-caller-credential';
  process.env.CAPABILITY_RELAY_CONTRACT_VERSION = '1';
  // A deliberately hostile service env: whatever else the service carries must not leak.
  process.env.CF_API_TOKEN = 'cf-secret';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-secret-2';
  process.env.OPENROUTER_API_KEY = 'sk-or';
  process.env.TELEGRAM_BOT_TOKEN = '700000:tg';
  process.env.AGENT_SECRET = 'agent-secret';
  process.env.DEEPGRAM_API_KEY = 'dg';

  try {
    const config = buildMcpConfig(workDir, 'tester');
    assert.ok(RELAY_ID in config.mcpServers, 'endpoint switches the feature on');
    const spec = config.mcpServers[RELAY_ID];
    assert.equal(spec.command, 'node');
    assert.deepEqual(spec.args, [path.resolve(__dirname, '..', 'src', 'capability-relay', 'index.js')]);

    const keys = Object.keys(spec.env);
    assert.deepEqual(keys.sort(), ['CAPABILITY_RELAY_CONTRACT_VERSION', 'CAPABILITY_RELAY_ENDPOINT', 'CAPABILITY_RELAY_TOKEN'].sort(),
      'only the relay allowlist');
    for (const key of keys) assert.ok(RELAY_ENV_ALLOW.includes(key), `${key} must be on the allowlist`);
    assert.deepEqual(leaksForbidden(spec.env), [], 'no CF/provider/bot/agent secret reaches the relay');
    assert.equal(spec.env.CF_API_TOKEN, undefined);
    assert.equal(spec.env.OPENROUTER_API_KEY, undefined);

    // It is genuinely a different env from the one the core tools get.
    assert.notDeepEqual(spec.env, config.mcpServers['trained-skills'].env);
    assert.equal(JSON.stringify(spec.env).includes('cf-secret'), false);

    // The rest of the config is untouched by the feature: same server set, minus the relay.
    assert.ok(Array.isArray(baselineKeys), 'the default-off baseline must be recorded first');
    assert.deepEqual(Object.keys(config.mcpServers).filter(k => k !== RELAY_ID).sort(), baselineKeys,
      'the relay must not add, drop or rename any other server');
  } finally {
    delete process.env.CAPABILITY_RELAY_ENDPOINT;
    delete process.env.CAPABILITY_RELAY_TOKEN;
    delete process.env.CAPABILITY_RELAY_CONTRACT_VERSION;
    delete process.env.CF_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.AGENT_SECRET;
    delete process.env.DEEPGRAM_API_KEY;
  }
});

test('relayEnvFrom drops everything outside the allowlist, whatever the caller passes', () => {
  const env = relayEnvFrom({
    CAPABILITY_RELAY_ENDPOINT: 'http://127.0.0.1:1',
    CAPABILITY_RELAY_TOKEN: 'tok',
    CF_API_TOKEN: 'x', OPENROUTER_API_KEY: 'y', AGENT_SECRET: 'z',
    RANDOM_SERVICE_FLAG: 'on', PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CAPABILITY_RELAY_ENDPOINT', 'CAPABILITY_RELAY_TOKEN'].sort());
  assert.equal(leaksForbidden(env).length, 0);
});

// ── R14: the relay is a separate process whose only input is the contract ──────

function requireGraph(dir) {
  const repoRoot = path.resolve(__dirname, '..');
  const seen = new Set();
  const stack = [...fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f))];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = match[1];
      if (target.startsWith('.')) stack.push(path.resolve(path.dirname(file), target));
      else seen.add(`ext:${target}`);
    }
  }
  // Repo-relative: the absolute path of a GitHub runner is /home/runner/work/… and
  // would otherwise trip the `runner` forbidden substring on the checkout location.
  return [...seen].map(entry => (entry.startsWith('ext:') ? entry : `local:${path.relative(repoRoot, entry)}`));
}

test('the relay requires no core internals — contract in, HTTP out, nothing else', () => {
  const graph = requireGraph(path.resolve(__dirname, '..', 'src', 'capability-relay'));
  const local = graph.filter(entry => entry.startsWith('local:')).map(entry => entry.slice(6));
  const external = graph.filter(entry => entry.startsWith('ext:')).map(entry => entry.slice(4));
  assert.ok(local.length >= 4, `expected the relay modules, saw ${local.length}`);
  const forbidden = ['mcp-skills', 'mcp-action', 'llm-ladder', 'runner', 'secrets', 'browser', 'agent-isolation', 'skills/'];
  for (const entry of [...local, ...external]) {
    for (const bad of forbidden) {
      assert.equal(entry.includes(bad), false, `relay must not reach into ${bad}: ${entry}`);
    }
  }
  // Node built-ins and the contract are the whole world of the relay.
  assert.deepEqual(external.filter(name => !['readline', 'fs', 'path'].includes(name)), [],
    `unexpected external dependency: ${external.join(', ')}`);
});

test('the graph walk actually follows requires (sanity for the boundary check)', () => {
  const graph = requireGraph(path.resolve(__dirname, '..', 'src', 'capability-relay'));
  assert.equal(graph.some(entry => entry.startsWith('ext:')), true, 'external requires are recorded');
  assert.equal(graph.some(entry => entry.endsWith('errors.js')), true, 'relative requires are followed');
});