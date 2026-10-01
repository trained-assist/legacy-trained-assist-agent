'use strict';
// providerErrorText — what the ladder classifier is allowed to look at.
//
// Incident 2026-09-30/10-01: the old `codexErrorMsg || claudeResult || fullOutput.text || result`
// scanned a CONFIRMED run's answer for error patterns, so a step report mentioning «401»
// («токен из origin URL мёртв (401)») classified as worker_unreachable and the runner threw the
// COMPLETED step away (execution-history: errorText = a report ending in `DURABLE: done`).
// Research made it worse: from the research→ladder PR its model is `ladder/research:*`, so the
// classifier applies to it for the first time (an `opencode-go/…` model never matched).
const fs = require('node:fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-err-'));
process.env.AGENT_DATA_DIR = path.join(ROOT, 'data');
process.env.USERS_DIR = path.join(ROOT, 'users');
process.env.MIN_FREE_RAM_MB = '0';
process.env.TELEGRAM_API_URL = 'http://127.0.0.1:9';
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { providerErrorText } = require('../src/runner');
const { classifyWorkerFailure } = require('../src/opencode-ladder-provider');

const DONE = '**ИТОГ ШАГА**\n- ✅ П.1 — issue #8 создан\n- Поправка: токен из origin URL мёртв (401), работаем через `gh` CLI.\n\nDURABLE: done';

test('a confirmed run is never scanned: answer prose with «401» is not an error', () => {
  assert.equal(providerErrorText({
    codexErrorMsg: null, claudeErrorText: null, terminalSuccess: true, outputText: DONE, result: DONE,
  }), '', 'the completed answer must not reach the classifier');
  assert.equal(classifyWorkerFailure(providerErrorText({
    codexErrorMsg: null, claudeErrorText: null, terminalSuccess: true, outputText: DONE, result: DONE,
  })), null, 'so it can never become worker_unreachable');
});

test('a real error event is used verbatim, even when the run also produced text', () => {
  assert.equal(providerErrorText({
    codexErrorMsg: 'Cannot connect to API: Unable to connect', claudeErrorText: null,
    terminalSuccess: true, outputText: DONE, result: DONE,
  }), 'Cannot connect to API: Unable to connect');
  assert.equal(providerErrorText({
    codexErrorMsg: null, claudeErrorText: 'AI_APICallError: every rung failed',
    terminalSuccess: true, outputText: '', result: '',
  }), 'AI_APICallError: every rung failed', 'claude is_error result counts too');
  assert.equal(classifyWorkerFailure('Cannot connect to API: Unable to connect'), 'worker_unreachable');
});

test('an unconfirmed run falls back to its accumulated output, then to the status message', () => {
  assert.equal(providerErrorText({
    codexErrorMsg: null, claudeErrorText: null, terminalSuccess: false,
    outputText: 'TypeError: fetch failed (ECONNREFUSED)', result: '⚠️ Работа прервана (код 1).',
  }), 'TypeError: fetch failed (ECONNREFUSED)', 'plain-output errors are still classified');
  assert.equal(providerErrorText({
    codexErrorMsg: null, claudeErrorText: null, terminalSuccess: false, outputText: '', result: '⚠️ Работа прервана (код 1).',
  }), '⚠️ Работа прервана (код 1).');
  assert.equal(providerErrorText({
    codexErrorMsg: null, claudeErrorText: null, terminalSuccess: false, outputText: '', result: '',
  }), '', 'nothing in, nothing out');
  assert.equal(providerErrorText(undefined), '', 'never throws on a missing argument bag');
});
