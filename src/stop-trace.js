'use strict';
// «Стоп» — trace-id + timestamp-гейт (spec: docs/user-scenarios/core/02-stop-and-supplement.md §2,
// ревизия: traceId вместо реестра taskChainId — см. §2а в этом же документе).
//
// ТРЕЙС — это адрес диалога/сессии, в которой бежит задача. Он ВЫВОДИТСЯ из тех же
// координат, что и admission-lane (src/core/execution-context.js): для Telegram это
// ключ диалога (bot+chat+topic), для web — профиль+сессия. Ничего хранить не надо:
// и ран, и Стоп считают trace из своих координат и получают один и тот же ключ.
//
// ГЕЙТ: новый спавн блокируется тогда и только тогда, когда
//     !fromUser && initiatedAt <= stoppedAt(trace)
// то есть блокируются только ВНУТРЕННИЕ хопы (ретраи, продолжения, GTD, durable,
// resume), чей `initiatedAt` (момент исходного запроса юзера) старше отметки Стопа.
// Любой новый запрос юзера (`fromUser`, POST /run и web-раны) проходит всегда — K1
// выполняется структурно, без реестра цепочек: старого запроса, пережившего Стоп,
// в системе не появляется, потому что он не мог быть принят ПОСЛЕ отметки Стопа.
// Стоп переживает рестарт — отметка лежит на диске (K14), TTL 24ч ограничивает
// любую ошибку.
//
// Fail-open намеренно: непрочитанная/отсутствующая отметка, отсутствующий trace или
// неизвестный `initiatedAt` ⇒ спавн идёт (поведение как сегодня). Цена fail-open —
// один ускользнувший респавн; цена fail-closed — заблокированный агент, чем этот
// фича ни при каких обстоятельствах не имеет права становиться.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stoppedTracesDir } = require('./data-paths');
const { atomicJson } = require('./atomic-json');
const { fromLegacyTelegram, conversationKey } = require('./core/conversation-ref');

const STOP_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

// The one user-stop reply prefix shared by every surface that reports a stop:
// '⛔ Остановлено\n…', '⛔ Остановлено. Можешь…', '⛔ Остановлено до начала…'.
// Deliberately NOT matching the loop-guard message '⛔ Остановлено: модель…' —
// a stuck model is a failure to retry, not a user action.
const STOPPED_REPLY_RE = /^⛔ Остановлено(?!\s*:)/;

function hasChat(chatId) {
  return chatId != null && chatId !== 0 && chatId !== '0' && chatId !== '';
}

/**
 * Trace = адрес диалога (TG: bot+chat+topic) или пары профиль+сессия (web).
 * Возвращает null, когда адреса нет (chatId 0 без sessionId) — гейт тогда
 * ничего не блокирует (fail-open), а не угадывает.
 */
function traceIdFor({ chatId, audience, threadId, username, sessionId } = {}) {
  if (hasChat(chatId)) {
    let ref = null;
    try { ref = fromLegacyTelegram({ chatId, audience, threadId }); }
    catch { /* unknown audience — берём legacy-ключ ниже, lane всё равно сериализуется */ }
    if (ref) return `tg:${conversationKey(ref)}`;
    return `tg-legacy:${audience || 'default'}|${String(chatId)}|${threadId || ''}`;
  }
  if (username && sessionId) return `web:${username}:${sessionId}`;
  return null;
}

// traceId носит '|' и '%' — в имя файла идёт только хеш (сам trace внутри JSON).
function tombstonePath(traceId) {
  if (typeof traceId !== 'string' || traceId.length === 0 || traceId.length > 512) return null;
  const digest = crypto.createHash('sha256').update(traceId).digest('hex').slice(0, 40);
  return path.join(stoppedTracesDir(), `${digest}.json`);
}

/**
 * Durably mark a trace as stopped by the user. Idempotent (повторный Стоп
 * обновляет отметку). Returns false when the id is unusable or the write fails;
 * callers treat a failed write as "not stopped" (fail-open).
 */
function markTraceStopped(traceId, meta = {}) {
  const file = tombstonePath(traceId);
  if (!file) {
    console.warn('[stop-trace] refusing to tombstone unusable traceId:', String(traceId).slice(0, 80));
    return false;
  }
  const now = Date.now();
  // Healing a corrupt record passes its own mtime as stoppedAt — never use
  // "now" there, that would block every run accepted before this second.
  const stoppedAt = Number.isFinite(meta.stoppedAt) ? meta.stoppedAt : now;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Атомарно (tmp+fsync+rename): оборванная запись не оставляет битый файл,
    // который читался бы fail-closed (см. traceStoppedAt).
    atomicJson(file, {
      traceId,
      stoppedAt,
      expiresAt: now + STOP_TOMBSTONE_TTL_MS,
      username: meta.username ?? null,
      chatId: meta.chatId ?? null,
      threadId: meta.threadId ?? null,
      audience: meta.audience ?? null,
      sessionId: meta.sessionId ?? null,
      reason: meta.reason || 'user-stop',
    }, { space: 2, mode: 0o600 });
    sweepStoppedTraces();
    return true;
  } catch (e) {
    console.warn(`[stop-trace] tombstone write failed: ${e.message}`);
    return false;
  }
}

/**
 * stoppedAt живой отметки трейса, иначе null. Fail-open на любую проблему чтения
 * (см. шапку). Протухшая отметка удаляется и считается «не останавливалось».
 */
function traceStoppedAt(traceId) {
  const file = tombstonePath(traceId);
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[stop-trace] read failed: ${e.message}`);
    return null; // missing → never stopped; unreadable → fail-open
  }
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) {
    // The file exists, so a Stop did happen — honour it (fail-closed per trace),
    // healing the record with the file's own mtime as stoppedAt (never "now":
    // that would block every run accepted before this very second).
    console.warn(`[stop-trace] corrupt tombstone, honouring stop: ${e.message}`);
    let mtime = Date.now();
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep now */ }
    markTraceStopped(traceId, { reason: 'healed-corrupt', stoppedAt: mtime });
    return mtime;
  }
  if (!rec.expiresAt || rec.expiresAt <= Date.now()) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return null;
  }
  return Number.isFinite(rec.stoppedAt) ? rec.stoppedAt : null;
}

/**
 * THE gate. Блокирует только внутренние хопы, у которых известен `initiatedAt`
 * и он не позже отметки Стопа. Вызывается из каждой точки спавна; `fromUser`
 * (POST /run, web-ран) снимает проверку целиком.
 */
function isRunStopped({ traceId, initiatedAt, fromUser = false } = {}) {
  if (fromUser) return false;
  if (!traceId) return false;
  if (!Number.isFinite(initiatedAt)) return false; // старые pending-записи без initiatedAt — fail-open
  const stoppedAt = traceStoppedAt(traceId);
  if (stoppedAt == null) return false;
  return initiatedAt <= stoppedAt;
}

/** Delete expired tombstones (called on every write — stops are rare, so this is cheap). */
function sweepStoppedTraces() {
  let dir;
  try { dir = fs.readdirSync(stoppedTracesDir()); }
  catch { return; }
  for (const f of dir) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(stoppedTracesDir(), f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { /* healed inline below — no markTraceStopped call, it re-enters this sweep */ }
    if (rec && rec.expiresAt && rec.expiresAt > Date.now()) continue;
    if (rec === null) {
      // Unparseable tombstone: heal it with a fresh full TTL instead of deleting —
      // it records a real Stop, deleting would silently un-stop the trace.
      // stoppedAt comes from the file's own mtime (see traceStoppedAt).
      const now = Date.now();
      let mtime = now;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep now */ }
      try {
        atomicJson(file, {
          traceId: null, stoppedAt: mtime, expiresAt: now + STOP_TOMBSTONE_TTL_MS,
          username: null, chatId: null, threadId: null, audience: null, sessionId: null,
          reason: 'healed-corrupt',
        }, { space: 2, mode: 0o600 });
      } catch { /* best-effort */ }
      continue;
    }
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

/**
 * Does this reply text mean "the user pressed Stop"? Used by gtd-controller and
 * the durable settle to treat a stop as terminal instead of a retryable failure
 * (R3/R4). A loop-guard message is excluded — see STOPPED_REPLY_RE.
 */
function isUserStoppedReply(text) {
  return typeof text === 'string' && STOPPED_REPLY_RE.test(text.trimStart());
}

module.exports = {
  traceIdFor,
  markTraceStopped,
  traceStoppedAt,
  isRunStopped,
  isUserStoppedReply,
  sweepStoppedTraces,
  STOPPED_REPLY_RE,
  STOP_TOMBSTONE_TTL_MS,
  _internals: { tombstonePath },
};
