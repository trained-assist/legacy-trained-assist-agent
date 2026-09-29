// Domain Store (issue #1220):
// scoped JSON records, profile/project isolation, revision concurrency, TTL.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DomainStore } = require('../../src/domain-store');

// :memory: — unit tests for the store's logic, not on-disk WAL behavior.
const store = () => new DomainStore(':memory:');
const checkError = (fn, code) => {
  expect(fn).toThrow();
  try { fn(); } catch (e) { expect(e.code).toBe(code); }
};
const base = { providerId: 'recruiting', profileId: 'alice', collection: 'candidates' };

describe('DomainStore', () => {
  it('create + get round-trips data, schema_version and revision', () => {
    const s = store();
    const rec = s.put({ ...base, recordId: 'c1', data: { name: 'Ivan' }, schemaVersion: 2 });
    expect(rec).toMatchObject({
      providerId: 'recruiting', profileId: 'alice', projectId: null,
      collection: 'candidates', recordId: 'c1', schemaVersion: 2, revision: 1,
      data: { name: 'Ivan' },
    });
    expect(s.get({ ...base, recordId: 'c1' })).toEqual(rec);
  });

  it('isolates by profile: same collection/recordId does not leak across profiles', () => {
    const s = store();
    s.put({ ...base, recordId: 'c1', data: { owner: 'alice' } });
    s.put({ ...base, profileId: 'bob', recordId: 'c1', data: { owner: 'bob' } });
    expect(s.get({ ...base, recordId: 'c1' }).data.owner).toBe('alice');
    expect(s.get({ ...base, profileId: 'bob', recordId: 'c1' }).data.owner).toBe('bob');
    expect(s.get({ ...base, profileId: 'carol', recordId: 'c1' })).toBeNull();
  });

  it('isolates by project; NULL project is profile scope, not a wildcard', () => {
    const s = store();
    s.put({ ...base, projectId: 'vacancy-a', recordId: 'c1', data: { v: 'a' } });
    s.put({ ...base, projectId: 'vacancy-b', recordId: 'c1', data: { v: 'b' } });
    s.put({ ...base, recordId: 'c1', data: { v: 'profile' } });
    expect(s.get({ ...base, projectId: 'vacancy-a', recordId: 'c1' }).data.v).toBe('a');
    expect(s.get({ ...base, projectId: 'vacancy-b', recordId: 'c1' }).data.v).toBe('b');
    expect(s.get({ ...base, recordId: 'c1' }).data.v).toBe('profile');
    // list in one project never returns another project's records
    expect(s.list({ ...base, projectId: 'vacancy-a' }).records).toHaveLength(1);
    expect(s.list({ ...base }).records).toHaveLength(1);
  });

  it('empty-string projectId collapses to profile scope (no second scope)', () => {
    const s = store();
    s.put({ ...base, projectId: '', recordId: 'c1', data: { x: 1 } });
    expect(s.get({ ...base, projectId: null, recordId: 'c1' }).data.x).toBe(1);
    expect(s.get({ ...base, projectId: undefined, recordId: 'c1' }).data.x).toBe(1);
  });

  it('create on an existing record is CONFLICT', () => {
    const s = store();
    s.put({ ...base, recordId: 'c1', data: {} });
    checkError(() => s.put({ ...base, recordId: 'c1', data: {} }), 'CONFLICT');
  });

  it('update requires an exact expected_revision and increments it', () => {
    const s = store();
    s.put({ ...base, recordId: 'c1', data: { n: 1 } });
    checkError(() => s.put({ ...base, recordId: 'c1', data: { n: 2 }, expectedRevision: 5 }), 'CONFLICT');
    const updated = s.put({ ...base, recordId: 'c1', data: { n: 2 }, expectedRevision: 1 });
    expect(updated.revision).toBe(2);
    expect(updated.data.n).toBe(2);
  });

  it('update/delete of a missing record is NOT_FOUND; delete honours revision', () => {
    const s = store();
    checkError(() => s.put({ ...base, recordId: 'missing', data: {}, expectedRevision: 1 }), 'NOT_FOUND');
    checkError(() => s.delete({ ...base, recordId: 'missing' }), 'NOT_FOUND');
    s.put({ ...base, recordId: 'c1', data: {} });
    checkError(() => s.delete({ ...base, recordId: 'c1', expectedRevision: 9 }), 'CONFLICT');
    expect(s.delete({ ...base, recordId: 'c1', expectedRevision: 1 })).toEqual({ deleted: true, recordId: 'c1' });
    expect(s.get({ ...base, recordId: 'c1' })).toBeNull();
  });

  it('TTL: expired records are hidden from get/list unless includeExpired', () => {
    const s = store();
    const t0 = 1_000_000;
    s.put({ ...base, recordId: 'old', data: { k: 1 }, ttlMs: 100, now: t0 });
    s.put({ ...base, recordId: 'fresh', data: { k: 2 }, ttlMs: 10_000, now: t0 });
    const later = t0 + 500;
    expect(s.get({ ...base, recordId: 'old', now: later })).toBeNull();
    expect(s.get({ ...base, recordId: 'old', includeExpired: true, now: later }).data.k).toBe(1);
    expect(s.list({ ...base, now: later }).records.map(r => r.recordId)).toEqual(['fresh']);
    expect(s.list({ ...base, includeExpired: true, now: later }).records.map(r => r.recordId).sort()).toEqual(['fresh', 'old']);
  });

  it('TTL: ttlMs undefined keeps existing expiry; null clears it', () => {
    const s = store();
    const t0 = 1_000_000;
    s.put({ ...base, recordId: 'c1', data: {}, ttlMs: 1000, now: t0 });
    const kept = s.put({ ...base, recordId: 'c1', data: {}, expectedRevision: 1, now: t0 });
    expect(kept.expiresAt).toBe(t0 + 1000);
    const cleared = s.put({ ...base, recordId: 'c1', data: {}, expectedRevision: 2, ttlMs: null, now: t0 });
    expect(cleared.expiresAt).toBeNull();
  });

  it('sweepExpired removes only expired rows', () => {
    const s = store();
    const t0 = 1_000_000;
    s.put({ ...base, recordId: 'old', data: {}, ttlMs: 100, now: t0 });
    s.put({ ...base, recordId: 'forever', data: {}, now: t0 });
    expect(s.sweepExpired(t0 + 500)).toEqual({ deleted: 1 });
    expect(s.get({ ...base, recordId: 'forever', includeExpired: true })).not.toBeNull();
    expect(s.get({ ...base, recordId: 'old', includeExpired: true, now: t0 + 500 })).toBeNull();
  });

  it('validates arguments: ids required, data must be a JSON object, schemaVersion >= 1', () => {
    const s = store();
    checkError(() => s.put({ ...base, collection: '', recordId: 'c1', data: {} }), 'INVALID_ARGUMENTS');
    checkError(() => s.put({ ...base, recordId: '', data: {} }), 'INVALID_ARGUMENTS');
    checkError(() => s.put({ ...base, recordId: 'c1', data: [1, 2] }), 'INVALID_ARGUMENTS');
    checkError(() => s.put({ ...base, recordId: 'c1', data: null }), 'INVALID_ARGUMENTS');
    checkError(() => s.put({ ...base, recordId: 'c1', data: {}, schemaVersion: 0 }), 'INVALID_ARGUMENTS');
    checkError(() => s.get({ ...base, collection: '', recordId: 'c1' }), 'INVALID_ARGUMENTS');
  });

  it('list pages with a keyset cursor and stable ordering', () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      s.put({ ...base, recordId: `c${i}`, data: { i }, now: 1000 + i });
    }
    const first = s.list({ ...base, limit: 2 });
    expect(first.records.map(r => r.recordId)).toEqual(['c0', 'c1']);
    expect(first.nextCursor).toBeTruthy();
    const second = s.list({ ...base, limit: 2, cursor: first.nextCursor });
    expect(second.records.map(r => r.recordId)).toEqual(['c2', 'c3']);
    const last = s.list({ ...base, limit: 2, cursor: second.nextCursor });
    expect(last.records.map(r => r.recordId)).toEqual(['c4']);
    expect(last.nextCursor).toBeNull();
  });
});
