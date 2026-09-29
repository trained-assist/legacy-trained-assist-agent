'use strict';

// Generic website connector: Playwright login → BFS crawl → Claude Haiku analysis → intents.
// Used by POST /connect/site. Long-running work (crawl + analysis) runs async after login.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('./data-paths');
const {
  slugFor,
  saveSiteConfig,
  saveSiteCreds,
  saveCrawlReport,
  saveIntents,
  saveStorageState,
} = require('./user-sites');

const MAX_PAGES = 30;
const MAX_DEPTH = 3;
const NAV_TIMEOUT = 12000;
const CRAWL_TOTAL_MS = 90000;

// Static extensions to skip during crawl
const SKIP_EXT = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|pdf|zip|mp4|webp)(\?.*)?$/i;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Login + async crawl + analysis.
 * Returns quickly after login; crawl runs in background.
 * @returns {{ slug, name, status:'crawling' } | { error }}
 */
async function connectSite(username, { url, login, password }) {
  let normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
  const slug = slugFor(normalizedUrl);

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    return { error: `Не удалось запустить браузер: ${e.message}` };
  }

  const apiEndpoints = [];
  let context, page;

  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
    });

    // Intercept XHR/fetch calls to discover API endpoints
    context.on('request', req => {
      if (['xhr', 'fetch'].includes(req.resourceType())) {
        const ep = { url: req.url(), method: req.method() };
        if (!apiEndpoints.some(e => e.url === ep.url)) apiEndpoints.push(ep);
      }
    });

    page = await context.newPage();

    // Navigate to site
    try {
      await page.goto(normalizedUrl, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    } catch (e) {
      await browser.close();
      return { error: `Не удалось открыть сайт: ${e.message}` };
    }

    // Login
    const loginResult = await tryLogin(page, login, password, normalizedUrl);
    if (!loginResult.success) {
      await browser.close();
      return { error: loginResult.error || 'Не удалось войти — форма входа не найдена или неверные данные' };
    }

    // Save session state (cookies + storage)
    const storageState = await context.storageState();
    saveStorageState(username, slug, storageState);

    // Persist initial config and credentials
    const hostname = (() => { try { return new URL(normalizedUrl).hostname; } catch { return slug; } })();
    const config = {
      url: normalizedUrl,
      slug,
      name: hostname,
      createdAt: new Date().toISOString(),
      lastCrawled: null,
      status: 'crawling',
      pagesFound: 0,
      apiEndpointsFound: 0,
    };
    saveSiteConfig(username, slug, config);
    saveSiteCreds(username, slug, { login, password });

    // Run crawl + analysis in background (don't await — return to caller immediately)
    const landingUrl = page.url();
    runBackgroundCrawl(browser, context, page, username, slug, config, landingUrl, apiEndpoints)
      .catch(e => console.error('[site-connector] background crawl error:', e.message));

    return { slug, name: hostname, status: 'crawling' };

  } catch (e) {
    console.error('[site-connector] connectSite error:', e);
    try { await browser.close(); } catch {}
    return { error: e.message };
  }
}

// ── Login ────────────────────────────────────────────────────────────────────

async function tryLogin(page, login, password, originalUrl) {
  // Try login form on current page
  let filled = await fillLoginForm(page, login, password);
  if (filled) return waitForLoginSuccess(page, originalUrl);

  // Follow obvious login links
  try {
    const loginLink = await page.$([
      'a[href*="login"]', 'a[href*="signin"]', 'a[href*="sign-in"]',
      'a[href*="auth"]', 'a[href*="/log"]',
    ].join(','));
    if (loginLink) {
      await loginLink.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      filled = await fillLoginForm(page, login, password);
      if (filled) return waitForLoginSuccess(page, originalUrl);
    }
  } catch (e) {
    console.warn('[site-connector] login-link follow failed:', e.message);
  }

  return { success: false, error: 'Форма входа не найдена. Укажи прямую ссылку на страницу логина.' };
}

async function fillLoginForm(page, login, password) {
  try {
    const pwInput = await page.$('input[type="password"]');
    if (!pwInput) return false;

    // Find username/email input — prefer named/typed inputs, fall back to first text input
    const loginSelectors = [
      'input[type="email"]',
      'input[name*="login"]', 'input[name*="username"]', 'input[name*="email"]', 'input[name*="user"]',
      'input[id*="login"]', 'input[id*="email"]', 'input[id*="username"]',
      'input[type="text"]',
    ];
    let loginInput = null;
    for (const sel of loginSelectors) {
      loginInput = await page.$(sel);
      if (loginInput) break;
    }

    if (loginInput) {
      await loginInput.fill(login);
      await page.waitForTimeout(150);
    }

    await pwInput.fill(password);
    await page.waitForTimeout(150);

    // Submit
    const submitBtn = await page.$([
      'button[type="submit"]', 'input[type="submit"]',
      'button:has-text("Log in")', 'button:has-text("Sign in")',
      'button:has-text("Login")', 'button:has-text("Войти")', 'button:has-text("Вход")',
    ].join(','));

    if (submitBtn) {
      await submitBtn.click();
    } else {
      await pwInput.press('Enter');
    }

    return true;
  } catch (e) {
    console.warn('[site-connector] fillLoginForm:', e.message);
    return false;
  }
}

async function waitForLoginSuccess(page, originalUrl) {
  try {
    // Wait up to 8s for URL to change away from a login-looking page
    await page.waitForFunction(
      (orig) => {
        const cur = location.href;
        if (cur === orig) return false;
        const isLoginPage = /login|signin|sign-in|\/auth\//i.test(new URL(cur).pathname);
        return !isLoginPage;
      },
      originalUrl,
      { timeout: 8000 }
    );
    return { success: true };
  } catch {
    // URL didn't change — check for visible error messages
    try {
      const errText = await page.evaluate(() => {
        const el = document.querySelector(
          '.error, .alert-danger, .flash-error, [class*="error-msg"], [class*="alert--error"]'
        );
        return el?.textContent?.trim()?.slice(0, 200) || null;
      });
      if (errText) return { success: false, error: `Ошибка входа: ${errText}` };
    } catch {}
    // No error visible — SPA probably stayed on same URL but is logged in
    return { success: true };
  }
}

// ── Background crawl + analysis ──────────────────────────────────────────────

async function runBackgroundCrawl(browser, context, page, username, slug, config, startUrl, apiEndpoints) {
  const pages = [];
  const forms = [];
  const baseHost = (() => { try { return new URL(startUrl).hostname; } catch { return ''; } })();

  try {
    const visited = new Set([startUrl]);
    const queue = [{ url: startUrl, depth: 0 }];
    const crawlStart = Date.now();

    while (queue.length > 0 && visited.size <= MAX_PAGES && Date.now() - crawlStart < CRAWL_TOTAL_MS) {
      const { url: curUrl, depth } = queue.shift();

      let title = '';
      let links = [];
      let pageForms = [];

      try {
        if (page.url() !== curUrl) {
          await page.goto(curUrl, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(400);
        }
        title = await page.title();

        if (depth < MAX_DEPTH) {
          links = await page.evaluate((host) => {
            return [...document.querySelectorAll('a[href]')]
              .map(a => { try { return new URL(a.href, location.href).href; } catch { return null; } })
              .filter(h => h && new URL(h).hostname === host && !h.includes('#'))
              .slice(0, 60);
          }, baseHost).catch(() => []);
        }

        pageForms = await page.evaluate(() =>
          [...document.querySelectorAll('form')].slice(0, 5).map(f => ({
            action: f.action,
            method: f.method || 'GET',
            fields: [...f.querySelectorAll('input,select,textarea')]
              .map(el => ({ name: el.name || el.id, type: el.type }))
              .filter(el => el.name).slice(0, 10),
          }))
        ).catch(() => []);
      } catch (e) {
        console.warn(`[site-connector] crawl error ${curUrl}:`, e.message);
      }

      pages.push({ url: curUrl, title, depth });
      forms.push(...pageForms);

      for (const link of links) {
        if (!visited.has(link) && !SKIP_EXT.test(link)) {
          visited.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  const report = {
    pages,
    apiEndpoints: apiEndpoints.slice(0, 100),
    forms: forms.slice(0, 20),
    crawledAt: new Date().toISOString(),
  };
  saveCrawlReport(username, slug, report);

  // Generate intents via Claude Haiku
  const intents = await analyzeAndGenerateIntents(config.url, pages, apiEndpoints, forms);
  saveIntents(username, slug, intents);

  // Update config with final stats
  saveSiteConfig(username, slug, {
    ...config,
    lastCrawled: new Date().toISOString(),
    status: 'connected',
    pagesFound: pages.length,
    apiEndpointsFound: apiEndpoints.length,
  });

  console.log(`[site-connector] ${username}/${slug}: crawl done — ${pages.length} pages, ${apiEndpoints.length} endpoints, ${intents.length} intents`);

  // Notify user via Telegram if we have their chat ID + bot token
  try {
    const chatIdFile = path.join(
      tokensRoot(),
      username, '.chatid'
    );
    const chatId = fs.readFileSync(chatIdFile, 'utf8').trim();
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
    if (chatId && botToken) {
      const text = `✅ Сайт *${config.name}* подключён!\n\n` +
        `📄 Страниц: ${pages.length}\n` +
        `🔗 API-эндпоинтов: ${apiEndpoints.length}\n` +
        `⚡ Быстрых ответов: ${intents.length}\n\n` +
        `Теперь я умею работать с этим сайтом. Спроси что-нибудь!`;
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch (e) {
    console.warn('[site-connector] Telegram notify failed:', e.message);
  }
}

// ── Claude Haiku analysis ────────────────────────────────────────────────────

async function analyzeAndGenerateIntents(url, pages, apiEndpoints, forms) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) return defaultIntents(url);

  try {
    let hostname;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }

    const summary = {
      site: url,
      pages: pages.slice(0, 20).map(p => ({ url: p.url, title: p.title })),
      apiEndpoints: apiEndpoints.slice(0, 25).map(e => ({ url: e.url, method: e.method })),
      forms: forms.slice(0, 8).map(f => ({ action: f.action, method: f.method, fields: f.fields })),
    };

    const prompt = `Ты анализируешь сайт ${hostname}, к которому пользователь подключился через бота (авто-логин + краулинг).

Данные краулинга:
${JSON.stringify(summary, null, 2)}

Задача: сгенерируй quick-answer интенты — фразы которые пользователь напишет боту и что ему ответить.

Верни JSON массив (ТОЛЬКО JSON, без markdown):
[
  {
    "pattern": "regex-паттерн (без /.../ и флагов, будет применён с флагом i)",
    "response": "Готовый ответ 2-3 предложения: что умею делать на этом сайте и как попросить"
  }
]

Сгенерируй 5-8 интентов. Покрой:
- Вопрос о возможностях: "что умеешь на X", "умеешь работать с X"
- Получение данных/отчётов с сайта
- Типовые действия (из форм и API)
- Навигация/поиск по сайту
Используй в паттернах hostname или ключевые слова из названия сайта.`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) throw new Error(`OpenRouter API ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('[site-connector] analyzeAndGenerateIntents error:', e.message);
  }

  return defaultIntents(url);
}

function defaultIntents(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { hostname = url; }
  const slug = hostname.replace(/\./g, '\\.').replace(/-/g, '[-_]');
  return [
    {
      pattern: `что.{0,30}${slug}|умееш.{0,30}${slug}|${slug}.{0,30}(?:умееш|можешь|делает|скил)`,
      response: `Подключён сайт ${hostname}. Я могу заходить туда под твоим аккаунтом: собирать данные, заполнять формы, читать страницы, вызывать API. Просто опиши задачу.`,
    },
  ];
}

module.exports = { connectSite };
