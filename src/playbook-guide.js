'use strict';

// Playbook «гайд» mode (#1887 п.1, issue #1894). A guide run does not create a durable
// plan: playbook_run appends a checklist.md section to the current project (Goal +
// Owner-session + Owner-chat + Mode: guide) and the live Telegram session walks the steps;
// GTD keeps it going via Owner-session. Owner decision 29.09: guide is the DEFAULT in an
// interactive Telegram chat, unless that chat already has an open guide (→ background) or
// the caller asked for background explicitly. The choice is made here, in code — not by a
// prompt rule — so a second playbook in the same chat can never silently hijack the first.

const fs = require('fs');
const path = require('path');

const GUIDE_STALE_MS = 24 * 3600e3;

function guideDefaultOn(env = process.env) {
  return !['0', 'false', 'off', 'no'].includes(String(env.PLAYBOOK_GUIDE_DEFAULT ?? '').trim().toLowerCase());
}

function modeError(code, message) { const e = new Error(message); e.code = code; return e; }

// First match wins (design §2.1). Whether this run is an interactive Telegram dialog is
// resolved by the caller from src/run-identity (session file, not the chat-id env);
// `activate` only matters for the resulting background plan.
function resolveMode({ mode, activate, interactive = false, guideDefault = true, openGuide = null, sessionPlan = null } = {}) {
  if (mode != null && mode !== 'guide' && mode !== 'background') {
    throw modeError('MODE_INVALID', `mode «${mode}» не поддерживается — "guide" или "background"`);
  }
  if (mode === 'guide' && activate === true) {
    throw modeError('MODE_CONFLICT', 'mode:"guide" и activate:true противоречат друг другу: гайд не создаёт фоновый план. ' +
      'Убери activate (гайд) или передай mode:"background"');
  }
  if (mode) return { mode, reason: 'explicit' };
  if (!interactive) return { mode: 'background', reason: 'non_interactive' };
  if (openGuide) return { mode: 'background', reason: 'foreground_busy' };
  if (sessionPlan) return { mode: 'background', reason: 'session_has_plan' };
  if (!guideDefault) return { mode: 'background', reason: 'guide_default_off' };
  return { mode: 'guide', reason: 'default_telegram' };
}

function _checklistFiles(profileRoot) {
  const files = [path.join(profileRoot, 'checklist.md')];
  let names = [];
  try { names = fs.readdirSync(path.join(profileRoot, 'projects')); } catch { /* no projects */ }
  for (const n of names) files.push(path.join(profileRoot, 'projects', n, 'checklist.md'));
  return files;
}

// Open guide of THIS chat anywhere in the profile (the key is the chat, not the project):
// the active section (the one GTD actually drives) is Mode: guide + Owner-chat: <chatId>,
// not Cancelled/Closed, has an open item and the file changed within 24 h. Older guide
// sections superseded by a newer one are abandoned — GTD no longer drives them either.
function findOpenGuide({ profileRoot, chatId, now = Date.now() } = {}) {
  if (!profileRoot || chatId == null || String(chatId) === '' || String(chatId) === '0') return null;
  const { _parseChecklistSections, _activeSection } = require('./gtd-controller');
  for (const file of _checklistFiles(profileRoot)) {
    let raw; let mtime;
    try { raw = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!/^\s*mode:\s*guide\s*$/im.test(raw)) continue;
    if (now - mtime > GUIDE_STALE_MS) continue;
    const sec = _activeSection(_parseChecklistSections(raw).sections);
    if (!sec || sec.mode !== 'guide' || sec.ownerChat !== String(chatId)) continue;
    if (sec.cancelled || sec.closed || !sec.items.some(i => !i.done)) continue;
    return { goal: sec.goal, checklist_path: file, owner_session: sec.owner };
  }
  return null;
}

function _validationBrief(validation) {
  return Object.entries(validation || {})
    .map(([k, v]) => (v === true ? k : `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`))
    .join(', ');
}

// items: compiled.items; off: Map(index → reason); isProtected(item) → bool.
function renderGuideSection({ goal, items, off = new Map(), isProtected = () => false, sessionId, chatId, playbook, now = Date.now() }) {
  const one = s => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const lines = [
    `Goal: ${one(goal)}`,
    `Owner-session: ${sessionId}`,
    `Owner-chat: ${chatId}`,
    'Mode: guide',
    ...(playbook ? [`Playbook: ${playbook.id}@v${playbook.version}`] : []),
    `Started: ${new Date(now).toISOString()}`,
  ];
  items.forEach((it, i) => {
    const title = `${i + 1}. ${one(it.title)}`;
    if (off.has(i)) { lines.push(`- [x] ${title} — выключен: ${one(off.get(i))}`); return; }
    const check = _validationBrief(it.validation);
    lines.push(`- [ ] ${title}${check ? ` — проверка: ${check}` : ''}${isProtected(it) ? ' [ГЕЙТ, не пропускается]' : ''}`);
  });
  return lines.join('\n') + '\n';
}

// Append-only (checklist.md is a journal), atomic write like gtd-controller.
function appendGuideSection(file, section) {
  let prev = '';
  try { prev = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const sep = prev && !prev.endsWith('\n\n') ? (prev.endsWith('\n') ? '\n' : '\n\n') : '';
  require('./atomic-json').atomicText(file, prev + sep + section);
}

const GUIDE_HINT = 'Режим гайд: фонового плана нет — веди шаги прямо в этом диалоге по checklist_md. ' +
  'Отмечай [x] в checklist.md по факту выполнения; вопросы пользователю — обычным сообщением. ' +
  'Шаги [ГЕЙТ] (CI/staging/мерж) закрываются только зелёной проверкой. Секцию уже записал тул — не дублируй её.';

module.exports = {
  guideDefaultOn, resolveMode, findOpenGuide, renderGuideSection, appendGuideSection,
  GUIDE_HINT, GUIDE_STALE_MS,
};
