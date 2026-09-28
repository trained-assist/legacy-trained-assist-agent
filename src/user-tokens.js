const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { tokensRoot, userTokensDir } = require('./data-paths');

const TOKENS_ROOT = tokensRoot();
const CONNECT_PENDING_DIR = path.join(os.homedir(), 'connect-pending');

// Files whose values have a reviewed engine-facing contract. Everything else
// (credentials, browser state, cookies, passwords, and future files) is
// server-side only and is deliberately excluded by loadUserTokens().
const ENGINE_TOKEN_FILES = new Set([
  'github', 'figma', 'notion', 'linear', 'dadata', 'weeek', 'gdrive', 'nalog',
]);
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '');

const ZEROCREDS_URL = (process.env.ZEROCREDS_URL || 'https://zerocreds.ru').replace(/\/$/, '');
const ZEROCREDS_ADMIN_TOKEN = process.env.ZEROCREDS_ADMIN_TOKEN || '';

// Form schemas for services migrated to ZeroCreds.
// Services absent from this map (nalog, hh, gdrive) fall back to the legacy /connect/:service path.
const SERVICE_FORM_SCHEMA = {
  github: {
    title: 'Подключить GitHub',
    description: 'github.com/settings/tokens → Generate new token (classic) → repo, read:org',
    fields: [
      { name: 'value', label: 'GitHub Token', type: 'password',
        placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx', required: true, level: 'secret' },
    ],
  },
  figma: {
    title: 'Подключить Figma',
    description: 'Figma → Account Settings → Personal Access Tokens → Create new token',
    fields: [
      { name: 'value', label: 'Figma Token', type: 'password', required: true, level: 'secret' },
    ],
  },
  notion: {
    title: 'Подключить Notion',
    description: 'notion.so/my-integrations → New integration → Copy token',
    fields: [
      { name: 'value', label: 'Notion Token', type: 'password',
        placeholder: 'secret_...', required: true, level: 'secret' },
    ],
  },
  linear: {
    title: 'Подключить Linear',
    description: 'Linear → Settings → API → Personal API keys → Create key',
    fields: [
      { name: 'value', label: 'Linear API Key', type: 'password', required: true, level: 'secret' },
    ],
  },
  dadata: {
    title: 'Подключить DaData',
    description: 'dadata.ru → Profile → API Keys',
    fields: [
      { name: 'value', label: 'DaData API Key', type: 'password', required: true, level: 'secret' },
    ],
  },
  'tilda-session': {
    title: 'Подключить Tilda (cookie)',
    description: 'Откройте tilda.cc в браузере → F12 → Application → Cookies → скопируйте всю строку',
    fields: [
      { name: 'value', label: 'Cookie строка', type: 'textarea',
        placeholder: 'tilda_uid=...; tilda_hash=...', required: true, level: 'secret' },
    ],
  },
  'tilda-creds': {
    title: 'Подключить Tilda (логин)',
    description: 'Введите логин и пароль от вашего аккаунта Tilda.',
    fields: [
      { name: 'email',    label: 'Email',   type: 'email',    required: true,  level: 'pii' },
      { name: 'password', label: 'Пароль',  type: 'password', required: true,  level: 'secret' },
    ],
  },
  weeek: {
    title: 'Подключить Weeek CRM',
    description: 'Weeek → Settings → Integrations → API → Generate token. Логин+пароль необязательны — нужны только для добавления комментариев к сделкам.',
    fields: [
      { name: 'value',    label: 'API токен',                        type: 'password', placeholder: 'Вставьте API токен', required: true,  level: 'secret' },
      { name: 'email',    label: 'Email / логин (необязательно)',    type: 'email',    required: false, level: 'pii' },
      { name: 'password', label: 'Пароль (необязательно)',           type: 'password', required: false, level: 'secret' },
    ],
  },
  getcourse: {
    title: 'Подключить GetCourse',
    description: 'Данные не попадают в чат — форма отправляет их напрямую на сервер.',
    fields: [
      { name: 'domain',   label: 'Домен аккаунта',              type: 'text',     placeholder: 'myschool.getcourse.ru', required: true,  level: 'pii' },
      { name: 'apiKey',   label: 'API ключ (необязательно)',     type: 'password', required: false, level: 'secret' },
      { name: 'login',    label: 'Логин (необязательно)',        type: 'email',    required: false, level: 'pii' },
      { name: 'password', label: 'Пароль (необязательно)',       type: 'password', required: false, level: 'secret' },
    ],
  },
  cloudflare: {
    title: 'Подключить свой Cloudflare',
    description: 'Необязательно: без него сайты публикуются в общий аккаунт. dash.cloudflare.com → My Profile → API Tokens → Create Token → шаблон «Edit Cloudflare Workers» или право Account · Cloudflare Pages · Edit.',
    fields: [
      { name: 'value',      label: 'API токен',  type: 'password', required: true,  level: 'secret' },
      { name: 'account_id', label: 'Account ID (необязательно)', type: 'text', required: false, level: 'pii' },
    ],
  },
  'nalog-creds': {
    title: 'Налог.ру — войти через Госуслуги',
    description: 'Данные не попадают в чат — форма отправляет их напрямую на сервер. Ассистент войдёт автоматически и сохранит сессию.',
    fields: [
      { name: 'login',    label: 'Логин Госуслуг (телефон, email или СНИЛС)', type: 'text',     required: true },
      { name: 'password', label: 'Пароль Госуслуг',                           type: 'password', required: true },
    ],
  },
};

const LOG_FILES = new Set(['.secrets_log', 'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json', '.chatid']); // internal state files, not credentials

const SERVICE_DISPLAY = {
  github:          'GitHub',
  weeek:           'Weeek CRM',
  nalog:           'Налог.ру (НПД)',
  'nalog-creds':   'Налог.ру (Госуслуги логин)',
  figma:           'Figma',
  notion:          'Notion',
  linear:          'Linear',
  tilda:           'Tilda',
  'tilda-session': 'Tilda (сессия)',
  'tilda-creds':   'Tilda (логин)',
  dadata:          'DaData',
  gdrive:          'Google Drive',
  cloudflare:      'Cloudflare (свой)',
  hh:              'HeadHunter',
  site:            'Сайт (авто-логин)',
};

function tokensDir(userId) {
  return userTokensDir(userId);
}

// Parses credential files ({"value":...}, {"access_token":...}, plain string).
// Shared single source of truth so every reader agrees on the format.
const { readTokenValue } = require('./token-value');
// Encrypted-at-rest credential store (epic #1789 P0 C4). Decryption happens
// INSIDE these read helpers — callers keep reading plain strings.
const { readCredentialFile, deleteCredential, isMetaSidecar, removeFromIndex } = require('./credential-store');

function appendSecretsLog(userId, services) {
  try {
    const line = `${new Date().toISOString()}\t${services.join(',')}\n`;
    fs.appendFileSync(path.join(tokensDir(userId), '.secrets_log'), line, { mode: 0o600 });
  } catch (e) { console.warn('[user-tokens] appendSecretsLog:', e.message); }
}

function loadUserTokens(userId, legacyChatId) {
  // userId is now a username (e.g. "efi"), legacyChatId is the current group chatId for migration hint.
  // If the username folder is empty, try to migrate from any chatId folder that has tokens.
  // Priority: 1) the supplied legacyChatId, 2) any other chatId-like folder (negative integer).
  const userDir = tokensDir(userId);
  const userHasFiles = () => fs.existsSync(userDir) &&
    fs.readdirSync(userDir).filter(f => !LOG_FILES.has(f) && !f.startsWith('.')).length > 0;

  if (!userHasFiles()) {
    // Build candidate list: supplied chatId first, then scan for other chatId-like dirs
    const candidates = [];
    if (legacyChatId && String(legacyChatId) !== String(userId)) candidates.push(String(legacyChatId));
    try {
      for (const name of fs.readdirSync(TOKENS_ROOT)) {
        if (/^-?\d+$/.test(name) && name !== String(legacyChatId)) candidates.push(name);
      }
    } catch (e) { console.warn('[user-tokens] readdir TOKENS_ROOT:', e.message); }

    for (const candidate of candidates) {
      const legacyDir = userTokensDir(candidate);
      if (!fs.existsSync(legacyDir)) continue;
      const hasContent = fs.readdirSync(legacyDir).filter(f => !LOG_FILES.has(f) && !f.startsWith('.')).length > 0;
      if (!hasContent) continue;
      // Check if this folder's .username marker matches (skip if it belongs to someone else)
      const markerFile = path.join(legacyDir, '.username');
      if (fs.existsSync(markerFile)) {
        const owner = fs.readFileSync(markerFile, 'utf8').trim();
        if (owner && owner !== String(userId)) continue; // belongs to a different user
      } else if (candidate !== String(legacyChatId)) {
        // No ownership marker and not the exact legacyChatId for this connection — skip to avoid
        // cross-contaminating tokens from unrelated accounts (e.g. old test sessions).
        continue;
      }
      fs.mkdirSync(userDir, { recursive: true });
      for (const file of fs.readdirSync(legacyDir)) {
        if (LOG_FILES.has(file) || file.startsWith('.')) continue;
        try {
          const src = path.join(legacyDir, file);
          const dst = path.join(userDir, file);
          if (!fs.existsSync(dst)) {
            if (fs.statSync(src).isDirectory()) {
              fs.cpSync(src, dst, { recursive: true });
            } else {
              fs.copyFileSync(src, dst);
            }
          }
        } catch (e) { console.warn('[user-tokens] migrate file:', e.message); }
      }
      console.log(`[user-tokens] migrated tokens from chatId=${candidate} → username=${userId}`);
      break; // stop after first successful migration
    }
  }

  const dir = tokensDir(userId);
  const extra = {};
  if (!fs.existsSync(dir)) return extra;
  const accessed = [];
  for (const file of fs.readdirSync(dir)) {
    if (LOG_FILES.has(file) || isMetaSidecar(file)) continue;
    const filePath = path.join(dir, file);
    try { if (fs.statSync(filePath).isDirectory()) continue; } catch { continue; }
    let val;
    try { val = readCredentialFile(filePath).trim(); }
    catch (e) { console.warn('[user-tokens] readFileSync race:', e.message); continue; } // file deleted between readdirSync and readFileSync — skip
    const label = file.toLowerCase();
    accessed.push(label);
    if (!ENGINE_TOKEN_FILES.has(label)) continue;
    if (label === 'github') {
      const tok = readTokenValue(val);
      extra.GH_TOKEN = tok; extra.GITHUB_TOKEN = tok;
    }
    else if (label === 'figma') extra.FIGMA_TOKEN = readTokenValue(val);
    else if (label === 'notion') extra.NOTION_TOKEN = readTokenValue(val);
    else if (label === 'linear') extra.LINEAR_API_KEY = readTokenValue(val);
    else if (label === 'dadata') extra.DADATA_API_TOKEN = readTokenValue(val);
    else if (label === 'weeek') {
      // Supports both plain string (legacy) and zerocreds JSON {value, email?, password?}
      extra.WEEEK_API_TOKEN = readTokenValue(val);
      try {
        const parsed = JSON.parse(val);
        if (parsed.email)    extra.WEEEK_L2_EMAIL    = parsed.email;
        if (parsed.password) extra.WEEEK_L2_PASSWORD = parsed.password;
      } catch { /* plain string — no L2 in this file */ }
    }
    else if (label === 'gdrive') extra.GDRIVE_SA_JSON = val;
    // Used server-side only by site_deploy (src/cf-pages.js); never exported to the engine env.
    else if (label === 'cloudflare') continue;
    else if (label === 'nalog') {
      try {
        const parsed = JSON.parse(val);
        if (parsed.auth_token)    extra.NALOG_TOKEN        = parsed.auth_token;
        if (parsed.refresh_token) extra.NALOG_REFRESH_TOKEN = parsed.refresh_token;
        if (parsed.expires)       extra.NALOG_TOKEN_EXPIRES = parsed.expires;
        if (parsed.device_id)     extra.NALOG_DEVICE_ID     = parsed.device_id;
      } catch { extra.NALOG_TOKEN = val; }
    }
    // Default-deny: unknown profile files remain server-side credentials/state.
  }
  if (accessed.length > 0) appendSecretsLog(userId, accessed);
  return extra;
}

function listConnectedServices(userId) {
  const dir = tokensDir(userId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => {
    if (LOG_FILES.has(f) || isMetaSidecar(f)) return false; // .meta sidecars are not services
    try { return !fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
  });
  if (files.length === 0) return null;
  return files.map(f => {
    const name = SERVICE_DISPLAY[f.toLowerCase()] || f;
    let mtime = new Date(0);
    try { mtime = fs.statSync(path.join(dir, f)).mtime; } catch (e) { console.warn('[user-tokens] statSync race:', e.message); } // race: file deleted between readdirSync and statSync
    return { file: f, name, mtime };
  });
}

function revokeService(userId, serviceName) {
  const dir = tokensDir(userId);
  const ALIASES = {
    hh: 'hh', хх: 'hh', headhunter: 'hh',
    github: 'github', гитхаб: 'github',
    weeek: 'weeek', вик: 'weeek',
    nalog: 'nalog', налог: 'nalog', нпд: 'nalog', самозан: 'nalog',
    figma: 'figma', фигма: 'figma',
    notion: 'notion',
    linear: 'linear',
    tilda: 'tilda', тильда: 'tilda',
    // 'tilda-creds' → stripped of dash → 'tildacreds'
    'tilda-creds': 'tilda-creds', tildacreds: 'tilda-creds', тильдакред: 'tilda-creds',
    getcourse: 'getcourse', геткурс: 'getcourse',
    gdrive: 'gdrive', гугл: 'gdrive', google: 'gdrive',
    dadata: 'dadata',
  };
  const key = ALIASES[serviceName.toLowerCase().replace(/[^a-zа-яё]/gi, '')];
  if (!key) return null;

  const filePath = path.join(dir, key);
  if (!fs.existsSync(filePath)) return 'not_found';
  try {
    if (fs.statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
      removeFromIndex(userId, key); // dir-backed service (getcourse/) — no single file to delete
    } else {
      deleteCredential(userId, key); // file + .meta sidecar + .index.json entry
    }
  } catch (e) { console.warn('[user-tokens] revokeService unlink:', e.message); return 'not_found'; }
  appendSecretsLog(userId, [`revoke:${key}`]);
  return key;
}

function getSecretsLog(userId) {
  const logPath = path.join(tokensDir(userId), '.secrets_log');
  if (!fs.existsSync(logPath)) return null;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-20).reverse();
}

async function generateConnectLink(userId, service, inlineSchema) {
  const schema = inlineSchema || SERVICE_FORM_SCHEMA[service];
  const agentSecret = process.env.AGENT_SECRET || '';

  if (ZEROCREDS_URL && ZEROCREDS_ADMIN_TOKEN && schema) {
    try {
      const body = {
        title: schema.title,
        description: schema.description,
        fields: schema.fields,
        destination: {
          type: 'http_post',
          url: `${AGENT_PUBLIC_URL}/tokens?userId=${encodeURIComponent(userId)}&label=${encodeURIComponent(service)}`,
          headers: { 'Authorization': `Bearer ${agentSecret}` },
          body: { value: '{fields_json}' },
        },
        ttl_minutes: 30,
        uid: String(userId),
        service,
      };
      const resp = await fetch(`${ZEROCREDS_URL}/api/session/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZEROCREDS_ADMIN_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`zerocreds HTTP ${resp.status}: ${await resp.text()}`);
      const { url, reused } = await resp.json();
      console.log('[user-tokens] zerocreds link for service=%s uid=%s reused=%s', service, userId, !!reused);
      return url;
    } catch (e) {
      console.warn('[user-tokens] zerocreds unavailable (%s), falling back to legacy', e.message);
    }
  }

  // Legacy path: local connect-pending token + /connect/:service on this server.
  // Carry the schema along so the generic multi-field renderer in server.js can
  // still serve a real form for services with no dedicated handler (e.g. anything
  // created via credentials_form_create) — without it, unknown services 404.
  return generateLegacyConnectLink(userId, service, schema);
}

function generateLegacyConnectLink(userId, service, schema) {
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(CONNECT_PENDING_DIR, { recursive: true });
  const pending = { uid: String(userId), service, expires: Date.now() + 30 * 60 * 1000 };
  if (schema) pending.schema = schema;
  fs.writeFileSync(
    path.join(CONNECT_PENDING_DIR, `${token}.json`),
    JSON.stringify(pending),
    { mode: 0o600 }
  );
  return `${AGENT_PUBLIC_URL}/connect/${service}?t=${token}`;
}

/**
 * Validates and consumes a connect-pending token.
 * Returns the pending data on success, or null on failure (invalid, expired, or unreadable).
 * Deletes the pending file on success (one-time use).
 */
function receiveConnect(t) {
  if (!t || !/^[a-f0-9]{32}$/.test(t)) return null;
  const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
  let pending;
  try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { return null; }
  if (!pending || Date.now() > pending.expires) return null;
  try { fs.unlinkSync(pendingFile); } catch {}
  return pending;
}

/**
 * Reads a connect-pending token WITHOUT consuming it.
 * Returns the parsed pending object, or null if the token is malformed/unreadable.
 * Caller is responsible for expiry + service checks; nothing is deleted.
 */
function readConnectPending(t) {
  if (!t || !/^[a-f0-9]{32}$/.test(t)) return null;
  const pendingFile = path.join(CONNECT_PENDING_DIR, `${t}.json`);
  try { return JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { return null; }
}

/**
 * Deletes a connect-pending token file. Returns true if a token file existed and was removed,
 * false if the token is malformed or the file was already gone (e.g. consumed concurrently).
 */
function consumeConnectPending(t) {
  if (!t || !/^[a-f0-9]{32}$/.test(t)) return false;
  try { fs.unlinkSync(path.join(CONNECT_PENDING_DIR, `${t}.json`)); return true; } catch { return false; }
}

module.exports = {
  loadUserTokens,
  listConnectedServices,
  revokeService,
  getSecretsLog,
  generateConnectLink,
  generateLegacyConnectLink,
  readTokenValue,
  receiveConnect,
  readConnectPending,
  consumeConnectPending,
  SERVICE_DISPLAY,
  SERVICE_FORM_SCHEMA,
};
