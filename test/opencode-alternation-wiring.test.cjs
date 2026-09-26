// Wiring test for forceOpencodeAlternation (unified crash-retry provider alternation,
// SESSION-CRASH-RETRY-SPEC.md §2.4 / PR4) — the ladder/toggle logic itself is unit-tested in
// test/opencode-ladder.test.cjs and test/opencode-go-toggle.test.cjs; this only checks that
// runner/index.js's _forceOpencodeAlternation calls the right one for the right profile shape,
// and stays a no-op for claude/codex (no alternative provider exists for those today).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated state files, set BEFORE requiring runner/index.js (which requires opencode-ladder and
// opencode-go-toggle at module top) — same pattern as test/opencode-ladder.test.cjs — so this
// never touches the real ~/.config/opencode/*.json.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-alternation-wiring-test-'));
  process.env.OPENCODE_LADDER_STATE_FILE = path.join(dir, 'ladder-state.json');
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(dir, 'model-health.json');
  process.env.OPENCODE_GO_MODE_FILE = path.join(dir, 'go-mode.json');
  delete require.cache[require.resolve('../src/opencode-ladder')];
  delete require.cache[require.resolve('../src/opencode-go-toggle')];
  delete require.cache[require.resolve('../src/runner')];
  const runner = require('../src/runner');
  return { forceOpencodeAlternation: runner._forceOpencodeAlternation, dir };
}

test('non-opencode engines are a no-op (no alternative provider exists for claude/codex today)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'claude', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
  assert.equal(forceOpencodeAlternation({ engine: 'codex', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
});

test('opencode without a resolved profile is a no-op (nothing to alternate)', () => {
  const { forceOpencodeAlternation } = freshModule();
  assert.equal(forceOpencodeAlternation({ engine: 'opencode', ocProfileName: null, ocProfileOverrides: null, ocProfileIsDeepseek: false }), null);
});

test('deepseek profile with a resolved rung advances its OWN ladder (same gateway), not the VM toggle', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeGoToggle = require('../src/opencode-go-toggle');
  const opencodeLadder = require('../src/opencode-ladder');
  const fs = require('node:fs');
  const path = require('node:path');
  assert.equal(opencodeGoToggle.getMode(), 'go');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek-go',
    ocProfileOverrides: { model: 'opencode-go/deepseek-v4.1-flash' }, ocProfileIsDeepseek: true,
  });
  // 2026-09-26: both deepseek-gateway profiles carry a real ladder, so escalation advances to the
  // next rung on the SAME gateway (deepseek-v4.1-flash → deepseek-v4-flash) instead of dragging
  // the whole team's VM toggle across to OpenRouter for one flaky rung.
  assert.match(note, /следующую ступень лестницы/);
  assert.equal(opencodeGoToggle.getMode(), 'go', 'the VM-wide toggle must NOT flip when a same-gateway sibling rung exists');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.opencode', 'profiles', 'deepseek-go.json'), 'utf8'));
  assert.notEqual(opencodeLadder.resolveModel(raw, 'deepseek-go', 'build'), 'opencode-go/deepseek-v4.1-flash',
    'the failed rung must be skipped on the next resolve');
});

test('deepseek profile with no resolved rung falls back to flipping the VM toggle', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeGoToggle = require('../src/opencode-go-toggle');
  assert.equal(opencodeGoToggle.getMode(), 'go');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek-go',
    ocProfileOverrides: null, ocProfileIsDeepseek: true,
  });
  assert.match(note, /go→openrouter/);
  assert.equal(opencodeGoToggle.getMode(), 'openrouter');
});

test('escalate:false leaves the rung untouched (early same-model retries must not move off it)', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeGoToggle = require('../src/opencode-go-toggle');
  const opencodeLadder = require('../src/opencode-ladder');
  assert.equal(forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'max',
    ocProfileOverrides: { model: 'anthropic/claude-opus' }, ocProfileIsDeepseek: false, escalate: false,
  }), null);
  assert.equal(opencodeLadder.resolveModel({ ladder: { build: ['anthropic/claude-opus', 'anthropic/claude-sonnet'] } }, 'max', 'build'),
    'anthropic/claude-opus', 'an early same-model retry must not have advanced the ladder');
  assert.equal(forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'deepseek-go',
    ocProfileOverrides: { model: 'opencode-go/deepseek-v4.1-flash' }, ocProfileIsDeepseek: true, escalate: false,
  }), null);
  assert.equal(opencodeGoToggle.getMode(), 'go');
});

test('ladder profile marks the current model exhausted and returns a user-facing note', () => {
  const { forceOpencodeAlternation } = freshModule();
  const opencodeLadder = require('../src/opencode-ladder');
  const note = forceOpencodeAlternation({
    engine: 'opencode', ocProfileName: 'max',
    ocProfileOverrides: { model: 'anthropic/claude-opus' }, ocProfileIsDeepseek: false,
  });
  assert.match(note, /anthropic\/claude-opus/);
  assert.equal(opencodeLadder.resolveModel({ ladder: { build: ['anthropic/claude-opus', 'anthropic/claude-sonnet'] } }, 'max', 'build'), 'anthropic/claude-sonnet');
});
