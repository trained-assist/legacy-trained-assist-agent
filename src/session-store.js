const fs = require('fs');
const path = require('path');
const { atomicJson } = require('./atomic-json');

const SESSIONS_FILE = 'sessions.json';
const SESSIONS_DIR  = 'sessions';
const MAX_SESSIONS  = 50; // keep last N per user

function sessionsPath(workDir) {
  return path.join(workDir, SESSIONS_FILE);
}

function sessionFilePath(workDir, id) {
  return path.join(workDir, SESSIONS_DIR, `${id}.json`);
}

function loadIndex(workDir) {
  try {
    const p = sessionsPath(workDir);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    try {
      const raw = fs.readFileSync(sessionsPath(workDir), 'utf8').slice(0, 200);
      console.warn('[session-store] loadIndex corrupted:', e.message, '| content:', raw);
    } catch { console.warn('[session-store] loadIndex:', e.message); }
    return [];
  }
}

// All durable writes go through atomic-json (tmp + fsync + rename + dir fsync): a
// restart mid-write must never leave a torn sessions.json / session file behind.
// The local `${fp}.tmp` helper used here previously had no fsync and a fixed tmp
// suffix, so two processes writing one file could collide (issue #1735 step 6).

/** Order by recency of activity (lastAt), newest first. Falls back to createdAt
 *  for legacy records missing lastAt. Mutates and returns the same array. */
function sortByRecency(sessions) {
  return sessions.sort((a, b) => (b.lastAt || b.createdAt || 0) - (a.lastAt || a.createdAt || 0));
}

function saveIndex(workDir, sessions) {
  // Single source of truth: the on-disk index is always ordered by recency of
  // activity and capped at MAX_SESSIONS. This keeps the session picker and the
  // gateway's reply-classifier fed with genuinely recent sessions, and makes
  // eviction drop the least-recently-active rather than the oldest-created.
  const ordered = sortByRecency(sessions);
  if (ordered.length > MAX_SESSIONS) ordered.splice(MAX_SESSIONS);
  atomicJson(sessionsPath(workDir), ordered, { space: 2 });
}

/** Create a new session record, return its id.
 *  `projectId` anchors the session to a project folder (see projects.js). Optional —
 *  legacy/un-migrated profiles create sessions with projectId=null and behave as before.
 *  `audience` scopes the session to a bot/surface (e.g. 'recruiter') sharing the same
 *  username+chatId (see AUDIENCE-SCOPE-SPEC). Defaults to 'default' — omitting it, or
 *  passing 'default' explicitly, is byte-for-byte identical to the pre-audience behavior. */
// Telegram forum topic = the update's `message_thread_id` (#1409). Only a positive
// integer is a topic; anything else means "no topic" (private chat / non-forum group).
function normThreadId(t) {
  const n = typeof t === 'string' && /^\d+$/.test(t) ? Number(t) : t;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The topic a session belongs to. `undefined` = legacy record written before #1409
// (topic unknown); `null` = explicitly no topic; number = that forum topic.
function threadOf(session) {
  if (!session || !Object.prototype.hasOwnProperty.call(session, 'messageThreadId')) return undefined;
  return normThreadId(session.messageThreadId);
}

// Does `session` belong to the conversation (telegramChatId, message_thread_id)?
// A foreign chat or a foreign topic → false. Legacy topic-less records match on chat only.
function belongsToConversation(session, chatId, threadId) {
  const attached = session?.liveChatId ?? session?.ownerChatId;
  if (attached && String(attached) !== String(chatId)) return false;
  const t = threadOf(session);
  return t === undefined || t === normThreadId(threadId);
}

// `sideSession: true` writes only the session file, not the index: the record exists for
// qa_more escalation (src/quick-reply.js) but must not show up in the picker/journal or
// evict real dialogs from the MAX_SESSIONS index. promoteSideSession() indexes it once
// the user actually escalates it into a dialog.
function createSession(workDir, { task, id: providedId, chatId, projectId = null, audience, threadId, sideSession = false, pending = false }) {
  const id = providedId || `s-${Date.now()}`;
  const topic = task.slice(0, 80).replace(/\s+/g, ' ').trim();
  const now = Date.now();
  const aud = audience || 'default';

  // `pending: true` (#1867) mints the file for an id the caller is about to hand out,
  // with NO messages yet: the runner records the user turn at its usual point, so a
  // pre-recorded task would show up twice in the prompt and frame the first message
  // as "[Продолжение сессии]". The id is durable either way — a restart in the window
  // between mint and first append leaves an empty-but-openable session, not a 404.
  const meta = pending
    ? { id, topic, projectId: projectId || null, audience: aud, createdAt: now, lastAt: now, messageCount: 0 }
    : { id, topic, projectId: projectId || null, audience: aud, createdAt: now, lastAt: now, messageCount: 1, lastUserMessage: topic, lastMessageRole: 'user' };

  if (!sideSession) {
    const sessions = loadIndex(workDir);
    sessions.unshift(meta);
    saveIndex(workDir, sessions); // saveIndex orders by recency and caps at MAX_SESSIONS
  }

  // Write full session file
  const dir = path.join(workDir, SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = {
    ...meta,
    liveChatId: chatId || null, // chat the session is currently attached to (renamed from ownerChatId; roams via /sessions)
    // Telegram `message_thread_id` of the forum topic (#1409). Written only when the caller
    // knows it (null = no topic); an omitted threadId leaves the topic unknown (legacy
    // semantics) instead of wrongly pinning the session to "no topic".
    ...(threadId !== undefined && chatId ? { messageThreadId: normThreadId(threadId) } : {}),
    projectId: projectId || null,
    ...(sideSession ? { sideSession: true } : {}),
    messages: pending ? [] : [{ role: 'user', content: task, at: now }],
  };
  atomicJson(sessionFilePath(workDir, id), full, { space: 2 });

  // Register the new session as the chat's CURRENT session immediately — durable at
  // creation, not deferred until after the (long) Claude run. Otherwise a follow-up
  // arriving mid-run, or a crash before the run finishes («on sdoh»), leaves the
  // freshly-created session orphaned: getCurrentSessionId returns null, the next
  // message spawns a brand-new context-blind session, and the accumulated ТЗ is lost
  // (issue #531). setCurrentSessionId is idempotent with the later runner calls.
  if (chatId) setCurrentSessionId(workDir, id, chatId, audience, threadId ?? null);

  return id;
}

/** Index a side session (createSession sideSession:true) once it becomes a real dialog. */
function promoteSideSession(workDir, id) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return false;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!full.sideSession) return false;
    delete full.sideSession;
    atomicJson(fp, full, { space: 2 });
    const sessions = loadIndex(workDir);
    if (!sessions.some(s => s.id === id)) {
      const lastUser = [...(full.messages || [])].reverse().find(m => m.role === 'user');
      sessions.unshift({
        id, topic: full.topic, projectId: full.projectId || null, audience: full.audience || 'default',
        createdAt: full.createdAt, lastAt: full.lastAt || Date.now(), messageCount: full.messageCount || (full.messages || []).length,
        lastUserMessage: String(lastUser?.content || full.topic || '').slice(0, 120),
        lastMessageRole: (full.messages || []).slice(-1)[0]?.role || 'user',
      });
      saveIndex(workDir, sessions);
    }
    return true;
  } catch (e) {
    console.warn('[session-store] promoteSideSession:', e.message);
    return false;
  }
}

/** Append user message to an existing session (before running Claude) */
function appendUserMessage(workDir, id, content) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const now = Date.now();
    // Compressor: skip a user message identical to the previous one. Restart storms
    // (resumePendingTasks) re-append the same "[ПРОДОЛЖЕНИЕ]" prompt once per restart,
    // stacking 3-10 identical lines into the session (observed: 3 in a row) and bloating
    // the context window for every later turn. Same content adds no information.
    const last = full.messages[full.messages.length - 1];
    if (last && last.role === 'user' && last.content === content) return;
    full.messages.push({ role: 'user', content, at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicJson(fp, full, { space: 2 });

    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].lastAt = now;
      sessions[idx].messageCount = full.messageCount;
      sessions[idx].lastUserMessage = content.slice(0, 120);
      sessions[idx].lastMessageRole = 'user';
    }
    saveIndex(workDir, sessions);
  } catch (e) {
    console.error('[session-store] appendUserMessage error:', e.message);
  }
}

/** Append assistant reply to an existing session */
function appendReply(workDir, id, reply) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const now = Date.now();
    full.messages.push({ role: 'assistant', content: reply, at: now });
    full.lastAt = now;
    full.messageCount = full.messages.length;
    atomicJson(fp, full, { space: 2 });

    // Update index
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].lastAt = now;
      sessions[idx].messageCount = full.messageCount;
      sessions[idx].lastMessageRole = 'assistant';
      sessions[idx].lastAssistantSnippet = reply.slice(0, 120);
    }
    saveIndex(workDir, sessions);
  } catch (e) {
    console.error('[session-store] appendReply error:', e.message);
  }
}

/** List sessions (index only, no message bodies).
 *  `audience` (default 'default') scopes the list so two bots sharing the same username
 *  don't see each other's sessions — a session with no `audience` field (every record on
 *  disk before this feature existed) counts as 'default'. Pass audience: null explicitly
 *  to bypass filtering entirely (internal/debug tools only — never an HTTP path reachable
 *  by an external bot). */
function listSessions(workDir, limit = 10, audience = 'default') {
  // Defensive re-sort: heals legacy indexes written before recency ordering,
  // so the picker/classifier get the most-recently-active sessions even on the
  // first read after upgrade (before any write re-orders the file).
  const all = sortByRecency(loadIndex(workDir));
  const filtered = audience === null
    ? all
    : all.filter(s => (s.audience || 'default') === audience);
  return filtered.slice(0, limit);
}

/** Mark a session body as ARCHIVED on its index record (epic #1784 M2,
 *  issue #1916 PR-D). `marker` = {key, sha256, size, at} — the stored object's
 *  identity, so a later materialize can integrity-check the download.
 *
 *  sessions.json has exactly ONE writer — saveIndex — so the marker goes through
 *  it like every other index mutation (the body/archive layer must not rewrite
 *  the index with its own copy of the rules: ordering, the MAX_SESSIONS cap and
 *  the atomic write all live here).
 *
 *  The READ is strict, unlike loadIndex: a corrupt index must throw, never be
 *  read as `[]` and written back — that would silently destroy every other
 *  record. Returns {marked:true} / {marked:false, reason} for the non-error
 *  misses (no index yet, no record for this id). */
function markSessionArchived(workDir, id, marker) {
  if (!id || !marker || typeof marker.key !== 'string') return { marked: false, reason: 'no marker' };
  const p = sessionsPath(workDir);
  if (!fs.existsSync(p)) return { marked: false, reason: 'no index' };
  let index;
  try {
    index = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${SESSIONS_FILE} is unreadable (${e.message}) — refusing to rewrite the index`);
  }
  if (!Array.isArray(index)) throw new Error(`${SESSIONS_FILE} is not a JSON array — refusing to rewrite the index`);
  const record = index.find(r => r && r.id === id);
  if (!record) return { marked: false, reason: `no index record for ${id}` };
  record.archived = marker;
  saveIndex(workDir, index);
  return { marked: true };
}

/** Index record for one session — the CHEAP lookup: no body read, so it answers
 *  "does this session exist / is it archived" even between runs, when the body
 *  itself lives only in GCS (epic #1784 M2). Returns null when the index has no
 *  such record. Deliberately never falls back to the file: callers use this to
 *  tell «archived» from «never existed», which is exactly what a body read
 *  cannot do once the body is gone. */
function getSessionRecord(workDir, id) {
  if (!id) return null;
  try {
    const sessions = loadIndex(workDir);
    return sessions.find(s => s && s.id === id) || null;
  } catch (e) {
    console.warn('[session-store] getSessionRecord:', e.message);
    return null;
  }
}

/** Get full session with messages */
function getSession(workDir, id) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[session-store] getSession:', e.message); return null; }
}

/** Build context string from a previous session (for Claude prompt prefix) */
function buildContext(workDir, sessionId, limit = 500, msgCount = 6) {
  const session = getSession(workDir, sessionId);
  if (!session) return null;
  // No exchanges yet (a `pending` shell minted for a web id, #1867): there is no
  // history to continue. Emitting only the "[Продолжение сессии …]" header would
  // both mislabel a first message and drop the current task into the context twice.
  if (!(session.messages || []).length) return null;

  const date = new Date(session.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const lines = [`[Продолжение сессии от ${date}]\nТема: "${session.topic}"\n`];

  for (const msg of session.messages.slice(-msgCount)) {
    const prefix = msg.role === 'user' ? 'Пользователь' : 'Клод';
    lines.push(`${prefix}: ${msg.content.slice(0, limit)}`);
  }

  return lines.join('\n');
}

const CURRENT_SESSION_FILE = 'current-session.json';
const CURRENT_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// `audience` distinguishes the current-session pointer file per bot/surface sharing the
// same chatId (see AUDIENCE-SCOPE-SPEC). Falsy or 'default' → EXACTLY the pre-existing
// filename, so every existing pointer on disk keeps resolving unchanged. Only a truthy
// non-default audience gets its own pointer file.
function _currentSessionFile(chatId, audience, threadId = null) {
  const suffix = Number.isInteger(threadId) && threadId > 0 ? `-${threadId}` : '';
  if (!audience || audience === 'default') {
    return chatId ? `current-session-${chatId}${suffix}.json` : CURRENT_SESSION_FILE;
  }
  return chatId ? `current-session-${audience}-${chatId}${suffix}.json` : `current-session-${audience}.json`;
}

function getCurrentSessionId(workDir, chatId, audience, threadId = null) {
  try {
    const fp = path.join(workDir, SESSIONS_DIR, _currentSessionFile(chatId, audience, threadId));
    if (!fs.existsSync(fp)) return null;
    const { id, lastAt } = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Date.now() - lastAt > CURRENT_SESSION_TTL_MS) return null;
    return id;
  } catch (e) { console.warn('[session-store] getCurrentSessionId:', e.message); return null; }
}

function setCurrentSessionId(workDir, id, chatId, audience, threadId = null) {
  try {
    const dir = path.join(workDir, SESSIONS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    atomicJson(path.join(dir, _currentSessionFile(chatId, audience, threadId)), { id, lastAt: Date.now() });
    // Update liveChatId in the session file so it knows which chat it's attached to
    if (id && chatId) {
      const fp = sessionFilePath(workDir, id);
      if (fs.existsSync(fp)) {
        const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const current = full.liveChatId ?? full.ownerChatId; // read-compat: pre-rename files store ownerChatId
        if (current !== chatId) {
          full.liveChatId = chatId;
          delete full.ownerChatId; // lazily migrate the field name on the durable record
          atomicJson(fp, full, { space: 2 });
        }
      }
    }
  } catch (e) {
    console.error('[session-store] setCurrentSessionId error:', e.message);
  }
}

/**
 * First-touch attachment claim for legacy / unattached sessions (issue #489).
 * Persists liveChatId ONLY when it is currently unset — never overwrites an
 * existing attachment. Returns the effective chatId (existing or newly set),
 * or null on failure / when chatId is falsy.
 * (Renamed from claimOwnerChatId; reads the pre-rename ownerChatId as a fallback.)
 */
function claimLiveChatId(workDir, id, chatId, threadId) {
  if (!id || !chatId) return null;
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return null;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const current = full.liveChatId ?? full.ownerChatId; // read-compat: pre-rename files store ownerChatId
    let dirty = false;
    if (!current) { full.liveChatId = chatId; dirty = true; }
    // Legacy record with an unknown topic (#1409): pin it to the first topic that
    // touches it, so a sibling topic of the same forum group can no longer adopt it.
    if (threadId !== undefined && threadOf(full) === undefined && (!current || String(current) === String(chatId))) {
      full.messageThreadId = normThreadId(threadId);
      dirty = true;
    }
    if (dirty) atomicJson(fp, full, { space: 2 });
    return current || chatId;
  } catch (e) {
    console.warn('[session-store] claimLiveChatId:', e.message);
    return null;
  }
}

/**
 * Sign-robust session resolution (chatId sign-split heal, issue: chatId-sign-split-session-loss).
 * The gateway remembers `lastSessionId` in its own KV and passes it back on the next
 * message. That id can diverge from what's actually on disk — historically the gateway
 * built ids with `Math.abs(chatId)` (`s-1003…`) while older sessions were keyed by the
 * raw negative chatId (`s--1003…`), so a group ended up with two session families. When
 * the passed id has no file on disk, blindly honoring it spawns a BLANK session and
 * orphans the accumulated ТЗ ("fresh session held only bare link → agent saw a fragment").
 *
 * The current-session pointer is keyed by the real chatId WITH its sign preserved
 * (`current-session--1003….json`), so it is the durable source of truth for "which
 * session does this chat continue". Resolution order:
 *   1. the explicit id, if its session file exists (normal path — no divergence);
 *      a session id, once known, is unambiguous — audience-agnostic by design.
 *   2. otherwise the chat's current-session pointer (scoped by `audience`, see
 *      _currentSessionFile), if it resolves to a real session;
 *   3. otherwise null — caller creates a fresh session.
 * Returns the id to use, or null.
 */
function resolveChatSession(workDir, sessionId, chatId, audience, threadId = null) {
  if (sessionId && getSession(workDir, sessionId)) return sessionId;
  if (chatId) {
    const pointerId = getCurrentSessionId(workDir, chatId, audience, threadId);
    const pointed = pointerId && getSession(workDir, pointerId);
    // A topic pointer that leads into another topic's session (the pre-#1409 bleed) is not ours.
    if (pointed && belongsToConversation(pointed, chatId, threadId)) return pointerId;
  }
  return null;
}

/** Persist a durable summary object onto a session (both index + full file).
 *  `atMsgCount` records the message count the summary reflects, so we know when
 *  it goes stale (see needsSummary). Idempotent; safe to call repeatedly. */
function setSummary(workDir, id, summary, atMsgCount) {
  if (!id || !summary) return false;
  try {
    const fp = sessionFilePath(workDir, id);
    let mc = atMsgCount;
    if (fs.existsSync(fp)) {
      const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (mc == null) mc = full.messageCount || (full.messages ? full.messages.length : 0);
      full.summary = summary;
      full.summaryMsgCount = mc;
      full.summaryAt = Date.now();
      atomicJson(fp, full, { space: 2 });
    }
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      if (mc == null) mc = sessions[idx].messageCount;
      sessions[idx].summary = summary;
      sessions[idx].summaryMsgCount = mc;
      sessions[idx].summaryAt = Date.now();
      saveIndex(workDir, sessions);
    }
    return true;
  } catch (e) {
    console.error('[session-store] setSummary error:', e.message);
    return false;
  }
}

// Rebind (or clear, id=null) the project a session belongs to. Used to self-heal a stale
// binding — e.g. the project folder was archived/merged in a reproject.js restructuring
// after this session last ran — so the NEXT message resolves fresh instead of repeating
// the same missing-folder situation forever.
function setSessionProject(workDir, id, projectId) {
  if (!id) return false;
  try {
    const fp = sessionFilePath(workDir, id);
    if (fs.existsSync(fp)) {
      const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
      full.projectId = projectId || null;
      atomicJson(fp, full, { space: 2 });
    }
    const sessions = loadIndex(workDir);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      sessions[idx].projectId = projectId || null;
      saveIndex(workDir, sessions);
    }
    return true;
  } catch (e) {
    console.error('[session-store] setSessionProject error:', e.message);
    return false;
  }
}

// OpenCode model ladder can degrade between two turns of the same session (issue #1061
// Фаза 4) — the resolved model for a role isn't part of the visible transcript, so track
// it separately per session to detect a silent swap and tell the user explicitly.
function getLastOcModel(workDir, id, role) {
  const full = getSession(workDir, id);
  return full?.ocModels?.[role] || null;
}

function setLastOcModel(workDir, id, role, model) {
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    full.ocModels = full.ocModels || {};
    full.ocModels[role] = model;
    atomicJson(fp, full, { space: 2 });
  } catch (e) {
    console.error('[session-store] setLastOcModel error:', e.message);
  }
}

// Native session id of the underlying engine CLI (claude `session_id` / codex `thread_id` /
// opencode `sessionID`), keyed by engine. The agent session id (`s-…`) is our own; this is the
// CLI's, and it is what makes a real native resume possible after a restart (issue #1234).
// A session can switch engines mid-life (/switch2*), so keep one id per engine.
function getEngineSessionId(workDir, id, engine) {
  const full = getSession(workDir, id);
  return full?.engineSessions?.[engine] || null;
}

function setEngineSessionId(workDir, id, engine, engineSessionId) {
  if (!id || !engine || !engineSessionId) return false;
  try {
    const fp = sessionFilePath(workDir, id);
    if (!fs.existsSync(fp)) return false;
    const full = JSON.parse(fs.readFileSync(fp, 'utf8'));
    full.engineSessions = full.engineSessions || {};
    if (full.engineSessions[engine] === engineSessionId) return true; // idempotent — skip the rewrite
    full.engineSessions[engine] = engineSessionId;
    atomicJson(fp, full, { space: 2 });
    return true;
  } catch (e) {
    console.warn('[session-store] setEngineSessionId:', e.message);
    return false;
  }
}

/** True when a session's stored summary is missing or stale (messages grew since). */
function needsSummary(meta) {
  if (!meta) return false;
  if (!meta.summary || !meta.summary.title) return true;
  return (meta.summaryMsgCount || 0) !== (meta.messageCount || 0);
}

/** Archive (remove) sessions by id; returns count actually removed */
function archiveSessions(workDir, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return 0;
  const idSet = new Set(sessionIds);
  const sessions = loadIndex(workDir);
  const remaining = sessions.filter(s => !idSet.has(s.id));
  const archived = sessions.length - remaining.length;
  if (archived > 0) {
    saveIndex(workDir, remaining);
    for (const id of idSet) {
      try { fs.unlinkSync(sessionFilePath(workDir, id)); } catch (e) { console.warn('[session-store] archiveSessions unlink:', e.message); }
    }
  }
  return archived;
}

module.exports = {
  createSession, promoteSideSession, appendUserMessage, appendReply, listSessions, getSession, getSessionRecord, buildContext,
  getCurrentSessionId, setCurrentSessionId, claimLiveChatId, normThreadId, threadOf, belongsToConversation, resolveChatSession, archiveSessions, setSummary, needsSummary,
  markSessionArchived,
  getLastOcModel, setLastOcModel, setSessionProject,
  getEngineSessionId, setEngineSessionId,
  // Back-compat alias for the pre-rename name (see PROFILE-RENAME-SPEC.md); remove once no caller uses it.
  claimOwnerChatId: claimLiveChatId,
};
