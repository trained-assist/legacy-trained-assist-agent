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
