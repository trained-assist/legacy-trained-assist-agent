const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// /oc_ds_or, /oc_ds_go (aka /oc_deepseek_openrouter, /oc_deepseek_go) — pin THIS profile to a
// concrete deepseek-* gateway file directly, bypassing the shared VM-wide go/openrouter toggle
// (src/opencode-go-toggle.js) that /oc_deepseek follows. Added because there was no per-profile
// way to force OpenRouter without flipping the toggle for every "deepseek" user on the VM.
const { getQuickAnswer } = require('../src/runner/intent-engine');
const profiles = require('../src/profiles');
const opencodeLadder = require('../src/opencode-ladder');

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-pin-test-'));
}

test('/oc_ds_or pins ocProfile to the literal deepseek-openrouter file', () => {
  const wd = freshWorkDir();
  const reply = getQuickAnswer('/oc_ds_or', 'u1', wd);
  assert.match(reply, /OpenRouter/);
  assert.match(reply, /Закреплено намертво/);
  assert.equal(profiles.getOcProfile(wd), 'deepseek-openrouter');
  const overrides = opencodeLadder.buildOcProfileOverrides(profiles.getOcProfile(wd));
  assert.equal(overrides.model, 'openrouter/deepseek/deepseek-v4-flash-0731');
});

test('/oc_deepseek_openrouter is a full-word alias for /oc_ds_or', () => {
  const wd = freshWorkDir();
  getQuickAnswer('/oc_deepseek_openrouter', 'u1', wd);
  assert.equal(profiles.getOcProfile(wd), 'deepseek-openrouter');
});

test('/oc_ds_go pins ocProfile to the literal deepseek-go file', () => {
  const wd = freshWorkDir();
  const reply = getQuickAnswer('/oc_ds_go', 'u1', wd);
  assert.match(reply, /закреплено на Go/);
  assert.equal(profiles.getOcProfile(wd), 'deepseek-go');
  const overrides = opencodeLadder.buildOcProfileOverrides(profiles.getOcProfile(wd));
  assert.equal(overrides.model, 'opencode-go/deepseek-v4.1-flash');
});

test('/oc_deepseek_go is a full-word alias for /oc_ds_go', () => {
  const wd = freshWorkDir();
  getQuickAnswer('/oc_deepseek_go', 'u1', wd);
  assert.equal(profiles.getOcProfile(wd), 'deepseek-go');
});

test('/oc_deepseek (logical) is unaffected — still stores the bare "deepseek" marker', () => {
  const wd = freshWorkDir();
  const reply = getQuickAnswer('/oc_deepseek', 'u1', wd);
  assert.match(reply, /общий, единая модель/);
  assert.equal(profiles.getOcProfile(wd), 'deepseek');
});

test('/oc_go and /oc_openrouter (VM-wide toggle) are not swallowed by the new aliases', () => {
  const wd = freshWorkDir();
  const reply = getQuickAnswer('/oc_openrouter', 'u1', wd);
  assert.match(reply, /Общий тумблер OpenCode Go\/OpenRouter/);
  // The VM toggle never touches per-profile ocProfile.
  assert.equal(profiles.getOcProfile(wd), 'max');
});
