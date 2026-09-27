const path = require('path');
const { EventEmitter } = require('events');
const { webAuth } = require('./web-auth');
const { listSessions, getSession, getCurrentSessionId } = require('./session-store');
const { isTaskRunning, isSessionRunning, isSessionQueuedFor, runTask, stopSessionTask } = require('./runner');
const { userWorkDir, SYSTEM_ROOT } = require('./data-paths');
const { readTrace } = require('./session-trace');
const { newWebSessionId, webCanaryEnabled } = require('./core/web-conversation');

// Per-task SSE emitters: taskId → EventEmitter
const taskEmitters = new Map();

const PING_INTERVAL_MS = 15_000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function webMutationReceiptPath(username, requestId) {
  return path.join(SYSTEM_ROOT, 'web-mutations', username, `${requestId}.json`);
}

// A web task in flight always has its pending-tasks journal record (runner's
// savePendingTask). After a restart, boot resume clears every web record (web
// tasks have no Telegram audience, so isTaskResumable is false) — so a receipt
// WITHOUT a journal record is a crash orphan, not a running task.
function webTaskJournalRecordExists(username, requestId) {
  const fs = require('fs');
  try {
    return fs.existsSync(path.join(SYSTEM_ROOT, 'pending-tasks', `${username}-web-${requestId}.json`));
  } catch { return false; }
}

// Durable claim: create-once with O_EXCL semantics. A duplicate requestId can
// never start a second agent task while the first is genuinely alive.
//
// Takeover rule (#web-task-restart-recovery, 2026-09-26 incident): a receipt
// whose task completed (state 'done') blocks forever — correct. But a receipt
// orphaned by a process restart (state 'accepted', task journal already
// cleared) or left by a failed attempt (state 'error') used to 409 the retry
// forever with the lie "already accepted" — the user's draft was permanently
// poisoned. Now a retry takes the receipt over when the task is provably not
// running: no journal record AND the receipt is older than the claim/flight
// race window (a fresh double-submit within WEB_MUTATION_TAKEOVER_MS still
// 409s, as does any in-flight task).
const WEB_MUTATION_TAKEOVER_MS = 15_000;

function claimWebMutation(username, requestId, meta = {}) {
  if (!requestId) return { claimed: true, receipt: null };
  if (!USERNAME_RE.test(username) || !REQUEST_ID_RE.test(requestId)) {
    return { claimed: false, invalid: true, receipt: null };
  }
  const fs = require('fs');
  const fp = webMutationReceiptPath(username, requestId);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const receipt = {
    requestId, username, state: 'accepted', acceptedAt: Date.now(),
    kind: meta.kind || null, sessionId: meta.sessionId || null,
  };
  const writeReceipt = (data) => {
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fp);
  };
  try {
    const fd = fs.openSync(fp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(receipt, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { claimed: true, receipt };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch { return { claimed: false, receipt: { requestId, username, state: 'accepted' } }; }
    if (existing.state === 'done') return { claimed: false, receipt: existing };
    const lastTouch = existing.updatedAt || existing.acceptedAt || 0;
    const inFlight = webTaskJournalRecordExists(username, requestId)
      || (Date.now() - lastTouch) < WEB_MUTATION_TAKEOVER_MS;
    if (inFlight) return { claimed: false, receipt: existing };
    const takeover = {
      ...receipt,
      attempt: (existing.attempt || 1) + 1,
      previousState: existing.state || null,
    };
    try { writeReceipt(takeover); } catch (e2) {
      console.warn('[web-mutation] takeover rewrite failed:', e2.message);
      return { claimed: false, receipt: existing };
    }
    return { claimed: true, receipt: takeover, takeover: true };
  }
}

function completeWebMutation(username, requestId, patch = {}) {
  if (!requestId || !USERNAME_RE.test(username) || !REQUEST_ID_RE.test(requestId)) return;
  const fs = require('fs');
  const fp = webMutationReceiptPath(username, requestId);
  try {
    const current = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const next = { ...current, ...patch, updatedAt: Date.now() };
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fp);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[web-mutation] receipt update failed:', e.message);
  }
}

// Shared session readers — used by both the cookie-authed /web/* routes below
// and the stateless bearer-gated /web/sessions-list, /web/session-get endpoints
// in server.js (the Cloudflare front-end delegates to those). Single source of
// truth so the external UI and the agent's own UI never drift.
function listSessionsFor(username, limit = 20) {
  const workDir = userWorkDir(username);
  const cap = Math.min(parseInt(limit, 10) || 20, 50);
  return listSessions(workDir, cap).map((s) => ({
    id: s.id,
    topic: s.topic,
    lastAt: s.lastAt,
    createdAt: s.createdAt,
    messageCount: s.messageCount,
    lastUserMessage: s.lastUserMessage,
    summary: s.summary || null,
    projectId: s.projectId || null,
    status: isSessionRunning(s.id) ? 'running' : (s.status || 'completed'),
  }));
}

function getSessionFor(username, sessionId) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const workDir = userWorkDir(username);
  // The file on disk is the source of truth, not the 50-entry recency index:
  // gating on the index made every older dialog (e.g. a «📜 Журнал» link to it)
  // fail with 404 → "Failed to load session". Open-by-id is audience-agnostic
  // (like resolveChatSession): every audience's session belongs to this same
  // profile, and a «📜 Журнал» tap in a recruiter/freelance bot chat links to
  // that bot's session — scoping here 404'd every such link. Only the list stays
  // scoped to the default audience (listSessionsFor).
  const session = getSession(workDir, sessionId);
  if (!session) return null;
  const meta = listSessions(workDir, Infinity, null).find(s => s.id === sessionId) || {};
  return {
    id: session.id,
    topic: session.topic,
    createdAt: session.createdAt,
    lastAt: session.lastAt,
    messageCount: session.messageCount,
    summary: session.summary || meta.summary || null,
    projectId: session.projectId || meta.projectId || null,
    audience: session.audience || 'default',
    status: isSessionRunning(sessionId) ? 'running' : (session.status || 'completed'),
    messages: session.messages || [],
  };
}

// Read the full working trace for one session (reasoning/tool/steps from the
// engine's own store — see session-trace.js). Returns { ok:false, error } when
// the session has no engine trace (claude-only, missing db, etc.).
function getTraceFor(username, sessionId) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'invalid session id' };
  const workDir = userWorkDir(username);
  const session = getSession(workDir, sessionId);
  if (!session) return { ok: false, error: 'session not found' };
  const res = readTrace(workDir, session);
  // Clamp: never expose engine internals the owner didn't ask for.
  if (!res.ok) return { ok: false, error: res.error, engine: res.engine || null };
  return res;
}

// Stop the running task for one session, scoped to the chat it's attached to
// (see stopUserTask's comment — a profile's workDir/activeTimers is shared
// across chats, so an unscoped kill would also hit a different chat's task).
// Shared by both the cookie-authed /web/stop/:id route and the bearer-gated
// /web/stop-bearer route (external frontends can't hold a WEB_JWT cookie).
function stopSessionFor(username, sessionId) {
  if (!sessionId) return false;
  // A brand-new Web session has no file until the runner creates it, but its
  // id is already known to the client (SSE 'session') — Stop must reach it.
  if (!getSession(userWorkDir(username), sessionId) && !isSessionQueuedFor?.(username, sessionId)) return false;
  return stopSessionTask(username, sessionId);
}

// Resolve session status: running (process alive) or from stored field, fallback completed
function sessionStatus(username, session) {
  if (isTaskRunning(username)) {
    // Only mark as running if this is the most recent session for the user
    // (activeTimers doesn't track per-session, only per-username)
    return 'running';
  }
  return session.status || 'completed';
}

/**
 * Handle all /web/* routes that use cookie auth (not Bearer AGENT_SECRET).
 * Returns true if the request was handled, false to fall through.
 */
async function handleWebRoute(req, url, res, secrets) {
  const p = url.pathname;

  if (!p.startsWith('/web/')) return false;

  // ── GET /web/sessions — list sessions for authenticated profile ──────────
  if (req.method === 'GET' && p === '/web/sessions') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const result = listSessionsFor(username, url.searchParams.get('limit') || '20');
    return json(res, 200, result), true;
  }

  // ── GET /web/session/:id — full session with messages ────────────────────
  if (req.method === 'GET' && p.startsWith('/web/session/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const sessionId = p.slice('/web/session/'.length);
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    const out = getSessionFor(username, sessionId);
    if (!out) return json(res, 404, { error: 'session not found' }), true;
    return json(res, 200, out), true;
  }

  // ── GET /web/session/:id/trace — full working log (reasoning/tools) ───────
  if (req.method === 'GET' && p.match(/^\/web\/session\/[^/]+\/trace$/)) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const sessionId = p.split('/')[3];
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    const trace = getTraceFor(username, sessionId);
    if (!trace.ok) {
      // Not an error the UI must scream about — the trace simply may not exist
      // (claude engine, pre-migration session). Signal it distinctly.
      return json(res, 200, { ok: false, error: trace.error, engine: trace.engine || null }), true;
    }
    return json(res, 200, { ok: true, engine: trace.engine, sessionId: trace.sessionId, events: trace.events, byMessage: trace.byMessage, ttlMs: trace.ttlMs }), true;
  }

  // ── GET /web/files/tree — directory tree inside profile workDir ──────────
  if (req.method === 'GET' && p === '/web/files/tree') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;

    const workDir = userWorkDir(username);
    const subPath = url.searchParams.get('path') || '';

    // Security: reject any path traversal attempt
    if (subPath.includes('..') || subPath.includes('\0')) return json(res, 400, { error: 'invalid path' }), true;

    const target = subPath ? path.join(workDir, subPath) : workDir;
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(workDir))) return json(res, 400, { error: 'path outside workdir' }), true;

    const tree = buildDirTree(resolved, workDir, 2);
    return json(res, 200, { root: workDir, tree }), true;
  }

  // ── POST /web/run — start a new task, stream via SSE ────────────────────
  if (req.method === 'POST' && p === '/web/run') {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }), true; }
    const { task, sessionId } = body || {};
    if (!task || typeof task !== 'string' || !task.trim()) return json(res, 400, { error: 'task required' }), true;

    return streamWebTask({ req, res, secrets, username, task: task.trim(), sessionId: sessionId || null }), true;
  }

  // ── POST /web/reply/:sessionId — resume a session ────────────────────────
  if (req.method === 'POST' && p.startsWith('/web/reply/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    const sessionId = p.slice('/web/reply/'.length);
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }), true; }
    const { message } = body || {};
    if (!message || typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'message required' }), true;

    return streamWebTask({ req, res, secrets, username, task: message.trim(), sessionId }), true;
  }

  // ── POST /web/stop/:sessionId — stop running task ────────────────────────
  if (req.method === 'POST' && p.startsWith('/web/stop/')) {
    const username = webAuth(req, secrets.WEB_JWT_SECRET);
    if (!username) return json(res, 401, { error: 'unauthorized' }), true;
    if (!checkOrigin(req, secrets)) return json(res, 403, { error: 'forbidden' }), true;

    const sessionId = p.slice('/web/stop/'.length);
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return json(res, 400, { error: 'invalid session id' }), true;

    const stopped = stopSessionFor(username, sessionId);
    return stopped
      ? (json(res, 200, { ok: true, sessionId }), true)
      : (json(res, 409, { ok: false, error: 'session is not running', sessionId }), true);
  }

  return false;
}

function buildDirTree(dir, root, maxDepth, currentDepth = 0) {
  const fs = require('fs');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const result = [];
  for (const entry of entries) {
    // Skip hidden files and the sessions sub-directory index
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'sessions.json') continue;

    const fullPath = path.join(dir, entry.name);
    // Use lstat to avoid following symlinks outside workDir
    let stat;
    try { stat = fs.lstatSync(fullPath); } catch { continue; }
    if (stat.isSymbolicLink()) continue;

    const relativePath = path.relative(root, fullPath);
    if (stat.isDirectory()) {
      const node = { name: entry.name, path: relativePath, type: 'dir' };
      if (currentDepth < maxDepth) {
        node.children = buildDirTree(fullPath, root, maxDepth, currentDepth + 1);
      }
      result.push(node);
    } else if (currentDepth > 0) {
      // Only include files at depth > 0 (not at root level — too noisy)
      result.push({ name: entry.name, path: relativePath, type: 'file' });
    }
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function checkOrigin(req, secrets) {
  const origin = req.headers['origin'] || '';
  const allowed = process.env.AGENT_PUBLIC_URL || 'http://localhost:3001';
  // Also allow localhost in dev
  if (origin === allowed) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

async function prepareWebTaskFiles(username, task, fileRefs, secrets = {}) {
  const workDir = userWorkDir(username);
  const engine = require('./profiles').getEngine(workDir, 0);
  return require('./intake-materializer').materializeFileRefs({
    workDir, username, fileRefs, task, engine,
    openrouterKey: secrets.OPENROUTER_API_KEY,
    gatewayUrl: process.env.MEDIA_GATEWAY_URL,
    agentSecret: secrets.AGENT_SECRET,
  });
}

async function streamWebTask({ req, res, secrets, username, task, sessionId, newSessionId = null, projectId = null, fileRefs = [], requestId = null }) {
  const workDir = userWorkDir(username);
  // Web ConversationRef canary (#1365 PR3): the run names its exact session.
  // A new Web task gets its id minted HERE (not read back from the shared
  // chat-0 pointer after the run), so parallel Web sessions never collapse.
  const webExactSession = webCanaryEnabled(username);
  const isNewWebSession = webExactSession && !sessionId;
  if (isNewWebSession) sessionId = newSessionId || newWebSessionId();
  const taskId = requestId ? `${username}-web-${requestId}` : `${username}-web-${Date.now()}`;

  const emitter = new EventEmitter();
  taskEmitters.set(taskId, emitter);

  // Start SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const ping = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch {}
  }, PING_INTERVAL_MS);

  emitter.on('chunk', text => send({ type: 'chunk', text }));
  emitter.on('done', sessionId => send({ type: 'done', sessionId }));
  emitter.on('error', err => send({ type: 'error', error: err }));
  emitter.on('progress', label => send({ type: 'progress', message: label }));

  req.on('close', () => {
    clearInterval(ping);
    taskEmitters.delete(taskId);
  });

  // Exact session known up front → the client can Stop / navigate a brand-new
  // run before it finishes (legacy path only learns the id on 'done').
  if (webExactSession) send({ type: 'session', sessionId });

  const finish = (eventName, payload) => {
    emitter.emit(eventName, payload);
    clearInterval(ping);
    taskEmitters.delete(taskId);
    try { res.end(); } catch {}
  };

  // 'done' must mean the user got an answer. runTask swallows admission/queue
  // failures (it resolves undefined after logging), and some answers never pass
  // through outputCallback (quick answers, early-return notices are returned as
  // the resolved string). So: forward a returned string that wasn't streamed,
  // and if nothing was streamed, returned or persisted → report an error.
  const startedAt = Date.now();
  let streamed = false;
  const answerPersisted = (id) => {
    if (!id) return false;
    try {
      const last = (getSession(workDir, id)?.messages || []).at(-1);
      return !!last && last.role === 'assistant' && (last.at || 0) >= startedAt;
    } catch { return false; }
  };

  // runTask returns a Promise that resolves when Claude exits
  runTask({
    taskId,
    user: { id: 0, name: username, username, workDir },
    task,
    context: '',
    sessionId: sessionId || undefined,
    ...(webExactSession && { webExactSession: true, forceNew: isNewWebSession }),
    secrets: { TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN, ...secrets },
    initialMsgId: null,
    pinnedMsgId: null,
    projectId: projectId || null,
    fileRefs,
    // #1671: a restart resumes this run in the same engine session and closes the
    // receipt itself (the SSE stream dies with the process; the answer lands in the
    // web session the client re-reads).
    resumeSink: { kind: 'web', username, requestId },
    outputCallback: (text) => { streamed = true; emitter.emit('chunk', text); },
    onProgress: (label) => emitter.emit('progress', label),
  }).then((result) => {
    if (!streamed && typeof result === 'string' && result.trim()) {
      streamed = true;
      emitter.emit('chunk', result);
    }
    // sessionId may have been created inside _runTask. The runner persists the
    // active session id per-workDir, so read it back to tell the client which
    // session to navigate to (critical for brand-new tasks where sessionId was null).
    let realId = sessionId || null;
    if (!realId && !webExactSession) {
      try { realId = getCurrentSessionId(workDir) || null; } catch {}
    }
    if (!streamed && !answerPersisted(realId)) {
      const error = 'Задача завершилась без ответа — попробуй отправить ещё раз.';
      completeWebMutation(username, requestId, { state: 'error', error, sessionId: realId || null, taskId });
      return finish('error', error);
    }
    completeWebMutation(username, requestId, { state: 'done', sessionId: realId || null, taskId });
    finish('done', realId);
  }).catch((err) => {
    completeWebMutation(username, requestId, { state: 'error', error: err?.message || 'task failed', taskId });
    finish('error', err?.message || 'task failed');
  });
}

module.exports = {
  handleWebRoute, listSessionsFor, getSessionFor, getTraceFor, prepareWebTaskFiles,
  claimWebMutation, completeWebMutation, streamWebTask, stopSessionFor,
};
