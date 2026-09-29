'use strict';
// Fill and submit a login form in the remote Chrome via CDP.
// Credentials passed via env vars LOGIN_EMAIL / LOGIN_PASSWORD.
// Optional LOGIN_URL: navigate to this URL first (for non-Tilda sites).

// Resolve playwright from the release this script ships in (agent-master/node_modules);
// fall back to the legacy git checkout for a copy still living in ~/browser-session.
const PLAYWRIGHT = (() => {
  try { return require('playwright'); }
  catch { return require('/home/vova/trained-assist-agent/node_modules/playwright'); }
})();
const { decideLoginOutcome, isLoginLikeUrl } = require('./login-outcome');

const PASSWORD_SEL = 'input[type="password"]';

const email    = process.env.LOGIN_EMAIL;
const password = process.env.LOGIN_PASSWORD;
const loginUrl = process.env.LOGIN_URL || null;

if (!email || !password) {
  console.log(JSON.stringify({ ok: false, error: 'LOGIN_EMAIL / LOGIN_PASSWORD env vars required' }));
  process.exit(1);
}

(async () => {
  const browser = await PLAYWRIGHT.chromium.connectOverCDP('http://127.0.0.1:9224');
  try {
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    if (!pages.length) throw new Error('No pages in browser');
    const page = pages[0];
    await page.bringToFront();

    if (loginUrl) {
      // Bypass the HTTP cache: a cached SPA shell can reference a bundle the site has
      // since deleted (404) → the JS redirect to the auth page never happens (#1866).
      const cdp = await ctx.newCDPSession(page).catch(() => null);
      if (cdp) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
      await page.goto(loginUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
      // SPAs redirect by JS only after a multi-MB bundle loads (8–11s on new.contabo.com),
      // so a fixed 3s wait raced it. Poll up to 15s: done when the password field shows up
      // (form ready), or when the network went idle and we still sit on a non-login URL
      // (already logged in — the app had its chance to redirect and didn't).
      let idle = false;
      page.waitForLoadState('networkidle', { timeout: 15000 }).then(() => { idle = true; }, () => {});
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await page.isVisible(PASSWORD_SEL).catch(() => false)) break;
        if (idle && !isLoginLikeUrl(page.url())) break;
        await page.waitForTimeout(500);
      }
      if (cdp) await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    }

    const urlBefore = page.url();
    const titleBefore = await page.title().catch(() => '');

    const isLoginPage = isLoginLikeUrl(urlBefore) || await page.isVisible(PASSWORD_SEL).catch(() => false);
    if (!isLoginPage) {
      console.log(JSON.stringify({ ok: true, url_before: urlBefore, url_after: urlBefore, navigated: false, already_logged_in: true, captcha: false, two_factor: false, error_on_page: false }));
      try { browser._connection.close(); } catch {}
      process.exit(0);
    }

    // Fill email / username field
    const emailSel = 'input[type="email"], input[name="email"], input[name="login"], input[name="username"]';
    await page.fill(emailSel, email, { timeout: 8000 });

    // Fill password
    await page.fill(PASSWORD_SEL, password, { timeout: 5000 });

    // Find the real submit button — skip OAuth provider buttons (Google, VK, SSO etc.)
    // This handles login forms that show multiple login providers alongside email+password.
    const submitHandle = await page.evaluateHandle(() => {
      const oauthRe = /google|facebook|вконтакте|vk\.com|sso|единый|apple|github|microsoft/i;
      // Prefer button[type="submit"] that isn't an OAuth button
      const typedBtns = [...document.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const mainTyped = typedBtns.find(b => !oauthRe.test(b.textContent + (b.value || '')));
      if (mainTyped) return mainTyped;
      // Fallback: exact-text button (Войти, Log in, Sign in) that isn't OAuth
      const allBtns = [...document.querySelectorAll('button')].filter(el => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return allBtns.find(b => {
        const t = (b.textContent || '').trim();
        return /^(Войти|Log in|Sign in|Login|Submit|Вход)$/i.test(t) && !oauthRe.test(t);
      }) || null;
    });

    if (!submitHandle || (await submitHandle.jsonValue()) === null) {
      throw new Error('Submit button not found — could not locate a non-OAuth submit button');
    }
    await submitHandle.asElement().click({ timeout: 5000 });
    await submitHandle.dispose();

    // Wait for navigation or SPA route change
    await Promise.race([
      page.waitForNavigation({ timeout: 10000, waitUntil: 'commit' }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);
    // Extra wait for SPA rendering
    await page.waitForTimeout(2000);

    const urlAfter   = page.url();
    const titleAfter = await page.title().catch(() => '');
    const pageText   = await page.innerText('body').catch(() => '');

    // Detect Google OAuth redirect
    const googleRedirect = /accounts\.google\.com/i.test(urlAfter);
    if (googleRedirect) {
      console.log(JSON.stringify({
        ok: false,
        url_before: urlBefore,
        url_after: urlAfter,
        navigated: true,
        google_redirect: true,
        captcha: false,
        two_factor: false,
        error_on_page: false,
        message: 'Аккаунт привязан к Google — email+пароль не работает. Нужен вход через Google OAuth (noVNC).',
      }));
      try { browser._connection.close(); } catch {}
      process.exit(0);
    }

    const hasCaptcha = /captcha|recaptcha|hcaptcha/i.test(pageText) ||
      (await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null)) !== null;
    const passwordFieldVisible = await page.isVisible(PASSWORD_SEL).catch(() => false);
    const outcome = decideLoginOutcome({
      urlBefore, urlAfter, titleBefore, titleAfter, pageText, hasCaptcha, passwordFieldVisible,
    });

    console.log(JSON.stringify({
      ok: outcome.ok,
      url_before: urlBefore,
      url_after:  urlAfter,
      title_after: titleAfter,
      navigated:  outcome.navigated,
      captcha:    outcome.captcha,
      two_factor: outcome.two_factor,
      error_on_page: outcome.error_on_page,
      password_field_visible: passwordFieldVisible,
    }));
  } finally {
    try { browser._connection.close(); } catch {}
  }
  process.exit(0);
})().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
