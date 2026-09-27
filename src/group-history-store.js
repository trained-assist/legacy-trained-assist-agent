'use strict';

// Durable copy of the quiet-mode group history (trained-assist-tg-bot src/group-history.js).
//
// The gateway remembers group messages not addressed to the bot and sends each one to
// the agent ONCE — with the next addressed /run, as a prompt block plus the structured
// `groupHistory` array. The next run doesn't repeat them, so to keep already-delivered
// messages readable they are appended here and served by the get_group_history MCP tool.
// One file per (username, group chat, forum topic); dedup by gateway seq / message id;
// last RETAIN_MS, at most RETAIN_MAX entries. Never throws into /run.

const fs = require('fs');
const path = require('path');
const { groupHistoryPath } = require('./data-paths');

const RETAIN_MS = 7 * 24 * 3600_000;
const RETAIN_MAX = 1000;
const MAX_BATCH = 200;
const TEXT_MAX = 2000;

function readEntries(fp) {
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch { return []; }
}

function keyOf(e) {
  return e.id != null ? `id:${e.id}` : `seq:${e.seq}:${e.ts}`;
}

/** Only well-formed entries from the wire; anything else is dropped, not rejected. */
function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw.slice(-MAX_BATCH)) {
    if (!e || typeof e.text !== 'string' || !e.text || !Number.isFinite(e.ts)) continue;
    out.push({
      id: Number.isSafeInteger(e.id) ? e.id : null,
      seq: Number.isSafeInteger(e.seq) ? e.seq : null,
      ts: e.ts,
      from: typeof e.from === 'string' ? e.from.slice(0, 200) : 'участник',
      text: e.text.slice(0, TEXT_MAX),
    });
  }
  return out;
}

/** Append delivered entries for a group chat. Returns how many were new. */
function appendGroupHistory(username, chatId, threadId, raw, now = Date.now()) {
  try {
    if (!(Number(chatId) < 0)) return 0;
    const incoming = sanitize(raw);
    if (!incoming.length) return 0;
    const fp = groupHistoryPath(username, chatId, threadId);
    const existing = readEntries(fp);
    const seen = new Set(existing.map(keyOf));
    const fresh = incoming.filter(e => !seen.has(keyOf(e)));
    const kept = [...existing, ...fresh]
      .filter(e => now - e.ts <= RETAIN_MS)
      .sort((a, b) => a.ts - b.ts)
      .slice(-RETAIN_MAX);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ chatId: String(chatId), threadId: threadId ?? null, entries: kept }));
    fs.renameSync(tmp, fp);
    return fresh.length;
  } catch (e) {
    console.warn(`[group-history] persist failed chat=${chatId}: ${e?.message || e}`);
    return 0;
  }
}

/** Kept entries, oldest first. opts: sinceHours, limit (newest `limit`), now. */
function readGroupHistory(username, chatId, threadId, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let entries = readEntries(groupHistoryPath(username, chatId, threadId))
    .filter(e => now - e.ts <= RETAIN_MS);
  if (opts.sinceHours > 0) entries = entries.filter(e => e.ts >= now - opts.sinceHours * 3600_000);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), RETAIN_MAX);
  return entries.slice(-limit);
}

module.exports = { appendGroupHistory, readGroupHistory, RETAIN_MS, RETAIN_MAX };
