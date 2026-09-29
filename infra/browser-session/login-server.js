'use strict';
// POST /login {email, password, uid, token} → validates pending token, runs login.js, captures cookies.
// Listens on 127.0.0.1:9090, proxied by nginx at /browser-login.

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execFileSync } = require('child_process');
const { resolveShipped } = require('./script-paths');

// Shipped copies (same dir as this file) — never the hand copy in ~/browser-session, which
// nothing deploys and which still reports success on rejected credentials (#1875).
const LOGIN_SCRIPT   = resolveShipped('login.js');
const CAPTURE_SCRIPT = resolveShipped('capture-cookies.js');
const PENDING_DIR    = path.join(os.homedir(), 'browser-session', 'pending');
const ORIGIN         = 'https://136-65-7-197.sslip.io';
const PORT = 9090;
const BODY_LIMIT = 65536; // 64 KB

const TOKEN_RE  = /^[0-9a-f]{24}$/;
const UID_RE    = /^[a-zA-Z0-9_-]{1,50}$/;
const DOMAIN_RE = /^[a-zA-Z0-9.-]{1,253}$/;

// Map domain → token filename so MCP skills can read them by their expected label
const DOMAIN_TO_LABEL = { 'tilda.ru': 'tilda-session' };

function loadPending(token) {
  if (!TOKEN_RE.test(token)) return null;
  try {
    const file = path.join(PENDING_DIR, `${token}.json`);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.expires < Date.now()) { fs.unlinkSync(file); return null; }
    return d;
  } catch { return null; }
}

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > BODY_LIMIT) { req.destroy(); }
    });
    req.on('end', () => {
      let email, password, uid, token;
      try { ({ email, password, uid, token } = JSON.parse(body)); } catch {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'bad json' })); return;
      }

      // Validate and resolve uid+token
      let pending = null;
      if (token) {
        pending = loadPending(token); // TOKEN_RE validated inside
        if (!pending) {
          res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'invalid or expired token' })); return;
        }
        uid = pending.uid; // always from trusted pending file, not request body
      }

      // Validate uid only when it comes from the request body (pending token is already trusted)
      if (!pending && uid && !UID_RE.test(String(uid))) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid uid' })); return;
      }

      try {
        const out = execFileSync(process.execPath, [LOGIN_SCRIPT], {
          timeout: 20000, encoding: 'utf8',
          env: { ...process.env, LOGIN_EMAIL: email, LOGIN_PASSWORD: password },
        });
        const data = JSON.parse(out.trim());

        // Auto-capture cookies on clean success (navigated or already logged in)
        const shouldCapture = (data.navigated || data.already_logged_in) && !data.captcha && !data.two_factor && !data.error_on_page;
        if (shouldCapture) {
          const domain = pending?.domain || 'tilda.ru';
          if (!DOMAIN_RE.test(domain)) {
            data.cookies_captured = false;
            data.cookies_error = 'invalid domain in pending token';
          } else {
            const label  = DOMAIN_TO_LABEL[domain] || domain.replace(/\./g, '-') + '-session';
            const outDir  = uid
              ? path.join(os.homedir(), 'agent-tokens', String(uid))
              : path.join(os.homedir(), 'browser-session');
            const outPath = uid
              ? path.join(outDir, label)
              : path.join(outDir, 'tilda-latest-cookies.txt');

            fs.mkdirSync(outDir, { recursive: true });
            try {
              execFileSync(process.execPath, [CAPTURE_SCRIPT, domain, outPath], { timeout: 25000, encoding: 'utf8' });
              data.cookies_captured = true;
              data.saved_to = outPath;
            } catch (e) {
              data.cookies_captured = false;
              data.cookies_error = e.message;
            }
          }

          // Consume pending token
          if (token) {
            try { fs.unlinkSync(path.join(PENDING_DIR, `${token}.json`)); } catch {}
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.stderr || e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`login-server listening on :${PORT}`));
