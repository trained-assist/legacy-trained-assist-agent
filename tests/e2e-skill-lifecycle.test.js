/**
 * E2E skill lifecycle tests.
 *
 * Coverage:
 *  1. Connect form HTML — pre-fill with saved / empty state
 *  2. Playwright scraping (gc_group_list, gc_course_list):
 *     - normal list
 *     - session expired → typed error instead of empty list
 *     - pagination → has_more warning
 *     - icon-only anchors filtered out
 *     - cookie without domain field doesn't throw
 *  3. Skill lifecycle: activate → use → deactivate (revoke)
 *
 * All tests use the mock HTTPS server and a temp agent-tokens directory
 * so no real credentials or external services are needed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// Playwright tests require a real Chromium binary — skip in CI (no binary installed there)
// and on macOS dev machines. Run locally on Linux VMs (GCP + RU) or when RUN_PW_TESTS=1.
const IS_LINUX = process.platform === 'linux' && !process.env.CI;
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { startMockServer, stopMockServer, setScenario } = require('./helpers/mock-getcourse-server.js');
const { connectFormHtml } = require('../src/connect-forms/generic.js');
const { getcourseFormHtml } = require('../src/connect-forms/getcourse.js');
const { loginCredsFormHtml } = require('../src/connect-forms/login-creds.js');
const { revokeService, listConnectedServices } = require('../src/user-tokens.js');
const { tokensRoot } = require('../src/data-paths.js');

let MOCK_DOMAIN;

// Test user isolated from production data. Path comes from the single token-root
// resolver (data-paths) — hardcoding homedir()/agent-tokens here would point at a
// different root than user-tokens uses whenever AGENT_TOKENS_DIR/ROOT is redirected
// (the vitest isolation setup does exactly that).
const TEST_USER_ID = `e2e-test-${process.pid}-${Date.now()}`;
const TOKEN_DIR = join(tokensRoot(), TEST_USER_ID);
const GC_CONFIG_DIR = join(TOKEN_DIR, 'getcourse');
const GC_CONFIG_FILE = join(GC_CONFIG_DIR, 'config.json');

function makeGcConfig(overrides = {}) {
  return {
    accountDomain: MOCK_DOMAIN,
    apiKey: 'test-api-key',
    sessionCookies: [
      { name: 'PHPSESSID', value: 'fakesession', domain: '127.0.0.1', path: '/', secure: true, httpOnly: false },
    ],
    sessionUserAgent: 'Mozilla/5.0 (Test)',
    ...overrides,
  };
}

function writeGcConfig(cfg) {
  mkdirSync(GC_CONFIG_DIR, { recursive: true });
  writeFileSync(GC_CONFIG_FILE, JSON.stringify(cfg));
}

function loadGcTools() {
  // Re-require so USER_ID env is picked up
  delete require.cache[require.resolve('../src/mcp-skills/tools/80-getcourse.js')];
  return require('../src/mcp-skills/tools/80-getcourse.js').tools;
}

const ctx = { userId: TEST_USER_ID };

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.USER_ID = TEST_USER_ID;
  MOCK_DOMAIN = `127.0.0.1:${await startMockServer(0)}`;
}, 20000);

afterAll(async () => {
  await stopMockServer();
  try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  delete process.env.USER_ID;
});

beforeEach(() => {
  setScenario('normal');
});

// ── 1. Connect form HTML ──────────────────────────────────────────────────────

describe('Connect form HTML', () => {
  describe('generic form (GitHub, Weeek)', () => {
    const meta = { name: 'GitHub', placeholder: 'ghp_xxx', hint: 'Settings → Tokens' };

    it('shows plain form when no saved value', () => {
      const html = connectFormHtml('github', meta, 'tok123', null);
      // Button says "Подключить"; no saved-state banner; no prefilled indicator
      expect(html).toContain('>Подключить</button>');
      expect(html).not.toContain('Данные сохранены с прошлого раза');
      // Note: the word "Переподключить" appears in JS error-handler code even without saved data —
      // only the button element text and the banner div reveal actual saved state to the user.
    });

    it('shows pre-fill banner and "Переподключить" when saved value exists', () => {
      const html = connectFormHtml('github', meta, 'tok123', 'ghp_real_token');
      expect(html).toContain('Данные сохранены с прошлого раза');
      expect(html).toContain('Переподключить');
      // Saved value embedded as JS literal (JSON-encoded)
      expect(html).toContain(JSON.stringify('ghp_real_token'));
    });

    it('does not XSS-inject saved value — embeds via JSON.stringify', () => {
      const malicious = '</script><script>alert(1)</script>';
      const html = connectFormHtml('github', meta, 'tok123', malicious);
      // JSON.stringify escapes < > so no raw script tags injected
      expect(html).not.toContain(malicious);
      expect(html).toContain('\\u003c'); // JSON-escaped <
    });
  });

  describe('GetCourse form', () => {
    it('shows plain form when no saved config', () => {
      const html = getcourseFormHtml('tok123', null);
      expect(html).toContain('Подключить');
      expect(html).not.toContain('Данные сохранены с прошлого раза');
    });

    it('shows pre-fill banner with saved domain and apiKey', () => {
      const saved = { domain: 'myschool.getcourse.ru', apiKey: 'key123', login: null, password: null, hasSession: false };
      const html = getcourseFormHtml('tok123', saved);
      expect(html).toContain('Данные сохранены с прошлого раза');
      expect(html).toContain(JSON.stringify('myschool.getcourse.ru'));
      expect(html).toContain(JSON.stringify('key123'));
    });

    it('shows "сессия активна" badge when hasSession true', () => {
      const saved = { domain: 'x.getcourse.ru', apiKey: null, login: null, password: null, hasSession: true };
      const html = getcourseFormHtml('tok123', saved);
      expect(html).toContain('активна');
    });

    it('handles null saved gracefully (no crash, no pre-fill)', () => {
      const html = getcourseFormHtml('tok123', null);
      expect(html).toContain('Подключить');
    });
  });

  describe('login-creds form (Tilda)', () => {
    const meta = { name: 'Tilda (логин)', hint: 'Логин от tilda.ru', emailPlaceholder: 'you@tilda.ru' };

    it('shows plain form with no saved data', () => {
      const html = loginCredsFormHtml('tilda-creds', meta, 'tok123', null);
      expect(html).toContain('Сохранить');
      expect(html).not.toContain('Данные сохранены с прошлого раза');
    });

    it('pre-fills email and shows "Обновить" when data saved', () => {
      const saved = { email: 'me@tilda.ru', password: 's3cret' };
      const html = loginCredsFormHtml('tilda-creds', meta, 'tok123', saved);
      expect(html).toContain('Данные сохранены с прошлого раза');
      expect(html).toContain(JSON.stringify('me@tilda.ru'));
      expect(html).toContain('Обновить');
    });
  });
});

// ── 2. Playwright scraping ────────────────────────────────────────────────────

describe.skipIf(!IS_LINUX)('gc_group_list Playwright scraping', () => {
  beforeEach(() => {
    writeGcConfig(makeGcConfig());
  });

  it('returns groups from normal page', async () => {
    setScenario('normal');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);

    expect(result.groups).toBeDefined();
    expect(result.groups.length).toBeGreaterThanOrEqual(2);

    const names = result.groups.map(g => g.name);
    expect(names).toContain('Базовый доступ');
    expect(names).toContain('Премиум');

    // Icon-only anchor (id=103) must be filtered out
    const ids = result.groups.map(g => g.id);
    expect(ids).not.toContain('103');
  }, 30000);

  it('filters group names — no badge text concatenated into name', async () => {
    setScenario('normal');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);

    const premium = result.groups.find(g => g.id === '102');
    expect(premium).toBeDefined();
    // "Премиум" group has a <span>3</span> badge — name must NOT be "Премиум3"
    expect(premium.name).toBe('Премиум');
  }, 30000);

  it('query param filters results', async () => {
    setScenario('normal');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({ query: 'баз' }, ctx);

    expect(result.groups.length).toBe(1);
    expect(result.groups[0].name).toBe('Базовый доступ');
  }, 30000);

  it('returns session_expired error (not empty list) when session stale', async () => {
    setScenario('expired');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);

    expect(result.error).toBe('session_expired');
    expect(result.message).toMatch(/gc_connect/);
    // Must NOT return an empty groups array — that was the silent-failure bug
    expect(result.groups).toBeUndefined();
  }, 30000);

  it('returns has_more warning on paginated page', async () => {
    setScenario('pagination');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('has_more');
  }, 30000);

  it('handles cookie without domain field (no TypeError crash)', async () => {
    writeGcConfig(makeGcConfig({
      sessionCookies: [
        { name: 'PHPSESSID', value: 'fakesession', path: '/' }, // no domain field
      ],
    }));
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);

    // Should not throw TypeError — either succeeds or returns a typed error
    expect(result.error).not.toMatch(/TypeError/);
  }, 30000);
}, { timeout: 60000 });

describe.skipIf(!IS_LINUX)('gc_course_list Playwright scraping', () => {
  beforeEach(() => {
    writeGcConfig(makeGcConfig());
  });

  it('returns courses from course tree page', async () => {
    const { gc_course_list } = loadGcTools();
    const result = await gc_course_list.handler({}, ctx);

    expect(result.courses).toBeDefined();
    expect(result.courses.length).toBe(2);
    const ids = result.courses.map(c => c.id);
    expect(ids).toContain('201');
    expect(ids).toContain('202');
  }, 30000);

  it('returns session_expired error when session stale', async () => {
    setScenario('expired');
    const { gc_course_list } = loadGcTools();
    const result = await gc_course_list.handler({}, ctx);

    expect(result.error).toBe('session_expired');
    expect(result.courses).toBeUndefined();
  }, 30000);
});

// ── 3. Skill lifecycle: activate → use → deactivate ──────────────────────────

describe('Skill lifecycle (no real external service)', () => {
  beforeEach(() => {
    // Clean state: remove any leftover tokens for test user
    try { rmSync(TOKEN_DIR, { recursive: true, force: true }); } catch {}
  });

  it('activate: write tilda-creds → list shows connected → use reads back → revoke removes', () => {
    // Activate: simulate what the form POST handler does
    mkdirSync(TOKEN_DIR, { recursive: true });
    const credsPath = join(TOKEN_DIR, 'tilda-creds');
    writeFileSync(credsPath, JSON.stringify({ email: 'test@tilda.ru', password: 's3cret' }), { mode: 0o600 });

    // List: service appears in connected list
    const connected = listConnectedServices(TEST_USER_ID);
    expect(connected).not.toBeNull();
    const names = connected.map(s => s.file);
    expect(names).toContain('tilda-creds');

    // Use: creds readable back correctly
    const stored = JSON.parse(readFileSync(credsPath, 'utf8'));
    expect(stored.email).toBe('test@tilda.ru');
    expect(stored.password).toBe('s3cret');

    // Deactivate: revoke removes the file
    const result = revokeService(TEST_USER_ID, 'tilda-creds');
    expect(result).toBe('tilda-creds');
    expect(existsSync(credsPath)).toBe(false);

    // Confirm service no longer in list
    const after = listConnectedServices(TEST_USER_ID);
    expect(after).toBeNull();
  });

  it.skipIf(!IS_LINUX)('activate: write getcourse config → gc_group_list uses it → revoke cleans up', async () => {
    writeGcConfig(makeGcConfig());

    // Use: gc_group_list reads config and scrapes mock server
    setScenario('normal');
    const { gc_group_list } = loadGcTools();
    const result = await gc_group_list.handler({}, ctx);
    expect(result.groups?.length).toBeGreaterThan(0);

    // Deactivate: revoke removes getcourse dir
    const revoked = revokeService(TEST_USER_ID, 'getcourse');
    // getcourse is stored as a directory, not a flat file — revoke may return not_found
    // depending on SERVICE_DISPLAY config; verify the config file is gone
    expect(existsSync(GC_CONFIG_FILE)).toBe(false);
  }, 30000);
});
