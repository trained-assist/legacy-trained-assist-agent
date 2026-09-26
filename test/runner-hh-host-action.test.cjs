'use strict';

// Epic #1470 P1.3-runner-quick: runner HH quick commands go to the host-only
// hh-skill action (runHostAction), not require('../hh-quick'). The provider is
// stubbed here; its own behavior is covered in trained-assist-hh-skill
// tests/behavior/host-quick.test.cjs over a real MCP process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-host-'));
process.env.HOME = home;
delete process.env.OPENROUTER_API_KEY;
const USER = 'hhuser';
fs.mkdirSync(path.join(home, 'agent-tokens', USER, 'hh'), { recursive: true }); // hhConnected
const workDir = fs.mkdtempSync(path.join(home, 'wd-'));

const calls = [];
let reply = async () => 'ok';
const mcpActionPath = require.resolve('../src/mcp-action');
require.cache[mcpActionPath] = { id: mcpActionPath, filename: mcpActionPath, loaded: true,
  exports: { runHostAction: async (req) => { calls.push(req); return reply(req); } } };
const { runQuickAnswer } = require('../src/runner/intent-engine');

async function ask(task) { calls.length = 0; return runQuickAnswer(task, USER, workDir, null); }

test('slash quick commands route to hh_quick_answer with the right intent', async () => {
  const cases = [['/hh_status', 'status'], ['/hh_send_yes', 'send_confirm'], ['/hh_send_no', 'send_cancel'],
    ['/hh_send 123 привет', 'send_preview'], ['/hh_reject_yes', 'reject_confirm'], ['/hh_reject_no', 'reject_cancel'],
    ['/hh_reject', 'reject_dry_run']];
  for (const [task, intent] of cases) {
    reply = async () => `answer:${intent}`;
    assert.equal(await ask(task), `answer:${intent}`, task);
    const last = calls.at(-1);
    assert.equal(last.tool, 'hh_quick_answer');
    assert.equal(last.params.intent, intent, task);
    assert.equal(last.params.task, task);
    assert.equal(last.username, USER);
    assert.equal(last.workDir, workDir);
  }
});

test('empty answer or provider failure falls through to the full session', async () => {
  reply = async () => '';
  assert.equal(await ask('/hh_status'), null);
  reply = async () => { throw Object.assign(new Error('down'), { code: 'ACTION_NOT_FOUND' }); };
  assert.equal(await ask('/hh_status'), null);
});

test('confirm timeout never invites a blind retry; other failures keep the old text', async () => {
  reply = async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }); };
  assert.match(await ask('/hh_send_yes'), /прежде чем повторять/);
  assert.ok(calls.at(-1).timeoutMs >= 120_000, 'confirm gets the long deadline');
  reply = async () => { throw Object.assign(new Error('boom'), { code: 'tool_error' }); };
  assert.equal(await ask('/hh_reject_yes'), '⚠️ Не удалось отклонить — попробуй ещё раз.');
});

test('/hh_evaluate and /hh_scan never produce a quick answer', async () => {
  reply = async () => 'must-not-be-used';
  for (const t of ['/hh_evaluate', '/hh_scan']) {
    assert.equal(await ask(t), null, t);
    assert.ok(!calls.some(c => ['evaluate', 'scan'].includes(c.params.intent)));
  }
});
