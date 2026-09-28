const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoadWatcher } = require('../src/load-watch');

const CORES = 4;
const M = 60_000;

function mk(opts) { return createLoadWatcher(opts); }

test('calm load never alerts', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M });
  for (let i = 0; i < 60; i++) {
    const { event } = w.sample(2.0, CORES, i * M);
    assert.equal(event, null, `tick ${i}`);
  }
});

test('brief spike under the sustain window does not alert', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M });
  // 9 minutes above threshold, then back to normal
  for (let i = 0; i < 9; i++) assert.equal(w.sample(5.0, CORES, i * M).event, null);
  assert.equal(w.sample(2.0, CORES, 9 * M).event, null, 'spike dropped before sustain');
  // counter resets: a later 9-minute rise also stays silent
  for (let i = 10; i < 19; i++) assert.equal(w.sample(5.0, CORES, i * M).event, null);
  assert.equal(w.sample(2.0, CORES, 19 * M).event, null);
});

test('sustained overload alerts exactly once at the sustain boundary', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M });
  const events = [];
  for (let i = 0; i <= 25; i++) {
    const { event } = w.sample(5.0, CORES, i * M);
    if (event) events.push({ i, event });
  }
  assert.deepEqual(events, [{ i: 10, event: 'alert' }], 'alert at minute 10, no repeat while it stays high');
});

test('re-alerts only after the cooldown', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M });
  const events = [];
  let t = 0;
  const runHigh = n => { for (let k = 0; k < n; k++) { const r = w.sample(5.0, CORES, t); t += M; if (r.event) events.push({ at: r.event, t }); } };
  const runLow = n => { for (let k = 0; k < n; k++) { const r = w.sample(2.0, CORES, t); t += M; if (r.event) events.push({ at: r.event, t }); } };
  runHigh(15);          // alert at t=10m
  runLow(5);            // recovery
  runHigh(15);          // rise again at t=20m; threshold crossed 10 min later = t=30m,
                        // but last alert was t=10m → cooldown (30m) not yet passed
  runLow(5);
  runHigh(40);          // by now t > lastAlert + 30m → second alert
  const alerts = events.filter(e => e.at === 'alert');
  assert.equal(alerts.length, 2, `expected 2 alerts, got ${JSON.stringify(events)}`);
});

test('recovery fires only after an alert and only below recoveryRatio', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M, recoveryRatio: 0.7 });
  const events = [];
  let t = 0;
  const step = v => { const r = w.sample(v, CORES, t); t += M; if (r.event) events.push(r.event); };
  for (let i = 0; i < 12; i++) step(5.0);   // alert at i=10
  for (let i = 0; i < 3; i++) step(3.0);    // 3.0 < 3.6 threshold but >= 0.7*4=2.8 → still "elevated"
  assert.equal(events.includes('recovery'), false, 'no recovery while load stays near threshold');
  step(2.0);                                 // 2.0 < 2.8 → recovery
  assert.equal(events[events.length - 1], 'recovery');
  step(2.0);
  assert.equal(events.filter(e => e === 'recovery').length, 1, 'recovery is not repeated');
});

test('recovery after a sub-sustain spike does not notify', () => {
  const w = mk({ sustainMs: 10 * M, cooldownMs: 30 * M });
  const events = [];
  let t = 0;
  const step = v => { const r = w.sample(v, CORES, t); t += M; if (r.event) events.push(r.event); };
  for (let i = 0; i < 5; i++) step(5.0);  // high but never reached sustain
  step(1.0);
  assert.deepEqual(events, [], 'no alert → no recovery');
});

test('a second sustained episode after recovery re-alerts', () => {
  const w = mk({ sustainMs: 5 * M, cooldownMs: 10 * M });
  const events = [];
  let t = 0;
  const step = v => { const r = w.sample(v, CORES, t); t += M; if (r.event) events.push({ e: r.event, t }); };
  for (let i = 0; i < 8; i++) step(5.0);
  for (let i = 0; i < 3; i++) step(1.0);
  for (let i = 0; i < 20; i++) step(5.0);
  const alerts = events.filter(x => x.e === 'alert');
  assert.equal(alerts.length, 2, JSON.stringify(events));
  assert.equal(events.filter(x => x.e === 'recovery').length, 1);
});
