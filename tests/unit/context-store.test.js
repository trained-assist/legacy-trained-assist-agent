// Tests the context_get/set/list/clear handlers and workDir isolation.
// Handlers use process.cwd() at call time, so process.chdir() gives us isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Reload module each test so process.cwd() is re-evaluated in contextPath().
// (contextPath calls process.cwd() at call time, not at module load — no cache bust
//  is actually needed, but clearing makes isolation explicit.)
function tools() {
  delete require.cache[require.resolve('../../src/mcp-skills/tools/03-context-store.js')];
  return require('../../src/mcp-skills/tools/03-context-store.js').tools;
}

let workDir;
let origCwd;

beforeEach(() => {
  origCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'ctx-'));
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(workDir, { recursive: true, force: true });
});

// ── set / get ──────────────────────────────────────────────────────────────────

describe('context_set / context_get', () => {
  it('set → get → found: true, value matches', async () => {
    const { context_set, context_get } = tools();
    await context_set.handler({ skill: 'hh', key: 'active_vacancy', value: { id: 42, title: 'Engineer' } });
    const r = await context_get.handler({ skill: 'hh', key: 'active_vacancy' });
    expect(r.found).toBe(true);
    expect(r.value).toEqual({ id: 42, title: 'Engineer' });
    expect(typeof r.updated_at).toBe('string');
  });

  it('get nonexistent key → { found: false, value: null }', async () => {
    const { context_get } = tools();
    const r = await context_get.handler({ skill: 'hh', key: 'no_such_key' });
    expect(r).toEqual({ found: false, value: null });
  });
});

// ── list ───────────────────────────────────────────────────────────────────────

describe('context_list', () => {
  it('returns all entries with preview and updated_at', async () => {
    const { context_set, context_list } = tools();
    await context_set.handler({ skill: 'hh',    key: 'vac',   value: 'v1' });
    await context_set.handler({ skill: 'weeek', key: 'board', value: 'b1' });
    const { entries, count } = await context_list.handler({});
    expect(count).toBe(2);
    const skillNames = entries.map(e => e.skill);
    expect(skillNames).toContain('hh');
    expect(skillNames).toContain('weeek');
    for (const e of entries) {
      expect(typeof e.preview).toBe('string');
      expect(typeof e.updated_at).toBe('string');
    }
  });

  it('filtered by skill → only that skill returned', async () => {
    const { context_set, context_list } = tools();
    await context_set.handler({ skill: 'hh',    key: 'vac',  value: 'v1' });
    await context_set.handler({ skill: 'tilda', key: 'site', value: 's1' });
    const { entries } = await context_list.handler({ skill: 'hh' });
    expect(entries.length).toBe(1);
    expect(entries[0].skill).toBe('hh');
  });

  it('empty store → { entries: [], count: 0 }', async () => {
    const { context_list } = tools();
    const r = await context_list.handler({});
    expect(r).toEqual({ entries: [], count: 0 });
  });
});

// ── clear ──────────────────────────────────────────────────────────────────────

describe('context_clear', () => {
  it('clear → get → found: false', async () => {
    const { context_set, context_get, context_clear } = tools();
    await context_set.handler({ skill: 'hh', key: 'vac', value: 'test' });
    expect((await context_get.handler({ skill: 'hh', key: 'vac' })).found).toBe(true);

    await context_clear.handler({ skill: 'hh', key: 'vac' });
    expect((await context_get.handler({ skill: 'hh', key: 'vac' })).found).toBe(false);
  });

  it('clear nonexistent key → { ok: false }', async () => {
    const { context_clear } = tools();
    const r = await context_clear.handler({ skill: 'hh', key: 'ghost' });
    expect(r.ok).toBe(false);
  });
});

// ── profile-root resolution (epic #1789 P1 / #1784 precondition) ──────────────
//
// The store must key off the PROFILE (AGENT_USER_ID → $USERS_DIR/<username>),
// not off process.cwd(): Claude's cwd is the profile root only for sessions
// without a project — with a project bound it is <profile>/projects/<id>, which
// is exactly where the old process.cwd() write parked this store.

describe('profile-root resolution', () => {
  it('AGENT_USER_ID set → data lands in $USERS_DIR/<user>/contexts, readable from any cwd', async () => {
    process.env.AGENT_USER_ID = 'ctx-profile-user';
    try {
      const { context_set, context_get } = tools();
      await context_set.handler({ skill: 'hh', key: 'moved', value: 'v' });

      const inProfile = join(process.env.USERS_DIR, 'ctx-profile-user', 'contexts', 'hh', 'moved.json');
      expect(existsSync(inProfile), `expected ${inProfile}`).toBe(true);
      expect(existsSync(join(workDir, 'contexts', 'hh', 'moved.json')), 'must not write into cwd').toBe(false);

      // cwd is irrelevant while a profile is bound — read from somewhere else.
      const dir2 = mkdtempSync(join(tmpdir(), 'ctx-cwd-'));
      process.chdir(dir2);
      try {
        const { context_get: get2 } = tools();
        const r = await get2.handler({ skill: 'hh', key: 'moved' });
        expect(r).toMatchObject({ found: true, value: 'v' });
      } finally {
        process.chdir(workDir);
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      delete process.env.AGENT_USER_ID;
    }
  });

  it('AGENT_USER_ID unset (tests, plain CLI) → falls back to process.cwd()', async () => {
    delete process.env.AGENT_USER_ID;
    const { context_set } = tools();
    await context_set.handler({ skill: 'hh', key: 'cwd-key', value: 'cv' });
    expect(existsSync(join(workDir, 'contexts', 'hh', 'cwd-key.json'))).toBe(true);
  });
});

// ── workDir isolation (no AGENT_USER_ID → the cwd contract the tests above rely on) ─────────

describe('workDir isolation', () => {
  it('data written in dir1 is not visible from dir2', async () => {
    const { context_set } = tools();
    await context_set.handler({ skill: 'hh', key: 'isolated', value: 'secret' });

    const dir2 = mkdtempSync(join(tmpdir(), 'ctx2-'));
    process.chdir(dir2);
    try {
      const { context_get } = tools();
      const r = await context_get.handler({ skill: 'hh', key: 'isolated' });
      expect(r.found).toBe(false);
    } finally {
      process.chdir(workDir); // restore so afterEach cleanup works
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
