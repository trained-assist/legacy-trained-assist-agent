'use strict';
// Ladder call/limit log (src/ladder-log.js): tier classification, reachedPaid, limit kinds,
// runner rung position, model-health → limits wiring.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-log-'));
process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(root, 'health.json');
delete process.env.LADDER_LOG_DIR;
const log = require('../src/ladder-log');
const health = require('../src/model-health');
const ladder = require('../src/opencode-ladder');
const lines = f => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

test('log dir follows the health file (tests never touch the prod log)', () => {
  assert.strictEqual(log.logDir(), path.join(root, 'ladder-log'));
});

test('tier: go = subscription, openrouter :free = free, everything else = paid', () => {
  assert.strictEqual(log.modelTier('opencode-go/deepseek-v4-flash'), 'subscription');
  assert.strictEqual(log.modelTier('openrouter/nvidia/x:free'), 'free');
  assert.strictEqual(log.modelTier('openrouter/deepseek/deepseek-v4-flash-0731'), 'paid');
  assert.strictEqual(log.modelTier('gigachat/GigaChat-Pro'), 'paid');
  assert.strictEqual(log.modelTier('whatever', 'free'), 'free');
});

test('reachedPaid is true when ANY attempted rung is paid', () => {
  const l = log.logCall({ source: 't', rungsTotal: 3, attempts: [
    { model: 'openrouter/a:free', rung: 1, outcome: 'error' },
    { model: 'openrouter/deepseek/x', rung: 2, outcome: 'ok' },
  ] });
  assert.strictEqual(l.rung, 2);
  assert.strictEqual(l.tier, 'paid');
  assert.strictEqual(l.reachedPaid, true);
  assert.strictEqual(lines(log.callsFile()).length, 1);
});

test('limit kinds are classified from error text', () => {
  assert.strictEqual(log.limitKind('HTTP 429: Rate limit exceeded: free-models-per-day'), 'daily_quota');
  assert.strictEqual(log.limitKind('HTTP 429: too many requests'), 'rate_limit');
  assert.strictEqual(log.limitKind('HTTP 402: insufficient credits'), 'credits');
  assert.strictEqual(log.limitKind('HTTP 401 unauthorized'), 'auth');
});

test('model-health: quota/config failures land in limits log; transient/force do not', () => {
  const before = lines(log.limitsFile()).length;
  health.recordFailure('openrouter/x:free', { class: 'transient', errorText: 'Bad Request' });
  health.recordFailure('openrouter/x:free', { class: 'force', retryAfterMs: 1000 });
  assert.strictEqual(lines(log.limitsFile()).length, before);
  ladder.recordFailure('value', 'build', 'openrouter/deepseek/deepseek-v4-flash-0731', 'HTTP 429 rate limit exceeded');
  const after = lines(log.limitsFile());
  assert.strictEqual(after.length, before + 1);
  const last = after[after.length - 1];
  assert.strictEqual(last.model, 'openrouter/deepseek/deepseek-v4-flash-0731');
  assert.strictEqual(last.source, 'runner:value');
  assert.strictEqual(last.tier, 'paid');
  assert.strictEqual(last.kind, 'rate_limit');
});

test('runner rung position: 1-based index in the profile role ladder', () => {
  const pos = ladder.rungPosition('deepseek', 'build', 'opencode-go/deepseek-v4-flash');
  assert.ok(pos);
  assert.strictEqual(pos.rung, 2);
  assert.ok(pos.rungsTotal >= 2);
  assert.strictEqual(pos.ladder, 'deepseek');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
