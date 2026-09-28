'use strict';

// Headless Playwright login to GetCourse (standard email/password form).
// Captures session cookies + localStorage GC tokens needed for UI API calls.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCredentialFile, writeCredentialFile } = require('./credential-store');

function configPath(userId) {
  // getcourse/ is a dir-backed credential: config.json is encrypted like any other file.
  // data-paths is required per call so a redirected token root (tests) is always honored.
  const { userTokensDir } = require('./data-paths');
  return path.join(userTokensDir(String(userId)), 'getcourse', 'config.json');
}

function readConfig(userId) {
  const file = configPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(readCredentialFile(file)); } catch { return {}; }
}

function mergeConfig(userId, patch) {
  const file = configPath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readConfig(userId);
  writeCredentialFile(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

/**
 * Log in to GetCourse with email + password.
 * Writes sessionCookies + sessionVars into config.json (merging with existing fields).
 * @returns {{ status:'ok', cookiesCount:number }|{ error:string }}
 */
async function startGetcourseLogin(userId, domain, login, password) {
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

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    const baseUrl = `https://${domain}`;
    console.log('[getcourse-login] navigating to %s/cms/system/login', baseUrl);
    await page.goto(`${baseUrl}/cms/system/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for email input to appear
    const emailInput = page.locator('input[name="email"], input[type="email"], input[name="login"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });

    // Wait for cookie banner to appear, then dismiss via JS (appears after ~1-2s)
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button')) {
        if (/^ok$/i.test(btn.textContent.trim())) { btn.click(); break; }
      }
    }).catch(() => {});
    await page.waitForTimeout(300);

    // Fill via evaluate + dispatch input events to trigger Vue reactivity
    // (page.fill() doesn't trigger Vue — button stays disabled)
    await page.evaluate(([email, pwd]) => {
      const inputs = document.querySelectorAll('input');
      const emailEl = inputs[0];
      const pwEl = inputs[1];
      emailEl.value = email;
      emailEl.dispatchEvent(new Event('input', { bubbles: true }));
      pwEl.value = pwd;
      pwEl.dispatchEvent(new Event('input', { bubbles: true }));
    }, [login, password]);
    await page.waitForTimeout(500);

    // force:true bypasses the disabled state — Vue handles the click and submits
    await page.click('button[type="submit"]', { force: true });

    // GetCourse uses Vue Router (client-side nav) — waitForURL misses it.
    // Poll the URL for up to 20s instead.
    let landed = false;
    let loginError = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (!u.includes('/cms/system/login') && !u.includes('/login')) { landed = true; break; }
      // Check for visible error message
      const errEl = await page.$('.form-error, .alert-danger, [class*="error"]').catch(() => null);
      if (errEl) {
        loginError = (await errEl.textContent().catch(() => '')) || 'Неверный логин или пароль';
        loginError = loginError.trim().slice(0, 200);
        break;
      }
    }

    if (loginError) {
      await browser.close();
      return { error: loginError || 'Неверный логин или пароль' };
    }

    if (!landed) {
      const screenshotPath = path.join(os.tmpdir(), `gc-login-fail-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.error('[getcourse-login] timeout, url=%s, screenshot=%s', page.url(), screenshotPath);
      await browser.close();
      return { error: 'Тайм-аут — проверьте домен, логин и пароль' };
    }

    // Grab cookies (filter to the account domain)
    const allCookies = await context.cookies();
    const sessionCookies = allCookies.filter(c =>
      c.domain.includes(domain) || c.domain.includes('getcourse.ru')
    );

    // Grab GetCourse session tokens from localStorage (needed for form-based UI API calls)
    const sessionVars = await page.evaluate(() => ({
      gcSession:     localStorage.getItem('gcSession'),
      gcVisit:       localStorage.getItem('gcVisit'),
      gcVisitor:     localStorage.getItem('gcVisitor'),
      gcSessionHash: localStorage.getItem('gcSessionHash'),
    })).catch(() => ({}));

    // Save the UA Playwright used — strip "Headless" so GetCourse doesn't reject it
    const rawUA = await page.evaluate(() => navigator.userAgent).catch(() => null);
    const sessionUserAgent = rawUA ? rawUA.replace('HeadlessChrome', 'Chrome') : null;

    await browser.close();

    mergeConfig(userId, {
      sessionCookies,
      sessionVars,
      sessionUserAgent,
      loginSavedAt: new Date().toISOString(),
    });

    console.log('[getcourse-login] session saved, userId=%s, domain=%s, cookies=%d', userId, domain, sessionCookies.length);
    return { status: 'ok', cookiesCount: sessionCookies.length };
  } catch (e) {
    browser.close().catch(() => {});
    console.error('[getcourse-login] error:', e.message);
    return { error: `Ошибка при входе: ${e.message.slice(0, 200)}` };
  }
}

module.exports = { startGetcourseLogin, mergeConfig };
