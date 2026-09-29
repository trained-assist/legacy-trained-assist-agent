'use strict';

// Browser Session skill
// Manages a persistent remote Chrome browser on the GCP VM (Xvfb + noVNC).
// Lets the user log into any site manually (handles CAPTCHAs, IP-binding, etc.)
// then captures cookies via CDP for use by other skills (Tilda, etc.)
//
// Architecture: Xvfb :99 → Chrome (CDP :9224) → x11vnc :5900 → websockify :6080 → nginx /browser/
// All processes run as persistent systemd services on the VM.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { readCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';

// URL where nginx proxies noVNC (set in BROWSER_SESSION_URL env or default)
const BROWSER_SESSION_URL = process.env.BROWSER_SESSION_URL
  || 'https://136-65-7-197.sslip.io/browser/';

// Pending login tokens dir — login-server reads these to validate uid+token pairs
const PENDING_DIR = path.join(os.homedir(), 'browser-session', 'pending');

function generateLoginLink(userId, domain) {
  const token = require('crypto').randomBytes(12).toString('hex');
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const expires = Date.now() + 30 * 60 * 1000; // 30 min
  fs.writeFileSync(
    path.join(PENDING_DIR, `${token}.json`),
    JSON.stringify({ uid: String(userId), domain, expires })
  );
  // Cleanup expired tokens while we're here
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(PENDING_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
        if (d.expires < now) fs.unlinkSync(path.join(PENDING_DIR, f));
      } catch {}
    }
  } catch {}
  return `${BROWSER_SESSION_URL}?uid=${encodeURIComponent(userId)}&token=${token}`;
}

// CDP endpoint for the persistent Chrome
// login.js runs from the release this module ships in, so a merged fix is live on the
// next deploy. It used to run a hand-copied ~/browser-session/login.js that nothing
// deployed (setup.sh never copied it) and that silently drifted from the repo (#1866).
// Shared with login-server.js so both executable paths stay on the same file (#1875).
const { resolveShipped } = require('../../../infra/browser-session/script-paths');
function loginScriptPath() {
  return resolveShipped('login.js');
}

const CDP_PORT = 9224;

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenDir(userId) {
  return path.join(os.homedir(), 'agent-tokens', String(userId || USER_ID));
}

function isChromeRunning() {
  try {
    execSync(`curl -sf http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Cookie capture via CDP ────────────────────────────────────────────────────
// Uses a subprocess so process.exit() doesn't close the browser's CDP connection.

async function captureCookiesViaScript(domain, outputPath) {
  const scriptPath = path.join(os.homedir(), 'browser-session', 'capture-cookies.js');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`capture-cookies.js not found at ${scriptPath}`);
  }
  const result = execFileSync(
    process.execPath, [scriptPath, domain, outputPath],
    { timeout: 25000, encoding: 'utf8' }
  );
  return result.trim();
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'browser_session_status',
    description: 'Check if the remote noVNC browser is running. Use only for IP-bound sites (Tilda). ' +
      'For regular email+password sites use credentials_form_create instead.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const running = isChromeRunning();
      return {
        running,
        url: BROWSER_SESSION_URL,
        instructions: running
          ? `Браузер запущен. Открой: ${BROWSER_SESSION_URL}\n\n⏳ После открытия подожди 10–15 секунд — страница входа загружается автоматически.\n\nЗалогинься, потом вызови browser_session_capture_cookies.`
          : 'Браузер не запущен. Запусти сервисы: sudo systemctl start xvfb-browser chrome-browser vnc-browser novnc-browser',
      };
    },
  },

  {
    name: 'browser_session_url',
    description: 'Generate a noVNC browser URL for sites that REQUIRE IP-bound sessions or hardware tokens (e.g. Tilda.cc). ' +
      'DO NOT use for regular sites with email+password login — use credentials_form_create instead, it is safer and simpler. ' +
      'noVNC requires the user to manually type credentials in a remote browser window.',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Telegram user ID' },
        domain:  { type: 'string', description: 'Domain to capture after login, e.g. "tilda.ru"', default: 'tilda.ru' },
      },
      required: ['user_id'],
    },
    handler: async ({ user_id, domain = 'tilda.ru' }) => {
      const running = isChromeRunning();
      if (!running) {
        return { error: 'browser_not_running', message: 'Remote browser is not running.' };
      }
      const url = generateLoginLink(user_id, domain);
      return {
        url,
        message: `Открой ссылку для входа в ${domain}:\n${url}\n\nПосле ввода логина и пароля страница сама всё сохранит и скажет "Готово".`,
      };
    },
  },

  {
    name: 'browser_session_evaluate',
    description: 'Execute JavaScript in the remote browser\'s current page using the browser\'s authenticated session. ' +
      'Use this AFTER browser_session_autologin to interact with the site without capturing cookies: ' +
      'click buttons, read data, call APIs (fetch() uses session cookies automatically), bulk-update records. ' +
      'The script runs in page context with full access to auth, localStorage, DOM. ' +
      'Return a value from the script to get it back. Async scripts are awaited (use async IIFE pattern).',
    inputSchema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript to run in the page. ' +
            'Simple expression: "document.title". ' +
            'Async IIFE (recommended): "(async () => { const r = await fetch(\'/api/videos\'); return r.json(); })()"',
        },
        navigate_to: {
          type: 'string',
          description: 'Optional: navigate to this URL before running the script.',
        },
      },
      required: ['script'],
    },
    handler: async ({ script, navigate_to } = {}) => {
      if (!isChromeRunning()) return { error: 'browser_not_running' };
      const scriptPath = path.join(os.homedir(), 'browser-session', 'evaluate.js');
      if (!fs.existsSync(scriptPath)) return { error: 'evaluate.js not found on VM — deploy infra/browser-session/evaluate.js' };

      const env = { ...process.env, EVAL_SCRIPT: script };
      if (navigate_to) env.EVAL_URL = navigate_to;

      try {
        const result = execSync(`node "${scriptPath}"`, {
          timeout: 50000,
          encoding: 'utf8',
          env,
        });
        return JSON.parse(result.trim());
      } catch (e) {
        return { error: 'evaluate_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_capture_cookies',
    description: 'Capture cookies for Tilda.cc (IP-bound sessions) ONLY. ' +
      'Do NOT use for regular sites after autologin — use browser_session_evaluate instead to interact with the page directly.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain to capture cookies for, e.g. "tilda.ru"',
        },
        label: {
          type: 'string',
          description: 'Token label (filename). E.g. "tilda-session". Defaults to "<domain>-session".',
        },
        user_id: {
          type: 'string',
          description: 'User ID (optional, defaults to current session user)',
        },
      },
      required: ['domain'],
    },
    handler: async ({ domain, label, user_id }) => {
      const uid = user_id || USER_ID;
      if (!uid) return { error: 'No user_id' };
      if (!isChromeRunning()) {
        return { error: 'browser_not_running', message: 'Remote browser is not running.' };
      }

      const tokenLabel = label || `${domain.replace(/\./g, '-')}-session`;
      const outPath = path.join(tokenDir(uid), tokenLabel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      try {
        const output = await captureCookiesViaScript(domain, outPath);
        const content = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim() : '';
        if (!content) {
          return { error: 'no_cookies', message: `No cookies found for ${domain}. Make sure you are logged in.` };
        }
        const cookieCount = content.split(';').length;
        return {
          ok: true,
          domain,
          label: tokenLabel,
          cookies_captured: cookieCount,
          saved_to: outPath,
          output,
        };
      } catch (e) {
        return { error: 'capture_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_autologin',
    description: 'Log into a site using stored credentials — credentials never pass through Claude context. ' +
      'Requires credentials saved via credentials_form_create first. ' +
      'After successful login: use browser_session_evaluate to interact with the page (call APIs, read data, automate UI) — ' +
      'the browser is already authenticated so fetch() calls use session cookies automatically. ' +
      'Do NOT call browser_session_capture_cookies after this unless the site is IP-bound (Tilda). ' +
      'Returns login result or instructions if no stored credentials found.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Credential store key, e.g. "kinescope-creds", "tilda-creds". Defaults to "tilda-creds".',
          default: 'tilda-creds',
        },
        login_url: {
          type: 'string',
          description: 'URL of the login page to navigate to before filling credentials. ' +
            'Required for non-Tilda services. E.g. "https://app.kinescope.io/login".',
        },
        user_id: { type: 'string', description: 'User ID (optional, defaults to current session user)' },
      },
    },
    handler: async ({ service = 'tilda-creds', login_url, user_id } = {}) => {
      const uid = user_id || USER_ID;
      if (!uid) return { error: 'No user_id' };

      const credsFile = path.join(os.homedir(), 'agent-tokens', String(uid), service);
      if (!fs.existsSync(credsFile)) {
        return {
          error: 'no_credentials',
          message: `No stored credentials for "${service}". Use credentials_form_create to generate a secure link for the user to enter their credentials.`,
        };
      }

      let creds;
      try { creds = JSON.parse(readCredentialFile(credsFile)); }
      catch { return { error: 'invalid_credentials_file', message: `Could not read credentials for "${service}".` }; }

      if (!creds.email || !creds.password) {
        return { error: 'incomplete_credentials', message: `Credentials for "${service}" are incomplete (need email + password). Ask the user to update them via credentials_form_create.` };
      }

      if (!isChromeRunning()) return { error: 'browser_not_running' };
      const scriptPath = loginScriptPath();
      if (!fs.existsSync(scriptPath)) return { error: 'login.js not found on VM' };

      const env = { ...process.env, LOGIN_EMAIL: creds.email, LOGIN_PASSWORD: creds.password };
      if (login_url) env.LOGIN_URL = login_url;

      try {
        const result = execSync(`node "${scriptPath}"`, {
          timeout: 60000,
          encoding: 'utf8',
          env,
        });
        const data = JSON.parse(result.trim());
        if (data.google_redirect) {
          data.message = `Аккаунт зарегистрирован через Google — email+пароль не работает.\n\nЧтобы войти, открой браузер и залогинься через Google:\n${BROWSER_SESSION_URL}\n\nПосле входа в дашборд напиши «готово».`;
        } else if (data.captcha) {
          data.message = `Появилась CAPTCHA — открой браузер и пройди её вручную: ${BROWSER_SESSION_URL}`;
        } else if (data.two_factor) {
          data.message = `Нужен код 2FA — введи его в браузере: ${BROWSER_SESSION_URL}`;
        } else if (data.error_on_page) {
          data.message = `Неверный логин или пароль — попроси пользователя обновить данные через credentials_form_create с service="${service}".`;
        } else if (data.already_logged_in) {
          data.message = 'Уже залогинен. Вызови browser_session_capture_cookies чтобы сохранить сессию.';
        } else if (data.ok) {
          data.message = 'Успешно залогинился. Теперь вызови browser_session_capture_cookies.';
        } else if (!data.error) {
          // Never report success without evidence (#1866): the form is still on screen.
          data.message = `Вход не подтверждён — форма входа всё ещё на экране. Проверь в браузере: ${BROWSER_SESSION_URL}`;
        }
        return data;
      } catch (e) {
        return { error: 'login_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_login',
    description: 'Fill and submit a login form in the remote browser (already open at the login page). Use when the user provides their credentials. Returns whether login succeeded, or whether CAPTCHA/2FA appeared and the user needs to handle it via VNC.',
    inputSchema: {
      type: 'object',
      properties: {
        email:    { type: 'string', description: 'Email or username' },
        password: { type: 'string', description: 'Password' },
      },
      required: ['email', 'password'],
    },
    handler: async ({ email, password }) => {
      if (!isChromeRunning()) return { error: 'browser_not_running' };
      const scriptPath = loginScriptPath();
      if (!fs.existsSync(scriptPath)) return { error: 'login.js not found on VM' };
      try {
        const result = execSync(`node "${scriptPath}"`, {
          timeout: 60000,
          encoding: 'utf8',
          env: { ...process.env, LOGIN_EMAIL: email, LOGIN_PASSWORD: password },
        });
        const data = JSON.parse(result.trim());
        if (data.captcha) {
          data.message = `Появилась CAPTCHA — открой браузер и пройди её вручную: ${BROWSER_SESSION_URL}`;
        } else if (data.two_factor) {
          data.message = `Нужен код 2FA — введи его в браузере: ${BROWSER_SESSION_URL}`;
        } else if (data.error_on_page) {
          data.message = 'Неверный логин или пароль — проверь данные.';
        } else if (data.ok) {
          data.message = 'Успешно залогинился. Теперь вызови browser_session_capture_cookies.';
        } else if (!data.error) {
          // Never report success without evidence (#1866): the form is still on screen.
          data.message = `Вход не подтверждён — форма входа всё ещё на экране. Проверь в браузере: ${BROWSER_SESSION_URL}`;
        }
        return data;
      } catch (e) {
        return { error: 'login_failed', message: e.message };
      }
    },
  },

  {
    name: 'browser_session_navigate',
    description: 'Navigate the remote browser to a URL (via CDP). Useful to open the right login page before asking user to interact.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
    handler: async ({ url }) => {
      if (!isChromeRunning()) {
        return { error: 'browser_not_running' };
      }
      try {
        // Get first page target
        const listRes = execSync(
          `curl -sf http://127.0.0.1:${CDP_PORT}/json`,
          { timeout: 5000, encoding: 'utf8' }
        );
        const targets = JSON.parse(listRes);
        const page = targets.find(t => t.type === 'page');
        if (!page) return { error: 'no_page_target' };

        // Navigate via CDP activate + navigate endpoint (simple HTTP approach)
        // Use execFileSync to avoid shell injection via page.id from CDP response
        execFileSync('curl', ['-sf', `http://127.0.0.1:${CDP_PORT}/json/activate/${page.id}`],
          { timeout: 3000 });
        // Use node to send CDP command (no ws module needed — use native approach)
        const navScript = path.join(os.homedir(), 'browser-session', 'navigate.js');
        if (fs.existsSync(navScript)) {
          execFileSync(process.execPath, [navScript, url], { timeout: 10000 });
        }
        return { ok: true, navigated_to: url };
      } catch (e) {
        return { error: 'navigate_failed', message: e.message };
      }
    },
  },
];

module.exports = { tools: Object.fromEntries(tools.map(t => [t.name, t])) };
