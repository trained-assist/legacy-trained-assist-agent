// Wiring test for forceOpencodeAlternation (unified crash-retry provider alternation,
// SESSION-CRASH-RETRY-SPEC.md §2.4 / PR4) — the ladder logic itself is unit-tested in
// test/opencode-ladder.test.cjs; this only checks that runner/index.js's
// _forceOpencodeAlternation advances the right rung and stays a no-op for claude/codex (no
// alternative provider exists for those today). There is no VM-wide go/openrouter toggle any more
// (removed 2026-09-27) — every profile, deepseek included, alternates by advancing its ladder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated state files, set BEFORE requiring runner/index.js — never touch ~/.config/opencode.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-alternation-wiring-test-'));
  process.env.OPENCODE_LADDER_STATE_FILE = path.join(dir, 'ladder-state.json');
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(dir, 'model-health.json');
  delete require.cache[require.resolve('../src/opencode-ladder')];
  delete require.cache[require.resolve('../src/model-health')];
  delete require.cache[require.resolve('../src/runner')];
  const runner = require('../src/runner');
  return { forceOpencodeAlternation: runner._forceOpencodeAlternation, dir };
}

const deepseekProfile = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.opencode', 'profiles', 'deepseek.json'), 'utf8'));

test('non-opencode engines are a no-op (no alternative provider exists for claude/codex today)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'claude', ocProfileName: null, ocProfileOverrides: null }), null);
  assert.equal(forceOpencodeAlternation({ engine: 'codex', ocProfileName: null, ocProfileOverrides: null }), null);
});

test('opencode without a resolved profile or rung is a no-op (nothing to alternate)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'opencode', ocProfileName: null, ocProfileOverrides: null }), null);
  assert.equal(forceOpencodeAlternation({ engine: 'opencode', ocProfileName: 'deepseek', ocProfileOverrides: null }), null);
});

test('deepseek: a failing top rung advances to the same-gateway Go sibling, not to OpenRouter', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek',
    ocProfileOverrides: { model: 'opencode-go/mimo-v2.6-flash' },
  });
  assert.match(note, /следующую ступень лестницы/);
  const next = opencodeLadder.resolveModel(deepseekProfile(), 'deepseek', 'build');
  assert.equal(next, 'opencode-go/deepseek-v4.1-flash', 'next rung is still on Go');
});

test('escalate:false leaves the rung untouched (early same-model retries must not move off it)', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  assert.equal(forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek',
    ocProfileOverrides: { model: 'opencode-go/mimo-v2.6-flash' }, escalate: false,
  }), null);
  assert.equal(opencodeLadder.resolveModel(deepseekProfile(), 'deepseek', 'build'), 'opencode-go/mimo-v2.6-flash');
});

test('ladder profile marks the current model exhausted and returns a user-facing note', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'max',
    ocProfileOverrides: { model: 'anthropic/claude-opus' },
  });
  assert.match(note, /anthropic\/claude-opus/);
  assert.equal(opencodeLadder.resolveModel({ ladder: { build: ['anthropic/claude-opus', 'anthropic/claude-sonnet'] } }, 'max', 'build'), 'anthropic/claude-sonnet');
});

test('all Go keys parked → parkProvider skips every Go rung, the ladder serves OpenRouter, Go returns when the skip lapses', () => {
  freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  const parked = opencodeLadder.parkProvider('deepseek', 'opencode-go/', Date.now() + 10 * 60 * 1000, 'usage limit');
  assert.ok(parked.length >= 2 && parked.every(m => m.startsWith('opencode-go/')));
  for (const role of opencodeLadder.ROLES) {
    assert.equal(opencodeLadder.resolveModel(deepseekProfile(), 'deepseek', role), 'openrouter/deepseek/deepseek-v4-flash-0731', role);
  }
  // Skip window lapses → back on Go without any manual step.
  const file = process.env.OPENCODE_MODEL_HEALTH_FILE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const m of parked) state[m].skipUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(opencodeLadder.resolveModel(deepseekProfile(), 'deepseek', 'build'), 'opencode-go/mimo-v2.6-flash');
});
