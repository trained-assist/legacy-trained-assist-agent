const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// /oc_* commands for the service profile after the VM-wide go/openrouter toggle was removed
// (2026-09-27) and the ladder rename (llm-ladder #49/#101): service is ONE ladder (Go first,
// OpenRouter only as the automatic last rung). /oc_go, /oc_service, /oc_ds, /oc_ds_go all select
// it; pinning to OpenRouter is gone. Profiles are named after the llm-ladder ladder, so the
// legacy names (ds/deepseek/value → service, x/max → doctor) still work and say so.
const { getQuickAnswer } = require('../src/runner/intent-engine');
const profiles = require('../src/profiles');

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-pin-test-'));
}

for (const cmd of ['/oc_service', '/oc_ds', '/oc_ds_go', '/oc_deepseek_go', '/oc_go']) {
  test(`${cmd} selects the service profile (Go first)`, () => {
    const wd = freshWorkDir();
    profiles.setOcProfile(wd, 'max');
    const reply = getQuickAnswer(cmd, 'u1', wd);
    assert.match(reply, /SERVICE/);
    assert.equal(profiles.getOcProfile(wd), 'service');
  });
}

for (const cmd of ['/oc_openrouter', '/oc_ds_or', '/oc_deepseek_openrouter']) {
  test(`${cmd} no longer switches anything — explains OpenRouter is the automatic last rung`, () => {
    const wd = freshWorkDir();
    profiles.setOcProfile(wd, 'max');
    const reply = getQuickAnswer(cmd, 'u1', wd);
    assert.match(reply, /Ручного переключения на OpenRouter больше нет/);
    assert.equal(profiles.getOcProfile(wd), 'max', 'profile untouched');
  });
}

test('legacy profile names resolve to their ladder (deepseek/value → service, max → doctor)', () => {
  const { ladderFor } = require('../src/opencode-ladder-provider');
  for (const [legacy, ladder] of [['deepseek', 'service'], ['value', 'service'], ['max', 'doctor']]) {
    const wd = freshWorkDir();
    fs.writeFileSync(path.join(wd, 'profile.json'), JSON.stringify({ ocProfile: legacy }));
    // The stored name is kept as-is (no silent rewrite) and resolved on read, so a stored
    // `max` still reaches the doctor ladder instead of falling through to the default.
    assert.equal(profiles.getOcProfile(wd), legacy);
    assert.equal(ladderFor(profiles.getOcProfile(wd)), ladder, `${legacy} keeps its ladder`);
  }
});

test('legacy stored deepseek-go / deepseek-openrouter read back as the single service ladder', () => {
  for (const legacy of ['deepseek-go', 'deepseek-openrouter']) {
    const wd = freshWorkDir();
    fs.writeFileSync(path.join(wd, 'profile.json'), JSON.stringify({ ocProfile: legacy }));
    assert.equal(profiles.getOcProfile(wd), 'service');
  }
});
