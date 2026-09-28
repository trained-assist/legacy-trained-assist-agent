// Connect handler — all /connect/* OAuth + token-collection routes + /hh-callback
// (issue #942 P3.3). server.js is the router; connect business logic lives here.
//
// Dispatcher pattern (same as hh-skill src/hh-routes.js, #1030): returns `false` when no
// route matched so server.js can continue to the next handler; any route match
// ends the request itself (the `return;` statements are the original handler
// returns — undefined !== false, so server.js stops after we return truthy).
const path = require('path');
const os = require('os');
const fs = require('fs');

const { receiveConnect, readConnectPending, consumeConnectPending } = require('../user-tokens');
const { readCredentialFile, writeCredential, writeCredentialFile } = require('../credential-store');
const { startGetcourseLogin, mergeConfig: mergeGetcourseConfig } = require('../getcourse-login');
const { connectSite } = require('../site-connector');
const { getcourseFormHtml } = require('../connect-forms/getcourse');
const { gdriveFormHtml, gdriveSuccessHtml, gdriveErrorHtml } = require('../connect-forms/gdrive');
const { hhSuccessHtml, hhErrorHtml, hhLandingHtml, hhConfirmHtml } = require('../connect-forms/hh');
const { connectFormHtml } = require('../connect-forms/generic');
const { loginCredsFormHtml } = require('../connect-forms/login-creds');
const { genericMultiFormHtml } = require('../connect-forms/generic-multi');
const { siteFormHtml } = require('../connect-forms/site');
const { weeekFormHtml } = require('../connect-forms/weeek');

// OAuth2 state store: state_token → {userId, expires}
const oauthStateStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStateStore) {
    if (v.expires < now) oauthStateStore.delete(k);
  }
}, 60_000);

const GDRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
].join(' ');

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function tgNotifyGetcourse(botToken, chatId, domain, level, cookiesCount) {
  const lines = [`✅ GetCourse подключён! [${domain}]`];
  if (level.includes('L1')) lines.push('• API ключ: ✓ (управление учениками)');
  if (level.includes('L2')) lines.push(`• Сессия: ✓ (${cookiesCount} куки, создание курсов)`);
  if (!level.includes('L1') && !level.includes('L2')) lines.push('• Только домен сохранён (введите API ключ или логин)');
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  fetch(`${tgBase}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
  }).catch(e => console.error('[getcourse] tg notify failed:', e.message));
}

async function handleConnect(req, url, res, ctx) {
  const { readChatId, secrets, GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REDIRECT_URI,
          HH_CLIENT_ID, HH_CLIENT_SECRET, HH_REDIRECT_URI, HH_CALLBACK_PATH } = ctx;

// nalog.ru login (/connect/nalog, /connect/nalog/code) moved to the RU edge
// service (src/ru-edge.js) — Госуслуги/ESIA and lknpd.nalog.ru are geo-blocked
// outside Russia, so the Playwright login must run with an RU IP. See issue #1288.

// ── GET /connect/gdrive/start?t=TOKEN — redirect to Google OAuth2 ────────
if (req.method === 'GET' && url.pathname === '/connect/gdrive/start') {
  const t = url.searchParams.get('t') || '';
  if (!/^[a-f0-9]{32}$/.test(t)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный токен.'));
    return;
  }
  if (!GDRIVE_CLIENT_ID) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Google OAuth не настроен на сервере.'));
    return;
  }

  const pending = readConnectPending(t);
  if (!pending) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка недействительна или устарела.'));
    return;
  }
  if (pending.expires < Date.now()) {
    consumeConnectPending(t);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
    return;
  }
  if (pending.service !== 'gdrive') {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный сервис.'));
    return;
  }
  if (!/^-?\d{1,20}$/.test(pending.uid)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный UID.'));
    return;
  }

  // Consume pending token; generate OAuth state
  if (!consumeConnectPending(t)) {
    // Already consumed by a concurrent request — return the same error as expired
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Ссылка уже использована.'));
    return;
  }
  const crypto = require('crypto');
  const stateToken = crypto.randomBytes(16).toString('hex');
  oauthStateStore.set(stateToken, { userId: pending.uid, expires: Date.now() + 15 * 60 * 1000 });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GDRIVE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', GDRIVE_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GDRIVE_SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', stateToken);

  res.writeHead(302, { 'Location': authUrl.toString() }).end();
  return;
}

// ── GET /connect/gdrive/callback?code=...&state=... ──────────────────────
if (req.method === 'GET' && url.pathname === '/connect/gdrive/callback') {
  const code  = url.searchParams.get('code')  || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml(`Ошибка авторизации: ${error}`));
    return;
  }
  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Неверный callback.'));
    return;
  }

  const stateData = oauthStateStore.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    oauthStateStore.delete(state);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml('Сессия авторизации устарела. Начни заново через Telegram.'));
    return;
  }
  oauthStateStore.delete(state);
  const { userId } = stateData;

  // Exchange code for tokens
  let tokenData;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GDRIVE_CLIENT_ID,
        client_secret: GDRIVE_CLIENT_SECRET,
        redirect_uri: GDRIVE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    tokenData = await tokenRes.json();
    if (!tokenData.refresh_token) {
      throw new Error(tokenData.error_description || tokenData.error || 'no refresh_token in response');
    }
  } catch (e) {
    console.error('[gdrive/callback] token exchange failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveErrorHtml(`Ошибка получения токена: ${e.message}`));
    return;
  }

  // Get user email via tokeninfo
  let email = '';
  try {
    const infoRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${tokenData.access_token}`, { signal: AbortSignal.timeout(5000) });
    const info = await infoRes.json();
    email = info.email || '';
  } catch { /* non-critical */ }

  // Save to user token file (encrypted at rest — epic #1789 P0 C4)
  const credData = {
    type: 'oauth2',
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expiry: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    email,
    scope: tokenData.scope || '',
  };
  writeCredential(userId, 'gdrive', JSON.stringify(credData));
  console.log(`[gdrive/callback] saved tokens for userId=${userId} email=${email}`);

  // Notify user in Telegram (userId is username; look up chatId from .chatid file)
  const notifyChatId = readChatId(userId);
  if (notifyChatId) {
    const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
    fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: notifyChatId,
        text: `✅ Google Drive подключён!${email ? ` (${email})` : ''}\n\nТеперь расшари нужные папки/файлы с ассистентом — он попросит тебя об этом когда нужно. Управление доступами: /secrets_list`,
      }),
    }).catch(e => console.error('[gdrive/callback] tg notify failed:', e.message));
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveSuccessHtml(email));
  return;
}

// ── GET /connect/hh/start?t=TOKEN — confirm page (token NOT consumed here) ──
// Telegram link previews auto-fetch URLs; we show a button page so the token
// is only consumed when the user actually clicks through to /connect/hh/authorize.
if (req.method === 'GET' && url.pathname === '/connect/hh/start') {
  const t = url.searchParams.get('t') || '';
  if (!/^[a-f0-9]{32}$/.test(t)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный токен.'));
    return;
  }
  if (!HH_CLIENT_ID) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('HH OAuth не настроен на сервере.'));
    return;
  }

  const pending = readConnectPending(t);
  if (!pending) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка недействительна или устарела.'));
    return;
  }
  if (pending.expires < Date.now()) {
    consumeConnectPending(t);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
    return;
  }
  if (pending.service !== 'hh') {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный сервис.'));
    return;
  }

  // Token is valid — show confirm page. Do NOT delete the file yet.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhConfirmHtml(t));
  return;
}

// ── GET /connect/hh/authorize?t=TOKEN — consume token, redirect to hh.ru OAuth ──
if (req.method === 'GET' && url.pathname === '/connect/hh/authorize') {
  const t = url.searchParams.get('t') || '';
  if (!/^[a-f0-9]{32}$/.test(t)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный токен.'));
    return;
  }
  if (!HH_CLIENT_ID) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('HH OAuth не настроен на сервере.'));
    return;
  }

  const pendingAuth = readConnectPending(t);
  if (!pendingAuth) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка недействительна или устарела.'));
    return;
  }
  if (pendingAuth.expires < Date.now()) {
    consumeConnectPending(t);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка устарела. Попроси новую через Telegram.'));
    return;
  }
  if (pendingAuth.service !== 'hh') {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный сервис.'));
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(pendingAuth.uid)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Неверный UID.'));
    return;
  }

  if (!consumeConnectPending(t)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Ссылка уже использована.'));
    return;
  }
  const crypto = require('crypto');
  const hhStateToken = crypto.randomBytes(16).toString('hex');
  oauthStateStore.set(hhStateToken, { userId: pendingAuth.uid, expires: Date.now() + 15 * 60 * 1000 });

  const hhAuthUrl = new URL('https://hh.ru/oauth/authorize');
  hhAuthUrl.searchParams.set('response_type', 'code');
  hhAuthUrl.searchParams.set('client_id', HH_CLIENT_ID);
  hhAuthUrl.searchParams.set('redirect_uri', HH_REDIRECT_URI);
  hhAuthUrl.searchParams.set('state', hhStateToken);

  res.writeHead(302, { 'Location': hhAuthUrl.toString() }).end();
  return;
}

// ── GET /hh-callback?code=...&state=... (path derived from HH_REDIRECT_URI) ──
if (req.method === 'GET' && url.pathname === HH_CALLBACK_PATH) {
  const code  = url.searchParams.get('code')  || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml(`Ошибка авторизации: ${error}`));
    return;
  }
  if (!code || !state) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhLandingHtml());
    return;
  }

  const hhStateData = oauthStateStore.get(state);
  if (!hhStateData || hhStateData.expires < Date.now()) {
    oauthStateStore.delete(state);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml('Сессия авторизации устарела. Начни заново через Telegram.'));
    return;
  }
  oauthStateStore.delete(state);
  const hhUserId = hhStateData.userId; // username (profile name)

  // Exchange code for tokens
  let hhTokenData;
  try {
    const tokenRes = await fetch('https://hh.ru/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: HH_CLIENT_ID,
        client_secret: HH_CLIENT_SECRET,
        code,
        redirect_uri: HH_REDIRECT_URI,
      }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    hhTokenData = await tokenRes.json();
    if (!hhTokenData.access_token) {
      throw new Error(hhTokenData.error_description || hhTokenData.error || 'no access_token');
    }
  } catch (e) {
    console.error('[hh/callback] token exchange failed:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhErrorHtml(`Ошибка получения токена: ${e.message}`));
    return;
  }

  // Get user info from HH
  let hhDisplayName = '';
  let hhEmployerId = null;
  try {
    const meRes = await fetch('https://api.hh.ru/me', {
      headers: {
        Authorization: `Bearer ${hhTokenData.access_token}`,
        'User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
        'HH-User-Agent': `trained-assist-agent/1.0 (${process.env.HH_APP_CONTACT || 'support@recruiter-assistant.ru'})`,
      },
      signal: AbortSignal.timeout(5000),
    });
    const me = await meRes.json();
    hhDisplayName = [me.last_name, me.first_name].filter(Boolean).join(' ');
    hhEmployerId = (me.employer && me.employer.id) || null;
  } catch { /* non-critical */ }

  // Save token to ~/agent-tokens/{username}/hh (encrypted at rest — #1789 P0 C4)
  writeCredential(
    hhUserId,
    'hh',
    JSON.stringify({
      access_token:  hhTokenData.access_token,
      refresh_token: hhTokenData.refresh_token || null,
      employer_id:   hhEmployerId,
      saved_at:      new Date().toISOString(),
    }),
  );
  console.log(`[hh/callback] saved token for userId=${hhUserId} name=${hhDisplayName} employer_id=${hhEmployerId}`);

  // Notify user in Telegram
  const hhChatId = readChatId(hhUserId);
  if (hhChatId) {
    const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
    fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: hhChatId,
        text: `✅ HeadHunter подключён!${hhDisplayName ? ` (${hhDisplayName})` : ''}\n\nМожешь начинать работу с вакансиями и откликами.`,
      }),
    }).catch(e => console.error('[hh/callback] tg notify failed:', e.message));
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(hhSuccessHtml(hhDisplayName));
  return;
}

// ── /connect/:service — token collection form (no AGENT_SECRET needed) ──
const connectMatch = url.pathname.match(/^\/connect\/([a-z0-9_-]+)$/);
if (connectMatch) {
  const service = connectMatch[1];

  // nalog.ru (service === 'nalog', legacy own-hosted login form) moved to the
  // RU edge service — see src/ru-edge.js. The active onboarding path is the
  // ZeroCreds 'nalog-creds' flow below, which POSTs to /tokens (server.js),
  // not through this /connect/:service dispatcher.

  // ── hh — redirect to OAuth2 start ───────────────────────────────────────
  if (service === 'hh') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      res.writeHead(302, { Location: `/connect/hh/start?t=${encodeURIComponent(t)}` }).end();
      return;
    }
    res.writeHead(405).end(); return;
  }

  // ── gdrive — OAuth2 authorization page ───────────────────────────────────
  if (service === 'gdrive') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(gdriveFormHtml(t));
      return;
    }
    res.writeHead(405).end(); return;
  }

  // ── getcourse — two-level connect form (domain + apiKey + login/password) ──
  if (service === 'getcourse') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      // Pre-fill from saved config if available
      let gcSaved = null;
      try {
        const pending = readConnectPending(t);
        if (pending && pending.uid && pending.expires > Date.now()) {
          const cfgFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'getcourse', 'config.json');
          if (fs.existsSync(cfgFile)) {
            const cfg = JSON.parse(readCredentialFile(cfgFile));
            gcSaved = {
              domain: cfg.accountDomain || null,
              apiKey: cfg.apiKey || null,
              login: cfg.login || null,
              password: cfg.password || null,
              hasSession: !!(cfg.sessionCookies && cfg.sessionCookies.length > 0),
            };
          }
        }
      } catch { /* non-critical: render form without pre-fill */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(getcourseFormHtml(t, gcSaved));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const { t, domain, apiKey, login, password } = payload;
      if (!t || !domain) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or domain' })); return; }
      if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

      const pending = receiveConnect(t);
      if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
      if (pending.service !== 'getcourse') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

      const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const patch = { accountDomain: cleanDomain };
      if (apiKey) patch.apiKey = apiKey.trim();
      if (login) patch.login = login.trim();
      if (password) patch.password = password; // stored for form pre-fill on next connect
      mergeGetcourseConfig(pending.uid, patch);

      let cookiesCount = 0;
      let level = [];
      if (apiKey) level.push('L1');

      if (login && password) {
        const result = await startGetcourseLogin(pending.uid, cleanDomain, login.trim(), password);
        if (result.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
          return;
        }
        cookiesCount = result.cookiesCount || 0;
        level.push('L2');
      }

      if (!level.length) level.push('domain-only');

      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, level }));
      const gcChatId = readChatId(pending.uid);
      if (gcChatId) tgNotifyGetcourse(secrets.BOT_TOKEN, gcChatId, cleanDomain, level, cookiesCount);
      return;
    }

    res.writeHead(405).end(); return;
  }

  // login-creds services: two-field (email+password) forms
  const LOGIN_CREDS_META = {
    'tilda-creds': {
      name: 'Tilda (логин)',
      hint: 'Сохраните логин и пароль от tilda.ru — ассистент сможет входить автоматически, не видя данных в чате.',
      emailLabel: 'Email от Tilda',
      emailPlaceholder: 'you@example.com',
    },
  };
  const loginCredsMeta = LOGIN_CREDS_META[service];
  if (loginCredsMeta) {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      let lcSaved = null;
      try {
        const pending = readConnectPending(t);
        if (pending && pending.uid && pending.expires > Date.now()) {
          const credsFile = path.join(os.homedir(), 'agent-tokens', pending.uid, service);
          if (fs.existsSync(credsFile)) {
            const stored = JSON.parse(readCredentialFile(credsFile));
            lcSaved = { email: stored.email || null, password: stored.password || null };
          }
        }
      } catch { /* non-critical */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(loginCredsFormHtml(service, loginCredsMeta, t, lcSaved));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const { t, email, password } = payload;
      if (!t || !email || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
      if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

      const pending = receiveConnect(t);
      if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
      if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

      writeCredential(pending.uid, service, JSON.stringify({ email: email.trim(), password }));
      console.log(`[connect] saved ${service} creds for uid=${pending.uid}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

      const lcChatId = readChatId(pending.uid);
      if (lcChatId) {
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: lcChatId,
            text: `✅ ${loginCredsMeta.name} сохранён! Ассистент теперь может входить автоматически — данные изолированы от чата.\n\nУправление: /secrets_list`,
          }),
        }).catch(e => console.error('[connect] tg notify failed:', e.message));
      }
      return;
    }

    res.writeHead(405).end(); return;
  }

  // ── weeek — L1 (API token) + optional L2 (login+password for deal comments) ──
  if (service === 'weeek') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      let savedToken = null, savedLogin = null;
      try {
        const pending = readConnectPending(t);
        if (pending && pending.uid && pending.expires > Date.now()) {
          const tokFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'weeek');
          if (fs.existsSync(tokFile)) savedToken = readCredentialFile(tokFile).trim() || null;
          const loginFile = path.join(os.homedir(), 'agent-tokens', pending.uid, 'weeek-login');
          if (fs.existsSync(loginFile)) {
            const stored = JSON.parse(readCredentialFile(loginFile));
            savedLogin = { email: stored.email || null, password: stored.password || null };
          }
        }
      } catch { /* non-critical */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(weeekFormHtml(t, savedToken, savedLogin));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const { t, token: apiToken, email, password } = payload;
      if (!t || !apiToken) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or token' })); return; }
      if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

      const pending = receiveConnect(t);
      if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
      if (pending.service !== 'weeek') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid in token' })); return; }

      writeCredential(pending.uid, 'weeek', String(apiToken).trim());

      const level = ['L1'];
      if (email && password) {
        writeCredential(pending.uid, 'weeek-login', JSON.stringify({ email: email.trim(), password }));
        level.push('L2');
      }

      console.log(`[connect] saved weeek token (level=${level.join('+')}) for uid=${pending.uid}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, level }));

      const wkChatId = readChatId(pending.uid);
      if (wkChatId) {
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        let notifyText = '✅ Weeek CRM подключён!\n';
        notifyText += '• L1 (API токен): ✓ создание сделок, контактов, задач\n';
        if (level.includes('L2')) notifyText += '• L2 (логин+пароль): ✓ комментарии к сделкам\n';
        notifyText += '\nУправление: /secrets_list';
        fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: wkChatId, text: notifyText }),
        }).catch(e => console.error('[connect] tg notify failed:', e.message));
      }
      return;
    }

    res.writeHead(405).end(); return;
  }

  // ── site — generic Playwright login + crawl ───────────────────────────────
  if (service === 'site') {
    if (req.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(siteFormHtml(t));
      return;
    }

    if (req.method === 'POST') {
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const { t, url: siteUrl, login, password } = payload;
      if (!t || !siteUrl || !login || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
      if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

      const pendingSite = receiveConnect(t);
      if (!pendingSite) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
      if (pendingSite.service !== 'site') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pendingSite.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

      const siteResult = await connectSite(pendingSite.uid, { url: siteUrl, login, password });
      if (siteResult.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: siteResult.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(siteResult));
      return;
    }

    res.writeHead(405).end(); return;
  }

  const SERVICE_META = {
    github: { name: 'GitHub', placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', hint: 'github.com/settings/tokens → Generate new token (classic) → scopes: <b>repo</b>, <b>read:org</b>' },
  };
  const meta = SERVICE_META[service];

  // ── generic fallback — any service created via credentials_form_create ──
  // (or any other caller passing an inline schema) that isn't one of the
  // specially-handled services above. Without this, ZeroCreds being down
  // for even a moment turns every such link into a dead 404 "Unknown service".
  if (!meta) {
    const t = url.searchParams.get('t') || (req.method === 'POST' ? null : '');
    const readPending = (token) => {
      const p = readConnectPending(token);
      if (!p || p.expires < Date.now() || p.service !== service || !p.schema) return null;
      return p;
    };

    if (req.method === 'GET') {
      const pending = readPending(t);
      if (!pending) { res.writeHead(404).end('Unknown service'); return; }
      let saved = null;
      try {
        const credsFile = path.join(os.homedir(), 'agent-tokens', pending.uid, service);
        if (fs.existsSync(credsFile)) saved = JSON.parse(readCredentialFile(credsFile));
      } catch { /* non-critical */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(genericMultiFormHtml(service, pending.schema, t, saved));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
      const tokenVal = payload.t;
      const pending = receiveConnect(tokenVal);
      if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
      if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
      if (!pending.schema) { res.writeHead(403).end(JSON.stringify({ error: 'missing schema' })); return; }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }
      const fieldsIn = payload.fields && typeof payload.fields === 'object' ? payload.fields : null;
      if (!fieldsIn) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
      for (const f of (pending.schema.fields || [])) {
        if (f.required && !fieldsIn[f.name]) { res.writeHead(400).end(JSON.stringify({ error: `missing field: ${f.name}` })); return; }
      }

      writeCredential(pending.uid, service, JSON.stringify(fieldsIn));
      console.log(`[connect] saved ${service} creds (generic form) for uid=${pending.uid}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

      const genChatId = readChatId(pending.uid);
      if (genChatId) {
        const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
        fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: genChatId,
            text: `✅ ${pending.schema.title || service} сохранено! Данные изолированы от чата.\n\nУправление: /secrets_list`,
          }),
        }).catch(e => console.error('[connect] tg notify failed:', e.message));
      }
      return;
    }

    res.writeHead(405).end(); return;
  }

  if (req.method === 'GET') {
    const t = url.searchParams.get('t') || '';
    // Pre-fill from saved token if available
    let savedValue = null;
    try {
      const pending = readConnectPending(t);
      if (pending && pending.uid && pending.expires > Date.now()) {
        const tokenFile = path.join(os.homedir(), 'agent-tokens', pending.uid, service);
        if (fs.existsSync(tokenFile)) {
          savedValue = readCredentialFile(tokenFile).trim() || null;
        }
      }
    } catch { /* non-critical */ }
    const html = connectFormHtml(service, meta, t, savedValue);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    return;
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const { t, value } = payload;
    if (!t || !value) { res.writeHead(400).end(JSON.stringify({ error: 'missing t or value' })); return; }
    if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

    const pending = receiveConnect(t);
    if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
    if (pending.service !== service) { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid in token' })); return; }
    writeCredential(pending.uid, service, String(value).trim());
    console.log(`[connect] saved ${service} token for uid=${pending.uid}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));

    // Notify user in Telegram (fire-and-forget)
    const svcChatId = readChatId(pending.uid);
    if (svcChatId) {
      const SERVICE_NAMES = { github: 'GitHub' };
      const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
      fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: svcChatId,
          text: `✅ ${SERVICE_NAMES[service] || service} подключён! Данные для входа сохранены в изолированном хранилище — в чат не попадают.\n\nУправление доступами: /secrets_list`,
        }),
      }).catch(e => console.error('[connect] tg notify failed:', e.message));
    }
    return;
  }

  res.writeHead(405).end(); return;
}

  return false;
}

module.exports = { handleConnect };
