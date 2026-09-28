'use strict';
// Encrypted credential store — epic #1789 P0 C4.
// Design: docs/credential-store-migration.md (AES-256-GCM per file, v2 envelope).
//
// Every credential file under TOKENS_ROOT (<username>/<service>) is stored as
//
//     base64( <version_byte=2> || iv[16] || auth_tag[16] || ciphertext )
//
// Legacy plaintext files (no v2 envelope) are still readable — transparent
// passthrough — and are re-encrypted on the next write. When CRED_ENCRYPTION_KEY
// is missing the store degrades to plaintext WITH a warning: never a hard failure.
//
// WHY EVERY READER MUST GO THROUGH HERE: a raw fs.readFileSync on an encrypted
// file returns base64 garbage, and JSON.parse of it silently yields no token.
// Use readCredentialFile()/writeCredentialFile() (or the username/service
// wrappers readCredential()/writeCredential()) at every credential read/write.
//
// Deliberately NOT static: paths are resolved through require('./data-paths') on
// every call, because tests bust that module's require cache to redirect roots.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT_VERSION = 2;
const IV_LEN = 16;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;
// base64 of the 33-byte header (version + iv + tag) with zero-length ciphertext.
const MIN_BLOB_CHARS = Math.ceil(HEADER_LEN / 3) * 4; // 44

const META_SUFFIX = '.meta';
const INDEX_FILE = '.index.json';

// Files in the same tree that are NOT credentials and must stay plaintext
// (routing metadata, audit log, owner marker, cross-user index, caches).
const PLAINTEXT_FILES = new Set([
  '.chatid', '.secrets_log', '.username', INDEX_FILE,
  'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json', 'gdrive-notif-muted',
]);
// Directories whose contents are not credentials (research output, backups).
const PLAINTEXT_DIRS = new Set(['hermes-research']);
// Root-level dirs under TOKENS_ROOT that are not profiles (index bookkeeping).
const NON_PROFILE_ROOTS = new Set(['llm-ladder']);

// ── Master key ────────────────────────────────────────────────────────────────
// 64-char hex → 32 bytes (AES-256). Loaded lazily from process.env on first use
// and then cached — "once at startup" in practice, but late-loading (server.js
// injects it into process.env after loadSecrets) and tests must both work.
let cachedKey = null;
let warnedMissing = false;

function parseKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

function masterKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CRED_ENCRYPTION_KEY;
  const key = parseKey(raw);
  if (key) {
    cachedKey = key;
    return key;
  }
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(raw
      ? '[credential-store] CRED_ENCRYPTION_KEY is set but is not 64 hex chars — credentials stay in PLAINTEXT'
      : '[credential-store] CRED_ENCRYPTION_KEY is not set — credentials stay in PLAINTEXT');
  }
  return null;
}

function hasMasterKey() {
  return !!masterKey();
}

/** Resolved key as lowercase hex (for child-process env, e.g. MCP tool env). */
function masterKeyHex() {
  const key = masterKey();
  return key ? key.toString('hex') : null;
}

/** Test seam: forget the cached key so a changed env is picked up. */
function _resetMasterKey() {
  cachedKey = null;
  warnedMissing = false;
}

// ── Encrypt / decrypt primitives ──────────────────────────────────────────────

/** plaintext → base64 v2 envelope. Throws when no master key is available. */
function encryptFile(plaintext) {
  const key = masterKey();
  if (!key) throw new Error('[credential-store] CRED_ENCRYPTION_KEY not available — cannot encrypt');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const blob = Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  return blob.toString('base64');
}

/** base64 v2 envelope → plaintext. Throws on wrong key / tampering — never garbage. */
function decryptFile(blob) {
  const buf = decodeEnvelope(blob);
  if (!buf) throw new Error('[credential-store] not a v2 credential envelope');
  const key = masterKey();
  if (!key) throw new Error('[credential-store] CRED_ENCRYPTION_KEY not available — cannot decrypt');
  return decryptEnvelope(buf, key);
}

function decryptEnvelope(buf, key) {
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, HEADER_LEN);
  const ciphertext = buf.subarray(HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Structural detection: strict base64 that decodes to a v2 envelope.
 * Deliberately strict (no whitespace, first byte 2) so ordinary tokens, JSON
 * blobs and .chatid-style values can never be mistaken for ciphertext.
 * Returns the decoded Buffer, or null when `raw` is not an envelope.
 */
function decodeEnvelope(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length < MIN_BLOB_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < HEADER_LEN) return null;
  if (buf[0] !== FORMAT_VERSION) return null;
  return buf;
}

function isEncrypted(raw) {
  return !!decodeEnvelope(raw);
}

// ── Path resolution ───────────────────────────────────────────────────────────

function dp() {
  return require('./data-paths'); // per-call: tests bust this module's cache
}

function tokensRoot() {
  return dp().tokensRoot();
}

function safeSegment(value, what) {
  const s = String(value);
  if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..') {
    throw new Error(`[credential-store] invalid ${what}: ${JSON.stringify(String(value))}`);
  }
  return s;
}

function readCredentialPath(username, service) {
  return path.join(tokensRoot(), safeSegment(username, 'username'), safeSegment(service, 'service'));
}

function relParts(filePath) {
  try {
    const rel = path.relative(tokensRoot(), filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).filter(Boolean);
  } catch { return null; }
}

function profileForPath(filePath) {
  const parts = relParts(filePath);
  return parts && parts.length >= 2 ? parts[0] : null;
}

function serviceForPath(filePath) {
  const parts = relParts(filePath);
  if (parts && parts.length >= 2) return parts[1];
  return path.basename(filePath);
}

// ── .meta sidecar (non-sensitive: service, created/expiry/last-used, version) ─

function metaPath(filePath) {
  return filePath + META_SUFFIX;
}

function readMeta(filePath) {
  try { return JSON.parse(fs.readFileSync(metaPath(filePath), 'utf8')); } catch { return null; }
}

function writeMeta(filePath, patch = {}) {
  const prev = readMeta(filePath) || {};
  const now = new Date().toISOString();
  const next = { ...prev, ...patch };
  next.service = prev.service || serviceForPath(filePath);
  next.created_at = prev.created_at || now;
  next.updated_at = now;
  if (!('expires_at' in next)) next.expires_at = prev.expires_at ?? null;
  if (!('version' in next)) next.version = FORMAT_VERSION;
  try {
    fs.writeFileSync(metaPath(filePath), JSON.stringify(next, null, 2) + '\n', dp().writeMode(0o600));
  } catch (e) {
    console.warn('[credential-store] meta write failed for %s: %s', filePath, e.message);
  }
  return next;
}

/**
 * Merge non-sensitive metadata into <service>.meta.
 * @param {string} username  profile name
 * @param {string} service   credential file name
 * @param {object} patch     e.g. { expires_at: '2026-09-03T14:00:00Z' }
 */
function appendMeta(username, service, patch) {
  return appendMetaForPath(readCredentialPath(username, service), patch);
}

function appendMetaForPath(filePath, patch) {
  return writeMeta(filePath, patch);
}

function removeMeta(filePath) {
  try { fs.unlinkSync(metaPath(filePath)); } catch { /* no sidecar */ }
}

// ── .index.json (cross-user: { "<profile>": ["github", "nalog", ...] }) ───────

function indexPath() {
  return path.join(tokensRoot(), INDEX_FILE);
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeIndex(index) {
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2) + '\n', dp().writeMode(0o600));
}

/** Register profile+service in the cross-user index. Best-effort — never fails a write. */
function touchIndex(filePath) {
  const profile = profileForPath(filePath);
  const service = serviceForPath(filePath);
  if (!profile || !service) return;
  if (profile.startsWith('.') || NON_PROFILE_ROOTS.has(profile)) return;
  try {
    const index = readIndex();
    const list = Array.isArray(index[profile]) ? index[profile] : [];
    if (!list.includes(service)) {
      list.push(service);
      index[profile] = list.sort();
      writeIndex(index);
    }
  } catch (e) {
    console.warn('[credential-store] index update failed for %s: %s', filePath, e.message);
  }
}

/** Drop a service (or profile) from the cross-user index. Best-effort. */
function removeFromIndex(username, service) {
  try {
    const key = String(username);
    const index = readIndex();
    const list = Array.isArray(index[key]) ? index[key] : null;
    if (!list) return;
    if (service == null) delete index[key];
    else index[key] = list.filter(s => s !== String(service));
    if (index[key] && index[key].length === 0) delete index[key];
    writeIndex(index);
  } catch (e) {
    console.warn('[credential-store] index remove failed for %s/%s: %s', username, service, e.message);
  }
}

// ── Read / write ──────────────────────────────────────────────────────────────

/**
 * Read a credential file, decrypting when needed — a drop-in for
 * fs.readFileSync(path, 'utf8') at every credential read site.
 * Throws ENOENT when the file is missing (same contract as readFileSync).
 */
function readCredentialFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const envelope = decodeEnvelope(raw);
  if (!envelope) return raw; // legacy plaintext (or a non-credential file)

  const key = masterKey();
  if (!key) {
    throw new Error(`[credential-store] ${filePath} is encrypted but CRED_ENCRYPTION_KEY is not set`);
  }
  try {
    return decryptEnvelope(envelope, key);
  } catch (e) {
    // Tampered blob WITH a v2 sidecar → this is a real integrity failure: loud, no garbage.
    if ((readMeta(filePath) || {}).version === FORMAT_VERSION) throw e;
    // No sidecar → almost certainly a plaintext value that happens to decode as an
    // envelope (e.g. a base64-looking token). Keep the old tolerant-reader contract.
    console.warn('[credential-store] %s failed envelope decrypt and has no %s sidecar — reading as plaintext (%s)',
      filePath, META_SUFFIX, e.message);
    return raw;
  }
}

/**
 * Write a credential file: encrypt when a master key is available, plaintext
 * (with a warning) when not, always mode 0600, always .meta + .index.json.
 * @param {{ expiresAt?: string|null }} [opts]
 */
function writeCredentialFile(filePath, value, opts = {}) {
  const key = masterKey();
  const plaintext = typeof value === 'string' ? value : String(value);
  let content;
  if (key) {
    content = encryptFile(plaintext);
  } else {
    content = plaintext;
    console.warn('[credential-store] writing %s in PLAINTEXT (no CRED_ENCRYPTION_KEY)', filePath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, dp().writeMode(0o600));
  if (key) {
    writeMeta(filePath, { expires_at: opts.expiresAt ?? null });
    touchIndex(filePath);
  } else {
    // Stored plaintext → a stale v2 sidecar would make the next read throw.
    removeMeta(filePath);
  }
  return filePath;
}

/** Read a credential by profile+service. Returns null when the file is absent. */
function readCredential(username, service) {
  try {
    return readCredentialFile(readCredentialPath(username, service));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Write a credential by profile+service (creates the profile dir). */
function writeCredential(username, service, value, opts = {}) {
  const filePath = readCredentialPath(username, service);
  writeCredentialFile(filePath, value, opts);
  return filePath;
}

/**
 * Delete a credential file plus its sidecars — the revoke path.
 * Returns true when the credential file itself existed.
 */
function deleteCredential(username, service) {
  const filePath = readCredentialPath(username, service);
  let existed = false;
  try { fs.unlinkSync(filePath); existed = true; } catch { /* already gone */ }
  removeMeta(filePath);
  removeFromIndex(username, service);
  return existed;
}

// ── Non-credential helpers (so callers do not re-implement the skip rules) ────

/** True for a filename that must never be encrypted (routing/audit/cache/index). */
function isPlaintextFile(name) {
  return PLAINTEXT_FILES.has(name);
}

/** True for the `<service>.meta` sidecars — metadata, never a service of its own. */
function isMetaSidecar(name) {
  return typeof name === 'string' && name.endsWith(META_SUFFIX);
}

/** True when `name` (a file under a profile dir) should be encrypted at rest. */
function shouldEncrypt(name) {
  if (isMetaSidecar(name)) return false;
  if (name.startsWith('.')) return name === '.webpasswd'; // dotfiles are state — .webpasswd is the exception
  if (PLAINTEXT_FILES.has(name)) return false;
  return true;
}

module.exports = {
  FORMAT_VERSION,
  META_SUFFIX,
  INDEX_FILE,
  PLAINTEXT_FILES,
  PLAINTEXT_DIRS,
  encryptFile,
  decryptFile,
  isEncrypted,
  hasMasterKey,
  masterKeyHex,
  readCredential,
  writeCredential,
  deleteCredential,
  readCredentialFile,
  writeCredentialFile,
  appendMeta,
  appendMetaForPath,
  readMeta,
  removeFromIndex,
  isPlaintextFile,
  isMetaSidecar,
  shouldEncrypt,
  _resetMasterKey,
};
