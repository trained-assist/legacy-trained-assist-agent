'use strict';

// Background-task notifications (owner 29.09): an opt-in per profile, so whoever
// wants to watch the playbooks run can see «шаг начат / шаг готов / прервано»
// arrive in Telegram instead of wondering whether the executor died.
//
// The flag lives next to the other per-profile credentials (TOKENS_ROOT/<user>/)
// because it is a profile setting, not a session artifact: it must survive
// restarts, projects and new dialogs. It stores WHERE to notify as well as
// on/off — the chat that turned it on may not be the plan's owner chat.

const fs = require('fs');
const path = require('path');
const { TOKENS_ROOT } = require('./data-paths');

const FLAG_FILE = 'bg-notify.json';

function flagPath(username) {
  return path.join(TOKENS_ROOT, String(username || ''), FLAG_FILE);
}

function readBgNotify(username) {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath(username), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Write with a mask: credentials-adjacent dir, and the chat id is personal data.
function writeBgNotify(username, patch) {
  if (!username) return null;
  const next = { ...(readBgNotify(username) || {}), ...patch, updated_at: new Date().toISOString() };
  const file = flagPath(username);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

function isBgNotifyEnabled(username) {
  return readBgNotify(username)?.enabled === true;
}

module.exports = { flagPath, readBgNotify, writeBgNotify, isBgNotifyEnabled, FLAG_FILE };
