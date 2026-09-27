'use strict';

// hermes_research result delivery (hotfix, 2026-09-27).
// A research run takes minutes; if the calling session dies or forgets to relay
// the answer, the result used to be lost. Now every successful run is
// (1) written to disk — <session cwd>/research/hermes-<ts>-<slug>.md — before
//     anything else, and
// (2) sent straight to the originating Telegram chat/topic as its own reply.
// Both steps are best-effort: a delivery failure never fails the tool call.
// Web-origin runs (AGENT_CHAT_ID=0) get the file only — the web UI has no
// out-of-band push path yet; the calling session still returns the result.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TG_TEXT_LIMIT = 3800;

function slugify(text) {
  return String(text || 'research').toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'research';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Research lands next to the session's project files — unless the cwd is a git
// checkout, where an untracked file would leak into a diff/commit.
function researchDir({ cwd = process.cwd(), username = process.env.AGENT_USER_ID || process.env.USER_ID } = {}) {
  if (!fs.existsSync(path.join(cwd, '.git'))) return path.join(cwd, 'research');
  return path.join(os.homedir(), 'agent-tokens', String(username || 'unknown'), 'hermes-research');
}

function renderMarkdown(task, result) {
  return `# Hermes research\n\nЗадача: ${task}\n\n` +
    '```json\n' + JSON.stringify(result, null, 2) + '\n```\n';
}

function saveResearch({ task, result, dir = researchDir(), now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const base = `hermes-${stamp(now)}-${slugify(task)}`;
  const mdPath = path.join(dir, `${base}.md`);
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(task, result));
  return mdPath;
}

function telegramTarget(env = process.env) {
  const token = env.AGENT_BOT_TOKEN || '';
  const chatId = env.AGENT_CHAT_ID || '';
  if (!token || !chatId || chatId === '0' || chatId === 'hermes') return null;
  const threadId = parseInt(env.AGENT_THREAD_ID || '', 10);
  return { token, chatId, threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null };
}

async function tgCall(target, method, form, fetchImpl) {
  const base = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  if (target.threadId) form.append('message_thread_id', String(target.threadId));
  const res = await fetchImpl(`${base}/bot${target.token}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// Short result → one text message; long → the .md as a document with a caption.
async function deliverToChat({ task, result, filePath, env = process.env, fetchImpl = fetch }) {
  const target = telegramTarget(env);
  if (!target) return { delivered: false, reason: 'no telegram chat (web or headless run)' };
  const header = `🔎 Hermes research готов\nЗадача: ${String(task).slice(0, 300)}`;
  const body = JSON.stringify(result, null, 2);
  const text = `${header}\n\n${body}`;
  const form = new FormData();
  form.append('chat_id', target.chatId);
  if (text.length <= TG_TEXT_LIMIT) {
    form.append('text', text);
    await tgCall(target, 'sendMessage', form, fetchImpl);
  } else {
    form.append('caption', `${header}\nПолный результат — в файле (сохранён: ${filePath})`.slice(0, 1024));
    form.append('document', new Blob([fs.readFileSync(filePath)], { type: 'text/markdown' }), path.basename(filePath));
    await tgCall(target, 'sendDocument', form, fetchImpl);
  }
  return { delivered: true, channel: 'telegram' };
}

// Save first (durable), then deliver. Never throws.
async function persistAndDeliver({ task, result, env = process.env, fetchImpl = fetch, dir }) {
  let savedTo = null;
  try { savedTo = saveResearch({ task, result, ...(dir ? { dir } : {}) }); }
  catch (e) { console.warn('[hermes-delivery] save failed:', e.message); }
  let delivery = { delivered: false, reason: 'not attempted' };
  try {
    if (savedTo || JSON.stringify(result).length + 400 <= TG_TEXT_LIMIT) {
      delivery = await deliverToChat({ task, result, filePath: savedTo, env, fetchImpl });
    } else delivery = { delivered: false, reason: 'save failed and result too long for a text message' };
  } catch (e) {
    delivery = { delivered: false, reason: e.message };
    console.warn('[hermes-delivery] telegram delivery failed:', e.message);
  }
  return { saved_to: savedTo, ...delivery };
}

module.exports = { persistAndDeliver, saveResearch, deliverToChat, telegramTarget, researchDir, slugify };
