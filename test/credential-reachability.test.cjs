'use strict';
// Credential reachability (#1891, epic #1885): the registry of credential
// consumers, the CI contract "declared ⊆ provided" and the profile-migrate
// invariant "reachable before → reachable after". The end-to-end loop over all
// of it is scripts/sandbox/credential-reachability.mjs; these are the unit pins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-reach-test-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// ── S2: buildMcpToolEnv is the object every MCP server gets ─────────────────
test('buildMcpToolEnv is exported and is exactly the env buildMcpConfig hands to MCP servers', () => {
  const browser = require('../src/browser.js');
  assert.equal(typeof browser.buildMcpToolEnv, 'function');
  const workDir = fs.mkdtempSync(path.join(TMP, 'wd-'));
  const opts = { userName: 'N', userHandle: 'h', extraEnv: { HERMES_DEPTH: '1' }, siblings: false };
  const config = browser.buildMcpConfig(workDir, 'u1', opts);
  const direct = browser.buildMcpToolEnv({ userId: 'u1', workDir, ...opts });
  assert.deepEqual(config.mcpServers['trained-skills'].env, direct);
  for (const k of ['USER_ID', 'WORK_DIR', 'HOME', 'PATH', 'AGENT_USER_NAME', 'AGENT_USER_HANDLE', 'HERMES_DEPTH']) {
    assert.ok(k in direct, `missing ${k}`);
  }
});

// ── S1: registry + schema ────────────────────────────────────────────────────
test('config/credentials.json is valid and carries the three regression cases', () => {
  const reg = require('../src/credential-registry.js').load();
  const has = (canon, alias) => reg.credentials.some(c => (c.env || []).includes(canon) && (!alias || (c.aliases || []).includes(alias)));
  assert.ok(has('DEEPGRAM_API_KEY', 'DEEPGRAM_KEY'), 'deepgram');
  assert.ok(has('CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'), 'cloudflare');
  assert.ok(reg.credentials.some(c => c.filesRoot === 'profile' && (c.files || []).includes('.inn-config.json')), 'dadata');
  assert.ok(!fs.existsSync(path.join(ROOT, 'config', 'mcp-provider-env.json')), 'dead mcp-provider-env.json is gone');
});

test('validate rejects bad entries', () => {
  const { validate } = require('../src/credential-registry.js');
  const bad = [
    { consumer: 'x', scope: 'platform' },                                        // neither env nor files
    { scope: 'platform', env: ['X'], host: 'mcp' },                              // no consumer
    { consumer: 'x', scope: 'profile', files: ['../escape.txt'] },               // traversal
    { consumer: 'x', scope: 'profile', files: ['a/../../b'] },
    { consumer: 'x', scope: 'profile', files: ['/abs/path'] },                   // absolute
    { consumer: 'x', scope: 'platform', env: ['X'] },                            // env without host
    { consumer: 'x', scope: 'platform', env: ['A', 'B'], aliases: ['C'], host: 'mcp' },
    { consumer: 'x', scope: 'platform', env: ['lower'], host: 'mcp' },
    { consumer: 'x', scope: 'profile', env: ['X'], host: 'mcp' },               // profile without files
  ];
  for (const c of bad) assert.throws(() => validate({ version: 1, credentials: [c] }), undefined, JSON.stringify(c));
  assert.throws(() => validate({ version: 1, credentials: [
    { consumer: 'x', scope: 'platform', env: ['X'], host: 'mcp' },
    { consumer: 'x', scope: 'platform', env: ['Y'], host: 'mcp' },
  ] }), /duplicate/);
});
