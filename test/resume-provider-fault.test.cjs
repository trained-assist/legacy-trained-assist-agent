'use strict';
// #1474: after a server restart, a provider-side fault (rejected Go key, quota, 5xx) must NOT make
// the runner drop the engine session and rebuild from scratch — the transcript is intact. Incident
// 2026-09-26: "Upstream request failed: Invalid credential" on every resume → native_resume_failed
// fallback → user saw the conversation "forget" its question.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isProviderFault } = require('../src/runner/index');

test('provider faults are recognised (dead key, quota, rate limit, 5xx)', () => {
  for (const t of [
    'Upstream request failed: Invalid credential',
    'HTTP 401 Unauthorized',
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage",
    '429 Too Many Requests',
    'Unexpected server error',
    '503 Service Unavailable',
    'model overloaded',
  ]) assert.equal(isProviderFault(t), true, t);
});

test('non-provider failures still take the native-resume fallback', () => {
  for (const t of ['', null, 'session not found', 'No conversation found with session ID abc', 'prompt is too long', 'exit 1'])
    assert.equal(isProviderFault(t), false, String(t));
});

test('runner wiring: fallback skipped on provider fault, retry keeps the engine session', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/runner/index.js'), 'utf8');
  assert.match(src, /if \(resumeSessionId && !resumeFallbackDone && !restartShutdown && !providerFault\)/);
  assert.match(src, /resumeSessionId: providerFault \? resumeSessionId : null/);
  assert.match(src, /opencodeGoToggle\.noteFailure\(ocActiveModel, resumeErrText\)/);
  assert.doesNotMatch(src, /попытка \$\{resumeAttempts \+ 1\}\/\$\{MAX_RESUME_ATTEMPTS\}/, 'no "4/3" counter');
});
