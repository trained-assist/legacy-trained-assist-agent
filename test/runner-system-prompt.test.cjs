'use strict';
// runner/system-prompt.js — layer order of the per-run system prompt (moved out of
// runner/index.js _runTask). Locks the observable contract: base prompt first, then
// the answer-router mode block; OpenCode gets the runtime capabilities block on top.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assembleSystemPrompt } = require('../src/runner/system-prompt');
const answerRouter = require('../src/answer-router');

function run(overrides = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysprompt-'));
  const mcpConfig = path.join(workDir, '.mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
  const out = assembleSystemPrompt({
    user: { workDir, username: 'u1', audience: 'default' },
    boundProjectId: null, mcpConfig, activeSessionId: null,
    explicitMode: null, internalGtd: false, engine: 'claude', secrets: {},
    ...overrides,
  });
  return { ...out, workDir };
}

test('claude: base prompt then the one-shot mode block, written to .system-prompt.txt (0600)', () => {
  const r = run();
  const base = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent-system-prompt.txt'), 'utf8');
  assert.ok(r.systemPromptText.startsWith(base.slice(0, 200)), 'starts with the base prompt');
  assert.ok(r.systemPromptText.includes(answerRouter.buildOneshotBlock().trim().slice(0, 60)), 'one-shot block appended');
  assert.equal(r.systemPromptFile, path.join(r.workDir, '.system-prompt.txt'));
  assert.equal(fs.statSync(r.systemPromptFile).mode & 0o777, 0o600);
  assert.equal(r.ocCapBlock, '');
  assert.equal(r.ocSystemPrompt, r.systemPromptText);
});

test('clarify wins over the default mode; internal GTD turns get no one-shot block', () => {
  assert.ok(run({ explicitMode: 'clarify' }).systemPromptText.includes(answerRouter.buildClarifyBlock().trim().slice(0, 60)));
  const gtd = run({ internalGtd: true }).systemPromptText;
  assert.ok(!gtd.includes(answerRouter.buildOneshotBlock().trim().slice(0, 60)));
});

test('opencode: capabilities block is appended after the prompt', () => {
  const r = run({ engine: 'opencode' });
  assert.ok(r.ocCapBlock.startsWith('## Возможности системы (runtime)'));
  assert.equal(r.ocSystemPrompt, `${r.systemPromptText}\n\n${r.ocCapBlock}`);
});
