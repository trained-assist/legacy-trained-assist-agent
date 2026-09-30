'use strict';
// Ф5 (web visibility): isSessionRunning() deliberately merges "accepted and
// waiting at admission" with "process is live" (the GTD guard needs the union),
// which left the web UI unable to render a visible «⏳ В очереди» — a second
// tab could not tell that its session's other writer is only QUEUED, not gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionRunPhase, _queuedSessions } = require('../src/runner');

test('sessionRunPhase: null when idle, queued while accepted-not-spawned, running while a process owns the session', () => {
  const sid = 's-web-phase-test';
  try {
    assert.equal(sessionRunPhase('alice', sid), null, 'idle session has no phase');
    _queuedSessions.add(sid);
    assert.equal(sessionRunPhase('alice', sid), 'queued', 'accepted-but-waiting is visible as queued');
    // The spawned state is exercised by the live runner (activeTimers owns it);
    // here we only pin that queued clears back to null with the session.
    _queuedSessions.delete(sid);
    assert.equal(sessionRunPhase('alice', sid), null, 'phase disappears with the run');
    assert.equal(sessionRunPhase('alice', ''), null);
    assert.equal(sessionRunPhase('alice', null), null);
  } finally {
    _queuedSessions.delete(sid);
  }
});
