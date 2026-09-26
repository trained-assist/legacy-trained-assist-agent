'use strict';

// Host-only HH actions are reachable only through runHostAction; the generic
// runMcpTool (/action route, action transport) must refuse them (#1470 P1.3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runMcpTool, runHostAction } = require('../src/mcp-action');

test('runMcpTool refuses hh_quick_answer', async () => {
  await assert.rejects(runMcpTool({ tool: 'hh_quick_answer', params: { intent: 'status' }, username: 'u' }),
    (e) => e.code === 'bad_request');
});

test('runHostAction refuses anything that is not a registered host action', async () => {
  await assert.rejects(runHostAction({ tool: 'hh_status', params: {}, username: 'u' }),
    (e) => e.code === 'ACTION_NOT_FOUND');
});
