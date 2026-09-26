'use strict';
// infra/opencode-switch-profile.sh runs on every deploy and writes the machine-wide
// ~/.config/opencode/opencode.json. #1476 moved profiles to `ladderRef`, the script only knew
// `ladder`/`model`, wrote `"model": null`, and opencode then rejected the whole config — every
// OpenCode task exited 1 at start. Run the real script against every real profile.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'infra', 'opencode-switch-profile.sh');
const routing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'model-routing.json'), 'utf8'));
const PUBLIC = ['max', 'value', 'free', 'russian'];

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

for (const profile of PUBLIC) {
  test(`${profile}: writes a string model = first rung of its ladder`, () => {
    const { r, out } = run(profile);
    assert.strictEqual(r.status, 0, r.stderr);
    const cfg = JSON.parse(fs.readFileSync(out, 'utf8'));
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, '.opencode', 'profiles', `${profile}.json`), 'utf8'));
    const ladder = p.ladderRef ? routing.ladders[p.ladderRef] : p.ladder;
    assert.strictEqual(typeof cfg.model, 'string');
    assert.strictEqual(cfg.model, p.model || ladder.build[0]);
    for (const [role, rungs] of Object.entries(ladder)) {
      assert.strictEqual(cfg.agent[role].model, rungs[0], `${profile}.${role}`);
    }
  });
}

test('russian keeps its reviewer rolePrompt', () => {
  const { r, out } = run('russian');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(JSON.parse(fs.readFileSync(out, 'utf8')).agent.review.prompt, /рецензент/);
});

test('unresolvable ladder: exits non-zero and keeps the previous config', () => {
  const prev = '{"model":"opencode-go/glm-5.3"}';
  const { r, out } = run('max', { PRE: prev, OPENCODE_ROUTING_FILE: '/nonexistent/routing.json' });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), prev);
});
