'use strict';
// #1899 пункты 2–3 — chat / non-durable runs on an exhausted llm-ladder (2026-09-29 incident:
// Go allowance spent on every key + OpenRouter at zero → the worker answered "every rung failed").
// Before this, the chat died with «попробуй позже» (BLOCKED). Now: ONE automatic re-run on the
// free ladder (opencode/free), guarded by ladderFallbackDone, plus ONE free-tariff warning per
// profile. worker_unreachable stays BLOCKED, `context` stays FAILED, durable plan steps keep the
// executor's own fallback (#1900/#1901) — and nothing here may ever name claude/codex as a target.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// contexts/ladder/free-tariff.json resolves through USERS_DIR, which data-paths snapshots at
// LOAD time — point it at a temp root before the first require so no test can touch a real
// profile workspace.
process.env.USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-free-users-'));

const {
  FREE_TARIFF_WARNING, FREE_RETRY_NOTICE,
  ladderFallbackTarget, ladderFallbackMessage,
  freeTariffFlagFile, hasFreeTariffWarning,
} = require('../src/ladder-fallback');

test('ladder_exhausted on a chat run → exactly one re-run on opencode/free', () => {
  assert.deepEqual(
    ladderFallbackTarget({ engine: 'opencode', workerFailure: 'ladder_exhausted', ladderFallbackDone: false }),
    { engine: 'opencode', ocProfile: 'free' },
  );
});

test('ladderFallbackDone blocks the second re-run — the run keeps its BLOCKED message', () => {
  assert.equal(
    ladderFallbackTarget({ engine: 'opencode', workerFailure: 'ladder_exhausted', ladderFallbackDone: true }),
    null,
    'a free re-run that fails again must dead-end exactly like today, not loop',
  );
});

test('worker_unreachable stays BLOCKED and `context` stays FAILED — neither is retried', () => {
  for (const workerFailure of ['worker_unreachable', 'context']) {
    assert.equal(
      ladderFallbackTarget({ engine: 'opencode', workerFailure, ladderFallbackDone: false }),
      null,
      workerFailure,
    );
  }
});

test('durable plan steps are left to the durable executor (#1900/#1901), no in-run re-run', () => {
  assert.equal(
    ladderFallbackTarget({ engine: 'opencode', workerFailure: 'ladder_exhausted', ladderFallbackDone: false, durable: true }),
    null,
  );
});

test('free-tariff warning: once per profile, flag in the context store, then silent', () => {
  const username = 'free-tariff-user';
  const flagFile = freeTariffFlagFile(username);
  assert.ok(flagFile.endsWith(path.join('contexts', 'ladder', 'free-tariff.json')), flagFile);

  const first = ladderFallbackMessage(username);
  assert.ok(first.includes(FREE_TARIFF_WARNING), `first switch carries the warning: ${first}`);
  assert.ok(first.includes(FREE_RETRY_NOTICE), 'the retry notice is always shown');
  assert.ok(hasFreeTariffWarning(username), 'the flag landed on disk');
  assert.equal(fs.statSync(flagFile).mode & 0o777, 0o600, 'context files are written 0600');
  assert.equal(JSON.parse(fs.readFileSync(flagFile, 'utf8')).value, true);

  const second = ladderFallbackMessage(username);
  assert.ok(!second.includes(FREE_TARIFF_WARNING), `repeated switches stay silent: ${second}`);
  assert.ok(second.includes(FREE_RETRY_NOTICE), 'the retry notice is still shown');
  assert.equal(hasFreeTariffWarning(username), true, 'the flag survives');
});

test('runner: the chat branch re-runs once on the free ladder and warns once', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/runner/index.js'), 'utf8');
  const start = src.indexOf('if (workerFailure) {');
  assert.ok(start > 0, 'the worker-failure branch must still exist');
  const end = src.indexOf('// Detect an auth/quota failure', start);
  assert.ok(end > start, 'the branch must end before the auth-fallback branch');
  const branch = src.slice(start, end);

  // The decision comes from the pure module (testable, never-Claude by construction) …
  assert.match(branch, /ladderFallbackTarget\(\{/);
  assert.match(branch, /engine, workerFailure, ladderFallbackDone,/);
  assert.match(branch, /durable: !!\(stepTimeoutMs \|\| \(resumeSink && resumeSink\.kind === 'durable'\)\)/);
  // … and the re-run carries the free profile behind ladderFallbackDone.
  assert.match(branch, /ocProfile: recovery\.ocProfile/);
  assert.match(branch, /engine: recovery\.engine/);
  assert.match(branch, /ladderFallbackDone: true/);
  // The engine-fallback flag of the original run is carried over: the two free-ladder guards
  // (loop, exhausted) may each fire at most once per run chain, in either order.
  assert.match(branch, /engineFallbackDone,\s+ladderFallbackDone: true/);
  assert.match(branch, /action: 'ladder_fallback_to_free'/);
  assert.match(branch, /ladderFallbackMessage\(user\.username\)/);

  // Guard: the branch may never name another engine or a paid ladder as the re-run target.
  assert.ok(
    !/(engine|ocProfile):\s*'(claude|codex|doctor|max|deepseek|russian|value)'/.test(branch),
    'the fallback path must not target claude/codex (or any non-free ladder)',
  );

  // The non-retry path is untouched: worker_unreachable/ladder_exhausted (flag set) → BLOCKED,
  // context → FAILED, with the same messages as before.
  assert.match(branch, /finalizeExecution\(executionId, workerFailure === 'context' \? 'FAILED' : 'BLOCKED'\)/);
  assert.match(branch, /Вся лестница моделей «\$\{ladderName\}» временно недоступна/);
});
