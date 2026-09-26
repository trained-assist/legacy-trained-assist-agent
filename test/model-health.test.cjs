// Unit tests for src/model-health.js — the unified PER-MODEL health store (issue #1467).
//
// Owner decisions under test:
//   - "клиент единый сервис, единый для всех профилей" → one health record per MODEL, shared by
//     every profile/role (no profile/role in the key).
//   - "ошибка разовая обычно" → first rollback short (15s), then ×2.
//   - ladders/policy are config-driven (config/model-routing.json), with code defaults so a
//     missing/unreadable config never breaks model selection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mh = require('../src/model-health');

// Fresh isolated state file per test. model-health resolves the path lazily on every call, so
// setting the env var is enough (no require-cache dance).
function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-test-'));
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(dir, 'model-health.json');
  mh.clear();
  return dir;
}

function writeConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routing-test-'));
  const f = path.join(dir, 'routing.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  process.env.MODEL_ROUTING_CONFIG = f;
  return f;
}

test('backoff sequence is 15s → ×2 → capped at 5min', () => {
  const p = { baseMs: 15000, multiplier: 2, capMs: 300000 };
  const seq = [1, 2, 3, 4, 5, 6, 7].map(n => mh.backoffFor(n, p));
  assert.deepEqual(seq, [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
});

test('policy reads config/model-routing.json and falls back to code defaults when it is absent', () => {
  delete process.env.MODEL_ROUTING_CONFIG;
  const p = mh.policy();
  assert.equal(p.baseMs, 15000);
  assert.equal(p.multiplier, 2);
  assert.equal(p.capMs, 300000);
  assert.equal(p.failureWindowMs, 900000);

  // A missing file must not throw and must yield the same defaults.
  process.env.MODEL_ROUTING_CONFIG = path.join(os.tmpdir(), `no-such-routing-${Date.now()}.json`);
  const d = mh.policy();
  assert.equal(d.baseMs, 15000);
  assert.equal(d.multiplier, 2);
  delete process.env.MODEL_ROUTING_CONFIG;
});

test('policy honors a custom config — backoff is config-driven, not hardcoded', () => {
  writeConfig({ backoff: { baseMs: 1000, multiplier: 3, capMs: 10000, failureWindowMs: 5000 } });
  const p = mh.policy();
  assert.equal(p.baseMs, 1000);
  assert.equal(p.multiplier, 3);
  assert.equal(p.capMs, 10000);
  assert.equal(mh.backoffFor(1, p), 1000);
  assert.equal(mh.backoffFor(2, p), 3000);
  assert.equal(mh.backoffFor(4, p), 10000); // capped
  delete process.env.MODEL_ROUTING_CONFIG;
});

test('a transient failure skips the model (one shared record) and carries a ~15s retry delay', () => {
  tmpState();
  const model = 'opencode-go/deepseek-v4.1-flash';
  const e = mh.recordFailure(model, { class: 'transient', errorText: 'Bad Request' });
  assert.equal(e.failures, 1);
  assert.ok(mh.isSkipped(model), 'the flaky model is skipped for every profile sharing it');
  const d = mh.nextRetryDelayMs(model);
  assert.ok(d >= 15000 && d <= 15300, `expected ~15s (+epsilon), got ${d}ms`);
});

test('repeated transient failures grow the backoff 15s → 30s → 60s', () => {
  tmpState();
  const m = 'flaky';
  const a = mh.recordFailure(m, { class: 'transient' });
  const b = mh.recordFailure(m, { class: 'transient' });
  const c = mh.recordFailure(m, { class: 'transient' });
  assert.equal(a.failures, 1);
  assert.equal(b.failures, 2);
  assert.equal(c.failures, 3);
  const delay = (e) => Date.parse(e.skipUntil) - Date.parse(e.lastFailureAt);
  assert.equal(delay(a), 15000);
  assert.equal(delay(b), 30000);
  assert.equal(delay(c), 60000);
});

test('recordSuccess clears the whole record — a recovered model comes straight back', () => {
  tmpState();
  mh.recordFailure('m', { class: 'transient' });
  assert.ok(mh.isSkipped('m'));
  mh.recordSuccess('m');
  assert.equal(mh.isSkipped('m'), false);
  assert.equal(mh.get('m'), null);
});

test('config-class never auto-clears (skipUntil null), unlike a quota TTL', () => {
  tmpState();
  const e = mh.recordFailure('m', { class: 'config' });
  assert.equal(e.skipUntil, null);
  assert.ok(mh.isSkipped('m'));
  const q = mh.recordFailure('q', { class: 'quota', retryAfterMs: -1 });
  assert.equal(mh.isSkipped('q'), false, 'an already-expired quota skip must not stick');
});

test('a failure streak older than failureWindowMs resets, so a model does not stay "sick" forever', () => {
  tmpState();
  writeConfig({ backoff: { baseMs: 15000, multiplier: 2, capMs: 300000, failureWindowMs: 1000 } });
  const stale = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(process.env.OPENCODE_MODEL_HEALTH_FILE, JSON.stringify({
    m: { failures: 5, firstFailureAt: stale, lastFailureAt: stale, skipUntil: stale, class: 'transient' },
  }));
  const e = mh.recordFailure('m', { class: 'transient' });
  assert.equal(e.failures, 1, 'the streak must reset after the window');
  delete process.env.MODEL_ROUTING_CONFIG;
});

test('a corrupt state file does not throw and is treated as empty', () => {
  tmpState();
  fs.writeFileSync(process.env.OPENCODE_MODEL_HEALTH_FILE, '{not json');
  assert.equal(mh.isSkipped('m'), false);
  const e = mh.recordFailure('m', { class: 'transient' });
  assert.equal(e.failures, 1);
  assert.ok(mh.isSkipped('m'));
});

test('ladder(name) returns the central config ladder and null for an unknown name', () => {
  delete process.env.MODEL_ROUTING_CONFIG;
  const l = mh.ladder('deepseek-go');
  assert.ok(Array.isArray(l.build) && l.build.length >= 2);
  assert.equal(l.build[0], 'opencode-go/deepseek-v4.1-flash');
  assert.equal(mh.ladder('does-not-exist'), null);
});
