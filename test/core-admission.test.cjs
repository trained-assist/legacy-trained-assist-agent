'use strict';
// Core admission (epic #1365 PR2): Telegram dialog lane + session writer guard.
// Replaces test/per-chat-queue.test.cjs (the per-chatId queue it covered was
// removed): its invariants P1 (same chat waits), P2 (different chats parallel),
// P4 (busy while running), P6 (FIFO) are kept below as CH-01/CH-02/FIFO; P3
// (chatId=0 never serialized) and P5 (clearChat frees the lane) are replaced
// on purpose — Web now gets the session writer guard (CH-05), and /wakeup may
// only free a lane with no live owner (CH-08).
//
// Fake engine: each "run" is a deferred the test resolves by hand, so overlap
// is observed directly (running counters), not inferred from timing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdmission } = require('../src/core/admission');
const { legacyAdmissionScopes } = require('../src/core/execution-context');

const tick = () => new Promise(r => setImmediate(r));

function fakeEngine(admission) {
  const running = new Set();
  let maxOverlap = 0;
  const log = [];
  function start(name, scopes) {
    let finish;
    const gate = new Promise(r => { finish = r; });
    const done = admission.run(scopes, async () => {
      running.add(name); maxOverlap = Math.max(maxOverlap, running.size); log.push(`${name}:start`);
      await gate;
      running.delete(name); log.push(`${name}:end`);
      return name;
    });
    return { finish, done };
  }
  return { start, running, log, get maxOverlap() { return maxOverlap; } };
}

const tg = (chatId, extra = {}) => legacyAdmissionScopes({ chatId, audience: 'default', profileId: 'alice', ...extra });
const web = sessionId => legacyAdmissionScopes({ chatId: 0, profileId: 'alice', sessionId });

test('CH-01: two sessions in ONE Telegram dialog — B waits for A, no bypass via a new session', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('A', tg(111, { sessionId: 's-A' }));
  await tick();
  assert.ok(a.isBusy(tg(111, { sessionId: 's-B' })), 'the waiting notice must fire for B');
  const B = e.start('B', tg(111, { sessionId: 's-B' }));
  await tick();
  assert.deepEqual([...e.running], ['A']);
  A.finish(); await A.done; await tick();
  assert.deepEqual([...e.running], ['B']);
  B.finish(); await B.done;
  assert.equal(e.maxOverlap, 1);
  assert.ok(!a.isBusy(tg(111)), 'lane released after the last run');
});

test('CH-02: different Telegram chats of one profile+workDir run concurrently', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('A', tg(111, { sessionId: 's-A' }));
  const B = e.start('B', tg(222, { sessionId: 's-B' }));
  await tick();
  assert.deepEqual([...e.running].sort(), ['A', 'B']);
  A.finish(); B.finish(); await Promise.all([A.done, B.done]);
});

test('CH-03: five Web sessions of one profile+folder all really run at once', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const runs = [1, 2, 3, 4, 5].map(i => e.start(`W${i}`, web(`s-${i}`)));
  await tick();
  assert.equal(e.running.size, 5, 'queued-only does not count — all five must be running');
  runs.forEach(r => r.finish()); await Promise.all(runs.map(r => r.done));
});

test('CH-04: Web + Telegram on different sessions of one profile overlap', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const T = e.start('T', tg(111, { sessionId: 's-T' }));
  const W = e.start('W', web('s-W'));
  await tick();
  assert.equal(e.running.size, 2);
  T.finish(); W.finish(); await Promise.all([T.done, W.done]);
});

test('CH-05: Web + Telegram (and two tabs) on the SAME session — one writer; other sessions unaffected', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const T = e.start('T', tg(111, { sessionId: 's-1' }));
  const W1 = e.start('W1', web('s-1'));
  const W2 = e.start('W2', web('s-1'));
  const other = e.start('X', web('s-2'));
  await tick();
  assert.deepEqual([...e.running].sort(), ['T', 'X']);
  T.finish(); await T.done; await tick();
  assert.deepEqual([...e.running].sort(), ['W1', 'X'], 'FIFO: first tab next');
  W1.finish(); await W1.done; await tick();
  assert.ok(e.running.has('W2'));
  W2.finish(); other.finish(); await Promise.all([W2.done, other.done]);
});

test('CH-06: forum topics and bot endpoints are separate lanes; the same topic is one lane', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const t1 = e.start('t1', legacyAdmissionScopes({ chatId: -100, audience: 'default', threadId: 5 }));
  const t2 = e.start('t2', legacyAdmissionScopes({ chatId: -100, audience: 'default', threadId: 6 }));
  const t1b = e.start('t1b', legacyAdmissionScopes({ chatId: -100, audience: 'default', threadId: 5 }));
  const rec = e.start('rec', legacyAdmissionScopes({ chatId: -100, audience: 'recruiter', threadId: 5 }));
  await tick();
  assert.deepEqual([...e.running].sort(), ['rec', 't1', 't2']);
  [t1, t2, rec].forEach(r => r.finish()); await Promise.all([t1.done, t2.done, rec.done]); await tick();
  assert.ok(e.running.has('t1b'));
  t1b.finish(); await t1b.done;
});

test('atomic + FIFO: a later request never overtakes an earlier one on a shared scope (no starvation)', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('A', ['session:alice:s-1']);            // holds s-1
  const B = e.start('B', ['lane:L', 'session:alice:s-1']);  // waits for s-1 — must NOT grab L alone
  const C = e.start('C', ['lane:L']);                        // L is free, but B is ahead on L
  await tick();
  assert.deepEqual([...e.running], ['A']);
  A.finish(); await A.done; await tick();
  assert.deepEqual([...e.running], ['B']);
  B.finish(); await B.done; await tick();
  assert.deepEqual([...e.running], ['C']);
  C.finish(); await C.done;
  assert.deepEqual(e.log, ['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']);
});

test('failure of the holder releases every scope and propagates the error', async () => {
  const a = createAdmission();
  await assert.rejects(a.run(['lane:L', 'session:p:s'], async () => { throw Error('boom'); }), /boom/);
  assert.ok(!a.isBusy(['lane:L', 'session:p:s']));
});

test('CH-08: forceRelease frees a stale lane; the late release of the old owner never frees the new owner', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const Old = e.start('Old', ['lane:L']);
  const New = e.start('New', ['lane:L']);
  await tick();
  assert.ok(a.forceRelease('lane:L'));
  await tick();
  assert.ok(e.running.has('New'), 'next task admitted after forced release');
  Old.finish(); await Old.done; await tick();
  assert.ok(a.isHeld('lane:L'), 'old owner finishing late must not release the new owner');
  New.finish(); await New.done;
  assert.ok(!a.isBusy(['lane:L']));
});

test('no scopes (headless internal / durable job) → runs immediately, never serialized', async () => {
  const a = createAdmission();
  const scopes = legacyAdmissionScopes({ chatId: null, profileId: 'alice' });
  assert.deepEqual(scopes, []);
  assert.equal(await a.run(scopes, () => 7), 7);
});

test('RC-03: the explicit parallel flag is the only way past the dialog lane', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('A', tg(111, { sessionId: 's-A' }));
  await tick();
  assert.ok(a.isBusy(tg(111, { sessionId: 's-P' })), 'a default run must still see the busy lane (CH-01 unchanged)');
  const P = e.start('P', tg(111, { sessionId: 's-P', parallel: true }));
  await tick();
  assert.deepEqual([...e.running].sort(), ['A', 'P'], 'only the flagged run overlaps the lane holder');
  A.finish(); await A.done; await tick();
  assert.ok(e.running.has('P'), 'parallel run is not tied to the lane holder lifetime');
  P.finish(); await P.done;
  assert.equal(e.maxOverlap, 2);
  assert.ok(!a.isBusy(tg(111)), 'lane released — it was held by A only');
});

test('RC-03: parallel never bypasses the session writer guard (two writers of one history stay impossible)', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('A', tg(111, { sessionId: 's-1' }));
  await tick();
  const P = e.start('P', tg(111, { sessionId: 's-1', parallel: true }));
  await tick();
  assert.deepEqual([...e.running], ['A'], 'same session + parallel → P waits for the writer slot');
  A.finish(); await A.done; await tick();
  assert.ok(e.running.has('P'));
  P.finish(); await P.done;
});

test('scope keys: lane from ConversationRef (endpoint+chat+topic), session keyed by profile', () => {
  assert.deepEqual(legacyAdmissionScopes({ chatId: 5, audience: 'default', threadId: 7, profileId: 'u', sessionId: 's1' }),
    ['lane:cref1|telegram|default|5|7', 'session:u:s1']);
  assert.deepEqual(legacyAdmissionScopes({ chatId: 0, profileId: 'u', sessionId: 's1' }), ['session:u:s1']);
  // unknown audience still gets a lane — never silently unserialized
  assert.equal(legacyAdmissionScopes({ chatId: 5, audience: 'ghost' }).length, 1);
  // RC-03 parallel: drops ONLY the lane (both the ConversationRef and the legacy
  // fallback form); the session writer guard survives every time.
  assert.deepEqual(legacyAdmissionScopes({ chatId: 5, audience: 'default', threadId: 7, profileId: 'u', sessionId: 's1', parallel: true }),
    ['session:u:s1']);
  assert.deepEqual(legacyAdmissionScopes({ chatId: 5, audience: 'ghost', parallel: true }), []);
});
