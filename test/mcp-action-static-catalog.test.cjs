'use strict';

// The /action + cron name gate runs in the shared server process, which has no
// USER_ID. Tools whose module isReady() keys on USER_ID must still be known to
// the gate; readiness is the per-user child's job (#1530 — cron hh_proactive_search
// failed "Unknown tool" before any child was spawned).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-1530-'));
fs.writeFileSync(path.join(dir, '10-gated.js'), `module.exports = {
  isReady: () => !!process.env.USER_ID,
  setupTools: ['gated_setup'],
  tools: {
    gated_setup: { description: 's', handler: async () => 'ok' },
    gated_action: { description: 'a', handler: async () => 'ok' },
  },
};`);
process.env.TOOLS_DIR = dir;
delete process.env.USER_ID;
delete process.env.AGENT_USER_ID;

// Siblings also honour TOOLS_DIR; keep this test about the core gate only.
const siblingsPath = require.resolve('../src/skill-siblings');
require.cache[siblingsPath] = { id: siblingsPath, filename: siblingsPath, loaded: true,
  exports: { ...require('../src/skill-siblings'), presentSiblings: () => [] } };

const registry = require('../src/mcp-skills/registry');
const { listActionTools } = require('../src/mcp-action');

test('server-process listTools hides the ready-gated tool (precondition)', () => {
  assert.deepEqual(registry.listTools().map(t => t.name), ['gated_setup']);
});

test('action gate knows ready-gated tools without USER_ID', () => {
  const names = listActionTools().map(t => t.name);
  assert.ok(names.includes('gated_action'), 'gated_action must pass the name gate');
  assert.ok(names.includes('gated_setup'));
});
