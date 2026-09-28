'use strict';

// Drive watcher — polls Google Drive Changes API for each user's SA.
//
// Uses Changes API (not sharedWithMe=true) — sharedWithMe doesn't work for SAs
// when shared from personal Gmail accounts. Changes API correctly tracks all
// files that become accessible to the SA.
//
// Scope: drive (full) required — drive.readonly misses externally-shared files.
//
// State stored in ~/agent-tokens/{userId}/gdrive-seen as JSON:
//   { type: 'changes', pageToken: '...' }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCredentialFile } = require('./credential-store');

const TG_BASE = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

function _readChatId(userId) {
  // Support both legacy numeric dirs (chatId == userId) and named profile dirs
  if (/^-?\d+$/.test(userId)) return userId;
  try {
    return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', userId, '.chatid'), 'utf8').trim() || null;
  } catch { return null; }
}

// ── SA JWT auth ───────────────────────────────────────────────────────────────

const _tokenCache = new Map();

function _makeJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive', // full scope required for SA file access
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  return `${data}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function _getSaToken(sa) {
  const key = sa.client_email;
  const cached = _tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const jwt = _makeJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`SA auth failed: ${JSON.stringify(data)}`);
  _tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + 3600_000 });
  return data.access_token;
}

// ── File catalog ──────────────────────────────────────────────────────────────

const EXPORT_MIME = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

async function _readSnippet(fileId, mimeType, token) {
  try {
    let url;
    const exportMime = EXPORT_MIME[mimeType];
    if (exportMime) {
      url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`;
    } else if (mimeType && (mimeType.startsWith('text/') || mimeType === 'application/json')) {
      url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    } else {
      return null;
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 600).trim() || null;
  } catch { return null; }
}

async function _catalogFile(userId, file, token) {
  const catalogPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-catalog.json');
  let catalog = [];
  try { catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch {}
  if (catalog.find(e => e.id === file.id)) return;

  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const snippet  = isFolder ? null : await _readSnippet(file.id, file.mimeType, token);

  catalog.push({
    id:          file.id,
    name:        file.name,
    mimeType:    file.mimeType,
    webViewLink: file.webViewLink,
    owner:       file.owners?.[0]?.emailAddress || file.owners?.[0]?.displayName || null,
    sharedAt:    new Date().toISOString(),
    snippet,
    catalogedAt: new Date().toISOString(),
  });

  const tmp = `${catalogPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2));
  fs.renameSync(tmp, catalogPath);
  console.log(`[drive-watcher] cataloged userId=${userId} fileId=${file.id} name="${file.name}"`);
}

// ── State helpers ─────────────────────────────────────────────────────────────

function _readState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8').trim();
    const parsed = JSON.parse(raw);
    // Old format was an array of file IDs — treat as needs-reinit
    if (Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

function _writeState(stateFile, state) {
  const tmp = `${stateFile}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error('[drive-watcher] state write failed:', e.message);
  }
}

// ── Per-user check ────────────────────────────────────────────────────────────

function _mimeLabel(mimeType = '') {
  if (mimeType.includes('spreadsheet'))  return 'таблице';
  if (mimeType.includes('document'))     return 'документу';
  if (mimeType.includes('presentation')) return 'презентации';
  if (mimeType.includes('folder'))       return 'папке';
  if (mimeType.includes('video'))        return 'видео';
  return 'файлу';
}

async function _checkUser(userId, botToken) {
  const saFile    = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
  const stateFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-seen');
  if (!fs.existsSync(saFile)) return;

  let sa;
  try { sa = JSON.parse(readCredentialFile(saFile)); }
  catch { return; }
  if (!sa?.client_email || !sa?.private_key) return;

  let token;
  try { token = await _getSaToken(sa); }
  catch (e) {
    console.error(`[drive-watcher] SA auth error userId=${userId}:`, e.message);
    return;
  }

  const state = _readState(stateFile);

  // First run (or stale old format): get startPageToken and return — no notification
  if (!state?.pageToken) {
    try {
      const res = await fetch(
        'https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true&includeCorpusRemovals=true',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) { console.error(`[drive-watcher] startPageToken ${res.status} userId=${userId}`); return; }
      const data = await res.json();
      _writeState(stateFile, { type: 'changes', pageToken: data.startPageToken });
      console.log(`[drive-watcher] userId=${userId} initialized Changes API pageToken=${data.startPageToken}`);
    } catch (e) {
      console.error(`[drive-watcher] init error userId=${userId}:`, e.message);
    }
    return;
  }

  // Poll changes since last token
  const newFiles = [];
  let currentToken = state.pageToken;
  let newPageToken = currentToken;

  try {
    for (;;) {
      const fields = 'nextPageToken,newStartPageToken,changes(changeType,removed,file(id,name,mimeType,webViewLink,owners))';
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(currentToken)}&fields=${encodeURIComponent(fields)}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error(`[drive-watcher] Changes API ${res.status} userId=${userId}:`, err.error?.message || '');
        return;
      }
      const data = await res.json();
      for (const change of (data.changes || [])) {
        if (change.changeType === 'file' && !change.removed && change.file?.id) {
          newFiles.push(change.file);
        }
      }
      if (data.nextPageToken) {
        currentToken = data.nextPageToken;
      } else {
        newPageToken = data.newStartPageToken || currentToken;
        break;
      }
    }
  } catch (e) {
    console.error(`[drive-watcher] changes fetch error userId=${userId}:`, e.message);
    return;
  }

  // Always advance the cursor even if no new files
  if (newPageToken !== state.pageToken) {
    _writeState(stateFile, { type: 'changes', pageToken: newPageToken });
  }

  if (!newFiles.length) return;

  console.log(`[drive-watcher] userId=${userId}: ${newFiles.length} new file(s) via Changes API`);

  const catalogPath = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-catalog.json');
  let existingIds = new Set();
  try { existingIds = new Set(JSON.parse(fs.readFileSync(catalogPath, 'utf8')).map(e => e.id)); } catch {}

  for (const file of newFiles) {
    const isNew = !existingIds.has(file.id);

    _catalogFile(userId, file, token).catch(e =>
      console.error(`[drive-watcher] catalog failed fileId=${file.id}:`, e.message)
    );

    if (!isNew) continue; // already known — don't spam notification on every edit

    const label = _mimeLabel(file.mimeType);
    const owner = file.owners?.[0]?.emailAddress || file.owners?.[0]?.displayName || '?';
    const name  = file.name || 'документ';
    const link  = file.webViewLink;
    const text  = link
      ? `📂 Открыли доступ к ${label} [${name}](${link})\nОт: ${owner}\n\nСкажи что делать с файлом.`
      : `📂 Открыли доступ к ${label} «${name}»\nОт: ${owner}\n\nСкажи что делать с файлом.`;

    const mutedFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive-notif-muted');
    if (fs.existsSync(mutedFile)) {
      console.log(`[drive-watcher] userId=${userId}: notifications muted, skipping TG send for "${name}"`);
      continue;
    }

    const chatId = _readChatId(userId);
    if (!chatId) {
      console.warn(`[drive-watcher] no chatId for userId=${userId}, skipping notification`);
      continue;
    }

    await fetch(`${TG_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false }),
      signal: AbortSignal.timeout(8000),
    }).catch(e => console.error('[drive-watcher] TG send failed:', e.message));
  }
}

// ── Scan all users ────────────────────────────────────────────────────────────

async function pollDriveChanges({ botToken }) {
  const tokensBase = path.join(os.homedir(), 'agent-tokens');
  if (!fs.existsSync(tokensBase)) return;

  let entries;
  try { entries = fs.readdirSync(tokensBase); }
  catch { return; }

  for (const userId of entries) {
    // Skip hidden files and internal files — accept both numeric chat IDs (legacy) and alphanumeric profile names
    if (userId.startsWith('.') || !/^-?[\w]+$/.test(userId)) continue;
    await _checkUser(userId, botToken).catch(e =>
      console.error(`[drive-watcher] uncaught error userId=${userId}:`, e.message)
    );
  }
}

// trackChat — kept for API compatibility with server.js
function trackChat() {}

module.exports = { trackChat, pollDriveChanges };
