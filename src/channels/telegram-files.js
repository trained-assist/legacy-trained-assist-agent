'use strict';

// Telegram transport adapter for tool-side file access (epic #1365 §6): the only
// place tools touch the Bot API or the per-run bot token env. Callers (MCP tools,
// run config) go through this module instead of hardcoding either.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Env var carrying THIS run's audience bot token into MCP tool processes.
const TOOL_BOT_TOKEN_ENV = 'AGENT_BOT_TOKEN';
// Bot API getFile serves files up to 20 MB; bigger ones need a direct upload to the bot.
const TG_FILE_MAX = 20 * 1024 * 1024;

function toolBotToken() {
  return process.env[TOOL_BOT_TOKEN_ENV] || '';
}

function safeFileName(name) {
  return path.basename(name || 'file').replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200) || 'file';
}

function defaultName(file) {
  if (file.name) return file.name;
  const ext = { photo: '.jpg', voice: '.ogg', audio: '.mp3', video: '.mp4' }[file.kind] || '';
  return `${file.kind || 'file'}${ext}`;
}

// Download a Telegram file by file_id with the run's bot token into `dir`.
// A file_id is bound to the bot that saw it, so the token must be the audience bot.
async function downloadTelegramFile({ file, dir, token = toolBotToken(), fetchImpl = fetch }) {
  if (!token) return { ok: false, error: `Bot token is not available to tools (${TOOL_BOT_TOKEN_ENV}).` };
  if (Number.isFinite(file.size) && file.size > TG_FILE_MAX) {
    return { ok: false, error: `Файл ${Math.round(file.size / 1048576)} МБ — Telegram отдаёт ботам только до 20 МБ. Попроси прислать файл ссылкой (Google Drive/Яндекс Диск).` };
  }
  const api = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const meta = await fetchImpl(`${api}/bot${token}/getFile?file_id=${encodeURIComponent(file.fileId)}`, { signal: AbortSignal.timeout(15000) })
    .then(r => r.json()).catch(e => ({ ok: false, description: e.message }));
  if (!meta?.ok || !meta.result?.file_path) {
    return { ok: false, error: `Telegram getFile failed: ${meta?.description || 'no file_path'}` };
  }
  const res = await fetchImpl(`${api}/file/bot${token}/${meta.result.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return { ok: false, error: `Telegram file download failed: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${crypto.randomUUID()}-${safeFileName(defaultName(file))}`);
  fs.writeFileSync(filePath, buf, { mode: 0o660 });
  return { ok: true, file_path: filePath, bytes: buf.length };
}

module.exports = { TOOL_BOT_TOKEN_ENV, TG_FILE_MAX, toolBotToken, downloadTelegramFile };
