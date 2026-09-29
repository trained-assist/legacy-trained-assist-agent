'use strict';

// tg_send_file / tg_send_photo — send local files to the user's Telegram chat.
// Always available (no opt-in gate), uses AGENT_BOT_TOKEN + AGENT_CHAT_ID from runner.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../../data-paths');
const os = require('os');
const https = require('https');
const http = require('http');

const BOT_TOKEN = process.env.AGENT_BOT_TOKEN || '';
const CHAT_ID   = process.env.AGENT_CHAT_ID   || '';
const TG_API    = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');

// ── Path guard (epic #1805, §3-1) ─────────────────────────────────────────────
// The MCP server runs as the SERVICE user, so an unchecked file_path lets any
// profile's agent exfiltrate any service-readable file (/home/vova/secrets.env,
// ~/.ssh, ~/.git-credentials, чужие agent-tokens) into its own chat. Allowed
// roots are the run's OWN scope: profile workspace (WORK_DIR), the run cwd,
// TMPDIR/system tmp, and this profile's hermes-research dir. Everything else —
// denied, before even checking existence (no existence oracle).
// Note: system tmp is shared across profiles (#1712) — accepted here because
// the guard's job is service secrets outside /tmp, not cross-profile /tmp.

function allowedSendRoots() {
  const userId = process.env.USER_ID || process.env.AGENT_USER_ID || '';
  const roots = [
    process.env.WORK_DIR,       // profile workspace (mcpToolEnv)
    process.cwd(),              // run cwd (bridge spawns MCP with cwd: run.cwd)
    process.env.TMPDIR,         // per-run tmp (inside .agent-home for slots)
    os.tmpdir(),                // engine default tmp
    userId && path.join(
      tokensRoot(),
      String(userId), 'hermes-research'), // own profile's research output only
  ].filter(Boolean);
  return [...new Set(roots.map(r => path.resolve(r)))];
}

function realpathOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Symlinks are followed (realpath) on both sides, so a link inside the
// workspace pointing at /home/vova/secrets.env is denied too.
function isAllowedSendPath(filePath) {
  const real = realpathOrResolve(filePath);
  return allowedSendRoots().map(realpathOrResolve)
    .some(root => real === root || real.startsWith(root + path.sep));
}

function detectMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function isImage(filePath) {
  return /\.(png|jpe?g|gif|webp)$/i.test(filePath);
}

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${TG_API}/bot${BOT_TOKEN}/${method}`);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${body.boundary}`,
        'Content-Length': body.data.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const d = JSON.parse(text);
          if (!d.ok) reject(new Error(`Telegram error: ${JSON.stringify(d)}`));
          else resolve(d);
        } catch { reject(new Error(`Non-JSON TG response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body.data);
    req.end();
  });
}

function buildMultipart(fields, file) {
  const boundary = `----FormBoundary${Date.now().toString(16)}`;
  const CRLF = '\r\n';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.field}"; filename="${file.name}"${CRLF}Content-Type: ${file.mime}${CRLF}${CRLF}`
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return { boundary, data: Buffer.concat(parts) };
}

async function sendFile(filePath, caption, asPhoto) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('AGENT_BOT_TOKEN or AGENT_CHAT_ID not set');
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const mime = detectMime(filePath);
  const usePhoto = asPhoto !== false && isImage(filePath);
  const field = usePhoto ? 'photo' : 'document';
  const method = usePhoto ? 'sendPhoto' : 'sendDocument';
  const fields = { chat_id: CHAT_ID };
  if (caption) fields.caption = String(caption).slice(0, 1024);
  const body = buildMultipart(fields, { field, name, mime, data: buf });
  return tgRequest(method, body);
}

// Plain-text / document reply to the run's chat, in its forum topic when there is one
// (AGENT_THREAD_ID). Used by hermes_research delivery — kept here, in the one legacy
// sender, so it migrates with tg_send_file to the channel adapter (epic #1365 PR5)
// instead of adding a new direct-Telegram site. `target`/`fetchImpl` are test seams.
function chatTarget() {
  if (!BOT_TOKEN || !CHAT_ID || CHAT_ID === '0' || CHAT_ID === 'hermes') return null;
  const threadId = parseInt(process.env.AGENT_THREAD_ID || '', 10);
  return { token: BOT_TOKEN, chatId: CHAT_ID, threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null };
}

async function sendChatReply({ text, document }, { target = chatTarget(), fetchImpl = fetch } = {}) {
  if (!target) return { delivered: false, reason: 'no telegram chat (web or headless run)' };
  const form = new FormData();
  form.append('chat_id', target.chatId);
  if (target.threadId) form.append('message_thread_id', String(target.threadId));
  let method = 'sendMessage';
  if (document) {
    method = 'sendDocument';
    if (document.caption) form.append('caption', String(document.caption).slice(0, 1024));
    form.append('document', new Blob([fs.readFileSync(document.path)], { type: detectMime(document.path) }), path.basename(document.path));
  } else form.append('text', String(text));
  const res = await fetchImpl(`${TG_API}/bot${target.token}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return { delivered: true, channel: 'telegram' };
}

module.exports = {
  chatTarget,
  sendChatReply,
  isAllowedSendPath, // test seam: path guard (epic #1805 §3-1)
  tools: {
    tg_send_file: {
      description:
        'Send a local file (image, PDF, CSV, any format) to the user\'s Telegram chat. ' +
        'Use for screenshots, QR codes, generated reports — anything the user should receive in chat. ' +
        'Images are sent as photos by default (use as_document=true to force file mode).',
      inputSchema: {
        type: 'object',
        required: ['file_path'],
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the local file to send. Must be inside the run workspace (WORK_DIR), the run cwd, TMPDIR, or this profile\'s hermes-research dir — files elsewhere (secrets, other profiles, system paths) are rejected.',
          },
          caption: {
            type: 'string',
            description: 'Optional caption shown under the file/photo (max 1024 chars).',
          },
          as_document: {
            type: 'boolean',
            description: 'Force sending as a document (not compressed photo). Default false for images.',
          },
        },
      },
      async handler({ file_path, caption, as_document }) {
        if (!file_path) return { error: 'file_path is required' };
        if (!isAllowedSendPath(file_path)) {
          return { error: `file_path is outside the allowed roots (run workspace / tmp / own hermes-research): ${file_path}` };
        }
        if (!fs.existsSync(file_path)) return { error: `File not found: ${file_path}` };
        try {
          const result = await sendFile(file_path, caption, !as_document);
          return {
            ok: true,
            file: path.basename(file_path),
            message_id: result.result?.message_id,
          };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    },
  },
};
