// Unit tests for src/engine-health.js
// Covers: healthy default, degraded→unavailable hysteresis, self-heal on success,
// irrelevant classes are a no-op, and the credentials-vs-health split (only AUTH is
// credential-invalid; QUOTA/RATE_LIMIT/CONFIG are not).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function freshModule() {
  const key = require.resolve('../../src/engine-health.js');
  if (require.cache[key]) delete require.cache[key];
  return require('../../src/engine-health.js');
}

let H;
let prevThreshold;

beforeEach(() => {
  prevThreshold = process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES;
  H = freshModule();
  H._resetForTests();
});

afterEach(() => {
  H._resetForTests();
  if (prevThreshold === undefined) delete process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES;
  else process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES = prevThreshold;
});

describe('engine health defaults', () => {
  it('a fresh engine is healthy with no failures', () => {
    const h = H.getEngineHealth('claude');
    expect(h.status).toBe('healthy');
    expect(h.consecutive_failures).toBe(0);
    expect(h.last_failure_at).toBeNull();
  });

  it('getAllEngineHealth returns all three engines', () => {
    expect(Object.keys(H.getAllEngineHealth()).sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('unknown engine names normalize to claude', () => {
    expect(H.getEngineHealth('bogus').engine).toBe('claude');
  });
});

describe('markEngineFailure — hysteresis', () => {
  it('one relevant failure → degraded, not unavailable', () => {
    const h = H.markEngineFailure('claude', { failureClass: 'AUTH', message: 'Not logged in' });
    expect(h.status).toBe('degraded');
    expect(h.consecutive_failures).toBe(1);
    expect(h.last_failure_class).toBe('AUTH');
    expect(h.last_failure_at).toBeTruthy();
  });

  it('reaches unavailable only at the configured threshold (default 3)', () => {
    H.markEngineFailure('claude', { failureClass: 'TRANSIENT', message: 'e1' });
    H.markEngineFailure('claude', { failureClass: 'TRANSIENT', message: 'e2' });
    expect(H.getEngineHealth('claude').status).toBe('degraded');
    const h = H.markEngineFailure('claude', { failureClass: 'TRANSIENT', message: 'e3' });
    expect(h.status).toBe('unavailable');
    expect(h.consecutive_failures).toBe(3);
  });

  it('honours ENGINE_UNAVAILABLE_AFTER_FAILURES', () => {
    process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES = '2';
    H.markEngineFailure('codex', { failureClass: 'QUOTA', message: 'e1' });
    const h = H.markEngineFailure('codex', { failureClass: 'QUOTA', message: 'e2' });
    expect(h.status).toBe('unavailable');
  });

  it('USER_STOP and UNKNOWN are a no-op (never degrade health)', () => {
    H.markEngineFailure('claude', { failureClass: 'USER_STOP', message: 'user stopped' });
    H.markEngineFailure('claude', { failureClass: 'UNKNOWN', message: 'incomplete' });
    const h = H.getEngineHealth('claude');
    expect(h.status).toBe('healthy');
    expect(h.consecutive_failures).toBe(0);
  });
});

describe('markEngineSuccess — self-heal', () => {
  it('resets status to healthy and the streak to 0, preserving failure history', () => {
    H.markEngineFailure('claude', { failureClass: 'AUTH', message: 'Not logged in' });
    H.markEngineFailure('claude', { failureClass: 'AUTH', message: 'Not logged in' });
    const h = H.markEngineSuccess('claude');
    expect(h.status).toBe('healthy');
    expect(h.consecutive_failures).toBe(0);
    expect(h.last_success_at).toBeTruthy();
    // Historical failure event is not erased.
    expect(h.last_failure_class).toBe('AUTH');
    expect(h.last_failure_at).toBeTruthy();
  });
});

describe('credentials vs health', () => {
  it('only AUTH is credential-invalid', () => {
    expect(H.isCredentialInvalidClass('AUTH')).toBe(true);
    for (const cls of ['QUOTA', 'RATE_LIMIT', 'CONFIG', 'TRANSIENT', 'MODEL_ERROR', 'UNKNOWN']) {
      expect(H.isCredentialInvalidClass(cls)).toBe(false);
    }
  });

  it('a QUOTA failure degrades health without being credential-invalid', () => {
    const h = H.markEngineFailure('opencode', { failureClass: 'QUOTA', message: 'quota exceeded' });
    expect(h.status).toBe('degraded');
    expect(h.last_failure_class).toBe('QUOTA');
    expect(H.isCredentialInvalidClass('QUOTA')).toBe(false);
  });
});

describe('half-open: unavailable expires after the cooldown', () => {
  const trip = (engine, cls, at) => {
    process.env.ENGINE_UNAVAILABLE_AFTER_FAILURES = '1';
    return H.markEngineFailure(engine, { failureClass: cls, message: 'limit', at });
  };

  it('stays unavailable inside the cooldown', () => {
    const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(trip('codex', 'QUOTA', at).status).toBe('unavailable');
    expect(H.getEngineHealth('codex').status).toBe('unavailable');
  });

  it('QUOTA older than the cooldown reads as degraded + half_open (probe allowed)', () => {
    trip('codex', 'QUOTA', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    const h = H.getEngineHealth('codex');
    expect(h.status).toBe('degraded');
    expect(h.half_open).toBe(true);
    expect(H.getAllEngineHealth().codex.status).toBe('degraded');
  });

  it('AUTH waits the longer auth cooldown', () => {
    trip('codex', 'AUTH', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    expect(H.getEngineHealth('codex').status).toBe('unavailable');
  });

  it('a failed probe restarts the cooldown without a second alert-worthy transition', () => {
    trip('codex', 'QUOTA', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    const probe = H.markEngineFailure('codex', { failureClass: 'QUOTA', message: 'still out' });
    expect(probe.status).toBe('unavailable');
    expect(H.getEngineHealth('codex').status).toBe('unavailable');
  });

  it('a successful probe heals', () => {
    trip('codex', 'QUOTA', new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    H.markEngineSuccess('codex');
    expect(H.getEngineHealth('codex').status).toBe('healthy');
  });
});
