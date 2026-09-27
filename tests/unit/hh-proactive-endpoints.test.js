// Integration tests for the new/updated HH proactive-search HTTP endpoints:
//   - POST /api/hh/proactive/add-manual  (new — spec item #2; step 7/7: vacancy tagging)
//   - GET  /api/hh/proactive/candidates  (updated — unified store, no pagination)
//   - GET  /hh/proactive                 (step 7/7: vacancy_id filter + tab switcher)
// Spawns a real server.js process with mocked secrets in env, uses mock-hh-server
// for the HH /resumes/{id} call, and verifies the unified all-candidates.json store.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import * as http from 'http';
import { createHmac } from 'node:crypto';
import { createMockHhServer } from '../helpers/mock-hh-server.js';

const TEST_UID = 'hh-proactive-ep-test-001';
const SECRET = 'test-agent-secret-hh-proactive';

let tokensDir, dataDir, usersDir, mockHh, serverProc, serverPort;

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function proactiveToken() {
  return createHmac('sha256', SECRET).update(TEST_UID).digest('hex').slice(0, 16);
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/server.js'], {
      cwd: join(fileURLToPath(import.meta.url), '..', '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    const lines = [];
    const expectedPort = parseInt(env.PORT || '3001', 10);
    const tryResolve = () => {
      for (const line of lines) {
        if (line.includes('listening on')) { resolved = true; resolve({ proc, port: expectedPort }); return true; }
      }
      return false;
    };
    proc.stdout.on('data', (chunk) => { const text = chunk.toString(); lines.push(...text.split('\n')); if (!resolved) tryResolve(); });
    proc.stderr.on('data', (chunk) => { const text = chunk.toString(); lines.push(...text.split('\n')); if (!resolved) tryResolve(); });
    proc.on('error', reject);
    proc.on('exit', (code) => { if (!resolved) reject(new Error(`Server exited with code ${code}\n${lines.join('\n')}`)); });
    setTimeout(() => { if (!resolved) reject(new Error(`Server didn't start in 5s. Output:\n${lines.join('\n')}`)); }, 5000);
  });
}

function writeActiveVacancies(vacancies) {
  const dir = join(usersDir, TEST_UID, 'contexts', 'hh');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'active_vacancies.json'),
    JSON.stringify({ value: vacancies, updated_at: new Date().toISOString() }),
  );
}

beforeAll(async () => {
  tokensDir = mkdtempSync(join(tmpdir(), 'hh-proactive-ep-tokens-'));
  dataDir = mkdtempSync(join(tmpdir(), 'hh-proactive-ep-data-'));
  usersDir = mkdtempSync(join(tmpdir(), 'hh-proactive-ep-users-'));

  const tokenDir = join(tokensDir, TEST_UID);
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'hh'), JSON.stringify({ access_token: 'test-hh-access-token', refresh_token: null, employer_id: 'emp-001' }), { mode: 0o600 });

  mockHh = createMockHhServer({
    resumes: {
      'manualres1': {
        id: 'manualres1',
        alternate_url: 'https://hh.ru/resume/manualres1',
        title: 'Финансовый директор',
        first_name: 'Мария',
        last_name: 'Кузнецова',
        age: 35,
        area: { name: 'Москва' },
        total_experience: { months: 84 },
        experience: [{ position: 'CFO', company: 'ООО Тест', start: '2019-01-01', end: null }],
      },
      'manualres2': {
        id: 'manualres2',
        alternate_url: 'https://hh.ru/resume/manualres2',
        title: 'Продуктовый менеджер',
        first_name: 'Пётр',
        last_name: 'Смирнов',
        age: 30,
        area: { name: 'Москва' },
        total_experience: { months: 48 },
        experience: [{ position: 'PM', company: 'ООО Продукт', start: '2021-01-01', end: null }],
      },
    },
  });
  await mockHh.start();

  const { proc, port } = await startServer({
    PORT: '13580',
    SECRETS_SOURCE: 'env',
    OPENROUTER_API_KEY: '',
    TELEGRAM_BOT_TOKEN: 'test-tg-token-hh-proactive',
    AGENT_SECRET: SECRET,
    AGENT_PUBLIC_URL: 'https://old-server.sslip.io/agent',
    HH_COLD_SEARCH_PUBLIC_URL: '',
    AGENT_TOKENS_DIR: tokensDir,
    AGENT_DATA_DIR: dataDir,
    USERS_DIR: usersDir,
    HH_API_BASE_URL: mockHh.baseUrl,
    NODE_ENV: 'test',
  });
  serverProc = proc;
  serverPort = port;
}, 10000);

afterAll(async () => {
  if (serverProc) serverProc.kill('SIGTERM');
  if (mockHh) await mockHh.stop();
  try { rmSync(tokensDir, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(usersDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  mockHh.reset();
});

describe('POST /api/hh/proactive/add-manual', () => {
  it('fetches the resume from HH, stores it as source:manual, and returns the candidate', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'https://hh.ru/resume/manualres1',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.candidate.id).toBe('manualres1');
    expect(r.body.candidate.source).toBe('manual');
    expect(r.body.candidate.first_name).toBe('Мария');
    expect(r.body.candidate.total_exp_years).toBe(7);

    const storeFile = join(dataDir, 'hh', TEST_UID, 'proactive', 'all-candidates.json');
    const store = JSON.parse(readFileSync(storeFile, 'utf8'));
    expect(store['manualres1'].source).toBe('manual');
  });

  it('accepts a bare resume id (not just a URL)', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'manualres1',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('missing resume_url_or_id → 400', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
    });
    expect(r.status).toBe(400);
  });

  it('wrong token → 403', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: 'wrong-token',
      resume_url_or_id: 'manualres1',
    });
    expect(r.status).toBe(403);
  });

  it('resume not found on HH → error response, not a crash', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID,
      token: proactiveToken(),
      resume_url_or_id: 'does-not-exist',
    });
    expect(r.status).toBe(500);
    expect(r.body.error).toBeTruthy();
  });
});

describe('GET /api/hh/proactive/candidates — unified, unpaginated', () => {
  it('returns the full unified list with no page/per_page params required', async () => {
    // Seed a couple more manual candidates so the list has >1 entry.
    await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: TEST_UID, token: proactiveToken(), resume_url_or_id: 'manualres1',
    });
    const r = await get(`http://127.0.0.1:${serverPort}/api/hh/proactive/candidates?username=${TEST_UID}&token=${proactiveToken()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.candidates)).toBe(true);
    expect(r.body.total).toBe(r.body.candidates.length);
    // Old paginated shape had `pages`/`per_page` — confirm the response no longer
    // implies server-side pagination by not silently truncating results.
    expect(r.body.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('wrong token → 403', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/api/hh/proactive/candidates?username=${TEST_UID}&token=wrong`);
    expect(r.status).toBe(403);
  });
});

// Multi-vacancy step 7/7: a profile tracking 2+ active vacancies tags manually-added
// candidates with whichever vacancy is active, and /hh/proactive filters + renders a
// tab switcher once active_vacancies.length > 1. Separate username from TEST_UID so
// this doesn't interact with the token-file state written above; token files are
// keyed by username only, but active_vacancies is what actually drives this feature.
const MULTI_VAC_UID = 'hh-proactive-ep-multivac-001';

function multiVacToken() {
  return createHmac('sha256', SECRET).update(MULTI_VAC_UID).digest('hex').slice(0, 16);
}

describe('multi-vacancy tagging + tab switcher (step 7/7)', () => {
  beforeAll(() => {
    const tokenDir = join(tokensDir, MULTI_VAC_UID);
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, 'hh'), JSON.stringify({ access_token: 'test-hh-access-token', refresh_token: null, employer_id: 'emp-001' }), { mode: 0o600 });
    const dir = join(usersDir, MULTI_VAC_UID, 'contexts', 'hh');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'active_vacancies.json'),
      JSON.stringify({ value: [{ id: 'vac-A', title: 'Vacancy A' }, { id: 'vac-B', title: 'Vacancy B' }], updated_at: new Date().toISOString() }),
    );
    // /hh/proactive 404s ("no data yet") unless at least one search-results-*.json
    // snapshot exists — seed a minimal one; the route overlays the unified
    // all-candidates store on top of it anyway (see hh-skill src/hh-routes.js).
    const proactiveDir = join(dataDir, 'hh', MULTI_VAC_UID, 'proactive');
    mkdirSync(proactiveDir, { recursive: true });
    writeFileSync(
      join(proactiveDir, 'search-results-2026-09-22.json'),
      JSON.stringify({ vacancy_id: 'vac-A', vacancy_title: 'Vacancy A', searched_at: new Date().toISOString(), candidates: [] }),
    );
  });

  it('add-manual tags the candidate with the profile\'s first active vacancy when no vacancy_id is given', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: MULTI_VAC_UID, token: multiVacToken(), resume_url_or_id: 'manualres1',
    });
    expect(r.status).toBe(200);
    expect(r.body.candidate.vacancy_ids).toEqual(['vac-A']);
  });

  it('add-manual tags with an explicit vacancy_id from the request body when given', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/add-manual`, {
      username: MULTI_VAC_UID, token: multiVacToken(), resume_url_or_id: 'manualres2', vacancy_id: 'vac-B',
    });
    expect(r.status).toBe(200);
    expect(r.body.candidate.vacancy_ids).toEqual(['vac-B']);
  });

  it('keeps cold-search navigation and API callbacks on the public recruiting domain', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-B`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('const CALLBACK_BASE = "https://recruiter-assistant.ru"');
    expect(r.body).toContain('https://recruiter-assistant.ru/hh/proactive?');
    expect(r.body).not.toContain('sslip.io');
  });

  it('GET /hh/proactive renders a tab per active vacancy, marking the requested one active', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-B`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('vacancy-tabs');
    expect(r.body).toContain('Vacancy A');
    expect(r.body).toContain('Vacancy B');
    expect(r.body).toContain('vacancy_id=vac-B');
  });

  // Candidate names only show up (lowercased) in each card's data-search attribute,
  // not as visible text — match on data-id (unambiguous, matches the actual filtering
  // contract) instead of relying on name substrings.
  it('GET /hh/proactive?vacancy_id=vac-B only shows the candidate tagged for vac-B', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-B`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('data-id=\\"manualres2\\"');
    expect(r.body).not.toContain('data-id=\\"manualres1\\"');
  });

  it('GET /hh/proactive?vacancy_id=vac-A only shows the candidate tagged for vac-A', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-A`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('data-id=\\"manualres1\\"');
    expect(r.body).not.toContain('data-id=\\"manualres2\\"');
  });
});

// Candidate triage lifecycle: POST /api/hh/proactive/set-status moves a candidate
// between active/starred/archived, and GET /hh/proactive?list=... only shows
// candidates currently in that state — reuses vac-A's manualres1 (still 'active'
// from the block above) so this exercises a real end-to-end move.
describe('POST /api/hh/proactive/set-status + list= tabs', () => {
  it('moves a candidate into the starred tab and out of the active one', async () => {
    const setRes = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/set-status`, {
      username: MULTI_VAC_UID, token: multiVacToken(), candidate_id: 'manualres1', status: 'starred',
    });
    expect(setRes.status).toBe(200);
    expect(setRes.body.ok).toBe(true);
    expect(setRes.body.status).toBe('starred');
    expect(setRes.body.status_changed_at).toBeTruthy();

    const activeView = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-A&list=active`);
    expect(activeView.body).not.toContain('data-id=\\"manualres1\\"');

    const starredView = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-A&list=starred`);
    expect(starredView.body).toContain('data-id=\\"manualres1\\"');
  });

  it('renders state tabs with counts reflecting the move above', async () => {
    const r = await get(`http://127.0.0.1:${serverPort}/hh/proactive?username=${MULTI_VAC_UID}&token=${multiVacToken()}&vacancy_id=vac-A`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('state-tabs');
    expect(r.body).toContain('⭐ Выбрано (1)');
  });

  it('rejects an invalid status value with 400, not a crash', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/set-status`, {
      username: MULTI_VAC_UID, token: multiVacToken(), candidate_id: 'manualres1', status: 'bogus',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid status/);
  });

  it('wrong token → 403', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/set-status`, {
      username: MULTI_VAC_UID, token: 'wrong', candidate_id: 'manualres1', status: 'archived',
    });
    expect(r.status).toBe(403);
  });

  it('unknown candidate_id → 400, not a crash', async () => {
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/set-status`, {
      username: MULTI_VAC_UID, token: multiVacToken(), candidate_id: 'does-not-exist', status: 'archived',
    });
    expect(r.status).toBe(400);
  });
});

describe('vacancy-scoped detail readers (#1232)', () => {
  it('AI detail reads requested A even when B has the newest snapshot', async () => {
    const dir = join(dataDir, 'hh', TEST_UID, 'proactive');
    mkdirSync(dir, { recursive: true });
    for (const [id, date] of [['reader-A', '2026-09-23'], ['reader-B', '2026-09-24']]) {
      writeFileSync(join(dir, `search-results-${id}.json`), JSON.stringify({ vacancy_id: id, searched_at: date,
        ats_config: { vacancy_title: id }, candidates: [{ id: `candidate-${id}`, experience: [] }] }));
    }
    const r = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/ai-score`, {
      username: TEST_UID, token: proactiveToken(), vacancy_id: 'reader-A', candidate_id: 'candidate-reader-B',
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('candidate not found');
    const a = await post(`http://127.0.0.1:${serverPort}/api/hh/proactive/ai-score`, {
      username: TEST_UID, token: proactiveToken(), vacancy_id: 'reader-A', candidate_id: 'candidate-reader-A',
    });
    expect(a.status).toBe(500);
    expect(a.body.error).toContain('OpenRouter API key not configured');
  });
});
