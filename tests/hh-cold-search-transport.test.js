import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveSearchAreas, searchResumes } = require('../src/domains/hh/lib').hhLib('hh-cold-search-transport');
afterEach(() => vi.unstubAllGlobals());
const response = (status, body = {}) => ({ ok: status === 200, status, headers: new Headers(), json: async () => body });
describe('cold search geography and failures (#1232)', () => {
  it('uses vacancy geography and allows an explicit unrestricted override', () => {
    expect(resolveSearchAreas({}, { area: { id: '2' } }, {})).toEqual(['2']);
    expect(resolveSearchAreas({}, { area: { id: '1' } }, { area: null })).toEqual([]);
    expect(resolveSearchAreas({ filters: { area: ['2', '4'] } }, { area: { id: '1' } }, {})).toEqual(['2', '4']);
    expect(() => resolveSearchAreas({}, {}, {})).toThrow(/географ/);
  });
  it('sends repeated area parameters, never an implicit Moscow', async () => {
    const fetch = vi.fn(async () => response(200, { items: [] })); vi.stubGlobal('fetch', fetch);
    await searchResumes('engineer', { access_token: 'test' }, 'user', { areas: ['2', '4'] });
    expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('area')).toEqual(['2', '4']);
    await searchResumes('engineer', { access_token: 'test' }, 'user', { areas: [] });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.has('area')).toBe(false);
  });
  it('refreshes expired auth once and reuses the refreshed token', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(401)).mockResolvedValue(response(200, { items: [] })); vi.stubGlobal('fetch', fetch);
    const token = { access_token: 'old' }; const refresh = vi.fn(async () => 'new');
    await searchResumes('x', token, 'u', { areas: [], refreshAccessToken: refresh });
    expect(refresh).toHaveBeenCalledTimes(1); expect(token.access_token).toBe('new');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });
  it.each([401, 403, 429, 500])('never reports HTTP %s as zero results', async status => {
    const fetch = vi.fn(async () => response(status)); vi.stubGlobal('fetch', fetch);
    await expect(searchResumes('x', { access_token: 'x' }, 'u', { areas: [], sleep: async () => {} })).rejects.toThrow(`HH resumes ${status}`);
    expect(fetch).toHaveBeenCalledTimes(status >= 429 ? 3 : 1);
  });
  it('bounds network retries and rejects malformed successful responses', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('network down'); }); vi.stubGlobal('fetch', fetch);
    await expect(searchResumes('x', {}, 'u', { areas: [], sleep: async () => {} })).rejects.toThrow('network down');
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValue(response(200, {}));
    await expect(searchResumes('x', {}, 'u', { areas: [] })).rejects.toThrow(/items/);
  });
});

describe('vacancy-scoped context', () => {
  it('selects B without changing A, rejects unowned legacy config', () => {
    const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    const { resolveSearchContext } = require('../src/domains/hh/lib').hhLib('hh-cold-search-context');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-context-'));
    const dir = path.join(root, 'contexts', 'hh'); fs.mkdirSync(dir, { recursive: true });
    const put = (key, value) => fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({ value }));
    try {
      put('active_vacancy', { id: 'A', area: { id: '1' } });
      put('ats_config', { vacancy_id: 'A', vacancy_title: 'Sales' });
      put('ats_config:B', { vacancy_id: 'B', vacancy_title: 'Engineering' });
      expect(resolveSearchContext(root, 'B').config.vacancy_title).toBe('Engineering');
      expect(resolveSearchContext(root).vacancyId).toBe('A');
      expect(() => resolveSearchContext(root, 'C')).toThrow(/ATS/);
      put('ats_config:B', { vacancy_id: 'C' });
      expect(() => resolveSearchContext(root, 'B')).toThrow(/другой/);
      put('ats_config', { vacancy_title: 'Unowned' });
      expect(() => resolveSearchContext(root)).toThrow(/ATS/);
      expect(() => resolveSearchContext(root, '../x')).toThrow(/ID/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('does not resurrect legacy selection after explicitly removing all vacancies', () => {
    const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    const { readActiveVacancies } = require('../src/domains/hh/lib').hhLib('hh-utils');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-active-'));
    const dir = path.join(root, 'contexts', 'hh'); fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'active_vacancy.json'), JSON.stringify({ value: { id: 'A' } }));
      expect(readActiveVacancies(root)).toEqual([{ id: 'A' }]);
      fs.writeFileSync(path.join(dir, 'active_vacancies.json'), JSON.stringify({ value: [] }));
      expect(readActiveVacancies(root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('candidate triage and score per vacancy', () => {
  it('keeps A starred and B archived across search repeats and reloads', () => {
    const { mergeSearchCandidatesIntoAll, setCandidateStatus, loadAllCandidates, allCandidatesPath } = require('../src/domains/hh/lib').hhLib('hh-proactive-search');
    const fs = require('node:fs'); const user = 'triage-' + Date.now();
    try {
      mergeSearchCandidatesIntoAll(user, [{ id: 'same', score: 9 }], {}, 'A');
      setCandidateStatus(user, 'same', 'starred', 'A');
      mergeSearchCandidatesIntoAll(user, [{ id: 'same', score: 2 }], {}, 'B');
      setCandidateStatus(user, 'same', 'archived', 'B');
      mergeSearchCandidatesIntoAll(user, [{ id: 'same', score: 10 }], {}, 'A');
      expect(loadAllCandidates(user, 'A').same).toMatchObject({ score: 10, status: 'starred' });
      expect(loadAllCandidates(user, 'B').same).toMatchObject({ score: 2, status: 'archived' });
      expect(() => setCandidateStatus(user, 'same', 'starred', 'C')).toThrow(/not found/);
      setCandidateStatus(user, 'same', 'active', 'B');
      expect(loadAllCandidates(user, 'B').same.status).toBe('active');
      expect(loadAllCandidates(user, 'A').same.status).toBe('starred');
    } finally { fs.rmSync(allCandidatesPath(user), { force: true }); }
  });
});

describe('full cold-search execution', () => {
  it('uses B criteria and region, preserves A, and saves every candidate before seen', async () => {
    const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    const api = require('../src/domains/hh/lib').hhLib('hh-proactive-search');
    const { latestProactiveFile } = require('../src/domains/hh/lib').hhLib('hh-cold-search-snapshots');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-run-'));
    const oldData = process.env.AGENT_DATA_DIR, oldTokens = process.env.AGENT_TOKENS_DIR, oldKey = process.env.OPENROUTER_API_KEY;
    process.env.AGENT_DATA_DIR = path.join(root, 'data'); process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens'); delete process.env.OPENROUTER_API_KEY;
    const user = 'fixture'; const ctx = path.join(root, 'contexts', 'hh'); fs.mkdirSync(ctx, { recursive: true });
    fs.mkdirSync(path.join(root, 'tokens', user), { recursive: true }); fs.writeFileSync(path.join(root, 'tokens', user, 'hh'), '{"access_token":"fixture"}');
    const put = (key, value) => fs.writeFileSync(path.join(ctx, key + '.json'), JSON.stringify({ value }));
    put('active_vacancy', { id: 'A', area: { id: '1' } });
    put('active_vacancies', [{ id: 'A', area: { id: '1' } }, { id: 'B', area: { id: '2' } }]);
    for (const id of ['A', 'B']) {
      const config = { vacancy_id: id, vacancy_title: 'Engineer', required: [{ name: 'Engineer', weight: 5 }] };
      put('ats_config:' + id, config); api.saveStoredQueries(user, id, ['Engineer'], api.atsConfigHash(config));
    }
    const fetch = vi.fn(async () => response(200, { items: Array.from({ length: 35 }, (_, i) => ({ id: 'r' + i, title: 'Engineer', total_experience: { months: 60 } })) }));
    vi.stubGlobal('fetch', fetch);
    try {
      await api.runProactiveSearch(user, root, { vacancyId: 'A' });
      await api.runProactiveSearch(user, root, { vacancyId: 'B' });
      expect(new URL(fetch.mock.calls[1][0]).searchParams.get('area')).toBe('2');
      expect(JSON.parse(fs.readFileSync(path.join(ctx, 'active_vacancy.json'))).value.id).toBe('A');
      expect(Object.keys(api.loadAllCandidates(user, 'B'))).toHaveLength(35);
      expect(Object.keys(api.loadSeenIds(user).B)).toHaveLength(35);
      expect(latestProactiveFile(user, 'A')).not.toBe(latestProactiveFile(user, 'B'));
      expect(JSON.parse(fs.readFileSync(latestProactiveFile(user, 'B'))).search_area_ids).toEqual(['2']);
      const write = fs.writeFileSync;
      const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        if (String(file).includes('all-candidates.json.tmp')) throw new Error('disk full');
        return write(file, ...args);
      });
      fetch.mockResolvedValue(response(200, { items: [{ id: 'unsaved', title: 'Engineer', total_experience: { months: 60 } }] }));
      try { await expect(api.runProactiveSearch(user, root, { vacancyId: 'B' })).rejects.toThrow('disk full'); }
      finally { spy.mockRestore(); }
      expect(api.loadSeenIds(user).B.unsaved).toBeUndefined();
      fetch.mockResolvedValue(response(403));
      await expect(api.runProactiveSearch(user, root, { vacancyId: 'B' })).rejects.toThrow('403');
      expect(JSON.parse(fs.readFileSync(latestProactiveFile(user, 'B'))).total_collected).toBe(35);
    } finally {
      for (const [key, value] of Object.entries({ AGENT_DATA_DIR: oldData, AGENT_TOKENS_DIR: oldTokens, OPENROUTER_API_KEY: oldKey })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('monitoring lifecycle and run exclusion', () => {
  it('a profile never runs two cold searches at once; a dead holder lock is reclaimed', async () => {
    const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
    const { acquireSearchLock } = require('../src/domains/hh/lib').hhLib('hh-cold-search-lock');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-schedule-')); const old = process.env.AGENT_DATA_DIR;
    process.env.AGENT_DATA_DIR = path.join(root, 'data');
    try {
      const release = acquireSearchLock('u');
      expect(() => acquireSearchLock('u')).toThrow(/уже выполняется/);
      release(); acquireSearchLock('u')();
      const lock = path.join(root, 'data', 'hh', 'u', 'proactive', 'search.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
      acquireSearchLock('u')();
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      if (old === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = old;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('scoring explanation belongs to the requested run', () => {
  it('does not mix latest B queries with A criteria or use config edited after the run', () => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const { buildScoringPromptText } = require('../src/domains/hh/lib').hhLib('hh-proactive-search');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-explain-'));
    const old = process.env.AGENT_DATA_DIR;
    process.env.AGENT_DATA_DIR = root;
    const dir = path.join(root, 'hh', 'fixture', 'proactive'); fs.mkdirSync(dir, { recursive: true });
    try {
      for (const [id, date, title] of [['A', '2026-09-23', 'Designer'], ['B', '2026-09-24', 'Sales']]) {
        fs.writeFileSync(path.join(dir, 'search-results-' + id + '.json'), JSON.stringify({ vacancy_id: id, searched_at: date,
          ats_config: { vacancy_title: title, required: [], preferred: [] }, search_queries: [title] }));
      }
      const a = buildScoringPromptText('fixture', 'A');
      expect(a).toContain('Designer'); expect(a).not.toContain('Sales');
      expect(buildScoringPromptText('fixture', 'B')).toContain('Sales');
      expect(buildScoringPromptText('fixture', 'C')).toContain('ещё не запускался');
    } finally {
      if (old === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = old;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('background scoring isolation', () => {
  it('scores latest snapshot of each vacancy with its own criteria and skips superseded history', async () => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const api = require('../src/domains/hh/lib').hhLib('hh-proactive-search');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-bg-scope-'));
    const old = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, AGENT_TOKENS_DIR: process.env.AGENT_TOKENS_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
    process.env.AGENT_DATA_DIR = root; process.env.AGENT_TOKENS_DIR = path.join(root, 'tokens'); process.env.OPENROUTER_API_KEY = 'fixture';
    const dir = path.join(root, 'hh', 'fixture', 'proactive'); fs.mkdirSync(dir, { recursive: true });
    const prompts = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      prompts.push(JSON.parse(init.body).messages[0].content);
      return response(200, { choices: [{ message: { content: JSON.stringify({ plus_tags: ['match'] }) } }] });
    });
    try {
      for (const [id, title, date] of [['A', 'Old criteria', '2026-09-21'], ['A', 'Designer', '2026-09-23'], ['B', 'Sales', '2026-09-24']]) {
        fs.writeFileSync(path.join(dir, `search-results-${id}-${date}.json`), JSON.stringify({ vacancy_id: id, searched_at: date,
          ats_config: { vacancy_title: title }, candidates: [{ id: 'same', title: 'Role', ai_pending: true }] }));
      }
      expect(await api.scoreUnscoredProactiveCandidates('fixture')).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts.join('\n')).not.toContain('Old criteria');
      expect(prompts.join('\n')).toContain('Designer'); expect(prompts.join('\n')).toContain('Sales');
      expect(api.loadAllCandidates('fixture', 'A').same.plus_tags).toEqual(['match']);
      expect(api.loadAllCandidates('fixture', 'B').same.plus_tags).toEqual(['match']);
      expect(await api.scoreUnscoredProactiveCandidates('fixture')).toBe(0);
    } finally {
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
