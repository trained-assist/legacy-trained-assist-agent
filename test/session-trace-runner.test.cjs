'use strict';
// #1893 slice 3: the runner's opencode stream parser persists streamed parts
// into the durable trace store — the 4 display-relevant event types only, and a
// broken store never breaks the run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-runner-'));
process.env.HOME = ROOT;
process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
process.env.USERS_DIR = path.join(ROOT, 'users');

const { persistOpencodePart } = require('../src/runner/claude-runner');
const store = require('../src/session-trace-store');

const STREAM = [
  { type: 'step_start', sessionID: 'ses_run', part: { id: 'a', type: 'step-start', time: { created: 1 } } },
  { type: 'agent', sessionID: 'ses_run', part: { name: 'build' } },
  { type: 'tool_use', sessionID: 'ses_run', part: { id: 'b', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'x', time: { start: 2 } } } },
  { type: 'text', sessionID: 'ses_run', part: { id: 'c', type: 'text', text: 'Готово', time: { created: 3 } } },
  { type: 'step_finish', sessionID: 'ses_run', part: { id: 'd', type: 'step-finish', reason: 'stop', time: { created: 4 } } },
];

test('4 of 5 stream events land in the store (agent markers are not trace parts)', () => {
  const wd = path.join(ROOT, 'profile');
  const written = STREAM.map(ev => persistOpencodePart(wd, ev.sessionID, ev, 't1'));
  assert.deepEqual(written, [true, false, true, true, true]);
  const r = store.readEvents(wd, 'opencode', 'ses_run');
  assert.deepEqual(r.events.map(e => e.kind), ['step-start', 'tool', 'text', 'step-finish']);
});

test('a throwing store never breaks the run', () => {
  const orig = store.appendEvent;
  store.appendEvent = () => { throw new Error('disk on fire'); };
  try {
    assert.equal(persistOpencodePart(path.join(ROOT, 'p2'), 'ses_x', STREAM[3], 't1'), false);
  } finally { store.appendEvent = orig; }
});

test('no workDir / no engine session id → skipped', () => {
  assert.equal(persistOpencodePart(null, 'ses_x', STREAM[3], 't1'), false);
  assert.equal(persistOpencodePart(path.join(ROOT, 'p3'), null, STREAM[3], 't1'), false);
});
