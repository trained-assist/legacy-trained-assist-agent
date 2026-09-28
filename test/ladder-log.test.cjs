'use strict';
// Ladder call log (src/ladder-log.js): tier classification, reachedPaid, isolated log dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-log-'));
process.env.LADDER_LOG_DIR = root;
const log = require('../src/ladder-log');
const lines = f => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

test('log dir follows LADDER_LOG_DIR (tests never touch the prod log)', () => {
  assert.strictEqual(log.logDir(), root);
});

test('tier: ladder/* = ladder (worker decides), go = subscription, openrouter :free = free, else paid', () => {
  assert.strictEqual(log.modelTier('ladder/deepseek:build'), 'ladder');
  assert.strictEqual(log.modelTier('opencode-go/deepseek-v4-flash'), 'subscription');
  assert.strictEqual(log.modelTier('openrouter/nvidia/x:free'), 'free');
  assert.strictEqual(log.modelTier('openrouter/google/gemini-2.5-flash'), 'paid');
  assert.strictEqual(log.modelTier('whatever', 'free'), 'free');
});

test('a worker-ladder run is logged with its ladder and never flagged as paid', () => {
  const l = log.logCall({ source: 'runner:deepseek', ladder: 'deepseek', attempts: [
    { model: 'ladder/deepseek:build', rung: null, outcome: 'ok' },
  ] });
  assert.strictEqual(l.model, 'ladder/deepseek:build');
  assert.strictEqual(l.tier, 'ladder');
  assert.strictEqual(l.reachedPaid, false);
  assert.strictEqual(lines(log.callsFile()).length, 1);
  assert.deepStrictEqual(log.summary().byLadder, { 'runner:deepseek#deepseek': 1 });
});

test('reachedPaid is true when ANY attempted model is paid', () => {
  const l = log.logCall({ source: 't', attempts: [
    { model: 'openrouter/google/gemini-2.5-flash', rung: null, outcome: 'ok' },
  ] });
  assert.strictEqual(l.reachedPaid, true);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
