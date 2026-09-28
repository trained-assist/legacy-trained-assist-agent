'use strict';

// RU-IP edge service (issue #1288) — everything that MUST run with a Russian IP:
// nalog.ru/Госуслуги (ESIA) login via Playwright, generic RU-geo-blocked page
// fetches, and the vacancy landing pages hosted on platform.recruiter-assistant.ru.
//
// No Claude, no runner, no task-queue, no MCP here — that is the entire point of
// this split (see the issue). All Claude sessions run on GCP; GCP calls this
// service over HTTP with Bearer AGENT_SECRET for anything that needs an RU IP,
// and this service calls GCP back (POST /nalog/token-store) to hand over the
// result of a nalog.ru login, since GCP is where 10-nalog.js and the expiry
// scheduler read the token from.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { loadSecrets } = require('./secrets');
const { startNalogLogin, confirmNalogCode, closeAll: closeNalogSessions } = require('./nalog-login');
const { receiveConnect } = require('./user-tokens');
const { nalogFormHtml, nalogCodeFormHtml } = require('./connect-forms/nalog');
const { workspacePath } = require('./data-paths');

const PORT = process.env.PORT || 8080;
const VM_NAME = process.env.VM_NAME || 'ru-edge';
const TOKENS_ROOT = process.env.AGENT_TOKENS_DIR || process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');

let GIT_COMMIT = 'unknown';
try { const sha = require('./release-info').getReleaseSha(); if (sha) GIT_COMMIT = sha.slice(0, 7); } catch {}

function readChatId(username) {
  try { return fs.readFileSync(path.join(TOKENS_ROOT, String(username), '.chatid'), 'utf8').trim() || null; }
  catch { return null; }
}

function tgNotifyNalog(botToken, chatId, expires) {
  const expiresStr = expires ? new Date(expires).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '~1 час';
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  fetch(`${tgBase}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Налог.ру подключён! Данные авторизации сохранены — действуют до ${expiresStr} (МСК).\n\nТеперь можно работать с чеками НПД. Управление доступами: /secrets_list`,
    }),
  }).catch(e => console.error('[nalog] tg notify failed:', e.message));
}

// Same shape as hh-vacancy.js's storeApplication() on GCP — duplicated (not
// required) rather than importing hh-vacancy.js, which pulls in hh-utils.js /
// hh-scoring.js and their transitive deps. This is the one piece of that file
// this service needs.
function storeApplication(workDir, vacancyId, fields) {
  const appDir = path.join(workDir, 'vacancy-drafts', vacancyId, 'applications');
  fs.mkdirSync(appDir, { recursive: true });
  const ts = Date.now();
  const meta = { ...fields, submitted_at: new Date(ts).toISOString() };
  fs.writeFileSync(path.join(appDir, `${ts}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

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

function readBodyBuffer(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function indexOfSeq(buf, seq) {
  for (let i = 0; i <= buf.length - seq.length; i++) {
    if (buf.slice(i, i + seq.length).equals(seq)) return i;
  }
  return -1;
}

function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  let pos;
  while ((pos = indexOfSeq(buf.slice(start), sep)) !== -1) {
    parts.push(buf.slice(start, start + pos));
    start += pos + sep.length;
  }
  parts.push(buf.slice(start));
  return parts.filter(p => p.length > 0);
}

async function main() {
  // auditBots:false — this process never delivers to a registry audience; it
  // sends only via the classic TELEGRAM_BOT_TOKEN (nalog login + vacancy
  // apply notifications). RECRUITER/FREELANCE tokens are legitimately absent
  // on this box, so their "delivery will fail" warning would be pure noise.
  const secrets = await loadSecrets({ auditBots: false });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      // ── Public, unauthenticated routes ──────────────────────────────────

      // GET /health — liveness check, no auth (matches server.js's /health)
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { status: 'alive', uptime: process.uptime(), vm: VM_NAME, commit: GIT_COMMIT, service: 'ru-edge' });
      }

      // ── GET /connect/nalog/code?sessionId=XXX — 2FA code entry page ─────
      if (req.method === 'GET' && url.pathname === '/connect/nalog/code') {
        const sessionId = url.searchParams.get('sessionId') || '';
        if (!/^[a-f0-9]{32}$/.test(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<p>Неверная ссылка. Запросите новую через Telegram.</p>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(nalogCodeFormHtml(sessionId));
        return;
      }

      // ── POST /connect/nalog/code — confirm 2FA code (no AGENT_SECRET needed,
      // the user opens this link directly from a Telegram message) ────────
      if (req.method === 'POST' && url.pathname === '/connect/nalog/code') {
        const body = await readBody(req);
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
        const { session, code } = payload || {};
        if (!session || !code) { res.writeHead(400).end(JSON.stringify({ error: 'missing session or code' })); return; }
        if (!/^[a-f0-9]{32}$/.test(session)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid session' })); return; }
        if (!/^\d{4,8}$/.test(code.trim())) { res.writeHead(400).end(JSON.stringify({ error: 'invalid code format' })); return; }

        const result = await confirmNalogCode(session, code.trim());
        if (result.error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error })); return; }

        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, expires: result.expires }));
        if (result.userId) {
          const chatId = readChatId(result.userId);
          if (chatId) tgNotifyNalog(secrets.BOT_TOKEN, chatId, result.expires);
        }
        return;
      }

      // ── /connect/nalog — legacy own-hosted login form (GET + POST) ──────
      // Superseded in practice by the ZeroCreds 'nalog-creds' flow (which POSTs
      // straight to GCP's /tokens and never reaches this route), but kept for
      // parity with the pre-migration server.js. Known limitation: the pending
      // token (`t`) is minted by generateConnectLink() on GCP — if this legacy
      // path were ever exercised again, GCP would need its own consume-pending
      // endpoint for us to call cross-VM. Not wired up; see PR description.
      if (req.method === 'GET' && url.pathname === '/connect/nalog') {
        const t = url.searchParams.get('t') || '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(nalogFormHtml(t));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/connect/nalog') {
        const body = await readBody(req);
        let payload;
        try { payload = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'bad json' })); return; }
        const { t, login, password } = payload || {};
        if (!t || !login || !password) { res.writeHead(400).end(JSON.stringify({ error: 'missing fields' })); return; }
        if (!/^[a-f0-9]{32}$/.test(t)) { res.writeHead(400).end(JSON.stringify({ error: 'invalid token' })); return; }

        const pending = receiveConnect(t);
        if (!pending) { res.writeHead(403).end(JSON.stringify({ error: 'invalid or expired token' })); return; }
        if (pending.service !== 'nalog') { res.writeHead(403).end(JSON.stringify({ error: 'service mismatch' })); return; }
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pending.uid)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid uid' })); return; }

        // Browser login may take 30-60s; form sets fetch timeout to 90s
        const result = await startNalogLogin(pending.uid, login, password);

        if (result.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: result.error }));
          return;
        }
        if (result.status === 'ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', expires: result.expires }));
          const nalogChatId = readChatId(pending.uid);
          if (nalogChatId) tgNotifyNalog(secrets.BOT_TOKEN, nalogChatId, result.expires);
          return;
        }
        if (result.status === 'need_code') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'need_code', sessionId: result.sessionId }));
          return;
        }
        res.writeHead(500).end(JSON.stringify({ error: 'unexpected result' }));
        return;
      }

      // GET /vacancy/:username/:vacancyId — public vacancy landing page
      const vacancyPageMatch = url.pathname.match(/^\/vacancy\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && vacancyPageMatch) {
        const [, username, vacancyId] = vacancyPageMatch;
        const htmlPath = workspacePath(username, 'vacancy-drafts', `${vacancyId}.html`);
        try {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        } catch {
          res.writeHead(404).end('Vacancy not found');
        }
        return;
      }

      // CORS preflight for /apply (form is hosted on chillai.space, different origin)
      if (req.method === 'OPTIONS' && /^\/apply\//.test(url.pathname)) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      // POST /apply/:username/:vacancyId — no auth, public endpoint for candidate applications
      if (req.method === 'POST' && /^\/apply\/[a-zA-Z0-9_-]+\/vac-\d+$/.test(url.pathname)) {
        const parts = url.pathname.split('/');
        const applyUsername = parts[2];
        const vacancyId = parts[3];
        const workDir = workspacePath(applyUsername);

        let fields = {};
        try {
          const ct = req.headers['content-type'] || '';
          if (ct.includes('multipart/form-data')) {
            const rawBuf = await readBodyBuffer(req);
            const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
            if (boundary) {
              const sep = Buffer.from(`--${boundary}`);
              const parts2 = splitBuffer(rawBuf, sep);
              for (const part of parts2) {
                const headerEnd = indexOfSeq(part, Buffer.from('\r\n\r\n'));
                if (headerEnd === -1) continue;
                const header = part.slice(0, headerEnd).toString();
                const value = part.slice(headerEnd + 4);
                const m = header.match(/Content-Disposition:[^\n]*name="([^"]+)"/);
                if (m && m[1] !== 'resume') {
                  const text = value.slice(-2).equals(Buffer.from('\r\n')) ? value.slice(0, -2) : value;
                  fields[m[1]] = text.toString('utf8').trim();
                }
              }
            }
          } else {
            const body = await readBody(req);
            if (ct.includes('application/json')) {
              fields = JSON.parse(body);
            } else if (ct.includes('application/x-www-form-urlencoded')) {
              for (const pair of body.split('&')) {
                const [k, v] = pair.split('=');
                if (k) fields[decodeURIComponent(k)] = decodeURIComponent(v || '');
              }
            }
          }
        } catch (e) {
          console.error('[apply] parse error:', e.message);
          res.writeHead(400, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid request body' }));
          return;
        }

        const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
        function applyJson(status, data) {
          res.writeHead(status, corsHeaders);
          res.end(JSON.stringify(data));
        }

        const email = String(fields.email || '').trim();
        const phone = String(fields.phone || '').trim();
        if (!email || !phone) return applyJson(400, { error: 'email and phone are required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return applyJson(400, { error: 'invalid email' });

        try {
          const app = storeApplication(workDir, vacancyId, {
            name: String(fields.name || '').trim().slice(0, 200),
            email,
            phone: phone.slice(0, 30),
            telegram: String(fields.telegram || '').trim().slice(0, 100),
            message: String(fields.message || '').trim().slice(0, 3000),
          });

          const chatId = readChatId(applyUsername);
          if (chatId && secrets.BOT_TOKEN) {
            const notifLines = [
              `📬 Новый отклик на вакансию!`,
              '',
              app.name ? `👤 ${app.name}` : '👤 (имя не указано)',
              `📧 ${app.email}`,
              `📞 ${app.phone}`,
              app.telegram ? `✈️ ${app.telegram}` : null,
              app.message ? `\n💬 ${app.message.slice(0, 300)}` : null,
            ].filter(Boolean).join('\n');
            const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
            fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              signal: AbortSignal.timeout(8000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: notifLines }),
            }).catch(e => console.error('[apply] tg notify error:', e.message));
          }

          return applyJson(200, { ok: true });
        } catch (e) {
          console.error('[apply] store error:', e.message);
          return applyJson(500, { error: 'failed to store application' });
        }
      }

      // ── Auth: everything below requires Bearer AGENT_SECRET ─────────────
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${secrets.AGENT_SECRET}`) {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      // POST /vacancy/store — receive and persist a vacancy landing page HTML from GCP
      if (req.method === 'POST' && url.pathname === '/vacancy/store') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        const { username, vacancyId, html } = body || {};
        if (!username || !vacancyId || !html) return json(res, 400, { error: 'missing fields' });
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username) || !/^[a-zA-Z0-9_-]{1,64}$/.test(vacancyId)) {
          return json(res, 400, { error: 'invalid username or vacancyId' });
        }
        const draftsDir = workspacePath(username, 'vacancy-drafts');
        fs.mkdirSync(draftsDir, { recursive: true });
        fs.writeFileSync(path.join(draftsDir, `${vacancyId}.html`), html, 'utf8');
        const pageUrl = `https://platform.recruiter-assistant.ru/vacancy/${username}/${vacancyId}`;
        return json(res, 200, { ok: true, url: pageUrl });
      }

      // GET /capabilities?userId=XXX — kept for structural parity with the
      // pre-migration server.js (issue #1288 dependency inventory), but this
      // service holds no per-user token directories or MCP tools any more —
      // always reports empty. The bot's RU-routing decision is now GCP-only
      // (tg-bot follow-up, see PR description); this route is not the source
      // of truth for that any more.
      if (req.method === 'GET' && url.pathname === '/capabilities') {
        const userId = url.searchParams.get('userId') || '';
        if (!userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) return json(res, 400, { error: 'invalid userId' });
        return json(res, 200, { capabilities: [], skills: [], upsell_text: '' });
      }

      // POST /playwright-fetch — run headless Playwright on this VM and return page content.
      // Used by the ru_browser_fetch/ru_browser_screenshot MCP skills so GCP
      // sessions can fetch RU-geo-blocked pages.
      if (req.method === 'POST' && url.pathname === '/playwright-fetch') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'bad json' }); }

        const { url: targetUrl, selector, waitFor, script, screenshot } = body || {};
        if (!targetUrl || typeof targetUrl !== 'string') return json(res, 400, { error: 'url required' });

        const { chromium } = require('playwright');
        let browser;
        try {
          browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          });
          const page = await context.newPage();
          await page.goto(targetUrl, { waitUntil: waitFor || 'domcontentloaded', timeout: 30000 });

          const title = await page.title();
          let text = null, scriptResult = null, screenshotB64 = null;

          if (script) {
            scriptResult = await page.evaluate(script);
          }
          if (screenshot) {
            const buf = await page.screenshot({ type: 'png', fullPage: false });
            screenshotB64 = buf.toString('base64');
          }
          if (selector) {
            const el = await page.$(selector);
            text = el ? await el.innerText() : null;
          } else if (!screenshot) {
            text = await page.innerText('body');
          }

          console.log(`[playwright-fetch] ok url=${targetUrl} title="${title}"`);
          return json(res, 200, { ok: true, url: targetUrl, title, text, scriptResult, screenshot: screenshotB64 });
        } catch (e) {
          console.error('[playwright-fetch] error:', e.message);
          return json(res, 500, { error: 'playwright_failed', message: e.message });
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      }

      // POST /nalog/start-login — GCP delegates a nalog.ru login attempt here
      // (auto re-login using saved nalog-creds, or the ZeroCreds nalog-creds
      // onboarding flow). Runs Playwright synchronously; browser login can take
      // 30-60s. Returns the same shape startNalogLogin() always has:
      // {status:'ok', expires} | {status:'need_code', sessionId} | {error}.
      // On 'need_code' the browser session stays alive here — the user then
      // opens /connect/nalog/code (this service, same process) directly.
      if (req.method === 'POST' && url.pathname === '/nalog/start-login') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        const { userId, login, password } = body || {};
        if (!userId || !login || !password) return json(res, 400, { error: 'missing fields' });
        const result = await startNalogLogin(String(userId), login, password);
        return json(res, 200, result);
      }

      // POST /nalog-api-relay — generic RU-IP egress for the lknpd.nalog.ru API
      // (used by src/mcp-skills/tools/10-nalog.js from GCP — nalog_get_profile,
      // nalog_get_incomes, nalog_create_receipt, nalog_refresh_token all call
      // lknpd.nalog.ru directly, which is geo-blocked outside Russia same as
      // ESIA). Forwards {path, method, body, token} to lknpd.nalog.ru/api/v1
      // and returns its response verbatim (status + JSON body).
      if (req.method === 'POST' && url.pathname === '/nalog-api-relay') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
        const { path: apiPath, method = 'GET', body: apiBody, token } = body || {};
        if (!apiPath || typeof apiPath !== 'string' || !apiPath.startsWith('/')) return json(res, 400, { error: 'invalid path' });
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const relayRes = await fetch(`https://lknpd.nalog.ru/api/v1${apiPath}`, {
            method,
            headers,
            body: apiBody ? JSON.stringify(apiBody) : undefined,
            signal: AbortSignal.timeout(20_000),
          });
          const data = await relayRes.json().catch(() => ({}));
          return json(res, relayRes.status, data);
        } catch (e) {
          return json(res, 502, { error: 'relay_failed', message: e.message });
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[ru-edge] unhandled error:', err);
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'internal server error' }));
    }
  });

  server.listen(PORT, () => {
    console.log(`ru-edge listening on :${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    try { closeNalogSessions(); } catch {}
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch(e => {
  console.error('[ru-edge] fatal startup error:', e);
  process.exit(1);
});
