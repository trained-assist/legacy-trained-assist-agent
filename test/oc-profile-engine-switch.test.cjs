'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fix for the 2026-09-25 report: a chat pinned to codex hit Codex's usage limit; the user ran
// /oc_deepseek expecting to move to OpenCode, but that only set the OpenCode model profile and
// left the engine on codex, so the next task kept failing. /oc_* must now also move THIS chat's
// engine to opencode and say so.
const { getQuickAnswer } = require('../src/runner/intent-engine');
const profiles = require('../src/profiles');

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-engine-switch-test-'));
}

test('/oc_deepseek switches a codex-pinned chat to the opencode engine', () => {
  const wd = freshWorkDir();
  profiles.setEngine(wd, 'codex', '123');
  const reply = getQuickAnswer('/oc_deepseek', 'u1', wd, false, '123');
  assert.equal(profiles.getOcProfile(wd), 'service');
  assert.equal(profiles.getEngine(wd, '123'), 'opencode');
  assert.match(reply, /Движок этого чата переключён с Codex CLI на OpenCode/);
});

test('/oc_max switches a claude-pinned chat to opencode and names the old engine', () => {
  const wd = freshWorkDir();
  profiles.setEngine(wd, 'claude', '123');
  const reply = getQuickAnswer('/oc_max', 'u1', wd, false, '123');
  assert.equal(profiles.getEngine(wd, '123'), 'opencode');
  assert.match(reply, /переключён с Claude Code на OpenCode/);
});

test('already on opencode → no engine-change note', () => {
  const wd = freshWorkDir();
  profiles.setEngine(wd, 'opencode', '123');
  const reply = getQuickAnswer('/oc_deepseek', 'u1', wd, false, '123');
  assert.equal(profiles.getEngine(wd, '123'), 'opencode');
  assert.doesNotMatch(reply, /переключён/);
});

test('the engine switch is scoped to the calling chat, not the profile default', () => {
  const wd = freshWorkDir();
  profiles.setEngine(wd, 'codex', 'chatA');
  profiles.setEngine(wd, 'claude', 'chatB');
  getQuickAnswer('/oc_deepseek', 'u1', wd, false, 'chatA');
  assert.equal(profiles.getEngine(wd, 'chatA'), 'opencode');
  assert.equal(profiles.getEngine(wd, 'chatB'), 'claude');
});
