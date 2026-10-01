const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Each case gets its own AGENT_DATA_DIR so the flag file (resolved at require time) is isolated.
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-admission-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete process.env.AGENT_CLAUDE_SWITCH;
  for (const m of ['../src/auth-flag', '../src/engine-admission']) {
    delete require.cache[require.resolve(m)];
  }
  return { flag: require('../src/auth-flag'), admission: require('../src/engine-admission'), dir };
}

test('claude is admitted when nothing blocks it', () => {
  const { admission } = fresh();
  const r = admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' });
  assert.equal(r.engine, 'claude');
  assert.equal(r.movedFrom, null);
  assert.equal(r.notice, false);
});

test('a suspended engine is never admitted, and no probe valve reopens it', () => {
  const { flag, admission } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'invalid_grant account_on_hold', engine: 'claude' });
  const r = admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' });
  assert.equal(r.engine, 'opencode');
  assert.equal(r.movedFrom, 'claude');
  assert.equal(r.reason, 'suspended');

  // The 6h probe valve lets ONE run through a stale failure flag. It must not apply to a
  // suspension: nobody reinstalled authorization, so the probe only spends a doomed attempt.
  const longAfter = Date.now() + 30 * 24 * 3600 * 1000;
  assert.equal(flag.authGate('claude', { now: longAfter }).blocked, true);
});

test('the lateral target is the profile engine, not a hard-coded codex', () => {
  const { flag, admission } = fresh();
  flag.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: '401', engine: 'claude' });
  assert.equal(admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' }).engine, 'opencode');
  assert.equal(admission.resolveEngine({ requested: 'claude', profileEngine: 'codex' }).engine, 'codex');
  // No profile engine at all → the always-available default, never claude.
  assert.equal(admission.resolveEngine({ requested: 'claude', profileEngine: null }).engine, 'opencode');
  // A fallback chain never re-introduces claude.
  assert.equal(
    admission.resolveEngine({ requested: 'claude', profileEngine: 'claude', fallbackChain: ['claude'] }).engine,
    'opencode',
  );
});

test('non-claude engines pass through untouched', () => {
  const { flag, admission } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'revoked', engine: 'claude' });
  for (const eng of ['opencode', 'codex']) {
    const r = admission.resolveEngine({ requested: eng, profileEngine: 'claude' });
    assert.equal(r.engine, eng);
    assert.equal(r.movedFrom, null);
  }
});

test('an unknown/absent requested engine falls back to opencode instead of claude', () => {
  const { admission } = fresh();
  // This is the boot-resume bug in one line: `p.engine || 'claude'` used to invent a Claude run
  // for every pending record written before engines were journaled.
  assert.equal(admission.resolveEngine({ requested: null, profileEngine: null }).engine, 'opencode');
  assert.equal(admission.resolveEngine({}).engine, 'opencode');
});

test('only a genuine breakage asks the owner for attention', () => {
  const { flag, admission } = fresh();

  // A transient failure (timeout / 5xx → plain flag): Claude was expected, it is broken. Announce.
  flag.setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'refresh timeout', engine: 'claude' });
  assert.equal(admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' }).notice, true);

  // Rejected outright → suspended → the owner already answered «не зови Claude». Stay quiet.
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'invalid_grant', engine: 'claude' });
  assert.equal(admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' }).notice, false);

  // Deliberate switch off → silence too.
  flag.clearAuthFailedFlag('claude');
  process.env.AGENT_CLAUDE_SWITCH = 'off';
  const r = admission.resolveEngine({ requested: 'claude', profileEngine: 'opencode' });
  assert.equal(r.engine, 'opencode');
  assert.equal(r.reason, 'owner_switch_off');
  assert.equal(r.notice, false);
});

test('the owner switch works without any failure flag at all', () => {
  const { admission } = fresh();
  process.env.AGENT_CLAUDE_SWITCH = 'OFF'; // case-insensitive on purpose
  assert.equal(admission.claudeAdmissible(), false);
  assert.equal(admission.claudeUnavailableReason(), 'owner_switch_off');
});

test('resuming an authorization clears the suspension too', () => {
  const { flag, admission } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'invalid_grant', engine: 'claude' });
  assert.equal(flag.getAuthFlag('claude').suspended, true);

  flag.resumeAuthFailedFlag('claude');
  assert.equal(flag.getAuthFlag('claude').suspended, false);
  assert.equal(flag.getAuthFlag('claude').failed, false);
  assert.equal(admission.claudeAdmissible(), true);
});

test('a suspension does not disturb other engines', () => {
  const { flag, admission } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  assert.equal(flag.getAuthFlag('codex').failed, false);
  assert.equal(flag.getAuthFlag('opencode').failed, false);
  assert.equal(admission.resolveEngine({ requested: 'codex', profileEngine: null }).engine, 'codex');
});