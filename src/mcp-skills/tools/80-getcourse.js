'use strict';

// GetCourse skill — two-level integration
// L1 (API key):  user management, orders           → /pl/api/*
// L2 (session):  course/lesson/block creation,     → /pl/teach/gcapi/* and /pl/lite/block/*
//                group listing (Playwright)

const fs = require('fs');
const path = require('path');
const { tokenPath } = require('../../data-paths');

const { generateConnectLink: generateConnectLinkZC } = require('../../user-tokens');
const { readCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';

// ── Playwright helper ────────────────────────────────────────────────────
// Shared browser launch + cookie injection to avoid copy-paste across tools.
async function openBrowserPage(cfg) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ userAgent: cfg.sessionUserAgent || FALLBACK_UA, ignoreHTTPSErrors: true });
  await context.addCookies((cfg.sessionCookies || []).map(c => ({
    name: c.name, value: c.value,
    domain: (c.domain || '').startsWith('.') ? c.domain : '.' + (c.domain || cfg.accountDomain),
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  return { browser, page };
}

// ── Config ────────────────────────────────────────────────────────────────

function configPath(userId) {
  return path.join(tokenPath(String(userId || USER_ID), 'getcourse'), 'config.json');
}

function readConfig(userId) {
  const file = configPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(readCredentialFile(file)); } catch { return {}; }
}

// ── Level guards ──────────────────────────────────────────────────────────

function requireL1(cfg) {
  if (!cfg.accountDomain) return { error: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
  if (!cfg.apiKey)        return { error: 'api_key_required', message: 'Нужен API ключ. Вызови gc_connect и введи API ключ из настроек GetCourse.' };
  return null;
}

function requireL2(cfg) {
  if (!cfg.accountDomain) return { error: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
  if (!cfg.sessionCookies || !cfg.sessionCookies.length)
    return { error: 'session_required', message: 'Для этой операции нужна авторизация через браузер. Вызови gc_connect и введи логин + пароль.' };
  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function buildCookieHeader(cfg) {
  return (cfg.sessionCookies || []).map(c => `${c.name}=${c.value}`).join('; ');
}

// L1: POST export  (users, groups, orders)
// GetCourse requires POST with form-encoded body — GET with query params returns "Пустой параметр action"
async function gcApiExport(cfg, endpoint, paramsObj) {
  const paramsB64 = Buffer.from(JSON.stringify(paramsObj)).toString('base64');
  const body = new URLSearchParams({ action: 'export', key: cfg.apiKey, params: paramsB64 });
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.error === 'Действие запрещено') {
      return { error: 'export_forbidden', message: 'API ключ не имеет прав на экспорт данных. В GetCourse: Настройки → API → включи "Экспорт пользователей" и "Экспорт заказов".' };
    }
    return json;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

// L1: POST import (users)
async function gcApiImport(cfg, endpoint, payload) {
  const paramsB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const body = new URLSearchParams({ action: 'add', key: cfg.apiKey, params: paramsB64 });
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

const FALLBACK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function l2Headers(cfg, extra = {}) {
  return {
    'User-Agent': cfg.sessionUserAgent || FALLBACK_UA,
    'Cookie': buildCookieHeader(cfg),
    'x-requested-with': 'XMLHttpRequest',
    'Origin': `https://${cfg.accountDomain}`,
    'Referer': `https://${cfg.accountDomain}/`,
    ...extra,
  };
}

// L2: JSON POST (createTraining, createLesson)
async function gcSessionJson(cfg, endpoint, payload) {
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: l2Headers(cfg, {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
    }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (res.redirected && res.url.includes('/login')) {
    return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
  }
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && (data.accountUserId === -1 || data.user_id === -1)) {
      return { error: 'session_expired', message: 'Сессия истекла (accountUserId=-1). Вызови gc_connect чтобы войти заново.' };
    }
    if (data && data.success === false) return { error: data.error || 'request failed', raw: data };
    return data;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

// L2: FormData POST (lesson-constructor/add, block/update-param, block/save-sorting)
async function gcSessionForm(cfg, endpoint, fields) {
  const form = new FormData();
  const vars = cfg.sessionVars || {};
  if (vars.gcSession)     form.append('gcSession',     vars.gcSession);
  if (vars.gcVisit)       form.append('gcVisit',       vars.gcVisit);
  if (vars.gcVisitor)     form.append('gcVisitor',     vars.gcVisitor);
  if (vars.gcSessionHash) form.append('gcSessionHash', vars.gcSessionHash);
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v == null ? '' : String(v));
  }
  const res = await fetch(`https://${cfg.accountDomain}${endpoint}`, {
    method: 'POST',
    headers: l2Headers(cfg, {
      'Accept': 'application/json, text/plain, */*',
    }),
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (res.redirected && res.url.includes('/login')) {
    return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
  }
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && (data.accountUserId === -1 || data.user_id === -1)) {
      return { error: 'session_expired', message: 'Сессия истекла (accountUserId=-1). Вызови gc_connect чтобы войти заново.' };
    }
    if (data && data.success === false) return { error: data.error || 'request failed', raw: data };
    return data;
  } catch { return { error: 'non-json response', preview: text.slice(0, 500) }; }
}

function parseCreatedId(result) {
  const url = result?.data?.redirectUrl || '';
  const m = url.match(/[?&]id=(\d+)/) || url.match(/\/id\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Connect pending token ─────────────────────────────────────────────────

async function generateConnectLink(userId) {
  return generateConnectLinkZC(String(userId), 'getcourse');
}

// ── Tools ─────────────────────────────────────────────────────────────────

module.exports = {
  isReady: () => USER_ID ? fs.existsSync(configPath(USER_ID)) : false,
  setupTools: ['gc_status', 'gc_connect'],

  tools: {

    gc_status: {
      description: 'Show GetCourse connection status: account domain, API key presence (L1), session presence and age (L2).',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        if (!cfg.accountDomain) {
          return { status: 'not_configured', message: 'GetCourse не подключён. Вызови gc_connect.' };
        }
        const hasL1 = !!cfg.apiKey;
        const hasL2 = !!(cfg.sessionCookies && cfg.sessionCookies.length);
        return {
          accountDomain: cfg.accountDomain,
          level1_api_key: hasL1 ? 'configured' : 'not configured',
          level2_session: hasL2 ? `configured (${cfg.loginSavedAt || 'date unknown'})` : 'not configured',
          available: hasL2 ? 'L1 + L2 (full)' : hasL1 ? 'L1 only (user management)' : 'none — reconnect via gc_connect',
        };
      },
    },

    gc_connect: {
      description: 'Generate a one-time connection link for the user. The form lets them enter: account domain (required), API key (→ L1 user management), login + password (→ L2 course editing via browser session). They can fill any combination.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const userId = ctx?.userId || USER_ID;
        if (!userId) return { error: 'No user ID in context' };
        const url = await generateConnectLink(String(userId));
        return {
          url,
          message: `Открой ссылку для подключения GetCourse:\n${url}\n\nФорма имеет 3 секции:\n• Домен аккаунта (обязательно)\n• API ключ — L1 (управление учениками)\n• Логин + Пароль — L2 (создание курсов через браузерную сессию)\n\nЛюбая комбинация полей допустима. Ссылка одноразовая, действует 30 минут.`,
        };
      },
    },

    // ── L1: User management ───────────────────────────────────────────────

    gc_user_add: {
      description: 'Add or update a GetCourse user and add them to access groups. Safe for existing users (refresh_if_exists). Use to grant course access.',
      inputSchema: {
        type: 'object',
        required: ['email'],
        properties: {
          email:      { type: 'string', description: 'User email' },
          first_name: { type: 'string', description: 'First name' },
          last_name:  { type: 'string', description: 'Last name' },
          phone:      { type: 'string', description: 'Phone number' },
          groups:     { type: 'array', items: { type: 'string' }, description: 'Group names to add the user to, e.g. ["Доступ | Курс X"]' },
          utm_source: { type: 'string', description: 'UTM source (default: agent)' },
        },
      },
      handler: async ({ email, first_name, last_name, phone, groups = [], utm_source = 'agent' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL1(cfg);
        if (err) return err;

        const payload = {
          user: {
            email,
            ...(first_name && { first_name }),
            ...(last_name  && { last_name }),
            ...(phone      && { phone }),
            ...(groups.length && { group_name: groups }),
          },
          system: { refresh_if_exists: 1 },
          session: { utm_source, utm_medium: 'bot', utm_campaign: 'agent_action', referer: 'agent' },
        };
        return gcApiImport(cfg, '/pl/api/users', payload);
      },
    },

    gc_user_find: {
      description: 'Find a GetCourse user by email via Playwright (L2 session). Returns user id, name, groups, registration date. Requires L2 session. Takes ~15s.',
      inputSchema: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'User email to search' },
        },
      },
      handler: async ({ email }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          const searchUrl = `https://${cfg.accountDomain}/pl/user/user/index?search[email]=${encodeURIComponent(email)}`;
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          // Extract user rows — links like /user/control/user/update/id/{id}
          const users = await page.evaluate(() => {
            const rows = [];
            document.querySelectorAll('a[href*="/user/control/user/update/id/"]').forEach(a => {
              const m = a.href.match(/\/user\/control\/user\/update\/id\/(\d+)/);
              if (!m) return;
              const id = m[1];
              if (rows.find(r => r.id === id)) return; // deduplicate
              const row = a.closest('tr') || a.closest('li') || a.parentElement;
              const text = row ? row.innerText.trim() : a.innerText.trim();
              rows.push({ id, text });
            });
            return rows;
          });

          await browser.close();

          if (!users.length) return { found: false, message: `Пользователь с email ${email} не найден.` };

          // Parse first result
          const first = users[0];
          return {
            found: true,
            user_id: first.id,
            profile_url: `https://${cfg.accountDomain}/user/control/user/update/id/${first.id}`,
            raw_text: first.text,
            total_found: users.length,
          };
        } catch (e) {
          if (browser) await browser.close().catch(() => {});
          return { error: 'playwright_error', message: e.message };
        }
      },
    },

    gc_group_courses: {
      description: 'List courses (trainings/streams) available to a GetCourse group. Takes group_id (from gc_group_list) or group_name substring. Returns list of courses the group has access to. Takes ~20s.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id:   { type: 'string', description: 'Group ID from gc_group_list' },
          group_name: { type: 'string', description: 'Group name or substring — will find group_id automatically' },
        },
      },
      handler: async ({ group_id, group_name }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        if (!group_id && !group_name) return { error: 'missing_param', message: 'Укажи group_id или group_name.' };

        let gid = group_id;

        // Resolve group_name → group_id via group list page
        if (!gid && group_name) {
          let browser2;
          try {
            const opened = await openBrowserPage(cfg);
            browser2 = opened.browser;
            const p2 = opened.page;
            await p2.goto(`https://${cfg.accountDomain}/pl/user/group/index`, { waitUntil: 'networkidle', timeout: 30000 });
            if (p2.url().includes('/login')) {
              await browser2.close();
              return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
            }
            await p2.waitForTimeout(4000);
            const found = await p2.evaluate((q) => {
              for (const li of document.querySelectorAll('li[data-type="group"]')) {
                const nameEl = li.querySelector('.rd-group-name');
                const name = nameEl?.textContent?.trim().replace(/\s+/g, ' ') || '';
                if (name.toLowerCase().includes(q.toLowerCase())) return { id: li.dataset.id, name };
              }
              return null;
            }, group_name);
            await browser2.close();
            if (!found) return { found: false, message: `Группа "${group_name}" не найдена. Используй gc_group_list чтобы увидеть все группы.` };
            gid = found.id;
          } catch (e) {
            await browser2?.close().catch(() => {});
            return { error: 'playwright_error', message: e.message.slice(0, 200) };
          }
        }

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          // Group edit page has a trainings/streams tab
          await page.goto(`https://${cfg.accountDomain}/pl/user/group/update?id=${gid}`, { waitUntil: 'networkidle', timeout: 30000 });
          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }
          await page.waitForTimeout(3000);

          // Click "Тренинги" / "Потоки" / "Курсы" tab if present
          const tabClicked = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('a, button, [role="tab"], li'));
            const tab = all.find(el => /тренинг|поток|курс/i.test((el.textContent || '').trim().slice(0, 30)));
            if (tab) { tab.click(); return true; }
            return false;
          });
          if (tabClicked) await page.waitForTimeout(2000);

          const courses = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            // Stream links anywhere on the page
            document.querySelectorAll('a[href*="/teach/control/stream/"]').forEach(a => {
              const href = a.getAttribute('href') || '';
              const m = href.match(/\/id\/(\d+)/);
              if (!m) return;
              const id = m[1];
              if (seen.has(id)) return;
              const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
              if (!text || text.length < 2) return;
              seen.add(id);
              results.push({ id, title: text.slice(0, 120) });
            });
            return results;
          });

          await browser.close();

          if (!courses.length) {
            return {
              found: false,
              group_id: gid,
              message: 'Тренинги для этой группы не найдены на странице настроек. Возможно, связь задана через правила автоматизации — проверь /pl/user/autogroup/index.',
            };
          }
          return { group_id: gid, count: courses.length, courses };
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: 'playwright_error', message: e.message.slice(0, 200) };
        }
      },
    },

    gc_group_list: {
      description: 'List groups (группы доступа) in GetCourse via Playwright. Requires L2 (session). Use to find correct group_name before gc_user_add. Takes ~15s. Returns has_more:true if the account has more groups than fit on the first page.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional substring filter for group name' },
        },
      },
      handler: async ({ query }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          await page.goto(`https://${cfg.accountDomain}/pl/user/group/index`, { waitUntil: 'networkidle', timeout: 30000 });

          // Detect session expiry: GetCourse silently redirects to /login/
          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          // GetCourse renders via Vue — wait for content to appear
          await page.waitForTimeout(4000);

          const { groups, hasMore } = await page.evaluate(() => {
            const results = [];
            // New GetCourse UI (2025+): li[data-type="group"] with .rd-group-name
            document.querySelectorAll('li[data-type="group"]').forEach(li => {
              const id = li.dataset.id;
              const nameEl = li.querySelector('.rd-group-name');
              const name = nameEl?.textContent?.trim().replace(/\s+/g, ' ');
              if (id && name && name.length > 1) results.push({ id, name });
            });
            // Fallback: links to /group/update?id={id} (new URL pattern)
            if (results.length === 0) {
              document.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href') || '';
                const m = href.match(/group\/update\?id=(\d+)/);
                if (!m) return;
                const id = m[1];
                if (results.find(r => r.id === id)) return;
                const nameEl = a.querySelector('.rd-group-name');
                const name = (nameEl?.textContent || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
                if (!name || name.length < 2) return;
                results.push({ id, name });
              });
            }
            // Pagination: new UI may use different controls
            const nextEl = document.querySelector(
              'a[rel="next"], li.next:not(.disabled) a, .pagination .next:not(.disabled) a, a[aria-label="Next"], [class*="pagination"] [class*="next"]:not([class*="disabled"])'
            );
            return { groups: results, hasMore: !!nextEl };
          });

          await browser.close();
          let filtered = groups;
          if (query) filtered = groups.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
          const result = { count: filtered.length, groups: filtered };
          if (hasMore) result.warning = 'has_more: только первая страница групп — на аккаунте их больше. Используй query для поиска по имени.';
          return result;
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: `Ошибка получения списка групп: ${e.message.slice(0, 200)}` };
        }
      },
    },

    gc_user_trainings: {
      description: 'List trainings (courses) a GetCourse user actually has access to — via group memberships. More reliable than gc_order_list for access checking. Provide user_id (from gc_user_find) or email. Takes ~20s.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'GetCourse user ID (from gc_user_find)' },
          email:   { type: 'string', description: 'User email — will resolve to user_id automatically' },
        },
      },
      handler: async ({ user_id, email }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        if (!user_id && !email) return { error: 'missing_param', message: 'Укажи user_id или email.' };

        let uid = user_id;

        if (!uid && email) {
          let browser2;
          try {
            const opened = await openBrowserPage(cfg);
            browser2 = opened.browser;
            const p2 = opened.page;
            await p2.goto(`https://${cfg.accountDomain}/pl/user/user/index?search[email]=${encodeURIComponent(email)}`, { waitUntil: 'networkidle', timeout: 30000 });
            if (p2.url().includes('/login')) {
              await browser2.close();
              return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
            }
            uid = await p2.evaluate(() => {
              const a = document.querySelector('a[href*="/user/control/user/update/id/"]');
              return a?.href.match(/\/id\/(\d+)/)?.[1] || null;
            });
            await browser2.close();
          } catch (e) {
            await browser2?.close().catch(() => {});
            return { error: 'playwright_error', message: e.message.slice(0, 200) };
          }
          if (!uid) return { found: false, message: `Пользователь с email ${email} не найден.` };
        }

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          // /pl/user/training-stat/user?id={uid} — actual training access per user (via groups)
          await page.goto(`https://${cfg.accountDomain}/pl/user/training-stat/user?id=${uid}`, { waitUntil: 'networkidle', timeout: 30000 });

          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(3000);

          const trainings = await page.evaluate(() => {
            const results = [];
            const seen = new Set();
            // Training links: /teach/control/stream/ or /pl/teach/...
            document.querySelectorAll('a[href*="/teach/control/stream/"], a[href*="/pl/teach/"]').forEach(a => {
              const href = a.getAttribute('href') || '';
              const m = href.match(/\/(?:stream|id)\/(?:view\/id\/|update\/id\/)?(\d+)/);
              if (!m) return;
              const id = m[1];
              if (seen.has(id)) return;
              const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
              if (!text || text.length < 2 || /icon|edit/i.test(a.className)) return;
              seen.add(id);
              results.push({ id, title: text.slice(0, 120) });
            });
            // Fallback: any element with training name text (rows/cards)
            if (results.length === 0) {
              document.querySelectorAll('tr, .training-item, .stream-item, [class*="training"]').forEach(el => {
                const text = (el.innerText || '').trim().replace(/\s+/g, ' ').split('\n')[0];
                if (!text || text.length < 3 || text.length > 150) return;
                results.push({ id: null, title: text.slice(0, 120) });
              });
            }
            return results;
          });

          await browser.close();

          if (!trainings.length) {
            return { found: false, user_id: uid, message: 'Тренинги не найдены. Возможно, у пользователя нет доступа ни к одному курсу.' };
          }
          return { user_id: uid, count: trainings.length, trainings };
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: 'playwright_error', message: e.message.slice(0, 200) };
        }
      },
    },

    gc_order_list: {
      description: 'List purchases/orders for a GetCourse user via Playwright (L2 session). Provide user_id (from gc_user_find) or email. Returns deal id, title, number, status, price. Takes ~20s.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'GetCourse user ID (from gc_user_find)' },
          email:   { type: 'string', description: 'User email — will search for user_id automatically' },
          count:   { type: 'number', description: 'Max records to return (default 20)' },
        },
      },
      handler: async ({ user_id, email, count = 20 }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        if (!user_id && !email) return { error: 'missing_param', message: 'Укажи user_id или email.' };

        let uid = user_id;

        // Resolve email → user_id via admin search
        if (!uid && email) {
          let browser2;
          try {
            const opened = await openBrowserPage(cfg);
            browser2 = opened.browser;
            const p2 = opened.page;
            await p2.goto(`https://${cfg.accountDomain}/pl/user/user/index?search[email]=${encodeURIComponent(email)}`, { waitUntil: 'networkidle', timeout: 30000 });
            if (p2.url().includes('/login')) {
              await browser2.close();
              return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
            }
            uid = await p2.evaluate(() => {
              const a = document.querySelector('a[href*="/user/control/user/update/id/"]');
              return a?.href.match(/\/id\/(\d+)/)?.[1] || null;
            });
            await browser2.close();
          } catch (e) {
            await browser2?.close().catch(() => {});
            return { error: 'playwright_error', message: `Не удалось найти user_id для ${email}: ${e.message.slice(0, 200)}` };
          }
          if (!uid) return { found: false, message: `Пользователь с email ${email} не найден.` };
        }

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          // GetCourse 2025+: purchases per user at /sales/control/userProduct/user/userId/{uid}
          await page.goto(`https://${cfg.accountDomain}/sales/control/userProduct/user/userId/${uid}`, { waitUntil: 'networkidle', timeout: 30000 });

          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(4000);

          const { orders, hasMore } = await page.evaluate((maxCount) => {
            const results = [];
            document.querySelectorAll('tr.t-rows').forEach(tr => {
              if (results.length >= maxCount) return;
              const dealLink = tr.querySelector('a[href*="/sales/control/deal/update/id/"]');
              if (!dealLink) return;
              const m = (dealLink.getAttribute('href') || '').match(/\/id\/(\d+)/);
              if (!m) return;
              const id = m[1];
              const titleEl = dealLink.querySelector('div') || dealLink;
              const title = (titleEl.innerText || titleEl.textContent || '').trim().replace(/\s+/g, ' ');
              const numberCell = tr.querySelector('.number-cell, [data-title="Номер"]');
              const statusCell = tr.querySelector('.status-cell, [data-title="Статус"]');
              const priceCell  = tr.querySelector('.price-cell,  [data-title="Стоимость"]');
              results.push({
                id,
                title: title.slice(0, 120),
                number: (numberCell?.innerText || '').trim() || undefined,
                status: (statusCell?.innerText || '').trim() || undefined,
                price:  (priceCell?.innerText  || '').trim() || undefined,
              });
            });
            const nextEl = document.querySelector(
              'a[rel="next"], li.next:not(.disabled) a, .pagination .next:not(.disabled) a, [class*="pagination"] [class*="next"]:not([class*="disabled"])'
            );
            return { orders: results, hasMore: !!nextEl };
          }, count);

          await browser.close();

          if (!orders.length) {
            return { found: false, user_id: uid, message: 'Заказы не найдены — возможно у пользователя нет покупок, или изменилась структура страницы.' };
          }

          const result = { user_id: uid, count: orders.length, orders };
          if (hasMore) result.warning = 'has_more: показана только первая страница заказов.';
          return result;
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: 'playwright_error', message: e.message };
        }
      },
    },

    gc_user_notifications: {
      description: 'List email notifications sent to a GetCourse user. Takes user_id (from gc_user_find) or email. Returns subject, date, open status. Requires L2 session. Takes ~20s.',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'GetCourse user ID (from gc_user_find)' },
          email:   { type: 'string', description: 'User email — will search for user_id automatically' },
          count:   { type: 'number', description: 'Max notifications to return (default 20)' },
        },
      },
      handler: async ({ user_id, email, count = 20 }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        if (!user_id && !email) return { error: 'missing_param', message: 'Укажи user_id или email.' };

        let uid = user_id;

        // Resolve email → user_id via admin search
        if (!uid && email) {
          let browser2;
          try {
            const opened = await openBrowserPage(cfg);
            browser2 = opened.browser;
            const p2 = opened.page;
            await p2.goto(`https://${cfg.accountDomain}/pl/user/user/index?search[email]=${encodeURIComponent(email)}`, { waitUntil: 'networkidle', timeout: 30000 });
            if (p2.url().includes('/login')) {
              await browser2.close();
              return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
            }
            uid = await p2.evaluate(() => {
              const a = document.querySelector('a[href*="/user/control/user/update/id/"]');
              return a?.href.match(/\/id\/(\d+)/)?.[1] || null;
            });
            await browser2.close();
          } catch (e) {
            await browser2?.close().catch(() => {});
            return { error: 'playwright_error', message: `Не удалось найти user_id для ${email}: ${e.message.slice(0, 200)}` };
          }
          if (!uid) return { found: false, message: `Пользователь с email ${email} не найден.` };
        }

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          // GetCourse 2025+: notifications per user at /notifications/control/messages/user/id/{uid}
          await page.goto(`https://${cfg.accountDomain}/notifications/control/messages/user/id/${uid}`, { waitUntil: 'networkidle', timeout: 30000 });

          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(4000);

          const { notifications, hasMore } = await page.evaluate((maxCount) => {
            const results = [];
            document.querySelectorAll('[data-message-id]').forEach(el => {
              if (results.length >= maxCount) return;
              const id = el.dataset.messageId;
              if (!id) return;
              const subjectEl = el.querySelector('.rd-h5');
              const subject = (subjectEl?.innerText || subjectEl?.textContent || '').trim();
              if (!subject) return;
              const viewLink = el.querySelector('a[href*="/messages/view/id/"]');
              const viewUrl  = viewLink ? viewLink.getAttribute('href') : null;
              // Date: first element whose text looks like a date/time
              const dateEl = el.querySelector('[class*="date"], [class*="time"], .message-date, .message-time');
              const date = dateEl ? (dateEl.innerText || '').trim() : undefined;
              results.push({ id, subject: subject.slice(0, 200), date: date || undefined, url: viewUrl || undefined });
            });
            const nextEl = document.querySelector(
              'a[rel="next"], li.next:not(.disabled) a, .pagination .next:not(.disabled) a, [class*="pagination"] [class*="next"]:not([class*="disabled"])'
            );
            return { notifications: results, hasMore: !!nextEl };
          }, count);

          await browser.close();

          if (!notifications.length) {
            return { found: false, user_id: uid, message: 'Уведомления не найдены — возможно пользователю ещё не отправляли письма, или изменилась структура страницы.' };
          }
          const result = { user_id: uid, count: notifications.length, notifications };
          if (hasMore) result.warning = 'has_more: показана только первая страница.';
          return result;
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: 'playwright_error', message: e.message };
        }
      },
    },

    // ── L2: Course listing & creation ────────────────────────────────────────

    gc_course_list: {
      description: 'List all courses (trainings) in the GetCourse account. Returns id, title, url for each course. Uses Playwright to scrape the admin course tree — takes 15–25s.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        let browser;
        try {
          const opened = await openBrowserPage(cfg);
          browser = opened.browser;
          const page = opened.page;

          await page.goto(`https://${cfg.accountDomain}/teach/control/stream/tree`, { waitUntil: 'networkidle', timeout: 30000 });

          // Detect session expiry: GetCourse silently redirects to /login/
          if (page.url().includes('/login')) {
            await browser.close();
            return { error: 'session_expired', message: 'Сессия истекла. Вызови gc_connect чтобы войти заново.' };
          }

          await page.waitForTimeout(2000);

          // Extract course links: /teach/control/stream/*/id/{id} or ?id={id}
          const courses = await page.evaluate(() => {
            const seen = new Set();
            const results = [];
            document.querySelectorAll('a[href*="/teach/control/stream/"]').forEach(a => {
              const href = a.getAttribute('href') || '';
              // Match /id/{id} path segment or ?id={id} query param
              let id = null;
              const pathMatch = href.match(/\/id\/(\d+)/);
              const queryMatch = href.match(/[?&]id=(\d+)/);
              if (pathMatch) id = pathMatch[1];
              else if (queryMatch) id = queryMatch[1];
              if (!id || seen.has(id)) return;
              const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
              if (!text || text.length < 2) return; // skip icon-only links
              seen.add(id);
              results.push({ id, title: text.slice(0, 120) });
            });
            return results;
          });

          await browser.close();
          const withUrls = courses.map(c => ({
            ...c,
            url: `https://${cfg.accountDomain}/teach/control/stream/view/id/${c.id}`,
          }));
          return { count: withUrls.length, courses: withUrls };
        } catch (e) {
          await browser?.close().catch(() => {});
          return { error: `Ошибка получения списка курсов: ${e.message.slice(0, 200)}` };
        }
      },
    },

    gc_course_create: {
      description: 'Create a top-level training (course). Returns id and URL. Use the id in gc_section_create.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string', description: 'Course title (max 180 chars)' },
          description: { type: 'string', description: 'Short description (max 240 chars)' },
        },
      },
      handler: async ({ title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/training/createTraining', {
          title: title.slice(0, 180),
          description: description.slice(0, 240),
          parentId: 0,
          orderPos: null,
          image: '',
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/stream/view?id=${id}` : null };
      },
    },

    gc_section_create: {
      description: 'Create a section (sub-training) inside a course. Returns id. Use the id in gc_lesson_create.',
      inputSchema: {
        type: 'object',
        required: ['course_id', 'title'],
        properties: {
          course_id:   { type: 'number', description: 'Parent course ID from gc_course_create' },
          title:       { type: 'string', description: 'Section title' },
          description: { type: 'string', description: 'Short description' },
        },
      },
      handler: async ({ course_id, title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/training/createTraining', {
          title: title.slice(0, 180),
          description: description.slice(0, 240),
          parentId: course_id,
          orderPos: null,
          image: '',
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/stream/view?id=${id}` : null };
      },
    },

    gc_lesson_create: {
      description: 'Create a lesson inside a section. Returns id. Use the id in gc_lesson_add_video / gc_lesson_add_text.',
      inputSchema: {
        type: 'object',
        required: ['section_id', 'title'],
        properties: {
          section_id:  { type: 'number', description: 'Section ID from gc_section_create' },
          title:       { type: 'string', description: 'Lesson title' },
          description: { type: 'string', description: 'Short description shown under the title' },
        },
      },
      handler: async ({ section_id, title, description = '' }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;
        const result = await gcSessionJson(cfg, '/pl/teach/gcapi/lesson-admin/createLesson', {
          trainingId: section_id,
          type: 'visual_constructor',
          title: title.slice(0, 180),
          description: description.slice(0, 240),
        });
        if (result.error) return result;
        const id = parseCreatedId(result);
        return { ok: true, id, url: id ? `https://${cfg.accountDomain}/teach/control/lesson/view?id=${id}` : null };
      },
    },

    gc_lesson_add_video: {
      description: 'Add a Kinescope video block to a lesson. Pass the Kinescope iframe src / player URL. Returns blockId.',
      inputSchema: {
        type: 'object',
        required: ['lesson_id', 'video_url'],
        properties: {
          lesson_id: { type: 'number', description: 'Lesson ID from gc_lesson_create' },
          video_url: { type: 'string', description: 'Kinescope player URL (iframe src)' },
        },
      },
      handler: async ({ lesson_id, video_url }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const addResult = await gcSessionForm(cfg, '/pl/api/teach/lesson-constructor/add', {
          ownerId: lesson_id, ownerTypeId: 161, presetId: 'lessonVid01',
        });
        if (addResult.error) return addResult;
        const blockId = addResult?.data?.id;
        if (!blockId) return { error: 'Could not get block id', raw: addResult };

        const updateResult = await gcSessionForm(cfg, `/pl/lite/block/update-param/?id=${blockId}&redesign=1`, {
          'params[source/src_video_link]':  video_url,
          'params[source][src_video_link]': video_url,
        });
        if (updateResult.error) return updateResult;

        return { ok: true, blockId: Number(blockId), lesson_id };
      },
    },

    gc_lesson_add_text: {
      description: 'Add a text/HTML block to a lesson. Returns blockId.',
      inputSchema: {
        type: 'object',
        required: ['lesson_id', 'html'],
        properties: {
          lesson_id: { type: 'number', description: 'Lesson ID from gc_lesson_create' },
          html:      { type: 'string', description: 'HTML content for the text block' },
        },
      },
      handler: async ({ lesson_id, html }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const addResult = await gcSessionForm(cfg, '/pl/api/teach/lesson-constructor/add', {
          ownerId: lesson_id, ownerTypeId: 161, presetId: 'lessonTxt01',
        });
        if (addResult.error) return addResult;
        const blockId = addResult?.data?.id;
        if (!blockId) return { error: 'Could not get block id', raw: addResult };

        const updateResult = await gcSessionForm(cfg, `/pl/lite/block/update-param/?id=${blockId}&redesign=1`, {
          'params[text]': html,
          'params[items][parts][text1][inner][text]': html,
        });
        if (updateResult.error) return updateResult;

        return { ok: true, blockId: Number(blockId), lesson_id };
      },
    },

    gc_lesson_sort: {
      description: 'Set the display order of blocks inside a lesson. Pass block IDs in the desired order.',
      inputSchema: {
        type: 'object',
        required: ['block_ids'],
        properties: {
          block_ids: { type: 'array', items: { type: 'number' }, description: 'Block IDs in desired display order' },
        },
      },
      handler: async ({ block_ids }, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const err = requireL2(cfg);
        if (err) return err;

        const form = new FormData();
        const vars = cfg.sessionVars || {};
        if (vars.gcSession)     form.append('gcSession',     vars.gcSession);
        if (vars.gcVisit)       form.append('gcVisit',       vars.gcVisit);
        if (vars.gcVisitor)     form.append('gcVisitor',     vars.gcVisitor);
        if (vars.gcSessionHash) form.append('gcSessionHash', vars.gcSessionHash);
        for (const id of block_ids) form.append('positions[]', String(id));

        const res = await fetch(`https://${cfg.accountDomain}/pl/lite/block/save-sorting`, {
          method: 'POST',
          headers: l2Headers(cfg, { 'Accept': 'application/json, text/plain, */*' }),
          body: form,
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { ok: res.ok, preview: text.slice(0, 200) }; }
      },
    },

  },
};
