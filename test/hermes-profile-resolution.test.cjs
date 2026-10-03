'use strict';
// Issue #2065: Hermes profile resolution must understand the per-role profiles — master/phd/free
// included — instead of only the pre-#2065 single-ladder names. An explicit valid profile passes
// through; an unknown name and no profile at all fall back to the research default (never an
// unknown ladder on the worker); a non-opencode engine carries no OpenCode profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveHermesProfile } = require('../src/hermes-tools-run');
const ocLadder = require('../src/opencode-ladder-provider');

test('no profile + opencode → the research default (hermes_research keeps its Go-first ladder)', () => {
  assert.equal(resolveHermesProfile(null, 'opencode'), 'research');
  assert.equal(resolveHermesProfile(undefined, 'opencode'), 'research');
});

test('master/phd/free pass through — the per-role profiles are understood (#2065)', () => {
  const buildLadder = { master: 'ladder/build', phd: 'ladder/build advanced', free: 'ladder/free' };
  for (const profile of ['master', 'phd', 'free']) {
    assert.equal(resolveHermesProfile(profile, 'opencode'), profile);
    // The resolved profile must be a real provider profile with a per-role ladder table.
    assert.ok(ocLadder.PROFILES.includes(profile), `${profile} is a selectable profile`);
    assert.equal(ocLadder.modelFor(profile, 'build'), buildLadder[profile]);
  }
});

test('every other known profile passes through too', () => {
  for (const profile of ocLadder.PROFILES) {
    assert.equal(resolveHermesProfile(profile, 'opencode'), profile);
  }
});

test('unknown profile name → research fallback, never an unknown ladder', () => {
  assert.equal(resolveHermesProfile('no-such-profile', 'opencode'), 'research');
  assert.equal(resolveHermesProfile('value', 'opencode'), 'research', 'a legacy alias is not a profile name');
});

test('no profile + non-opencode engine → null (the engine has no OpenCode profile)', () => {
  assert.equal(resolveHermesProfile(null, 'claude'), null);
  assert.equal(resolveHermesProfile(null, 'codex'), null);
});
