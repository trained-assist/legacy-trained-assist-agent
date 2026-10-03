#!/usr/bin/env node
'use strict';

// Refresh WEEEK_APP_COOKIE in the Cloudflare Worker secret.
//
// Flow:
//   1. Capture cookies for app.weeek.net from the running Chrome via CDP
//   2. If CDP fails → headless Playwright fallback using weeek-login credentials
//   3. Update the Cloudflare Worker secret via CF REST API
//   4. Send Telegram alert on failure (or success with --verbose)
//
// Env vars (loaded from GCP secrets by secrets.js or set manually):
//   TELEGRAM_BOT_TOKEN  — bot token for alert messages
//   CF_API_TOKEN        — Cloudflare API token with Workers:Edit scope
//   CF_ACCOUNT_ID       — Cloudflare account ID
//   CF_WORKER_NAME      — Worker script name (default: flexi-telegram-deal-bot)
//   OPERATOR_CHAT_ID    — Telegram chat ID to send alerts (default: 1714048)
//   BROWSER_SESSION_URL — noVNC URL shown in failure alerts
//   WEEEK_SESSION_PROFILES — comma-separated profiles to save session to (default: flexi)
//
// Exit codes: 0 = success, 1 = failure (alert sent)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCredentialFile, writeCredential } = require('../src/credential-store');

const CF_ACCOUNT_ID  = process.env.CF_ACCOUNT_ID  || 'd740a05e9442c1d0feacae2dfc673e93';
const CF_WORKER_NAME = process.env.CF_WORKER_NAME  || 'flexi-telegram-deal-bot';
const OPERATOR_CHAT  = process.env.OPERATOR_CHAT_ID || '1714048';
const BROWSER_URL    = process.env.BROWSER_SESSION_URL || 'https://136-65-7-197.sslip.io/browser/';
const VERBOSE        = process.argv.includes('--verbose');

const CAPTURE_SCRIPT = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
const TMP_COOKIE_FILE = path.join(os.tmpdir(), `weeek-cookie-${Date.now()}.tmp`);

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tgSend(token, chatId, text) {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }
}

// ── Cloudflare API ────────────────────────────────────────────────────────────

async function updateCfSecret(token, accountId, workerName, secretName, secretValue) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: secretName, text: secretValue, type: 'secret_text' }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`CF API ${res.status}: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

// ── Headless Playwright fallback ──────────────────────────────────────────────

// Returns a semicolon-separated cookie string for app.weeek.net, or throws.
async function captureViaPlaywright(profiles) {
  // Find credentials in any of the profiles
  let creds = null;
  let credsProfile = null;
  for (const profile of profiles) {
    // Check weeek-login first (legacy), then fall back to weeek JSON (zerocreds format)
    for (const filename of ['weeek-login', 'weeek']) {
      const file = path.join(os.homedir(), 'agent-tokens', profile, filename);
      try {
        const raw = JSON.parse(readCredentialFile(file));
        if (raw.email && raw.password) { creds = raw; credsProfile = profile; break; }
      } catch { /* not found or no creds */ }
    }
    if (creds) break;
  }
  if (!creds) {
    throw new Error(`weeek L2 creds not found for profiles (${profiles.join(', ')}) — добавьте логин/пароль через /connect/weeek`);
  }
  console.log('[refresh-weeek/pw] Using credentials from profile=%s', credsProfile);

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    throw new Error(`Не удалось запустить Playwright: ${e.message}`);
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ru-RU',
    });
    const page = await context.newPage();

    console.log('[refresh-weeek/pw] Navigating to app.weeek.net/login');
    await page.goto('https://app.weeek.net/login', { waitUntil: 'networkidle', timeout: 30000 });

    // Fill email
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="логин" i]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(creds.email);
    console.log('[refresh-weeek/pw] Email filled');

    // Fill password — may require clicking Next first on some SPAs
    const pwInput = page.locator('input[type="password"]').first();
    const pwVisible = await pwInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (!pwVisible) {
      // Click submit/next to reveal password field
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /далее|next|продолжить|continue/i.test(b.textContent) || b.type === 'submit'
        );
        if (btn) btn.click();
      });
      await pwInput.waitFor({ state: 'visible', timeout: 8000 });
    }
    await pwInput.fill(creds.password);
    console.log('[refresh-weeek/pw] Password filled, submitting…');

    // Submit
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        b.offsetParent !== null && (/войти|sign.?in|вход|login|enter/i.test(b.textContent) || b.type === 'submit')
      );
      if (btn) btn.click();
    });

    // Wait for successful auth — URL leaves /login or /auth, or app shell loads
    await Promise.race([
      page.waitForURL(u => !/login|auth/.test(u), { timeout: 30000 }),
      page.waitForURL(/app\.weeek\.net\/(w|dashboard|tasks|projects)/, { timeout: 30000 }),
    ]).catch(() => {});

    const finalUrl = page.url();
    if (/login|auth/.test(finalUrl)) {
      // Snapshot for debugging
      await page.screenshot({ path: `/tmp/weeek-login-fail-${Date.now()}.png` }).catch(() => {});
      const errText = await page.evaluate(() =>
        (document.querySelector('[class*="error"], [class*="alert"], .notification') || {}).textContent || ''
      ).catch(() => '');
      throw new Error(`Авторизация не прошла (URL: ${finalUrl}). ${errText.trim().slice(0, 150)}`);
    }
    console.log('[refresh-weeek/pw] Login success, url=%s', finalUrl);

    // Wait for auth cookies to settle (weeek_session is set on .api.weeek.net after login)
    await page.waitForTimeout(2000);

    // Extract cookies from ALL weeek.net domains (weeek_session lives on .api.weeek.net, not .app.weeek.net)
    const allCookies = await context.cookies();
    const cookies = allCookies.filter(c => c.domain.includes('weeek'));
    if (!cookies.length) throw new Error('Куки для weeek.net не найдены после входа');

    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`[refresh-weeek/pw] Captured ${cookies.length} weeek cookies`);

    await browser.close();
    return cookieStr;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  // #2046: canonical ADMIN_CLOUDFLARE_API_TOKEN, legacy CF_API_TOKEN as fallback.
  const cfToken  = process.env.ADMIN_CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;

  if (!cfToken) {
    console.error('[refresh-weeek] ADMIN_CLOUDFLARE_API_TOKEN not set — cannot update CF secret');
    await tgSend(botToken, OPERATOR_CHAT,
      '⚠️ <b>Weeek авторефреш не настроен</b>\n\n' +
      'ADMIN_CLOUDFLARE_API_TOKEN не задан в GCP secrets.\n\n' +
      'Нужно один раз добавить:\n' +
      '<code>echo "TOKEN" | gcloud secrets create ADMIN_CLOUDFLARE_API_TOKEN --data-file=-</code>\n\n' +
      'Токен создаётся на dash.cloudflare.com/profile/api-tokens → Create Token → Workers:Edit'
    );
    process.exit(1);
  }

  const LOCAL_SESSION_PROFILES = (process.env.WEEEK_SESSION_PROFILES || 'flexi').split(',').map(s => s.trim()).filter(Boolean);

  // Step 1: Capture cookies — try Chrome CDP first, fall back to headless Playwright
  console.log('[refresh-weeek] Capturing app.weeek.net cookies via CDP…');
  let cookieStr;
  let captureMethod = 'cdp';
  try {
    execSync(`node "${CAPTURE_SCRIPT}" app.weeek.net "${TMP_COOKIE_FILE}"`, {
      timeout: 20000,
      stdio: 'inherit',
    });
    cookieStr = fs.readFileSync(TMP_COOKIE_FILE, 'utf8').trim();
    if (!cookieStr) throw new Error('Empty cookie string after capture');
    console.log(`[refresh-weeek] CDP: captured ${cookieStr.split(';').length} cookies`);
  } catch (cdpErr) {
    console.warn('[refresh-weeek] CDP capture failed (%s) — trying headless Playwright fallback', cdpErr.message.slice(0, 100));
    try {
      cookieStr = await captureViaPlaywright(LOCAL_SESSION_PROFILES);
      captureMethod = 'playwright';
      console.log('[refresh-weeek] Playwright fallback succeeded');
    } catch (pwErr) {
      console.error('[refresh-weeek] Both methods failed. CDP: %s | PW: %s', cdpErr.message.slice(0, 100), pwErr.message.slice(0, 150));
      await tgSend(botToken, OPERATOR_CHAT,
        '⚠️ <b>Weeek сессия: авторефреш не удался</b>\n\n' +
        'Не удалось захватить куки ни через Chrome CDP, ни через headless Playwright.\n\n' +
        '<b>CDP:</b> ' + cdpErr.message.slice(0, 150) + '\n' +
        '<b>Playwright:</b> ' + pwErr.message.slice(0, 150) + '\n\n' +
        '<b>Как починить:</b>\n' +
        `1. Открой браузер на VM: <a href="${BROWSER_URL}">${BROWSER_URL}</a>\n` +
        '2. Зайди на app.weeek.net и авторизуйся\n' +
        '3. Открой расширение Cloud Auth Bridge → Передать токен\n' +
        '   (или обнови логин/пароль через /connect/weeek)\n\n' +
        '⏰ Следующая попытка авторефреша — через 6ч'
      );
      process.exit(1);
    }
  } finally {
    try { fs.unlinkSync(TMP_COOKIE_FILE); } catch {}
  }

  // Save to agent-tokens for profiles that need L2 Weeek session locally
  for (const profile of LOCAL_SESSION_PROFILES) {
    writeCredential(profile, 'weeek-session', cookieStr);
    console.log(`[refresh-weeek] Saved session to ~/agent-tokens/${profile}/weeek-session (via ${captureMethod})`);
  }

  // Step 2: Update Cloudflare secret
  console.log('[refresh-weeek] Updating CF secret WEEEK_APP_COOKIE…');
  try {
    await updateCfSecret(cfToken, CF_ACCOUNT_ID, CF_WORKER_NAME, 'WEEEK_APP_COOKIE', cookieStr);
    console.log('[refresh-weeek] ✅ CF secret updated successfully');
    if (VERBOSE) {
      await tgSend(botToken, OPERATOR_CHAT,
        '✅ <b>Weeek сессия обновлена</b>\n\nКуки захвачены и секрет в Cloudflare обновлён автоматически.'
      );
    }
  } catch (e) {
    console.error('[refresh-weeek] CF secret update failed:', e.message);
    await tgSend(botToken, OPERATOR_CHAT,
      '⚠️ <b>Weeek сессия: куки есть, но CF не обновился</b>\n\n' +
      'Куки захвачены успешно, но не удалось обновить секрет в Cloudflare.\n\n' +
      '<b>Причина:</b> ' + e.message.slice(0, 200) + '\n\n' +
      '<b>Как починить вручную:</b>\n' +
      '<code>wrangler secret put WEEEK_APP_COOKIE --config workers/telegram-deal-bot/wrangler.toml</code>\n' +
      '(запусти на своём Mac из flexi-crm-automation)'
    );
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[refresh-weeek] Unexpected error:', e.message);
  process.exit(1);
});
