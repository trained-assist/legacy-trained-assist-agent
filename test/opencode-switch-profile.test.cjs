'use strict';
// infra/opencode-switch-profile.sh runs on every deploy and writes the machine-wide
// ~/.config/opencode/opencode.json. A `"model": null` there makes opencode reject the whole config
// (every OpenCode task exits 1 at start). Since #1687 the script takes the shape from
// src/opencode-ladder-provider.js — run the real script against every profile.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'infra', 'opencode-switch-profile.sh');
const provider = require('../src/opencode-ladder-provider');

function run(profile, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-switch-'));
  const out = path.join(dir, 'opencode.json');
  if (env.PRE) fs.writeFileSync(out, env.PRE);
  const r = spawnSync('bash', [SCRIPT, profile], {
    env: { ...process.env, OPENCODE_CONFIG_OUT: out, SECRETS_ENV: path.join(dir, 'none.env'), HOME: dir, ...env },
    encoding: 'utf8',
  });
  return { r, out };
}

for (const profile of provider.PROFILES) {
  test(`${profile}: writes the worker provider and the ladder model per role`, () => {
    const { r, out } = run(profile);
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(cfg.model, provider.modelFor(profile, 'build'));
    for (const role of provider.ROLES) assert.strictEqual(cfg.agent[role].model, provider.modelFor(profile, role), `${profile}.${role}`);
    assert.ok(cfg.provider.ladder.options.baseURL.endsWith('/v1'));
    assert.strictEqual(cfg.agent.review.permission.edit, 'deny', 'base.json agent fields survive the merge');
  });
}

test('russian keeps its reviewer rolePrompt', () => {
  const { r, out } = run('russian');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).agent.review.prompt, /рецензент/);
});

test('unknown profile: exits non-zero and keeps the previous config', () => {
  const prev = '{"model":"ladder/service:build"}';
  const { r, out } = run('nonexistent', { PRE: prev });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), prev);
});
