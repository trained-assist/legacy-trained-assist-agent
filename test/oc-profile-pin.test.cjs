const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// /oc_* commands for the deepseek profile after the VM-wide go/openrouter toggle was removed
// (2026-09-27): deepseek is ONE ladder (Go first, OpenRouter only as the automatic last rung).
// /oc_go, /oc_deepseek, /oc_ds, /oc_ds_go all select it; pinning to OpenRouter is gone.
const { getQuickAnswer } = require('../src/runner/intent-engine');
const profiles = require('../src/profiles');

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-pin-test-'));
}

for (const cmd of ['/oc_deepseek', '/oc_ds', '/oc_ds_go', '/oc_deepseek_go', '/oc_go']) {
  test(`${cmd} selects the deepseek profile (Go first)`, () => {
    const wd = freshWorkDir();
    profiles.setOcProfile(wd, 'max');
    const reply = getQuickAnswer(cmd, 'u1', wd);
    assert.match(reply, /DEEPSEEK/);
    assert.equal(profiles.getOcProfile(wd), 'deepseek');
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

test('legacy stored deepseek-go / deepseek-openrouter read back as the single deepseek ladder', () => {
  for (const legacy of ['deepseek-go', 'deepseek-openrouter']) {
    const wd = freshWorkDir();
    fs.writeFileSync(path.join(wd, 'profile.json'), JSON.stringify({ ocProfile: legacy }));
    assert.equal(profiles.getOcProfile(wd), 'deepseek');
  }
});
