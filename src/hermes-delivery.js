'use strict';

// hermes_research result delivery (hotfix, 2026-09-27).
// A research run takes minutes; if the calling session dies or forgets to relay
// the answer, the result used to be lost. Now every successful run is
// (1) written to disk — <session cwd>/research/hermes-<ts>-<slug>.md — before
//     anything else, and
// (2) sent straight to the originating Telegram chat/topic as its own reply.
// Both steps are best-effort: a delivery failure never fails the tool call.
// Web-origin runs (chat id 0) get the file only — the web UI has no
// out-of-band push path yet; the calling session still returns the result.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sendChatReply } = require('./mcp-skills/tools/94-tg-send');

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

// Short result → one text message; long → the .md as a document with a caption.
async function deliverToChat({ task, result, filePath, target, fetchImpl }) {
  const header = `🔎 Hermes research готов\nЗадача: ${String(task).slice(0, 300)}`;
  const text = `${header}\n\n${JSON.stringify(result, null, 2)}`;
  const opts = { ...(target !== undefined ? { target } : {}), ...(fetchImpl ? { fetchImpl } : {}) };
  if (text.length <= TG_TEXT_LIMIT) return sendChatReply({ text }, opts);
  return sendChatReply({ document: { path: filePath, caption: `${header}\nПолный результат — в файле (сохранён: ${filePath})` } }, opts);
}

// Save first (durable), then deliver. Never throws.
async function persistAndDeliver({ task, result, target, fetchImpl, dir }) {
  let savedTo = null;
  try { savedTo = saveResearch({ task, result, ...(dir ? { dir } : {}) }); }
  catch (e) { console.warn('[hermes-delivery] save failed:', e.message); }
  let delivery = { delivered: false, reason: 'not attempted' };
  try {
    if (savedTo || JSON.stringify(result).length + 400 <= TG_TEXT_LIMIT) {
      delivery = await deliverToChat({ task, result, filePath: savedTo, target, fetchImpl });
    } else delivery = { delivered: false, reason: 'save failed and result too long for a text message' };
  } catch (e) {
    delivery = { delivered: false, reason: e.message };
    console.warn('[hermes-delivery] telegram delivery failed:', e.message);
  }
  return { saved_to: savedTo, ...delivery };
}

module.exports = { persistAndDeliver, saveResearch, deliverToChat, researchDir, slugify };
