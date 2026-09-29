'use strict';

// Headless Playwright login to tilda.ru (email + password form).
// On success: saves cookie string to ~/agent-tokens/{userId}/tilda-session.

const path = require('path');
const os = require('os');
const { writeCredential } = require('./credential-store');

/**
 * @returns {{ status:'ok', cookiesCount:number }|{ error:string }}
 */
async function startTildaLogin(userId, email, password) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (e) {
    return { error: `Не удалось запустить браузер: ${e.message}` };
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    console.log('[tilda-login] navigating to tilda.ru for userId=%s', userId);
    await page.goto('https://tilda.ru', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait a moment for any client-side init
    await page.waitForTimeout(1500);

    // Tilda may show the email input directly or behind a login button
    const EMAIL_SELECTORS = [
      'input[name="email"]',
      'input[type="email"]',
      'input[name="login"]',
    ];

    let emailInput = null;
    for (const sel of EMAIL_SELECTORS) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) { emailInput = el; break; }
    }

    if (!emailInput) {
      // Try clicking a sign-in trigger
      await page.click(
        'a[href*="signin"], a[href*="login"], [data-mode="login"], .js-signin, .t-signin',
        { timeout: 5000 }
      ).catch(() => {});
      await page.waitForTimeout(1000);

      for (const sel of EMAIL_SELECTORS) {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) { emailInput = el; break; }
      }
    }

    if (!emailInput) {
      const screenshotPath = path.join(os.tmpdir(), `tilda-login-noinput-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      await browser.close();
      return { error: `Форма логина не найдена на tilda.ru (скриншот: ${screenshotPath}). Возможно CAPTCHA или изменился интерфейс.` };
    }

    // Fill credentials via native events to bypass potential framework reactivity guards
    await page.evaluate(([e, p]) => {
      const inputs = document.querySelectorAll('input[type="email"], input[name="email"], input[name="login"], input[type="password"]');
      const emailEl = Array.from(inputs).find(el => el.type !== 'password');
      const pwEl = Array.from(inputs).find(el => el.type === 'password');
      if (emailEl) { emailEl.value = e; emailEl.dispatchEvent(new Event('input', { bubbles: true })); emailEl.dispatchEvent(new Event('change', { bubbles: true })); }
      if (pwEl)    { pwEl.value = p;    pwEl.dispatchEvent(new Event('input', { bubbles: true })); pwEl.dispatchEvent(new Event('change', { bubbles: true })); }
    }, [email, password]);

    await page.waitForTimeout(500);

    // Submit
    await page.click(
      'button[type="submit"], input[type="submit"], .js-signup-submit, .t-submit, form button',
      { force: true, timeout: 5000 }
    );

    // Wait for redirect to projects / dashboard
    let landed = false;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (/tilda\.ru\/(projects|dashboard|my)/i.test(u)) { landed = true; break; }
      if (u.includes('/projects')) { landed = true; break; }

      // Check for visible error message
      const errEl = await page.$('.form-error, .alert-danger, .t-form__error, [class*="error"]').catch(() => null);
      if (errEl && await errEl.isVisible().catch(() => false)) {
        const errText = (await errEl.textContent().catch(() => '')) || 'Неверный логин или пароль';
        await browser.close();
        return { error: errText.trim().slice(0, 200) };
      }
    }

    if (!landed) {
      const screenshotPath = path.join(os.tmpdir(), `tilda-login-timeout-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      console.error('[tilda-login] timeout url=%s screenshot=%s', page.url(), screenshotPath);
      await browser.close();
      return { error: `Тайм-аут входа — возможно неверный пароль или CAPTCHA. Скриншот: ${screenshotPath}` };
    }

    const allCookies = await context.cookies();
    const tildaCookies = allCookies.filter(c => c.domain.includes('tilda'));
    const cookieStr = tildaCookies.map(c => `${c.name}=${c.value}`).join('; ');

    writeCredential(userId, 'tilda-session', cookieStr);

    await browser.close();
    console.log('[tilda-login] session saved userId=%s cookies=%d', userId, tildaCookies.length);
    return { status: 'ok', cookiesCount: tildaCookies.length };
  } catch (e) {
    if (browser) browser.close().catch(() => {});
    console.error('[tilda-login] error:', e.message);
    return { error: `Ошибка при входе: ${e.message.slice(0, 200)}` };
  }
}

module.exports = { startTildaLogin };
