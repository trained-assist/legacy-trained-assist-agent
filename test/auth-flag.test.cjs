const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated AGENT_DATA_DIR per test run so this never touches the real system-flags file,
// and so auth-flag.js (which resolves FLAG_FILE at require time) picks it up fresh each time.
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-flag-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/auth-flag')];
  return { mod: require('../src/auth-flag'), dir };
}

test('setAuthFailedFlag/getAuthFlag are scoped per engine', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'not logged in', engine: 'codex' });

  assert.equal(mod.getAuthFlag('codex').failed, true);
  assert.equal(mod.getAuthFlag('codex').reason, 'AUTH_INVALID');
  assert.equal(mod.getAuthFlag('claude').failed, false);
  assert.equal(mod.getAuthFlag('opencode').failed, false);
});

test('engine defaults to claude when omitted, matching pre-per-engine behavior', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'QUOTA_EXCEEDED', error_text: 'rate limit' });
  assert.equal(mod.getAuthFlag('claude').failed, true);
  assert.equal(mod.getAuthFlag().failed, true);
});

test('clearAuthFailedFlag only clears the given engine', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'y', engine: 'codex' });

  mod.clearAuthFailedFlag('claude');
  assert.equal(mod.getAuthFlag('claude').failed, false);
  assert.equal(mod.getAuthFlag('codex').failed, true);
});

test('getAllAuthFlags reports all three engines in one call', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'opencode' });
  const all = mod.getAllAuthFlags();
  assert.deepEqual(Object.keys(all).sort(), ['claude', 'codex', 'opencode']);
  assert.equal(all.opencode.failed, true);
  assert.equal(all.claude.failed, false);
});

test('migrates a pre-per-engine flat flag file into engines.claude', () => {
  const { mod, dir } = freshModule();
  const flagsDir = path.join(dir, 'system-flags');
  fs.mkdirSync(flagsDir, { recursive: true });
  fs.writeFileSync(path.join(flagsDir, 'claude_auth.json'), JSON.stringify({
    failed: true, reason: 'AUTH_INVALID', error_text: 'legacy flag', vm: 'gcp-main',
    failed_at: '2026-01-01T00:00:00.000Z', repaired_at: null, repair_attempts: 0,
  }));

  assert.equal(mod.getAuthFlag('claude').failed, true);
  assert.equal(mod.getAuthFlag('claude').error_text, 'legacy flag');
  assert.equal(mod.getAuthFlag('codex').failed, false);
});

test('isAuthError/detectReason unaffected by the per-engine refactor', () => {
  const { mod } = freshModule();
  assert.equal(mod.isAuthError('Error: not logged in'), true);
  assert.equal(mod.isAuthError('rate limit exceeded'), true);
  assert.equal(mod.isAuthError('everything is fine'), false);
  assert.equal(mod.detectReason('quota exceeded'), 'QUOTA_EXCEEDED');
  assert.equal(mod.detectReason('invalid api key'), 'AUTH_INVALID');
});

// Regression (#1227): ordinary assistant prose mentioning rate limits must NOT be treated as
// an auth failure — it used to raise the global flag and bounce healthy tasks to the OpenCode
// fallback. These are the exact texts that polluted claude_auth.json on the VM.
// (The runner now also feeds isAuthError() only genuine error text — see runner/index.js.)
test('isAuthError ignores ordinary prose that merely mentions rate limits', () => {
  const { mod } = freshModule();
  const prose = [
    "Bug: src/admission-status.js treated Telegram's intentional 429-rate-limit drop as a real edit failure",
    'We hit a 429 rate-limit drop and spammed duplicate bubbles — fixed now.',
    'Root cause: the rate limiter dropped the edit. Summary of the fix follows.',
  ];
  for (const t of prose) assert.equal(mod.isAuthError(t), false, `should not match: ${t}`);

  // Genuine error-shaped text still matches.
  assert.equal(mod.isAuthError('Error: rate limit exceeded, retry later'), true);
  assert.equal(mod.isAuthError("You've hit your usage limit"), true);
  assert.equal(mod.isAuthError('quota exceeded'), true);
});


// ── Long-lived «Claude недоступен» gate ───────────────────────────────────────
// Regression (2026-10-01, GCP): the account went on hold at Anthropic, the refresh broker
// answered `invalid_grant / account_on_hold` every 30m, the access token expired — and every
// `claude` run died instantly with "Failed to authenticate. API Error: 401 OAuth access token
// has been revoked." None of the patterns matched it, so isAuthError() was false: no auth
// branch, no flag, no engine fallback, 3 blind retries, «Работа прервана (код 1)».
const CLAUDE_401 = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
const ACCOUNT_ON_HOLD = 'refresh HTTP 400: {"error": "invalid_grant", "error_description": "account_on_hold", "error_uri": "https://claude.ai/restricted"}';

test('isAuthError recognizes the live 401 / account_on_hold texts', () => {
  const { mod } = freshModule();
  for (const t of [CLAUDE_401, ACCOUNT_ON_HOLD, 'Error: Failed to authenticate', 'refresh HTTP 400: invalid_grant']) {
    assert.equal(mod.isAuthError(t), true, `should match: ${t}`);
  }
  // A bare status code in ordinary prose stays out — the phrase is the signal, not the number (#1227).
  assert.equal(mod.isAuthError('ответ сервера был 401, но это деталь описания'), false);
  assert.equal(mod.isAuthError('nothing wrong here'), false);
});

test('authGate blocks the engine while the flag is up, opens on the next authorization', () => {
  const { mod } = freshModule();
  assert.equal(mod.authGate('claude').blocked, false, 'no flag → engine usable');

  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: CLAUDE_401, engine: 'claude' });
  const gate = mod.authGate('claude');
  assert.equal(gate.blocked, true);
  assert.equal(gate.reason, 'AUTH_INVALID');
  assert.ok(gate.failedAt);
  assert.equal(mod.authGate('codex').blocked, false, 'the gate is per engine, not global');

  // «До следующей авторизации»: a successful refresh / run clears it and the gate opens.
  mod.clearAuthFailedFlag('claude');
  assert.equal(mod.authGate('claude').blocked, false);
});

test('authGate re-probes a flag nobody cleared instead of black-holing the engine forever', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: CLAUDE_401, engine: 'claude' });
  const now = Date.now();
  assert.equal(mod.authGate('claude', { now: now + 5 * 3600e3 }).blocked, true, 'still blocked inside the probe window');
  assert.equal(mod.authGate('claude', { now: now + 7 * 3600e3 }).blocked, false, 'stale → exactly one run gets through to re-stamp or clear the flag');
});

test('claimRedirectNotice fires once per profile per cooldown', () => {
  const { mod } = freshModule();
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: CLAUDE_401, engine: 'claude' });

  assert.equal(mod.claimRedirectNotice('claude', 'alice'), true, 'first redirect is announced');
  assert.equal(mod.claimRedirectNotice('claude', 'alice'), false, 'not again for the same profile inside the cooldown');
  assert.equal(mod.claimRedirectNotice('claude', 'bob'), true, 'another profile announces its own first redirect');

  // A NEW failure re-stamps the flag → a new outage is announced again.
  mod.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: CLAUDE_401, engine: 'claude' });
  assert.equal(mod.claimRedirectNotice('claude', 'alice'), true);

  mod.clearAuthFailedFlag('claude');
  assert.equal(mod.claimRedirectNotice('claude', 'alice'), false, 'flag down → nothing to claim');
});
