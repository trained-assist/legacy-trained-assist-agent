const crypto = require('crypto');
const { writeCredential, readCredentialFile } = require('./credential-store');

const PASSWD_FILE = '.webpasswd';
const TOKEN_COOKIE = 'web_token';
const TOKEN_COOKIE_PREFIX = 'web_token_';  // per-profile: web_token_<username>
const CURRENT_PROFILE_COOKIE = 'web_current';  // non-httpOnly, readable by JS
const JWT_EXP_MS = 24 * 60 * 60 * 1000;
const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000;  // 15 minutes

// ── Magic token store (in-memory, short-lived) ────────────────────────────────
// Map<token: string, {username: string, exp: number}>
const magicTokenStore = new Map();

// Sweep expired tokens occasionally (every login attempt)
function sweepExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of magicTokenStore) {
    if (entry.exp < now) magicTokenStore.delete(token);
  }
}

function generateMagicToken(username) {
  sweepExpiredTokens();
  const token = crypto.randomBytes(32).toString('hex');
  magicTokenStore.set(token, { username, exp: Date.now() + MAGIC_TOKEN_TTL_MS });
  return token;
}

function consumeMagicToken(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = magicTokenStore.get(token);
  if (!entry) return null;
  magicTokenStore.delete(token);  // one-use
  if (entry.exp < Date.now()) return null;
  return entry.username;
}

// ── Scrypt password hashing ───────────────────────────────────────────────────

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
  } catch {
    return false;
  }
}

// ── Minimal JWT (HMAC-SHA256, no external deps) ───────────────────────────────

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(username, secret) {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({ sub: username, exp: Date.now() + JWT_EXP_MS })));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function verifyJwt(token, secret) {
  try {
    const [header, payload, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data.sub;
  } catch {
    return null;
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

function setTokenCookie(res, token, username) {
  const cookies = [
    // Per-profile httpOnly cookie (new scheme)
    username
      ? `${TOKEN_COOKIE_PREFIX}${username}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${JWT_EXP_MS / 1000}`
      : `${TOKEN_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${JWT_EXP_MS / 1000}`,
  ];
  if (username) {
    // Non-httpOnly so JS can read it for the profile switcher
    cookies.push(`${CURRENT_PROFILE_COOKIE}=${encodeURIComponent(username)}; Path=/; SameSite=Strict; Max-Age=${JWT_EXP_MS / 1000}`);
  }
  res.setHeader('Set-Cookie', cookies);
}

function clearTokenCookie(res, username) {
  const cookies = [
    `${TOKEN_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
  ];
  if (username) {
    cookies.push(`${TOKEN_COOKIE_PREFIX}${username}=; HttpOnly; Path=/; Max-Age=0`);
    cookies.push(`${CURRENT_PROFILE_COOKIE}=; Path=/; Max-Age=0`);
  }
  res.setHeader('Set-Cookie', cookies);
}

function switchProfileCookie(res, username) {
  res.setHeader('Set-Cookie',
    `${CURRENT_PROFILE_COOKIE}=${encodeURIComponent(username)}; Path=/; SameSite=Strict; Max-Age=${JWT_EXP_MS / 1000}`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function webAuth(req, secret) {
  const cookies = parseCookies(req);

  // New scheme: read active profile from web_current, validate per-profile cookie
  const currentProfile = cookies[CURRENT_PROFILE_COOKIE]
    ? decodeURIComponent(cookies[CURRENT_PROFILE_COOKIE])
    : null;
  if (currentProfile && /^[a-zA-Z0-9_-]{1,64}$/.test(currentProfile)) {
    const profileToken = cookies[`${TOKEN_COOKIE_PREFIX}${currentProfile}`];
    if (profileToken) {
      const sub = verifyJwt(profileToken, secret);
      if (sub) return sub;
    }
  }

  // Fallback: legacy web_token cookie (old logins / password-based)
  const token = cookies[TOKEN_COOKIE];
  if (!token) return null;
  return verifyJwt(token, secret);
}

// Returns all profiles with valid JWTs found in request cookies
function listAuthedProfiles(req, secret) {
  const cookies = parseCookies(req);
  const profiles = [];
  const prefix = TOKEN_COOKIE_PREFIX;
  for (const [name, value] of Object.entries(cookies)) {
    if (!name.startsWith(prefix)) continue;
    const username = name.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) continue;
    const sub = verifyJwt(value, secret);
    if (sub === username) profiles.push(username);
  }
  return profiles;
}

// ── Password file helpers ─────────────────────────────────────────────────────

function passwdPath(username) {
  // data-paths is required per call so a redirected token root (tests) is honored.
  return require('./data-paths').tokenPath(String(username), PASSWD_FILE);
}

function savePassword(username, plain) {
  // .webpasswd is a credential — encrypted at rest like any other (#1789 C4).
  writeCredential(String(username), PASSWD_FILE, hashPassword(plain));
}

function checkPassword(username, plain) {
  try {
    const stored = readCredentialFile(passwdPath(username)).trim();
    return verifyPassword(plain, stored);
  } catch {
    return false;
  }
}

function generatePassword() {
  // 8 chars, alphanumeric, easy to read/type
  return crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, '').slice(0, 8);
}

module.exports = {
  webAuth, signJwt, setTokenCookie, clearTokenCookie, switchProfileCookie,
  savePassword, checkPassword, generatePassword,
  generateMagicToken, consumeMagicToken, listAuthedProfiles,
  CURRENT_PROFILE_COOKIE,
};
