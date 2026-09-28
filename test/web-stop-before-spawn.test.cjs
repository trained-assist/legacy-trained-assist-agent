'use strict';
// Web e2e 2026-09-25: Stop pressed while a Web task is accepted but has no
// process yet (admission wait / prompt build) returned 409 and the task ran
// anyway. The stop must be remembered (owner-scoped) and honored at spawn.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('stop for a queued session is remembered per owner and consumed once', () => {
  const r = require('../src/runner');
  assert.equal(r.stopSessionTask('alice', 's-web-1'), false, 'nothing queued → not running');
  r._queuedByOwner.set(r._ownerKey('alice', 's-web-1'), 1);
  assert.equal(r.isSessionQueuedFor('alice', 's-web-1'), true);
  assert.equal(r.isSessionQueuedFor('bob', 's-web-1'), false);
  assert.equal(r.stopSessionTask('bob', 's-web-1'), false, 'another profile cannot stop it');
  assert.equal(r._consumePendingStop('alice', 's-web-1'), false);
  assert.equal(r.stopSessionTask('alice', 's-web-1'), true, 'queued stop accepted');
  assert.equal(r._consumePendingStop('bob', 's-web-1'), false);
  assert.equal(r._consumePendingStop('alice', 's-web-1'), true, 'honored at spawn');
  assert.equal(r._consumePendingStop('alice', 's-web-1'), false, 'consumed once');
  r._queuedByOwner.clear();
});

test('stopSessionFor reaches a brand-new session that has no file yet', () => {
  for (const key of Object.keys(require.cache)) if (/\/src\/(web-routes|runner\/index)\.js$/.test(key)) delete require.cache[key];
  const r = require('../src/runner');
  const calls = [];
  r.stopSessionTask = (u, id) => { calls.push([u, id]); return true; };
  r.isSessionQueuedFor = (u, id) => u === 'alice' && id === 's-web-new';
  const { stopSessionFor } = require('../src/web-routes');
  assert.equal(stopSessionFor('alice', 's-web-new'), true);
  assert.equal(stopSessionFor('alice', 's-web-other'), false);
  assert.deepEqual(calls, [['alice', 's-web-new']]);
});

test('runner honors a pending stop at the admission gate and at process registration', () => {
  const fs = require('fs'); const path = require('path');
  const idx = fs.readFileSync(path.join(__dirname, '../src/runner/index.js'), 'utf8');
  assert.match(idx, /if \(consumePendingStop\(opts\.user\.username, opts\.sessionId\)\)/);
  assert.match(idx, /consumePendingStop: \(\) => consumePendingStop\(user\.username, activeSessionId\)/);
  const cr = fs.readFileSync(path.join(__dirname, '../src/runner/claude-runner.js'), 'utf8');
  // The pending stop is honored at process registration. stopEngineProcess sets
  // `userStopped = true` itself (and escalates SIGTERM→SIGKILL via the slot), so
  // the assertion pins the call, not the field assignment.
  assert.match(cr, /activeTimers\.set\(taskId, sessionState\);\n[^\n]*\n  if \(consumePendingStop\?\.\(\)\) \{\n    stopEngineProcess\(sessionState\);/);
});
