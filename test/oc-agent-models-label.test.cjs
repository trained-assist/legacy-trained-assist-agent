const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 2026-09-27: step/error log lines named the GLOBAL opencode.json model (opencode-go/gpt-6-luna)
// while the run was actually on OpenRouter via the per-invocation OPENCODE_CONFIG — the label must
// come from the run's own ocProfileOverrides.
test('readOcAgentModels labels a run by its per-invocation overrides, not the global config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-label-test-'));
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    model: 'opencode-go/gpt-6-luna', agent: { build: { model: 'opencode-go/gpt-6-luna' } },
  }));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { readOcAgentModels } = require('../src/runner/claude-runner');
    const or = 'openrouter/deepseek/deepseek-v4-flash-0731';
    const labels = readOcAgentModels({ model: or, agent: { build: { model: or } } });
    assert.equal(labels.build, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(labels._default, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(readOcAgentModels().build, 'opencode-go/gpt-6-luna', 'no overrides → global config as before');
  } finally {
    process.env.HOME = prevHome;
  }
});
