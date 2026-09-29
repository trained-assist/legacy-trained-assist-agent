// mainstream tester must not leave test profiles in the real users dir.
// Regression for 2026-09-29: USERS_DIR was not overridden for the spawned agent,
// so every cron run created mt<tag>h / mt<tag>a in ~/users (64 profiles piled up).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTestAgentEnv, pruneOldRunDirs } = require('../src/mainstream-tester/index.js');

test('spawned agent keeps profiles, data and tokens inside the run dir', () => {
  const dir = path.join(os.tmpdir(), 'mt-run-x');
  const env = buildTestAgentEnv(dir, 1234);
  for (const key of ['AGENT_DATA_DIR', 'USERS_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT']) {
    assert.ok(env[key] && env[key].startsWith(dir), `${key}=${env[key]} must be inside ${dir}`);
  }
  assert.equal(env.TELEGRAM_API_URL, 'http://127.0.0.1:1234');
});

test('pruneOldRunDirs keeps the newest run dirs and the durable log dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-prune-'));
  try {
    for (const ts of [100, 300, 200, 400]) fs.mkdirSync(path.join(root, `mainstream-test-${ts}`));
    fs.mkdirSync(path.join(root, 'mainstream-test'));
    fs.mkdirSync(path.join(root, 'mainstream-logs'));
    const removed = pruneOldRunDirs(root, 2);
    assert.deepEqual(removed.sort(), ['mainstream-test-100', 'mainstream-test-200']);
    assert.deepEqual(fs.readdirSync(root).sort(),
      ['mainstream-logs', 'mainstream-test', 'mainstream-test-300', 'mainstream-test-400']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOldRunDirs on a missing root is a no-op', () => {
  assert.deepEqual(pruneOldRunDirs(path.join(os.tmpdir(), 'no-such-mt-root-xyz')), []);
});
