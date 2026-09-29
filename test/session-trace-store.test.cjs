'use strict';
// Durable trace store (#1893): append/read, resume dedup, torn lines, cap, prune,
// filename guard, unreadable dir — all best-effort, never throwing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/session-trace-store');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
const part = (id, at, extra = {}) => ({ id, type: 'text', text: `t${id}`, time: { created: at }, ...extra });

test('append → read returns normalized events in time order', () => {
  const wd = tmp();
  assert.equal(store.appendEvent(wd, 'opencode', 'ses_a', part('b', 20)), true);
  assert.equal(store.appendEvent(wd, 'opencode', 'ses_a', part('a', 10)), true);
  const r = store.readEvents(wd, 'opencode', 'ses_a');
  assert.equal(r.found, true);
  assert.deepEqual(r.events.map(e => e.text), ['ta', 'tb']);
  assert.equal(r.events[0].kind, 'text');
});

test('resume: same file, re-sent id collapses, later copy wins', () => {
  const wd = tmp();
  store.appendEvent(wd, 'opencode', 'ses_r', { id: 'x', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 5 } } }, { taskId: 't1' });
  store.appendEvent(wd, 'opencode', 'ses_r', { id: 'x', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok', time: { start: 5 } } }, { taskId: 't2' });
  const r = store.readEvents(wd, 'opencode', 'ses_r');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].state, 'completed');
  assert.equal(fs.readdirSync(path.join(wd, '.session-traces')).length, 1);
});

test('torn line is skipped, the rest survives', () => {
  const wd = tmp();
  store.appendEvent(wd, 'opencode', 'ses_t', part('a', 1));
  fs.appendFileSync(store.traceFile(wd, 'opencode', 'ses_t'), '{"v":1,"id":"b","ev":{"ki\n');
  store.appendEvent(wd, 'opencode', 'ses_t', part('c', 3));
  assert.deepEqual(store.readEvents(wd, 'opencode', 'ses_t').events.map(e => e.text), ['ta', 'tc']);
});

test('cap: appends past MAX_EVENTS are dropped', () => {
  const wd = tmp();
  const file = store.traceFile(wd, 'opencode', 'ses_cap');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ v: 1, id: 'z', ev: { kind: 'text', at: 1 } })}\n`.repeat(store.MAX_EVENTS));
  assert.equal(store.appendEvent(wd, 'opencode', 'ses_cap', part('new', 2)), false);
});

test('prune drops files older than TTL', () => {
  const wd = tmp();
  store.appendEvent(wd, 'opencode', 'ses_old', part('a', 1));
  const file = store.traceFile(wd, 'opencode', 'ses_old');
  const old = (Date.now() - store.TTL_MS - 60000) / 1000;
  fs.utimesSync(file, old, old);
  store.prune(wd);
  assert.equal(fs.existsSync(file), false);
});

test('bad names and bad parts are refused without throwing', () => {
  const wd = tmp();
  assert.equal(store.appendEvent(wd, 'opencode', '../etc/passwd', part('a', 1)), false);
  assert.equal(store.appendEvent(wd, 'Open Code', 'ses_a', part('a', 1)), false);
  assert.equal(store.appendEvent(wd, 'opencode', 'ses_a', null), false);
  assert.equal(store.appendEvent(null, 'opencode', 'ses_a', part('a', 1)), false);
  assert.deepEqual(store.readEvents(wd, 'opencode', '../x'), { found: false });
  assert.deepEqual(store.readEvents(wd, 'opencode', 'ses_missing'), { found: false });
});

test('unwritable store dir → false, never throws', () => {
  const wd = tmp();
  fs.writeFileSync(path.join(wd, '.session-traces'), 'not a dir');
  assert.equal(store.appendEvent(wd, 'opencode', 'ses_a', part('a', 1)), false);
  assert.deepEqual(store.readEvents(wd, 'opencode', 'ses_a'), { found: false });
});
