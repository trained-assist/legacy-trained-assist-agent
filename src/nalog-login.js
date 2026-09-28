'use strict';

// Headless browser login to lknpd.nalog.ru via Gosuslugi (ESIA).
// Manages in-process Playwright sessions between the credential step
// and the optional 2FA code step.

const crypto = require('crypto');
const { writeCredential } = require('./credential-store');

// sessionId → { browser, page, context, userId, expires }
const pendingSessions = new Map();

const SESSION_TTL_MS = 25 * 60 * 1000; // 25 min

setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of pendingSessions) {
    if (sess.expires < now) {
      sess.browser.close().catch(() => {});
      pendingSessions.delete(id);
      console.log(`[nalog-login] session ${id} expired`);
    }
  }
}, 5 * 60 * 1000);

/**
 * Phase 1: navigate to lknpd.nalog.ru, redirect through ESIA, fill credentials.
 * @returns {{ status:'ok', expires?:string }
 *          |{ status:'need_code', sessionId:string }
 *          |{ error:string }}
 */
async function startNalogLogin(userId, login, password) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (e) {
    return { error: `Не удалось запустить браузер: ${e.message}` };
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      extraHTTPHeaders: {
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        // Override Client Hints to hide "HeadlessChrome"
        'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not-A.Brand";v="99"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Linux"',
      },
    });
    // Hide automation signals
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    });
    const page = await context.newPage();

    // Navigate; nalog.ru redirects to ESIA automatically
    console.log('[nalog-login] navigating to lknpd.nalog.ru');
    await page.goto('https://lknpd.nalog.ru/', { waitUntil: 'networkidle', timeout: 30000 });

    const onEsia = () => /gosuslugi\.ru|esia\./.test(page.url());

    if (!onEsia()) {
      // Ensure we're on the login page
      if (!/auth\/login/.test(page.url())) {
        await page.goto('https://lknpd.nalog.ru/auth/login', { waitUntil: 'networkidle', timeout: 15000 });
      }

      // nalog.ru has 3 login tabs: "ИНН и пароль" | "Номер телефона" | "Госуслуги"
      // Step 1: click the Госуслуги tab to switch to ESIA mode
      const tabEl = page.locator('button, [role="tab"]', { hasText: 'Госуслуги' }).first();
      try {
        await tabEl.waitFor({ state: 'visible', timeout: 8000 });
        const box = await tabEl.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(200);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await tabEl.click();
        }
        console.log('[nalog-login] clicked Госуслуги tab');
        await page.waitForTimeout(600);
      } catch {
        await browser.close();
        return { error: 'Не нашли вкладку "Госуслуги" на странице входа' };
      }

      // Step 2: click "ВОЙТИ" to start the ESIA OAuth redirect
      const submitBtn = page.locator('button', { hasText: /войти/i }).first();
      try {
        await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
        const box = await submitBtn.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(200);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await submitBtn.click();
        }
        console.log('[nalog-login] clicked ВОЙТИ, awaiting ESIA redirect');
      } catch {
        await browser.close();
        return { error: 'Не нашли кнопку "ВОЙТИ" после выбора вкладки Госуслуги' };
      }

      try {
        await page.waitForURL(/gosuslugi\.ru|esia\./, { timeout: 20000 });
      } catch {
        await browser.close();
        return { error: 'Не перешло на Госуслуги — сайт заблокировал переход или изменил структуру страницы' };
      }
    }

    if (!onEsia()) {
      await browser.close();
      return { error: 'Не удалось найти кнопку "Войти через Госуслуги"' };
    }

    console.log('[nalog-login] on ESIA, filling credentials, url=%s', page.url());

    // Wait for any input to appear (ESIA SPA takes time to render)
    await page.waitForSelector('input', { state: 'visible', timeout: 25000 }).catch(() => {});

    // ESIA sometimes opens on the QR-code tab — switch to login/password tab if needed
    const loginInput = page.locator('#login, input[name="login"], input[autocomplete="username"]').first();
    const loginVisible = await loginInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (!loginVisible) {
      console.log('[nalog-login] QR tab detected, switching to Логин и пароль');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => /логин.*пароль|пароль.*логин/i.test(b.textContent));
        if (btn) btn.click();
      });
      await page.waitForTimeout(1500);
    }

    // Log full page state for debugging
    const esiaState = await page.evaluate(() => ({
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input')).map(el => `${el.type}#${el.id}[${el.name}]ac=${el.autocomplete}`).join(' | '),
      buttons: Array.from(document.querySelectorAll('button')).map(b => `${b.type}:"${b.textContent.trim().slice(0, 20)}"[${b.className.slice(0, 40)}]`).join(' | '),
      bodyText: document.body?.innerText?.slice(0, 200) || '',
    }));
    console.log('[nalog-login] ESIA state: url=%s inputs=%s buttons=%s text=%s',
      esiaState.url, esiaState.inputs, esiaState.buttons, esiaState.bodyText.replace(/\n/g, ' '));
    // Save screenshot for debugging
    await page.screenshot({ path: `/tmp/esia-${Date.now()}.png`, fullPage: true }).catch(() => {});

    // Wait for the login/password form to be ready
    await loginInput.waitFor({ state: 'visible', timeout: 15000 });

    const pwInput = page.locator('#password, input[name="password"], input[type="password"]').first();
    // Check if password field is also visible right now (single-step form)
    const pwAlreadyVisible = await pwInput.isVisible({ timeout: 3000 }).catch(() => false);

    // Log what's on the page for debugging
    const pageState = await page.evaluate(() => ({
      buttons: Array.from(document.querySelectorAll('button'))
        .map(b => `${b.type}:"${b.textContent.trim().slice(0, 25)}"[${b.className.slice(0, 40)}]`)
        .join(' | '),
    }));
    console.log('[nalog-login] ESIA buttons: %s', pageState.buttons);

    // ESIA is a Vue SPA — standard fill()/keyboard.type() don't update Vue's reactive state.
    // Use nativeInputValueSetter + input/change events (standard trick for React/Vue controlled inputs).
    const fillVueInput = (selector, value) => page.evaluate(([sel, val]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, [selector, value]);

    // Focus + fill login, then Tab to trigger ESIA async validation
    await loginInput.click();
    await fillVueInput('#login, input[name="login"]', login);
    await page.keyboard.press('Tab');
    console.log('[nalog-login] tabbed out of login, waiting for ESIA async validation');
    await page.waitForTimeout(2000);

    if (!pwAlreadyVisible) {
      // Two-step form: login validation didn't auto-show password — click next
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b =>
          b.offsetParent !== null &&
          !b.classList.contains('header__lang-button') &&
          (/войти|далее|продолжить/i.test(b.textContent) || b.type === 'submit')
        );
        if (btn) { btn.click(); return btn.textContent.trim().slice(0, 30); }
        return null;
      });
      console.log('[nalog-login] ESIA two-step next clicked: %s', clicked);
      try {
        await pwInput.waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        await browser.close();
        return { error: 'Не нашли поле для пароля — Госуслуги заблокировали вход или изменили форму' };
      }
    }

    await pwInput.click();
    await fillVueInput('#password, input[type="password"]', password);
    await page.waitForTimeout(600);

    // Click the final "Войти" button via evaluate to avoid selector issues
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.offsetParent !== null &&
        !b.classList.contains('header__lang-button') &&
        (/войти/i.test(b.textContent) || b.type === 'submit')
      );
      if (btn) btn.click();
    });

    console.log('[nalog-login] credentials submitted, waiting for outcome');
    // Screenshot immediately after clicking Войти — shows what ESIA does next
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `/tmp/esia-after-${Date.now()}.png`, fullPage: true }).catch(() => {});
    const afterState = await page.evaluate(() => ({
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 300).replace(/\n/g, ' ') || '',
      inputs: Array.from(document.querySelectorAll('input')).map(el => `${el.type}#${el.id}`).join(' | '),
    }));
    console.log('[nalog-login] after-submit state: url=%s inputs=%s text=%s',
      afterState.url, afterState.inputs, afterState.bodyText);

    const outcome = await Promise.race([
      // Success: back on nalog.ru (not on /auth/ sub-path)
      page.waitForURL(u => /lknpd\.nalog\.ru/.test(u) && !/\/auth\//.test(u), { timeout: 30000 })
        .then(() => 'success'),
      // 2FA or SMS confirmation — broaden selectors to catch ESIA's actual OTP screen
      page.waitForSelector(
        '#otp, input[name="otp"], input[placeholder*="код"], input[placeholder*="sms"], input[maxlength="6"], .form-otp input, input[type="tel"], .totp input',
        { timeout: 30000 },
      ).then(() => 'need_code'),
      // ESIA may redirect to a consent/confirm screen on esia.gosuslugi.ru
      page.waitForURL(u => /esia.*confirm|esia.*consent|esia.*approve/.test(u), { timeout: 30000 })
        .then(() => 'success'),
    ]).catch(() => 'timeout');

    if (outcome === 'success') {
      return extractAndSave(page, browser, userId);
    }

    if (outcome === 'need_code') {
      const sessionId = crypto.randomBytes(16).toString('hex');
      pendingSessions.set(sessionId, { browser, page, context, userId, expires: Date.now() + SESSION_TTL_MS });
      console.log('[nalog-login] 2FA required, sessionId=%s', sessionId);
      return { status: 'need_code', sessionId };
    }

    // Timeout — snapshot what the page looks like and any error text
    const timeoutSnap = await page.evaluate(() => ({
      url: location.href,
      text: document.body?.innerText?.slice(0, 400).replace(/\n/g, ' ') || '',
    })).catch(() => ({ url: '?', text: '' }));
    await page.screenshot({ path: `/tmp/esia-timeout-${Date.now()}.png`, fullPage: true }).catch(() => {});
    console.log('[nalog-login] timeout: url=%s text=%s', timeoutSnap.url, timeoutSnap.text);
    const errEl = await page.$('.form__error, .error-text, [class*="error"], .esia-input__error-text');
    const errText = errEl ? (await errEl.textContent() || '').trim().slice(0, 200) : '';
    await browser.close();
    return { error: errText || 'Тайм-аут при ожидании ответа Госуслуг — проверьте логин и пароль' };

  } catch (e) {
    browser.close().catch(() => {});
    console.error('[nalog-login] startNalogLogin error:', e.message);
    return { error: `Ошибка при входе: ${e.message.slice(0, 200)}` };
  }
}

/**
 * Phase 2: fill the 2FA code and complete login.
 * @returns {{ status:'ok', expires?:string }|{ error:string }}
 */
async function confirmNalogCode(sessionId, code) {
  const sess = pendingSessions.get(sessionId);
  if (!sess) return { error: 'Сессия не найдена или истекла — начните заново' };
  if (sess.expires < Date.now()) {
    pendingSessions.delete(sessionId);
    sess.browser.close().catch(() => {});
    return { error: 'Сессия истекла — начните заново' };
  }

  const { browser, page, userId } = sess;
  pendingSessions.delete(sessionId); // one-time

  try {
    // ESIA uses 6 separate tel inputs (one digit per cell)
    const telInputs = page.locator('input[type="tel"]');
    const telCount = await telInputs.count().catch(() => 0);
    if (telCount >= code.length) {
      // Fill each digit into its own cell; many OTP forms auto-advance
      for (let i = 0; i < code.length; i++) {
        await telInputs.nth(i).click();
        await telInputs.nth(i).fill(code[i]);
        await page.waitForTimeout(50);
      }
    } else {
      // Fallback: single OTP input
      const codeInput = page.locator('#otp, input[name="otp"], input[placeholder*="код"], input[maxlength="6"], .form-otp input').first();
      await codeInput.fill(code);
    }
    // Many OTP forms auto-submit; wait briefly then click submit if still on same page
    await page.waitForTimeout(1500);
    const stillOnEsia = /esia|gosuslugi/.test(page.url());
    if (stillOnEsia) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.offsetParent !== null && !b.classList.contains('header__lang-button') &&
          (/подтвердить|войти|продолжить|далее/i.test(b.textContent) || b.type === 'submit')
        );
        if (btn) btn.click();
      });
    }

    await page.waitForURL(u => /lknpd\.nalog\.ru/.test(u) && !/\/auth\//.test(u), { timeout: 30000 });
    return extractAndSave(page, browser, userId);
  } catch (e) {
    browser.close().catch(() => {});
    return { error: `Ошибка при вводе кода: ${e.message.slice(0, 200)}` };
  }
}

async function extractAndSave(page, browser, userId) {
  try {
    // Wait for the SPA to write the token into sessionStorage
    await page.waitForFunction(() => !!sessionStorage.getItem('auth.token'), { timeout: 10000 });

    const tokens = await page.evaluate(() => ({
      auth_token: sessionStorage.getItem('auth.token'),
      refresh_token: sessionStorage.getItem('refresh.token'),
      expires: sessionStorage.getItem('auth.token.expires'),
    }));

    await browser.close();

    if (!tokens.auth_token) return { error: 'Вошли, но auth.token не появился в sessionStorage' };

    // Encrypted at rest on this VM too (#1789 C4); GCP gets its own copy via the token sink.
    writeCredential(String(userId), 'nalog', JSON.stringify(tokens, null, 2), { expiresAt: tokens.expires || null });
    console.log('[nalog-login] token saved locally, userId=%s, expires=%s', userId, tokens.expires);

    // Push the token to GCP too (issue #1288): this module now runs only on the
    // RU edge, which holds no other per-user state — 10-nalog.js and the expiry
    // scheduler both read from GCP's ~/agent-tokens, not this machine's.
    const sinkUrl = process.env.NALOG_TOKEN_SINK_URL;
    if (sinkUrl && process.env.AGENT_SECRET) {
      try {
        const sinkRes = await fetch(`${sinkUrl.replace(/\/$/, '')}/nalog/token-store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.AGENT_SECRET}` },
          body: JSON.stringify({ username: String(userId), tokens }),
          signal: AbortSignal.timeout(10000),
        });
        if (!sinkRes.ok) console.error('[nalog-login] token sink push failed: HTTP', sinkRes.status);
        else console.log('[nalog-login] token pushed to sink for userId=%s', userId);
      } catch (e) {
        console.error('[nalog-login] token sink push error:', e.message);
      }
    }

    return { status: 'ok', expires: tokens.expires, userId };
  } catch (e) {
    browser.close().catch(() => {});
    return { error: `Не удалось извлечь токен: ${e.message}` };
  }
}

function closeAll() {
  for (const [id, sess] of pendingSessions) {
    sess.browser.close().catch(() => {});
    pendingSessions.delete(id);
  }
}

module.exports = { startNalogLogin, confirmNalogCode, closeAll };
