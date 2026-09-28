'use strict';
// Осиротевшие чек-листы (#1729, сценарии BV-08 / BV-08a,
// docs/user-scenarios/core/02-background-run-visibility.md).
//
// Секция `Goal:` в корневом checklist.md проекта принадлежит сессии из строки
// `Owner-session: <id>`. scheduleFromChecklist цепляет доводку только к владельцу.
// Секция, которую никто не ведёт, — «осиротевшая»:
//
//   • не отменена (`Cancelled:` / cancelledAt), и в ней есть открытые пункты;
//   • ни одна открытая GTD-запись профиля не ведёт этот projectDir;
//   • владельца нет (legacy), ЛИБО у владельца нет открытой GTD-записи и его сессия
//     сейчас не бежит (isSessionRunning).
//
// Консервативность: при напоминании признак перепроверяется заново, и напоминание
// уходит не раньше 30 мин после max(firstSeenAt, mtime checklist.md) — свежий файл,
// который ещё дописывается идущим раном, не считается забытым.
//
// Durable store: <workDir>/gtd-orphans.json (НЕ в <workDir>/gtd/ — listGtd читает там
// каждый *.json как GTD-запись). Ключ записи = sha1(projectDir + goal)[:12] — он же
// короткий id в callback_data `ocl|do|<id>` / `ocl|no|<id>`.
//
// Анти-спам: одно напоминание на (секция, хэш открытых пунктов), не чаще раза в 24 ч
// на секцию; после «✖️ Отменить» — никогда. Список /all_forgotten_checklists сам по
// себе считается показом (напоминание по тем же пунктам больше не придёт).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicJson } = require('./atomic-json');

const STORE_FILE = 'gtd-orphans.json';
const REMIND_AFTER_MS = 30 * 60 * 1000;
const REMIND_MIN_GAP_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDERS_PER_TICK = 5;
const LABEL_MAX = 60;
const CALLBACK_PREFIX = 'ocl';

function gtd() { return require('./gtd-controller'); }

function storePath(workDir) { return path.join(workDir, STORE_FILE); }

function loadStore(workDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(storePath(workDir), 'utf8'));
    return obj && typeof obj === 'object' && obj.records ? obj : { records: {} };
  } catch { return { records: {} }; }
}

function saveStore(workDir, store) {
  try {
    fs.mkdirSync(workDir, { recursive: true });
    atomicJson(storePath(workDir), store, { space: 2 });
    return true;
  } catch (e) { console.error('[orphan-checklists] save:', e.message); return false; }
}

function sectionId(projectDir, goal) {
  return crypto.createHash('sha1').update(`${projectDir}\0${goal || ''}`).digest('hex').slice(0, 12);
}

function openItems(checklist) { return (checklist?.items || []).filter(i => !i.done); }

function openHash(checklist) {
  return crypto.createHash('sha1').update(openItems(checklist).map(i => i.text).join('\n')).digest('hex').slice(0, 12);
}

// Ярлык: цель, обрезанная по слову до 60 символов (без цели — первый открытый пункт).
function makeLabel(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= LABEL_MAX) return t;
  const cut = t.slice(0, LABEL_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

function labelFor(checklist) {
  return makeLabel(checklist?.goal || openItems(checklist)[0]?.text || 'чек-лист');
}

function findRecord(workDir, projectDir, goal) {
  return loadStore(workDir).records[sectionId(projectDir, goal)] || null;
}

function _running(isSessionRunning, username, sessionId) {
  if (!sessionId) return false;
  try {
    if (typeof isSessionRunning === 'function') return !!isSessionRunning(username, sessionId);
    return !!require('./runner').isSessionRunning(sessionId);
  } catch { return false; }
}

// Определение «осиротевшего» — см. шапку файла.
function isOrphan({ workDir, username, projectDir, checklist, isSessionRunning = null }) {
  if (!workDir || !projectDir || !checklist) return false;
  if (checklist.cancelled || !openItems(checklist).length) return false;
  const G = gtd();
  if (G.listGtd(workDir).some(r => r && r.status === 'open' && r.projectDir === projectDir)) return false;
  const owner = checklist.owner;
  if (owner) {
    const rec = G.readGtd(workDir, owner);
    if (rec && rec.status === 'open') return false;
    if (_running(isSessionRunning, username, owner)) return false;
  }
  return true;
}

function _ownerChat(workDir, owner) {
  if (!owner) return null;
  try {
    const s = require('./session-store').getSession(workDir, owner);
    const chatId = s ? (s.liveChatId ?? s.ownerChatId) : null;
    if (!chatId) return null;
    const t = Number(s.messageThreadId);
    return { chatId: String(chatId), threadId: Number.isInteger(t) && t > 0 ? t : null };
  } catch { return null; }
}

// Upsert записи для осиротевшей секции. Не трогает firstSeenAt у уже известной.
function _upsert(store, { workDir, projectDir, checklist, username, audience, chatId, threadId, now }) {
  const id = sectionId(projectDir, checklist.goal);
  const hash = openHash(checklist);
  const open = openItems(checklist);
  let rec = store.records[id];
  if (rec && rec.doneAt && !rec.cancelledAt) {
    // Та же секция снова открыта (новые пункты после закрытия) — новый эпизод.
    rec = { ...rec, doneAt: null, doingAt: null, firstSeenAt: now };
  }
  if (!rec) {
    const oc = _ownerChat(workDir, checklist.owner);
    const tid = Number(threadId);
    rec = {
      id, projectDir, goal: checklist.goal || null,
      firstSeenAt: now, remindedAt: null, remindedHash: null,
      cancelledAt: null, doneAt: null, doingAt: null,
      username: username || null, audience: audience || 'default',
      chatId: oc ? oc.chatId : (chatId != null ? String(chatId) : null),
      threadId: oc ? oc.threadId : (Number.isInteger(tid) && tid > 0 ? tid : null),
    };
  }
  if (!rec.chatId && chatId != null) {
    rec.chatId = String(chatId);
    const tid = Number(threadId);
    rec.threadId = Number.isInteger(tid) && tid > 0 ? tid : null;
  }
  rec.label = labelFor(checklist);
  rec.owner = checklist.owner || null;
  rec.openHash = hash;
  rec.openCount = open.length;
  rec.firstOpen = open[0]?.text || null;
  rec.lastSeenAt = now;
  store.records[id] = rec;
  return rec;
}

// Зовётся из scheduleFromChecklist, когда сессия пропустила чужую/legacy секцию.
function noteSkipped({ workDir, projectDir, checklist, username, audience, chatId, threadId, isSessionRunning = null, now = Date.now() }) {
  if (!isOrphan({ workDir, username, projectDir, checklist, isSessionRunning })) return null;
  const store = loadStore(workDir);
  const known = store.records[sectionId(projectDir, checklist.goal)];
  if (known && known.cancelledAt) return known;
  const rec = _upsert(store, { workDir, projectDir, checklist, username, audience, chatId, threadId, now });
  saveStore(workDir, store);
  return rec;
}

function reminderText(rec) {
  const more = rec.openCount > 1 ? ` и ещё ${rec.openCount - 1}` : '';
  return `🔁 «${rec.label}»: остался пункт «${rec.firstOpen || '…'}»${more}`;
}

function keyboard(id) {
  return { inline_keyboard: [[
    { text: '▶️ Делать', callback_data: `${CALLBACK_PREFIX}|do|${id}` },
    { text: '✖️ Отменить', callback_data: `${CALLBACK_PREFIX}|no|${id}` },
  ]] };
}

function _mtime(projectDir) {
  try { return fs.statSync(path.join(projectDir, 'checklist.md')).mtimeMs; } catch { return 0; }
}

// Состояние записи против текущего файла. Возвращает checklist, если секция всё ещё
// активна и открыта; иначе помечает doneAt и возвращает null.
function _refresh(rec, now) {
  const cl = gtd().readChecklist(rec.projectDir);
  const sameSection = cl && (cl.goal || null) === (rec.goal || null) && cl.items.length;
  if (!sameSection || !openItems(cl).length) {
    if (!rec.doneAt) rec.doneAt = now;
    return null;
  }
  if (cl.cancelled && !rec.cancelledAt) rec.cancelledAt = now;
  return cl;
}

// Тик (из gtd-controller._runDueInner): одно напоминание на (секция, хэш пунктов).
async function remindDue({ secrets = {}, baseUsersDir, now = Date.now(), isSessionRunning = null, notify = null, botTokenFor = null, maxPerTick = MAX_REMINDERS_PER_TICK }) {
  let users = [];
  try { users = fs.readdirSync(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u)); } catch { return 0; }
  const send = notify || gtd()._tgNotify;
  const tokenFor = botTokenFor || ((audience) => {
    // Default-audience secrets carry the token as BOT_TOKEN only (src/secrets.js);
    // deliverySecrets adds TELEGRAM_BOT_TOKEN just for non-default bots.
    try { const s = require('./bot-delivery').deliverySecrets(secrets, audience || 'default'); return s?.TELEGRAM_BOT_TOKEN || s?.BOT_TOKEN || null; }
    catch { return null; }
  });
  let sent = 0;
  for (const username of users) {
    const workDir = path.join(baseUsersDir, username);
    if (!fs.existsSync(storePath(workDir))) continue;
    const store = loadStore(workDir);
    let dirty = false;
    for (const rec of Object.values(store.records)) {
      if (sent >= maxPerTick) break;
      if (!rec || rec.cancelledAt || rec.doneAt) continue;
      const cl = _refresh(rec, now);
      if (!cl) { dirty = true; continue; }
      if (rec.cancelledAt) { dirty = true; continue; }
      if (!isOrphan({ workDir, username, projectDir: rec.projectDir, checklist: cl, isSessionRunning })) continue;
      const hash = openHash(cl);
      if (rec.remindedHash === hash) continue;                                  // по этим пунктам уже напоминали
      if (rec.remindedAt && now - rec.remindedAt < REMIND_MIN_GAP_MS) continue; // ≤ 1 в сутки на секцию
      if (now - Math.max(rec.firstSeenAt || now, _mtime(rec.projectDir)) < REMIND_AFTER_MS) continue;
      if (!rec.chatId) continue;
      const token = tokenFor(rec.audience);
      if (!token) continue;
      _upsert(store, { workDir, projectDir: rec.projectDir, checklist: cl, username, audience: rec.audience, now });
      // Отметку пишем ДО отправки: краш после send не должен дать дубль.
      rec.remindedAt = now; rec.remindedHash = hash;
      saveStore(workDir, store);
      const messageId = await Promise.resolve(send(token, rec.chatId, reminderText(rec), rec.threadId, { reply_markup: keyboard(rec.id) })).catch(() => null);
      rec.reminderMessageId = messageId ?? null;
      dirty = true;
      sent++;
      console.log(`[orphan-checklists] reminded user=${username} «${rec.label}» chat=${rec.chatId}`);
    }
    if (dirty) saveStore(workDir, store);
    if (sent >= maxPerTick) break;
  }
  return sent;
}

function _projectDirs(workDir) {
  const projects = require('./projects');
  const out = [];
  for (const p of projects.listProjects(workDir, null)) {
    out.push({ projectDir: projects.projectDir(workDir, p.id), projectName: p.name || p.id });
  }
  out.push({ projectDir: workDir, projectName: 'профиль' });
  return out;
}

// BV-08a: все осиротевшие, не отменённые, незакрытые секции профиля.
function listForgotten({ workDir, username, audience = 'default', chatId = null, threadId = null, isSessionRunning = null, now = Date.now(), markShown = true }) {
  if (!workDir) return [];
  const G = gtd();
  const store = loadStore(workDir);
  const out = [];
  for (const { projectDir, projectName } of _projectDirs(workDir)) {
    const cl = G.readChecklist(projectDir);
    if (!cl || !cl.items.length) continue;
    if (!isOrphan({ workDir, username, projectDir, checklist: cl, isSessionRunning })) continue;
    const known = store.records[sectionId(projectDir, cl.goal)];
    if (known && known.cancelledAt) continue;
    const rec = _upsert(store, { workDir, projectDir, checklist: cl, username, audience, chatId, threadId, now });
    if (markShown) { rec.remindedAt = rec.remindedAt || now; rec.remindedHash = rec.openHash; rec.listedAt = now; }
    out.push({ id: rec.id, label: rec.label, projectName, projectDir, openCount: rec.openCount, firstOpen: rec.firstOpen });
  }
  if (out.length) saveStore(workDir, store);
  return out;
}

function listEntryText(e) {
  return `🔁 «${e.label}» · ${e.projectName}\nОткрыто пунктов: ${e.openCount}. Первый: «${e.firstOpen || '…'}»`;
}

function _projectIdFor(workDir, projectDir) {
  const projects = require('./projects');
  if (path.resolve(path.dirname(projectDir)) !== path.resolve(projects.projectsRoot(workDir))) return null;
  const id = path.basename(projectDir);
  return projects.getProject(workDir, id) ? id : null;
}

// «▶️ Делать» / «✖️ Отменить». Детерминированно, без LLM. Возвращает
// { ok, status, text, sessionId? } — text идёт в правку сообщения с кнопками.
function act({ workDir, username, id, action, chatId = null, threadId = null, audience = null, now = Date.now() }) {
  if (!workDir || !id || !/^[a-f0-9]{6,40}$/.test(String(id))) return { ok: false, status: 'bad-request', text: '⚠️ Некорректная кнопка' };
  const G = gtd();
  const store = loadStore(workDir);
  const rec = store.records[id];
  if (!rec) return { ok: false, status: 'not-found', text: '⚠️ Чек-лист не найден — возможно, уже закрыт' };
  const label = rec.label || 'чек-лист';

  if (action === 'no') {
    if (!rec.cancelledAt) rec.cancelledAt = now;
    const cl = G.readChecklist(rec.projectDir);
    // Отметку в файл пишем только если активна та же секция (иначе пометили бы чужую).
    if (cl && (cl.goal || null) === (rec.goal || null) && cl.items.length) G.markChecklistCancelled(rec.projectDir, { now });
    // «Делать» → потом «Отменить»: гасим доводку, которую завели кнопкой (только её).
    for (const r of G.listGtd(workDir)) {
      if (r && r.status === 'open' && r.source === 'orphan-checklist' && r.projectDir === rec.projectDir) {
        r.status = 'closed'; r.closedReason = 'user-cancel';
        G.writeGtd(workDir, r);
      }
    }
    saveStore(workDir, store);
    return { ok: true, status: 'cancelled', text: `✖️ Отменено: «${label}»` };
  }
  if (action !== 'do') return { ok: false, status: 'bad-request', text: '⚠️ Некорректная кнопка' };
  if (rec.cancelledAt) return { ok: true, status: 'cancelled', text: `✖️ Уже отменено: «${label}»` };

  const cl = _refresh(rec, now);
  if (!cl) { saveStore(workDir, store); return { ok: true, status: 'done', text: `✅ Уже закрыт: «${label}»` }; }
  const tracking = G.listGtd(workDir).find(r => r && r.status === 'open' && r.projectDir === rec.projectDir);
  if (tracking) {
    rec.doingAt = rec.doingAt || now;
    saveStore(workDir, store);
    return { ok: true, status: 'already-running', sessionId: tracking.sessionId, text: `▶️ Уже в работе: «${label}»` };
  }

  // Отдельный фоновый запуск: сессия-владелец, если она жива, иначе новая сессия
  // (НЕ текущая сессия чата — chatId не передаём, чтобы не сдвинуть указатель чата).
  const sessions = require('./session-store');
  const aud = audience || rec.audience || 'default';
  let sessionId = cl.owner && sessions.getSession(workDir, cl.owner) ? cl.owner : null;
  if (!sessionId) {
    sessionId = sessions.createSession(workDir, {
      task: `🔁 Доводка чек-листа: ${label}`,
      chatId: null, projectId: _projectIdFor(workDir, rec.projectDir), audience: aud,
    });
  }
  G.setChecklistOwner(rec.projectDir, sessionId);
  const replyChat = chatId != null ? String(chatId) : rec.chatId;
  const tid = Number(threadId != null ? threadId : rec.threadId);
  const fresh = G.readChecklist(rec.projectDir) || cl;
  const gtdRec = {
    sessionId, chatId: replyChat || null,
    threadId: Number.isInteger(tid) && tid > 0 ? tid : null,
    username: username || rec.username || null,
    audience: aud,
    createdAt: now,
    dueAt: now, // стреляет на ближайшем тике (роут дёргает тик сразу)
    etaMinutes: G.ETA_MIN_CLAMP,
    iterations: 0,
    maxIterations: G.computeMaxIterations(fresh),
    status: 'open',
    originalTask: fresh.goal || label,
    goals: fresh.goal ? [fresh.goal] : [],
    projectDir: rec.projectDir,
    label,
    source: 'orphan-checklist',
    lastFiredAt: null,
    closedReason: null,
    consecutiveNoProgress: 0,
  };
  G.writeGtd(workDir, gtdRec);
  rec.doingAt = now;
  rec.owner = sessionId;
  saveStore(workDir, store);
  console.log(`[orphan-checklists] do user=${username} «${label}» session=${sessionId}`);
  return { ok: true, status: 'started', sessionId, text: `▶️ Взял в работу: «${label}»` };
}

module.exports = {
  STORE_FILE, REMIND_AFTER_MS, REMIND_MIN_GAP_MS, CALLBACK_PREFIX,
  storePath, loadStore, sectionId, openHash, makeLabel, findRecord,
  isOrphan, noteSkipped, remindDue, listForgotten, listEntryText, reminderText, keyboard, act,
};
