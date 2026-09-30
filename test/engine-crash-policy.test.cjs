'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Regression for the 2026-09-25 bug: Codex hitting its usage limit dead-ended with
// "Переключись на другой движок" whenever the process exited non-zero, never reaching the
// engine_fallback_to_opencode branch that the SAME error already triggered on exit 0.
// isTerminalQuickCrash must return false (→ fall through to the fallback path) for a
// provider-unusable error on an engine that can still fall back.
const {
  isTerminalQuickCrash, engineCanFallBack,
  isQuotaLikeClass, engineFallbackNotice, engineAuthNotice,
} = require('../src/engine-crash-policy');

const CODEX_QUOTA = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 29th, 2026 10:49 PM.";
const CLAUDE_AUTH = 'Not logged in · Please run /login';

test('codex usage-limit with non-zero exit falls through instead of dead-ending', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: false, errorText: CODEX_QUOTA,
  }), false);
});

test('claude auth error with non-zero exit also falls through', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 10, hasResult: false,
    engine: 'claude', engineFallbackDone: false, errorText: CLAUDE_AUTH,
  }), false);
});

test('same quota error is terminal once the engine already fell back (no loop)', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: true, errorText: CODEX_QUOTA,
  }), true);
});

test('opencode has no fallback target, so its quota stays terminal here', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'opencode', engineFallbackDone: false, errorText: CODEX_QUOTA,
  }), true);
});

test('a plain non-auth crash is still a terminal quick crash', () => {
  assert.equal(isTerminalQuickCrash({
    exitCode: 1, timedOut: false, outputLength: 0, hasResult: false,
    engine: 'codex', engineFallbackDone: false, errorText: 'spawn EAGAIN',
  }), true);
});

test('exit 0 / timeout / enough output / a result are never a quick crash', () => {
  const base = { exitCode: 1, timedOut: false, outputLength: 0, hasResult: false, engine: 'codex', engineFallbackDone: false, errorText: CODEX_QUOTA };
  assert.equal(isTerminalQuickCrash({ ...base, exitCode: 0 }), false);
  assert.equal(isTerminalQuickCrash({ ...base, timedOut: true }), false);
  assert.equal(isTerminalQuickCrash({ ...base, outputLength: 200 }), false);
  assert.equal(isTerminalQuickCrash({ ...base, hasResult: true }), false);
});

test('engineCanFallBack mirrors the fallback-branch guard', () => {
  assert.equal(engineCanFallBack('codex', false), true);
  assert.equal(engineCanFallBack('claude', false), true);
  assert.equal(engineCanFallBack('codex', true), false);
  assert.equal(engineCanFallBack('opencode', false), false);
});

// Regression for the 2026-09-25 message conflation: a Codex QUOTA hit (live errorText
// "You've hit your usage limit … try again at Sep 29th") was surfaced to the user as
// "Codex потерял авторизацию" — the auth-flag split made the FLAG honest but the MESSAGE was
// still hardcoded. The wording must follow the failure class, not assume credentials.
test('isQuotaLikeClass groups QUOTA and RATE_LIMIT, not AUTH', () => {
  assert.equal(isQuotaLikeClass('QUOTA'), true);
  assert.equal(isQuotaLikeClass('RATE_LIMIT'), true);
  assert.equal(isQuotaLikeClass('AUTH'), false);
  assert.equal(isQuotaLikeClass(undefined), false);
});

test('quota fallback notice says "лимит", never "потерял авторизацию"', () => {
  const msg = engineFallbackNotice('Codex', 'QUOTA');
  assert.match(msg, /упёрся в лимит/);
  assert.doesNotMatch(msg, /авторизац/i);
  assert.match(msg, /переключаюсь на OpenCode/);
});

test('auth fallback notice keeps the credential wording', () => {
  const msg = engineFallbackNotice('Claude Code', 'AUTH');
  assert.match(msg, /потерял авторизацию/);
  assert.doesNotMatch(msg, /лимит/);
});

test('terminal (no-fallback) notice is class-aware too', () => {
  assert.match(engineAuthNotice('Codex', 'QUOTA'), /временно упёрся в лимит/);
  assert.doesNotMatch(engineAuthNotice('Codex', 'QUOTA'), /авторизац/i);
  assert.match(engineAuthNotice('OpenCode', 'AUTH'), /Авторизация OpenCode истекла/);
});

// Owner 2026-09-30: architect chain claude → codex → opencode.
const { chatFallbackEngine, engineLabelOf } = require('../src/engine-crash-policy');

test('claude falls back to codex while codex is usable', () => {
  assert.equal(chatFallbackEngine('claude', { healthOf: () => ({ status: 'healthy' }) }), 'codex');
  assert.equal(chatFallbackEngine('claude', { healthOf: () => ({ status: 'degraded', half_open: true }) }), 'codex');
});

test('claude skips an unavailable codex straight to opencode', () => {
  assert.equal(chatFallbackEngine('claude', { healthOf: () => ({ status: 'unavailable' }) }), 'opencode');
});

test('codex (and anything else) falls back to opencode — never upward', () => {
  assert.equal(chatFallbackEngine('codex', { healthOf: () => ({ status: 'healthy' }) }), 'opencode');
  assert.equal(chatFallbackEngine('opencode', { healthOf: () => ({ status: 'healthy' }) }), 'opencode');
});

test('fallback notice names the real target engine', () => {
  assert.match(engineFallbackNotice('Claude Code', 'QUOTA', engineLabelOf('codex')), /переключаюсь на Codex/);
});
