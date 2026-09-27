// Acquire before modules can recover tasks: only one server may own the data directory.
const executionOwner = require('./execution-owner-lock').acquireExecutionOwner(require('./data-paths').SYSTEM_ROOT);
process.once('exit', () => executionOwner.close());
const { atomicJson } = require('./atomic-json');
const { deliverySecrets, taskDelivery } = require('./bot-delivery');
const { withDedupLock } = require('./request-dedup-lock');
const { isTaskResumable, resumeSinkOf } = require('./pending-task-resume');
const { isNonTaskMessage } = require('./resume-hygiene');
const { recordResume, getResumeStats } = require('./resume-stats');
const { getRetryDelayMs } = require('./retry-policy');
const { hhLib } = require('./domains/hh/lib');
const { refreshHhToken } = hhLib('hh-utils');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execSync, execFile, spawn } = require('child_process');
const path = require('path');
const { loadSecrets } = require('./secrets');
const { webAuth, signJwt, setTokenCookie, clearTokenCookie, switchProfileCookie, savePassword, checkPassword, generatePassword, generateMagicToken, consumeMagicToken, listAuthedProfiles } = require('./web-auth');
const { handleWebRoute } = require('./web-routes');
const { handleConnect } = require('./handlers/connect');
const { handleWeb } = require('./handlers/web');
const { handleInternal } = require('./handlers/internal');
const { runTokenFromAuthHeader } = require('./agent-run-tokens');
const { runTask, generateConnectLink, getQuickAnswer, getPendingTasks, clearPendingTask, interruptForRestart, reconcileSoftContinuations, MAX_RESUME_ATTEMPTS } = require('./runner');
const { runMcpTool } = require('./mcp-action');
const { computeSkillsList } = require('./capabilities-skills');
const { presentSiblings } = require('./skill-siblings');
const { isValidProjectId } = require('./valid-project-id');
const { trackChat, pollDriveChanges } = require('./drive-watcher');
const { listSessions, getSession: getSessionData, archiveSessions, getCurrentSessionId, needsSummary, setSummary, getEngineSessionId } = require('./session-store');
const { generateSummary } = require('./session-summary');
const { startGetcourseLogin } = require('./getcourse-login');
const { processMishaUpdate } = require('./misha-bot');
const { createHhNegotiations } = hhLib('hh-negotiations');

const profiles = require('./profiles');
const dataPaths = require('./data-paths');
const { installCrashGuards } = require('./stream-gone');

const PORT = process.env.PORT || 3001;
// Single source of truth (src/data-paths.js) — do not re-derive from HOME.
const BASE_USERS_DIR = dataPaths.USERS_ROOT;
const userWorkDir = dataPaths.userWorkDir;

// RU-IP edge (src/ru-edge.js, issue #1288) — thin RU-only service holding the
// nalog.ru/ESIA Playwright login (geo-blocked outside Russia). This agent never
// runs Playwright against lknpd.nalog.ru/gosuslugi.ru directly any more; it
// delegates over HTTP and the edge pushes the resulting token back via
// POST /nalog/token-store.
const RU_EDGE_URL = (process.env.RU_EDGE_URL || 'https://platform.recruiter-assistant.ru').replace(/\/$/, '');

// Delegates a nalog.ru login attempt to the RU edge (Playwright + Госуслуги/ESIA
// need a Russian IP). Mirrors the old local startNalogLogin() return shape:
// {status:'ok', expires} | {status:'need_code', sessionId} | {error}.
async function ruEdgeNalogStartLogin(userId, login, password) {
  try {
    const res = await fetch(`${RU_EDGE_URL}/nalog/start-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.AGENT_SECRET || ''}` },
      body: JSON.stringify({ userId, login, password }),
      signal: AbortSignal.timeout(90_000), // browser login can take 30-60s
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.error) return { error: `RU edge returned HTTP ${res.status}` };
    return data;
  } catch (e) {
    return { error: `Не удалось связаться с RU edge: ${e.message}` };
  }
}

// /run idempotency window (see the requestId handling below): in-memory only,
// resets on restart — acceptable because it's guarding against a retry racing
// the *same* process, not surviving a redeploy.
const recentRequestIds = new Map(); // requestId -> { taskId, at }
const REQUEST_ID_TTL_MS = 10 * 60 * 1000;
function seenRequestId(id) {
  const now = Date.now();
  for (const [k, v] of recentRequestIds) if (now - v.at > REQUEST_ID_TTL_MS) recentRequestIds.delete(k);
  return recentRequestIds.get(id)?.taskId || null;
}
function rememberRequestId(id, taskId) {
  recentRequestIds.set(id, { taskId, at: Date.now() });
}

// Token-save Telegram notices: suppress byte-identical repeats to the same chat
// (see src/tg-notice-dedupe.js) — stops automated/retried credential saves from
// spamming a chat with the same confirmation (duplicate flood of 2026-09-24).
const { createNoticeDeduper } = require('./tg-notice-dedupe');
const tokenNoticeDeduper = createNoticeDeduper();
const noticeAlreadySent = (chatId, text) => tokenNoticeDeduper.alreadySent(chatId, text);

// ZeroCreds destination preflight detection — see src/zerocreds-preflight.js.
const { isZeroCredsPreflight } = require('./zerocreds-preflight');

// Narrow ("specialized") bots delegate into a real profile instead of owning their
// own. @cmr_management_bot ("misha") IS Flexi Consulting — its data (6 expo projects,
// interviews, contexts) lives under the `flexi-consult` profile, so the bot must
// delegate there, not into an empty `misha` profile. Config-driven, not hardcoded,
// so future narrow bots just add an entry (bot key → owning profile).
const NARROW_BOTS = {
  misha: { profile: process.env.MISHA_PROFILE || 'flexi-consult' },
};

const VM_NAME = process.env.VM_NAME || 'unknown';
let RUNTIME_REVISION = 'unknown';
let GIT_COMMIT = 'unknown';
try { RUNTIME_REVISION = require('./release-info').getReleaseSha(); if (RUNTIME_REVISION) GIT_COMMIT = RUNTIME_REVISION.slice(0, 7); } catch {}

const { classifyMessage, CLASSIFY_MAX_AGE_MS } = require('./classify-message');
const { checkCompleteness } = require('./intake-gate');
const { startShadow: startInputRouterShadow } = require('./input-router');

function readChatId(username) {
  try { return fs.readFileSync(path.join(dataPaths.TOKENS_ROOT, String(username), '.chatid'), 'utf8').trim() || null; }
  catch { return null; }
}

function scheduleNalogExpiryChecks(secrets) {
  const notified = new Set();
  const AGENT_TOKENS_DIR = dataPaths.TOKENS_ROOT;
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  const NOTIFY_WINDOW_MS  = 10 * 60 * 1000; // notify if expired within last 10 min

  async function check() {
    if (!fs.existsSync(AGENT_TOKENS_DIR)) return;
    const now = Date.now();
    for (const username of fs.readdirSync(AGENT_TOKENS_DIR)) {
      const nalogFile = path.join(AGENT_TOKENS_DIR, username, 'nalog');
      if (!fs.existsSync(nalogFile)) continue;
      let tokenData;
      try { tokenData = JSON.parse(fs.readFileSync(nalogFile, 'utf8')); } catch { continue; }
      if (!tokenData.expires || !tokenData.auth_token) continue;
      const expiresMs = new Date(tokenData.expires).getTime();
      if (isNaN(expiresMs)) continue;
      const age = now - expiresMs;
      if (age < 0 || age > NOTIFY_WINDOW_MS) continue;
      const key = `${username}-${tokenData.expires}`;
      if (notified.has(key)) continue;
      notified.add(key);

      // Read the chatId stored by runner.js so we can send Telegram notification
      const chatIdFile = path.join(AGENT_TOKENS_DIR, username, '.chatid');
      let chatId;
      try { chatId = fs.readFileSync(chatIdFile, 'utf8').trim(); } catch { continue; }
      if (!chatId || !/^-?\d+$/.test(chatId)) continue;

      // If nalog-creds are saved, auto re-login without user interaction
      const nalogCredsFile = path.join(AGENT_TOKENS_DIR, username, 'nalog-creds');
      if (fs.existsSync(nalogCredsFile)) {
        let creds;
        try { creds = JSON.parse(fs.readFileSync(nalogCredsFile, 'utf8')); } catch {}
        if (creds && creds.login && creds.password) {
          console.log('[nalog-expiry] nalog-creds found for %s — auto re-login', username);
          const tgBase2 = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          fetch(`${tgBase2}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '🔄 Токен Налог.ру истёк — обновляю автоматически...' }),
          }).catch(() => {});
          ruEdgeNalogStartLogin(username, creds.login, creds.password).then(result => {
            let text;
            if (result.status === 'ok') {
              text = `✅ Налог.ру — токен обновлён автоматически. Действует до ${result.expires ? new Date(result.expires).toLocaleString('ru-RU') : '?'}.`;
            } else if (result.status === 'need_code') {
              const codeUrl = `${RU_EDGE_URL}/connect/nalog/code?sessionId=${result.sessionId}`;
              text = `📱 Нужен код из SMS для Госуслуг:\n\n👉 ${codeUrl}\n\nСсылка действительна 25 минут.`;
            } else {
              text = `❌ Не удалось обновить токен Налог.ру: ${result.error}\n\nСкажите «подключи налог» чтобы обновить данные.`;
            }
            fetch(`${tgBase2}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST', signal: AbortSignal.timeout(8000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text }),
            }).catch(() => {});
          }).catch(e => console.error('[nalog-expiry] auto re-login failed:', e.message));
          continue;
        }
      }

      // No saved creds — send ZeroCreds link to re-connect
      let connectUrl;
      try { connectUrl = await generateConnectLink(username, 'nalog-creds'); } catch (e) {
        console.error('[nalog-expiry] generateConnectLink failed:', e.message); continue;
      }
      const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
      await fetch(`${tgBase}/bot${secrets.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ Токен Налог.ру истёк. Войдите заново:\n\n👉 ${connectUrl}\n\nСсылка действительна 30 минут.`,
        }),
      }).catch(e => console.error('[nalog-expiry] tg notify failed:', e.message));
      console.log('[nalog-expiry] notified username=%s chatId=%s about expired token', username, chatId);
    }
  }

  const guardedCheck = () => check().catch(e => console.warn('[nalog-expiry]', e.message));
  setTimeout(guardedCheck, 60 * 1000); // first check 1 min after start (tokens may be fresh on restart)
  setInterval(guardedCheck, CHECK_INTERVAL_MS);
}

// Cached secrets for background tasks (HH OAuth refresh needs HH_CLIENT_ID/SECRET).
// Populated once in main() after loadSecrets(). Read by hh-negotiations.js via getSecretsCache().
let _secretsCache = null;

// HH domain — negotiations cache, background scoring and the /hh/* + /api/hh/* HTTP
// routes all live in trained-assist-hh-skill (src/hh-negotiations.js, src/hh-routes.js),
// reached via hhLib (#942, #1470). A missing/broken hh-skill checkout only disables HH:
// createHhNegotiations throws, hhNeg stays empty and core keeps serving everything else.
let hhNeg = {};
try {
  hhNeg = createHhNegotiations({
    refreshHhToken: (...a) => refreshHhToken(...a),
    readChatId,
    getSecretsCache: () => _secretsCache,
  });
} catch (e) { console.error(`[hh] negotiations unavailable: ${e.message}`); }
const { handleHhPublic, handleHhAuthed } = hhLib('hh-routes');
const isHhPath = (pathname) => /^\/(?:(?:api\/)?hh\/|calltips-)/.test(pathname);

// Host services for hh-routes. Module-level deps are bound here once; per-request
// state (secrets) is added per call.
const hhCtx = {
  readChatId,
  BASE_USERS_DIR,
  PORT,
  runMcpTool,
  getSecretsCache: () => _secretsCache,
  getHhNegotiationsWithCache: hhNeg.getHhNegotiationsWithCache,
  syncHhMessagesToHistory: hhNeg.syncHhMessagesToHistory,
  fetchAllHhNegotiations: hhNeg.fetchAllHhNegotiations,
  getHhDiscardedWithCache: hhNeg.getHhDiscardedWithCache,
  hhCacheFile: hhNeg.hhCacheFile,
};

// GTD controller tick: fire due check-backs for workrun tasks the user asked us
// to see through to done. Re-entrancy + hard-cap live in the module; here we just
// inject deps.
function scheduleGtdController(secrets) {
  const gtd = require('./gtd-controller');
  const { isSessionRunning } = require('./runner');
  const { getSession } = require('./session-store');
  const run = () => {
    // isSessionRunning checks the live in-process activeTimers map — authoritative,
    // no TTL guesswork. The previous guard used the pending-task journal with a
    // 30-min TTL fallback, but real Claude runs can legitimately take up to
    // CLAUDE_TIMEOUT_MS (40min) plus extend-timeout calls (up to 2h+): any GTD
    // turn running past 30 min aged out of that guard and could get double-fired
    // by the next tick, burning an extra iteration/notification/GitHub-precheck
    // on redundant queued work (chatLanes still serializes actual execution per
    // session, so this was never concurrent corruption — just wasted iterations,
    // which could exhaust maxIterations before the checklist was actually done).
    // Restart recovery is a separate concern already owned by resumePendingTasks
    // (runs at boot, well before the first GTD tick 2 min later), so this guard
    // doesn't need its own crash-orphan fallback.
    return gtd.runDue({
    secrets, baseUsersDir: BASE_USERS_DIR, isTaskRunning: (_username, sessionId) => isSessionRunning(sessionId), runTask, getSession,
    canRunSession: (_username, _sessionId) => true,
  }).catch(err => console.error('[gtd] tick error:', err.message));
  };
  gtdTickNow = run;
  setTimeout(run, 2 * 60 * 1000);      // first tick 2 min after start
  setInterval(run, 5 * 60 * 1000);     // then every 5 min
}

// Set by scheduleGtdController: POST /internal/gtd/tick runs the same tick now
// (the playbook e2e drives plans step to step instead of waiting 5 min).
let gtdTickNow = null;

// A restart is instant and silent: tasks it cuts off stay in the pending-task journal and
// the new process re-runs them with no status messages. The user hears from us only when a
// task cannot come back.
//
// The resume window used to be 20 min, on the assumption restarts are rare, brief blips.
// Measured reality (2026-09-21, live prod log): 34 restarts in one day from routine
// CI/CD auto-merge deploys, with gaps of 20-140 min between them several times that day —
// not crashes, just normal deploy spacing. Any deep/long task whose window straddled one
// of those gaps got silently abandoned ("Задача была прервана перезапуском и не
// возобновилась") even though nothing was actually lost — the journal had everything needed
// to resume. Resuming a Claude session has no wall-clock expiry, so there's no technical
// reason to cut this shorter than the point where we'd give up notifying the user at all.
// ABANDONED_NOTICE_MS stays wider than RESUME_WINDOW_MS: beyond the resume window we still
// want one notice for a genuinely abandoned task (e.g. extended downtime); collapsing the two
// to the same value makes that notice unreachable (resumable is false only once age already
// exceeds RESUME_WINDOW_MS, so "age < ABANDONED_NOTICE_MS" can never hold if they're equal).
const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;    // re-run tasks interrupted within this window
const ABANDONED_NOTICE_MS = 6 * 60 * 60 * 1000; // older but not ancient: tell the user it is gone
// Sent instead of the original task when the engine already holds the conversation (native resume)
// or when there is no task text to replay (forceClaude callbacks). An empty prompt stalls engines.
const CONTINUATION_PROMPT = '[ПРОДОЛЖЕНИЕ] Сервер перезапустился и прервал тебя. Продолжи с того места, где остановился.';

async function resumePendingTasks(secrets) {
  const pending = getPendingTasks();
  // Durable plan steps whose run is journaled (and still inside the resume window)
  // continue in their own engine session below (#1671); every OTHER step the
  // previous process was running goes straight back in the queue.
  const resumingDurable = new Set(pending
    .filter(p => isTaskResumable(p, Date.now(), RESUME_WINDOW_MS))
    .map(p => resumeSinkOf(p)).filter(s => s && s.kind === 'durable').map(s => s.itemId));
  try {
    const { reconcileOrphanedRunning } = require('./gtd-controller');
    const n = reconcileOrphanedRunning(undefined, { graceMs: 0, exceptItemIds: resumingDurable });
    if (n) console.log(`[resume] re-queued ${n} durable step(s) interrupted by the restart`);
  } catch (e) { console.error('[resume] durable re-queue failed:', e.message); }
  // Resume is NOT Telegram-only (#1671): web and durable runs resume without a bot token.
  if (pending.length === 0) return;
  // A durable step that cannot be resumed after all goes back to the queue.
  const requeueDurable = (sink) => {
    try {
      const { durableStore } = require('./gtd-controller');
      const st = durableStore();
      const it = st.getTaskItem(sink.itemId);
      if (it && it.status === 'running') st.updateTaskItem(it.id, { status: 'pending', due_at: Date.now() }, sink.profileId);
    } catch (e) { console.error('[resume] durable requeue:', e.message); }
  };
  const closeWeb = (sink, patch) => {
    try { require('./web-routes').completeWebMutation(sink.username, sink.requestId, patch); }
    catch (e) { console.warn('[resume] web receipt close failed:', e.message); }
  };

  const TG_BASE = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const tgCall = (token, method, body) =>
    fetch(`${TG_BASE}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  // Failure notice: replaces the task's status message when it has one, else sends a new one.
  const notifyFailure = (p, text) => {
    if (!p.userId || !secrets?.BOT_TOKEN) return Promise.resolve(); // Telegram sink only
    let token;
    try { token = taskDelivery({ user: { audience: p.audience, workDir: p.workDir || path.join(BASE_USERS_DIR, p.username) }, sessionId: p.sessionId, secrets }).secrets.BOT_TOKEN; }
    catch (e) { console.error('[resume] delivery unavailable:', e.message); return Promise.resolve(); }
    return p.initialMsgId
      ? tgCall(token, 'editMessageText', { chat_id: p.userId, message_id: p.initialMsgId, text })
      : tgCall(token, 'sendMessage', { chat_id: p.userId, text });
  };
  // Every resume path that ends WITHOUT handing off to a run must release the
  // gateway's busy hold for that chat. The original run's push was lost with the
  // dying process, and `resumePendingTasks` is the only component that knows the
  // task is never coming back — otherwise the chat stays `busy` until the
  // gateway's slow safety nets catch up, and «▶️ Запустить агента» looks broken
  // after every deploy. Delivery is fire-and-forget; the gateway no-ops on an
  // unknown/already-released chat.
  const { notifyRunFinished } = require('./gateway-callback');
  const releaseChat = (p) => {
    if (p.internalGtd || !p.userId) return Promise.resolve();
    return notifyRunFinished({
      chatId: p.userId, threadId: p.threadId || null,
      requestId: p.requestId || null, taskId: p.taskId, outcome: 'error',
      secret: secrets.AGENT_SECRET,
    }).catch(() => {});
  };

  for (const p of pending) {
    const now = Date.now();
    const age = now - (p.startedAt || 0);
    // Journal hygiene (#1239): never resume a ping / status question — replaying "движется?"
    // as a task is nonsense and was exactly the "user pings, session resumes with a question"
    // symptom. Drop it silently (a ping needs no apology, and re-pinging is trivial).
    if (isNonTaskMessage(p.task)) {
      clearPendingTask(p.taskId);
      await releaseChat(p);
      console.log(`[resume] dropped non-task ${p.taskId} (user=${p.username}): "${String(p.task).slice(0, 40)}"`);
      continue;
    }
    const resumable = isTaskResumable(p, now, RESUME_WINDOW_MS);
    if (!resumable) {
      // Stale entries would otherwise block GTD indefinitely: isTaskRunning() reads this journal.
      clearPendingTask(p.taskId);
      await releaseChat(p);
      console.log(`[resume] cleared stale task ${p.taskId} (user=${p.username}, age=${Math.round(age / 60000)}min)`);
      // A web task is never resumable (no Telegram audience), so every restart
      // lands here with its mutation receipt stuck in 'accepted' — which then
      // 409-blocks the user's retry forever. Finalize the receipt so the truth
      // is on disk and claimWebMutation's takeover rule can re-run the task
      // (#web-task-restart-recovery, 2026-09-26 incident).
      const webMatch = /^(.+)-web-([A-Za-z0-9_-]+)$/.exec(p.taskId || '');
      if (webMatch && webMatch[1] === p.username) {
        try {
          require('./web-routes').completeWebMutation(p.username, webMatch[2], {
            state: 'error', error: 'Задача была прервана рестартом агента — отправьте ещё раз.',
            sessionId: p.sessionId || null, clearedAt: new Date().toISOString(),
          });
          console.log(`[resume] finalized web mutation receipt for ${p.taskId}`);
        } catch (e) { console.warn('[resume] web receipt finalize failed:', e.message); }
      }
      if (p.startedAt && age < ABANDONED_NOTICE_MS && p.username && p.userId && !p.internalGtd) {
        await notifyFailure(p, '⚠️ Задача была прервана перезапуском и не возобновилась. Повтори запрос.');
      }
      continue;
    }

    const engine = p.engine || 'claude';
    // The attempt counter is OWNED BY THE RUNNER: it advances only when a resume actually FAILS
    // (runner/index.js retry block). This boot path must NOT advance it — a restart that kills an
    // in-flight resume is not a failure, and counting it as one burned the whole budget on a
    // deploy flurry (34 restarts/day), so a perfectly resumable task "gave up after 3 attempts"
    // without a single genuine failure. Reuse the journaled number; a fresh task starts at 1.
    const attempt = p.resumeAttempts || 1;
    const workDir = p.workDir || path.join(BASE_USERS_DIR, p.username);

    // Native resume (#1234): claude (Sub-2), codex (Sub-3) and opencode (Sub-4) are wired.
    // Source: the pending journal (written mid-run, survives SIGKILL) with the durable session
    // record as fallback. opencode is safe by construction — an id only exists if it previously
    // ran successfully; otherwise nativeResumeId is null and the old path is unchanged.
    const NATIVE_RESUME_ENGINES = ['claude', 'codex', 'opencode'];
    const nativeResumeId = NATIVE_RESUME_ENGINES.includes(engine)
      ? (p.engineSessionId || (p.sessionId ? getEngineSessionId(workDir, p.sessionId, engine) : null))
      : null;
    // With a native resume the engine already holds the task, so replaying it is redundant (and
    // risks redoing finished steps); send a short "keep going" instead. Same when there is no task
    // text at all (forceClaude callbacks) — there is nothing to replay, and an empty prompt would
    // stall the engine.
    const resumeTask = (nativeResumeId || !p.task) ? CONTINUATION_PROMPT : p.task;
    console.log(`[resume] ${nativeResumeId ? 'native' : 'fallback'} engine=${engine} user=${p.username} session=${p.sessionId} attempt=${attempt}/${MAX_RESUME_ATTEMPTS} task="${String(resumeTask).slice(0, 60)}"`);

    if (attempt > MAX_RESUME_ATTEMPTS) {
      // The resume itself keeps failing across restarts (not just once) — this is a real,
      // repeatable break, not restart noise. Stop retrying and say so plainly.
      await notifyFailure(p, `⚠️ Не удалось восстановить сессию после ${MAX_RESUME_ATTEMPTS} попыток через перезапуски сервера. Это сбой сервера, не твоей задачи — напиши запрос заново.`);
      const giveUpSink = resumeSinkOf(p);
      if (giveUpSink && giveUpSink.kind === 'durable') requeueDurable(giveUpSink);
      if (giveUpSink && giveUpSink.kind === 'web') closeWeb(giveUpSink, { state: 'error', error: 'Не удалось продолжить задачу после перезапусков — отправьте ещё раз.', sessionId: p.sessionId || null });
      clearPendingTask(p.taskId);
      await releaseChat(p);
      console.warn(`[resume] user=${p.username} session=${p.sessionId} gave up after ${MAX_RESUME_ATTEMPTS} attempts`);
      continue;
    }

    // Delayed via retry-policy's shared backoff schedule so a deploy flurry (several restarts in
    // quick succession) gets a chance to settle before we retry, instead of hammering the same
    // failure immediately on every restart.
    recordResume(nativeResumeId ? 'native' : 'fallback', engine); // #1240: measure native-vs-fallback
    const user = {
      id: p.userId, name: p.username, username: p.username, workDir,
      profileId: p.profileId, telegramUserId: p.telegramUserId, audience: p.audience,
    };
    const sink = resumeSinkOf(p);
    const fireResume = async () => {
      try {
        // runTask journals its replacement synchronously before returning its promise.
        // Keep the old durable entry throughout backoff and until that handoff succeeds.
        const running = runTask({
          taskId: `${p.username}-resume-${Date.now()}`,
          user, task: resumeTask, context: p.context || null,
          engine, sessionId: p.sessionId || null, webExactSession: !!p.webExactSession,
          contextFromSession: p.contextFromSession || null,
          forceClaude: true, projectId: p.projectId || null, projectPicked: p.projectPicked === true,
          initialMsgId: p.initialMsgId || null, pinnedMsgId: p.pinnedMsgId || null,
          resumedAfterRestart: true, resumeAttempts: attempt,
          resumeSessionId: nativeResumeId || null,
          secrets, internalGtd: !!p.internalGtd,
          mode: p.mode, continuationCount: p.continuationCount,
          initiatedAt: p.initiatedAt, threadId: p.threadId,
          rootTaskId: p.rootTaskId || p.taskId, requestId: p.requestId || null,
          resumeSink: p.resumeSink || null,
          // A web run streams to its SSE client, never to Telegram; that client is gone,
          // the answer is persisted in the web session the UI re-reads.
          ...(sink && sink.kind === 'web' ? { outputCallback: () => {} } : {}),
          ocProfile: p.ocProfile || null, ocRole: p.ocRole || null, stepTimeoutMs: p.stepTimeoutMs || null,
        });
        clearPendingTask(p.taskId);
        const reply = await running;
        // The original run's completion handler died with the old process: hand the
        // resumed reply to the same sink it would have gone to (#1671).
        if (sink && sink.kind === 'durable') await require('./gtd-controller').resumeDurableReply(sink, reply, { secrets });
        else if (sink && sink.kind === 'web') closeWeb(sink, { state: 'done', sessionId: p.sessionId || null, taskId: p.taskId });
        // Resumed GTD turn: runDue's .then() died with the old process, so settle here.
        else if (p.internalGtd && p.sessionId) require('./gtd-controller').settleResumedGtd(workDir, p.sessionId, reply);
      } catch (err) {
        console.error(`[resume] user=${p.username} error:`, err.message);
        await releaseChat(p);
        if (sink && sink.kind === 'durable') await require('./gtd-controller').resumeDurableCrash(sink, err, { secrets }).catch(() => {});
        else if (sink && sink.kind === 'web') closeWeb(sink, { state: 'error', error: 'Не удалось продолжить задачу после перезапуска — отправьте ещё раз.', sessionId: p.sessionId || null });
        else if (!p.internalGtd) await notifyFailure(p, '⚠️ Не удалось продолжить задачу после перезапуска. Повтори запрос.');
      }
    };
    const delayMs = getRetryDelayMs(attempt) || 0;
    if (delayMs > 0) setTimeout(fireResume, delayMs);
    else fireResume();
    // A process restart destroys its timers. Leave the journal intact while waiting
    // so the next process can schedule the same attempt again without losing work.
    await new Promise(r => setTimeout(r, 200)); // stagger multiple resumes
  }
}

async function main() {
  const secrets = await loadSecrets();
  _secretsCache = secrets; // expose to background tasks for HH auto-refresh
  require('./secrets').alertMissingBotTokens(secrets).catch(() => {});
  resumePendingTasks(secrets).catch(err => console.error('[resume] failed:', err.message));
  reconcileSoftContinuations(secrets).catch(err => console.error('[soft-incomplete] reconcile failed:', err.message));
  const intakeQuick = require('./intake-quick').createIntakeQuick({
    baseDir: BASE_USERS_DIR, answer: require('./runner').runQuickAnswer, apiKey: secrets.OPENROUTER_API_KEY,
  });

  const GDRIVE_CLIENT_ID     = secrets.GOOGLE_OAUTH_CLIENT_ID;
  const GDRIVE_CLIENT_SECRET = secrets.GOOGLE_OAUTH_CLIENT_SECRET;
  const GDRIVE_REDIRECT_URI  = `${(process.env.AGENT_PUBLIC_URL || 'https://136-65-7-197.sslip.io').replace(/\/$/, '')}/connect/gdrive/callback`;

  const HH_CLIENT_ID     = secrets.HH_CLIENT_ID;
  const HH_CLIENT_SECRET = secrets.HH_CLIENT_SECRET;
  const HH_REDIRECT_URI  = process.env.HH_REDIRECT_URI || 'https://recruiter-assistant.ru/hh-callback';
  // Parse callback path from the registered redirect URI so the route handler matches regardless of domain
  const HH_CALLBACK_PATH = (() => { try { return new URL(HH_REDIRECT_URI).pathname; } catch { return '/hh-callback'; } })();

  // Deps for the connect handler module (issue #942 P3.3). Module-level deps are
  // bound here once; per-request state (secrets) is injected per call.
  const connectCtx = {
    readChatId,
    GDRIVE_CLIENT_ID,
    GDRIVE_CLIENT_SECRET,
    GDRIVE_REDIRECT_URI,
    HH_CLIENT_ID,
    HH_CLIENT_SECRET,
    HH_REDIRECT_URI,
    HH_CALLBACK_PATH,
  };

  require('./intake-media-retention').startIntakeMediaRetention(BASE_USERS_DIR);
  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // ── /connect/* OAuth + token-collection + /hh-callback — dispatched to src/handlers/connect.js (#942 P3.3) ──
    if (await handleConnect(req, url, res, { ...connectCtx, secrets }) !== false) return;


    // CORS preflight for browser-facing endpoints (no auth needed for OPTIONS)

    // ── HH browser-facing + proactive endpoints (no AGENT_SECRET — authenticated by HH token file / HMAC) ──
    if (isHhPath(url.pathname) && await handleHhPublic(req, url, res, { ...hhCtx, secrets }) !== false) return;


    // ── HH browser-facing endpoints (no AGENT_SECRET — authenticated by HH token file) ──

    // GET /hh/review?username=X&token=Y — on-demand candidate review page

    // GET /hh/candidate?neg_id=X&username=Y&token=Z — candidate profile page

    // GET /hh/sync-log?username=X&token=Y — scoring run history page

    // GET /hh/ats-editor?username=X&token=Y — serve the ATS Template Editor HTML page
    // Must be before Bearer-auth gate so browsers can open it directly.

    // POST /hh/send — send a message to a candidate (called from review page)

    // POST /hh/generate-message — generate draft for one candidate (called from review page)

    // POST /hh/reject — bulk reject candidates (called from review page)

    // POST /hh/send-and-reject — send a rejection message then reject in HH

    // GET /hh/style?username=X&token=Y — style update page

    // POST /hh/update-style — extract style from examples and save

    // POST /hh/update-base-prompt — save or reset the per-recruiter base message-generation prompt

    // POST /hh/sync-negotiations — force-refresh negotiations cache (called from review page)

    // GET /images/:filename — serve images generated by skills (public, no auth — Telegram downloads without token)
    const imagesMatch = url.pathname.match(/^\/images\/([a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg))$/);
    if (req.method === 'GET' && imagesMatch) {
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const filePath = path.join(dataDir, 'images', imagesMatch[1]);
      if (!fs.existsSync(filePath)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(filePath).slice(1);
      res.writeHead(200, { 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Vacancy landing pages (GET /vacancy/:username/:vacancyId, POST /vacancy/store,
    // POST /apply/:username/:vacancyId) moved to the RU edge service — see
    // src/ru-edge.js. Vacancy hosting stays on platform.recruiter-assistant.ru by
    // owner decision (issue #1288); this agent still publishes to it via
    // publishVacancyPage() in hh-skill src/hh-vacancy.js (VACANCY_REMOTE_STORE_URL), unchanged.

    // GET /health — no auth, liveness check for smoke tests and monitoring
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'alive', uptime: process.uptime(), vm: VM_NAME, commit: GIT_COMMIT });
    }

    // GET /readiness — no auth, "can this server accept work?" (distinct from liveness).
    // 200 when ready; 503 when a critical dependency is down. A single unavailable engine does
    // not make the server unready as long as a fallback engine is usable (spec §13).
    if (req.method === 'GET' && url.pathname === '/readiness') {
      const { ready, checks } = require('./readiness').computeReadiness();
      return json(res, ready ? 200 : 503, { ready, checks, vm: VM_NAME, commit: GIT_COMMIT, uptime: process.uptime() });
    }

    // GET /p/:slug — serve a published page (no auth, public; password-gated
    // pages checked before ANY content incl. ?raw). See src/handlers/pages.js.
    if (req.method === 'GET' && require('./handlers/pages').servePublishedPage(req, url, res, publishPasswordForm)) return;


    // POST /telegram/misha — @cmr_management_bot direct webhook (no AGENT_SECRET auth)
    if (req.method === 'POST' && url.pathname === '/telegram/misha') {
      const mishaBotTokenFile = path.join(os.homedir(), 'agent-tokens', 'misha', 'telegram-bot-token');
      const mishaBotToken = fs.existsSync(mishaBotTokenFile)
        ? fs.readFileSync(mishaBotTokenFile, 'utf8').trim() : null;
      if (!mishaBotToken) {
        console.warn('[misha/webhook] Bot token file missing');
        return json(res, 503, { error: 'bot not configured' });
      }
      let update;
      try { update = JSON.parse(await readBody(req)); } catch { return json(res, 400, {}); }
      json(res, 200, { ok: true });
      processMishaUpdate(update, mishaBotToken, secrets).catch(e =>
        console.error('[misha/webhook] error:', e.message)
      );
      return;
    }


    // ── /web/* routes — cookie-auth endpoints (sessions, files, run) ─────────
    // Note: /web/magic, /web/auth, /web/logout, /web/me, /web/profiles,
    //       /web/switch-profile are handled above (no handleWebRoute delegation needed)
    if (url.pathname.startsWith('/web/') &&
        url.pathname !== '/web/auth' && url.pathname !== '/web/magic' &&
        url.pathname !== '/web/logout' && url.pathname !== '/web/me' &&
        url.pathname !== '/web/profiles' && url.pathname !== '/web/switch-profile' &&
        url.pathname !== '/web/verify' && url.pathname !== '/web/projects' &&
        url.pathname !== '/web/project-create' &&
        url.pathname !== '/web/sessions-list' && url.pathname !== '/web/session-get' &&
        url.pathname !== '/web/session-trace' &&
        url.pathname !== '/web/intake-file-bearer' &&
        url.pathname !== '/web/run-bearer' && url.pathname !== '/web/reply-bearer' &&
        url.pathname !== '/web/reproject-preview' && url.pathname !== '/web/reproject-adjust' &&
        url.pathname !== '/web/reproject-apply' && url.pathname !== '/web/reproject-revert') {
      if (await handleWebRoute(req, url, res, secrets)) return;
    }

// ── /web/* bearer-auth endpoints + static asset serving — dispatched to
    // src/handlers/web.js (#942 P3.3b) ────────────────────────────────
    if (await handleWeb(req, url, res, { secrets }) !== false) return;

    // ── POST /admin/webpass — generate magic link (or password) for a profile ─
    if (req.method === 'POST' && url.pathname === '/admin/webpass') {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${secrets.AGENT_SECRET}`) return json(res, 401, { error: 'unauthorized' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username } = body || {};
      if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      // Generate magic token (preferred) + password as fallback
      const magicToken = generateMagicToken(username);
      const publicUrl = process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru';
      const magicUrl = `${publicUrl}/web/magic?t=${magicToken}`;
      const password = generatePassword();
      savePassword(username, password);
      return json(res, 200, { ok: true, username, password, magicUrl });
    }

    // Call Tips endpoints (/calltips-session, /calltips-tips) are served by hh-skill
    // src/hh-routes.js via handleHhPublic above (#1470).

    // POST /tasks/:taskId/extend-timeout with a run-scoped token (issue #1649): an engine
    // run may extend only its OWN task. AGENT_SECRET callers use the route further down.
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/extend-timeout$/.test(url.pathname)) {
      const scope = runTokenFromAuthHeader(req.headers['authorization']);
      if (scope) {
        const taskId = url.pathname.split('/')[2];
        if (scope.taskId !== taskId) return json(res, 403, { ok: false, error: 'forbidden: run token belongs to another task' });
        const { extendTaskTimeout } = require('./runner');
        const result = extendTaskTimeout(taskId);
        return json(res, result.ok ? 200 : 404, result);
      }
    }

    // ── Auth: all endpoints require Bearer token ──────────────────────────────
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secrets.AGENT_SECRET}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // /internal/* — machine-to-machine routes (handlers/internal.js).
    if (url.pathname.startsWith('/internal/') &&
        await handleInternal(req, url, res, { json, readBody, BASE_USERS_DIR, getGtdTickNow: () => gtdTickNow }) !== false) return;

    // POST /cleanup-flood — delete the text messages this agent sent to a chat.
    // Called by the gateway's /clean_up_flood command (which separately deletes the
    // messages it sent itself). Body: { chatId, audience }. Files/artifacts are never
    // tracked here, so the cleanup leaves them in place.
    if (req.method === 'POST' && url.pathname === '/cleanup-flood') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const chatId = body?.chatId;
      const audience = body?.audience || 'default';
      if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'invalid chatId' });
      if (typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(audience)) return json(res, 400, { error: 'invalid audience' });
      let token;
      try { token = require('./bot-delivery').deliverySecrets(secrets, audience).BOT_TOKEN; }
      catch (e) { return json(res, 400, { error: e.message }); }
      if (!token) return json(res, 503, { error: 'no bot token for audience' });
      const result = await require('./sent-messages').deleteAll(token, chatId);
      return json(res, 200, { ok: true, ...result });
    }

    // POST /nalog/token-store — receive a nalog.ru token pushed by the RU edge
    // after a Playwright login (initial or post-2FA). The RU edge holds no
    // per-user state of its own; this agent (GCP) is the token's home, since
    // that's where 10-nalog.js and the expiry scheduler read it from.
    if (req.method === 'POST' && url.pathname === '/nalog/token-store') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, tokens } = body || {};
      if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      if (!tokens || typeof tokens !== 'object' || !tokens.auth_token) return json(res, 400, { error: 'missing tokens.auth_token' });
      const dir = path.join(dataPaths.TOKENS_ROOT, username);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'nalog'), JSON.stringify(tokens, null, 2), { mode: 0o600 });
      console.log('[nalog/token-store] saved token for username=%s expires=%s', username, tokens.expires);
      return json(res, 200, { ok: true });
    }

    // Compat for the bot's /restart command: "request" restarts right away (reply first,
    // then SIGTERM ourselves); every other action is a harmless status read. Nothing is
    // ever paused, and "pause" from stale deploy scripts must NOT restart the service.
    if (url.pathname === '/maintenance') {
      let action = '';
      if (req.method === 'POST') {
        try { action = JSON.parse(await readBody(req)).action || ''; }
        catch { return json(res, 400, { error: 'bad json' }); }
      }
      const restarting = action === 'request';
      // durableIngress: 1 is load-bearing — the bot's RunOutbox reads it before every /run
      // submit and holds all work if it is missing (see tg-bot src/run-outbox.js).
      json(res, 200, { paused: false, phase: restarting ? 'restarting' : 'ready', active: 0, maintenanceProtocol: 2, durableIngress: 1, runtimeCommit: RUNTIME_REVISION });
      if (restarting) res.once('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50));
      return;
    }

    // Compat: the bot still pings this while a restart is in progress. Restarts are
    // instant now — nothing is ever paused and nobody is owed a "restart finished" reply.
    if (req.method === 'POST' && url.pathname === '/restart/activity') {
      return json(res, 200, { paused: false });
    }
    if (req.method === 'POST' && url.pathname === '/intake-files/release') {
      const p = JSON.parse(await readBody(req));
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.username || '') || !Array.isArray(p.ids) || p.ids.length > 100 || p.ids.some(id=>!/^[a-f0-9]{64}$/.test(id))) return json(res,400,{error:'invalid refs'});
      const result = require('./intake-media-retention').releaseIntakeRefs(
        BASE_USERS_DIR, p.username, p.ids, { releaseSource: 'gateway' }
      );
      return json(res,200,{ok:true,...result});
    }

    // Authenticated release probe: exercises the same verified reader as /run,
    // without starting a user task or sending anything to Telegram.
    if (url.pathname === '/intake-media-check' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        const result = await require('./r2-media').verifyR2({ ref: body.ref, username: body.username,
          gatewayUrl: process.env.MEDIA_GATEWAY_URL, secret: secrets.AGENT_SECRET });
        return json(res, 200, result);
      } catch {
        return json(res, 503, { error: 'R2 reader verification failed' });
      }
    }

    // PUT/GET /intake-files?username=X&id=Y&name=Z — durable per-file store for
    // gateway intake (photos/voice/docs). Replaces base64-in-KV so a retry never
    // re-sends bytes and isn't capped by KV's 25MB value limit. See intake-files.js
    // in the gateway repo — id is a sha256 hex of (chatId:messageId:fileUniqueId).
    if (url.pathname === '/intake-files' && (req.method === 'PUT' || req.method === 'GET')) {
      const ifUsername = url.searchParams.get('username');
      const ifId = url.searchParams.get('id');
      if (!ifUsername || !/^[a-zA-Z0-9_-]{1,64}$/.test(ifUsername)) return json(res, 400, { error: 'invalid username' });
      if (!ifId || !/^[a-f0-9]{16,64}$/.test(ifId)) return json(res, 400, { error: 'invalid id' });
      const storeDir = path.join(BASE_USERS_DIR, ifUsername, 'media', 'intake-store', ifId);
      if (req.method === 'PUT') {
        const rawName = url.searchParams.get('name') || 'file';
        const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
        const mime = req.headers['content-type'] || 'application/octet-stream';
        let buf;
        try { buf = await readBodyBuffer(req, 20 * 1024 * 1024); }
        catch { return json(res, 413, { error: 'file too large' }); }
        fs.mkdirSync(storeDir, { recursive: true });
        fs.writeFileSync(path.join(storeDir, 'data'), buf, { mode: 0o600 });
        fs.writeFileSync(path.join(storeDir, 'meta.json'), JSON.stringify({ name: safeName, mime, size: buf.length, buffered: true }));
        return json(res, 200, { id: ifId, name: safeName, mime, size: buf.length });
      }
      // GET
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'meta.json'), 'utf8'));
        const buf = fs.readFileSync(path.join(storeDir, 'data'));
        res.writeHead(200, { 'Content-Type': meta.mime || 'application/octet-stream', 'Content-Length': buf.length });
        res.end(buf);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
      return;
    }

    // POST /report — create a GitHub issue from a user-submitted bug report
    if (req.method === 'POST' && url.pathname === '/report') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, description, sessionId } = body || {};
      if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      if (!description || typeof description !== 'string' || !description.trim()) return json(res, 400, { error: 'description required' });

      if (!secrets.GITHUB_ISSUES_TOKEN) return json(res, 503, { error: 'reporting not configured' });

      const workDir = userWorkDir(username);

      // Load current session
      let session = null;
      try {
        const sid = sessionId || getCurrentSessionId(workDir);
        if (sid) session = await getSessionData(workDir, sid);
      } catch {}

      // Load recent sessions list
      let recentSessions = [];
      try { recentSessions = await listSessions(workDir, 5); } catch {}

      // Build session section
      let sessionSection = '';
      if (session) {
        const msgs = (session.messages || []).slice(-6);
        const msgLines = msgs.map(m => {
          const role = m.role === 'user' ? '**Пользователь:**' : '**Клод:**';
          const text = (m.content || '').slice(0, 500);
          return `${role} ${text}`;
        }).join('\n\n');
        sessionSection = `\n## Текущая сессия\n\n**Тема:** "${session.topic || '—'}" (${(session.messages || []).length} сообщений)\n**ID:** ${session.id}\n\n### Последние сообщения\n\n${msgLines}\n`;
      }

      // Build recent sessions section
      let recentSection = '';
      if (recentSessions.length > 0) {
        const lines = recentSessions.map((s, i) => {
          const date = s.lastAt ? new Date(s.lastAt).toISOString().slice(0, 10) : '—';
          return `${i + 1}. "${s.topic || '—'}" — ${date}`;
        }).join('\n');
        recentSection = `\n## Последние сессии\n\n${lines}\n`;
      }

      const issueBody = `**Репорт от пользователя:** ${username}\n**Дата:** ${new Date().toISOString()}\n\n## Описание\n\n${description.trim()}${sessionSection}${recentSection}`;

      const issuePayload = JSON.stringify({
        title: `[Report] ${description.trim().slice(0, 80)}`,
        body: issueBody,
        labels: ['user-report'],
      });

      let ghRes;
      try {
        ghRes = await fetch('https://api.github.com/repos/trained-assist/trained-assist-agent/issues', {
          method: 'POST',
          headers: {
            'Authorization': `token ${secrets.GITHUB_ISSUES_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'trained-assist-agent/1.0',
            'Accept': 'application/vnd.github+json',
          },
          body: issuePayload,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        return json(res, 502, { error: `github request failed: ${e.message}` });
      }

      let issueData;
      try { issueData = await ghRes.json(); } catch { issueData = {}; }
      if (ghRes.status >= 400) return json(res, 502, { error: issueData.message || `github returned ${ghRes.status}` });

      return json(res, 200, { ok: true, url: issueData.html_url, number: issueData.number });
    }


    // GET /capabilities?userId=XXX — list services with tokens on this machine
    if (req.method === 'GET' && url.pathname === '/capabilities') {
      const userId = url.searchParams.get('userId') || '';
      if (!userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) return json(res, 400, { error: 'invalid userId' });
      const tokensDir = path.join(os.homedir(), 'agent-tokens', userId);
      const SKIP = new Set(['.secrets_log', 'gdrive-seen', 'gdrive-catalog', 'gdrive-catalog.json']);
      let capabilities = [];
      if (fs.existsSync(tokensDir)) {
        capabilities = fs.readdirSync(tokensDir).filter(f => !SKIP.has(f) && !f.startsWith('.'));
      }
      // skills[] — MCP tool categories available on this agent: core tools plus the
      // tools of every sibling domain repo checked out on this host (#942, #1470).
      const toolsDir = path.join(__dirname, 'mcp-skills', 'tools');
      const siblingsHere = presentSiblings();
      const toolFilenames = [toolsDir, ...siblingsHere.map(sib => path.join(path.dirname(sib.indexPath), 'tools'))]
        .flatMap(dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []));
      const skills = computeSkillsList(toolFilenames,
        siblingsHere.some(sib => sib.id === 'hh'), siblingsHere.some(sib => sib.id === 'freelance'));
      const upsell_text = process.env.AGENT_UPSELL_TEXT ||
        'За HH-рекрутингом, налогами, задачами Weeek и другим — обратитесь к @super_personal_assistant_bot';
      return json(res, 200, { capabilities, skills, upsell_text });
    }

    // Gateway preflight: full async quick engine, without /run or a spawned session.
    if (req.method === 'POST' && url.pathname === '/intake-quick') {
      let payload;
      try { payload = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'invalid json' }); }
      const result = await intakeQuick(payload);
      return json(res, result.status || 200, result);
    }

    // POST /quick — quick deterministic answer without Claude Code (<200ms)
    if (req.method === 'POST' && url.pathname === '/quick') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { userId, query } = payload;
      if (!userId || !query) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
      const workDir = path.join(BASE_USERS_DIR, String(userId));
      const start = Date.now();
      const answer = getQuickAnswer(String(query), String(userId), workDir) || null;
      return json(res, 200, { answer, ms: Date.now() - start });
    }

    // GET /skills — list all available MCP skills (for bot /skills command)
    if (req.method === 'GET' && url.pathname === '/skills') {
      const { tools: metaTools } = require('./mcp-skills/tools/00-meta.js');
      const { skills } = await metaTools.list_skills.handler();
      return json(res, 200, { skills });
    }

    // GET /health-full — runs actual claude call, verifies OAuth end-to-end
    if (req.method === 'GET' && url.pathname === '/health-full') {
      const start = Date.now();
      const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;
      try {
        const output = await new Promise((resolve, reject) => {
          execFile('claude', ['--dangerously-skip-permissions', '--print', 'say: pipeline-ok'], {
            env: cleanEnv,
            timeout: 45000,
          }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stdout || stderr || err.message).trim().slice(0, 300)));
            resolve(stdout.trim());
          });
        });
        const ok = output.toLowerCase().includes('pipeline-ok');
        return json(res, ok ? 200 : 500, { ok, output: output.slice(0, 200), auth: 'oauth', latencyMs: Date.now() - start });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message, latencyMs: Date.now() - start });
      }
    }

    // GET /analytics — aggregated token/cost usage across all users
    if (req.method === 'GET' && url.pathname === '/analytics') {
      const { getUsageLog } = require('./usage-store');
      // Usage logs live in each profile's workspace (USERS_ROOT/<u>/usage.json),
      // not the legacy SYSTEM_ROOT/sessions tree.
      const sessionsDir = dataPaths.USERS_ROOT;
      const totals = { tasks: 0, input: 0, output: 0, cost_usd: 0 };
      const byDate = {};   // date → { model → { input, output, cost, tasks } }
      const byUser = {};   // username → { tasks, input, output, cost_usd }
      try {
        const users = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
        for (const username of users) {
          const workDir = path.join(sessionsDir, username);
          if (!fs.statSync(workDir).isDirectory()) continue;
          const log = getUsageLog(workDir);
          if (!log || !log.length) continue;
          const u = byUser[username] = { tasks: 0, input: 0, output: 0, cost_usd: 0 };
          for (const entry of log) {
            const inp = entry.input_tokens || 0;
            const out = entry.output_tokens || 0;
            const cost = entry.cost_usd || 0;
            const model = entry.model || (entry.engine === 'opencode' ? 'opencode' : 'claude');
            const date = new Date(entry.at || 0).toISOString().slice(0, 10);
            totals.tasks += 1; totals.input += inp; totals.output += out; totals.cost_usd += cost;
            u.tasks += 1; u.input += inp; u.output += out; u.cost_usd += cost;
            if (!byDate[date]) byDate[date] = {};
            if (!byDate[date][model]) byDate[date][model] = { input: 0, output: 0, cost: 0, tasks: 0 };
            byDate[date][model].input += inp;
            byDate[date][model].output += out;
            byDate[date][model].cost += cost;
            byDate[date][model].tasks += 1;
          }
        }
      } catch (e) { console.error('[analytics]', e.message); }
      return json(res, 200, { totals, by_date: byDate, by_user: byUser });
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const load = os.loadavg();
      let disk = null;
      try {
        const df = execSync('df -BM / --output=size,used,avail', { encoding: 'utf8' });
        const [, line] = df.trim().split('\n');
        const [size, used, avail] = line.trim().split(/\s+/).map(s => parseInt(s));
        disk = { totalMb: size, usedMb: used, availMb: avail };
      } catch { /* ignore */ }
      return json(res, 200, {
        cpu: { cores: cpus.length, load1m: load[0], load5m: load[1] },
        memory: { totalMb: Math.round(totalMem / 1048576), usedMb: Math.round(usedMem / 1048576), freeMb: Math.round(freeMem / 1048576) },
        disk,
        uptime: process.uptime(),
        resume: getResumeStats(), // #1240: native vs fallback post-restart resumes
      });
    }

    // POST /tasks/:taskId/extend-timeout — called by session_extend_timeout MCP tool
    // Allows Claude to extend its own 15-min session (up to 8 × 15 min = 2h total)
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/extend-timeout$/.test(url.pathname)) {
      const taskId = url.pathname.split('/')[2];
      const { extendTaskTimeout } = require('./runner');
      const result = extendTaskTimeout(taskId);
      return json(res, result.ok ? 200 : 404, result);
    }

    // POST /tasks/:taskId/stop — kill a specific running Claude process by taskId.
    // Ownership-checked (#1303): AGENT_SECRET alone is NOT ownership — it is shared
    // by every first-party gateway, so on its own it lets any of them stop any
    // profile's/bot's task just by knowing its taskId. The caller must name the
    // owner (username required; audience defaults to 'default'; chatId optional),
    // matched by the same exact-username/audience rule #1302 §3.2 uses for
    // /tasks/stop. Missing owner or mismatch -> 403 and the task keeps running.
    // No Telegram callback calls this route (the bot's Stop button uses the
    // username-scoped /tasks/stop), so no existing caller is broken.
    if (req.method === 'POST' && /^\/tasks\/[^/]+\/stop$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[2]);
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { payload = null; }
      const username = payload?.username;
      const audience = payload?.audience;
      const chatId = payload?.chatId ?? payload?.userId ?? null;
      // Forum topic scope (#255): a task started in topic A is only stoppable from
      // topic A. Null/absent keeps the legacy chat-wide behavior.
      const rawThreadId = payload?.threadId;
      const threadId = Number.isInteger(rawThreadId) && rawThreadId > 0 ? rawThreadId : null;
      if (rawThreadId != null && threadId == null) return json(res, 400, { error: 'invalid threadId' });
      if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 403, { error: 'forbidden: owner username required' });
      if (audience != null && (typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(audience)))
        return json(res, 400, { error: 'invalid audience' });
      const { stopTask } = require('./runner');
      const result = stopTask(taskId, { username, audience: audience || 'default', chatId, threadId });
      if (result.forbidden) return json(res, 403, { error: result.error });
      return json(res, result.ok ? 200 : 404, result);
    }

    // POST /tasks/stop — kill any running Claude process for a user by username,
    // scoped to one audience/bot (default 'default' — never "every audience", #1302 §3.2).
    // Body: { username: string, audience?: string, chatId?: number, threadId?: number }
    // When chatId is supplied the kill is scoped to that chat; threadId (when valid)
    // further scopes it to one forum topic, so «стоп» in topic A cannot kill topic B.
    if (req.method === 'POST' && url.pathname === '/tasks/stop') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, audience, chatId } = payload || {};
      const rawThreadId = payload?.threadId;
      const threadId = Number.isInteger(rawThreadId) && rawThreadId > 0 ? rawThreadId : null;
      if (rawThreadId != null && threadId == null) return json(res, 400, { error: 'invalid threadId' });
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      if (audience != null && (typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(audience)))
        return json(res, 400, { error: 'invalid audience' });
      const { stopUserTask, killTaskByUsername } = require('./runner');
      const scoped = stopUserTask(username, chatId ?? null, audience || null, threadId);
      // Profile-wide (no chatId) callers keep the audience-wide kill semantics.
      const killed = (chatId == null && !scoped) ? killTaskByUsername(username, audience || null) : (scoped ? 1 : 0);
      return json(res, 200, { ok: true, killed, audience: audience || 'default' });
    }

    // GET /tasks/running?username=xxx — ground truth for whether a Claude
    // session is live for this user. The gateway IntakeBuffer polls this to
    // hold new messages for the REAL duration of a run (not just the /run
    // enqueue, which returns 202 immediately). Reading live state here — rather
    // than trusting a fire-and-forget completion callback — means a dropped
    // packet can't trap the buffer; the next poll self-heals.
    if (req.method === 'GET' && url.pathname === '/tasks/running') {
      // chatId-scoped check (epic #1527 PR1): what the gateway's IntakeBuffer
      // alarm poll uses to self-heal a lost run-finished push. acceptedByChat
      // is true from the synchronous runTask entry (before 202) until the run
      // settles — no admission-wait window where a poll would see "idle" and
      // wrongly release the chat's busy hold.
      const chatIdParam = url.searchParams.get('chatId');
      if (chatIdParam != null && chatIdParam !== '') {
        const chatId = Number(chatIdParam);
        if (!Number.isSafeInteger(chatId)) return json(res, 400, { error: 'invalid chatId' });
        const { isChatTaskRunning } = require('./runner');
        return json(res, 200, { running: isChatTaskRunning(chatId), scope: 'chat', chatId });
      }
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      // audience scopes which bot's task this checks — omitted -> 'default' only,
      // never "any audience" (#1302 §3.2/§2).
      const audience = url.searchParams.get('audience');
      if (audience != null && !/^[a-zA-Z0-9_-]{1,32}$/.test(audience))
        return json(res, 400, { error: 'invalid audience' });
      const { isTaskRunning } = require('./runner');
      return json(res, 200, { running: isTaskRunning(username, audience || null), audience: audience || 'default' });
    }

    // GET /projects?username=xxx — TYPED project list (projects.js), most-used first
    // (session count desc, recency as tiebreaker — matches /project-decision's ordering
    // so index-based lookups like tg-bot's pp:<i> stay in sync between the two endpoints).
    // Single source of truth: the on-disk projects/ folder. Replaces the old raw-subdir
    // listing (issue #517 convergence — no more folder-name picker).
    if (req.method === 'GET' && url.pathname === '/projects') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      // audience scopes the list to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every project created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';

      const workDir = path.join(BASE_USERS_DIR, username);
      try {
        const { listProjects, sortByUsage } = require('./projects');
        const sessions = require('./session-store');
        const countByProject = {};
        for (const s of sessions.listSessions(workDir, 1000, audience)) {
          if (s.projectId) countByProject[s.projectId] = (countByProject[s.projectId] || 0) + 1;
        }
        const projects = sortByUsage(listProjects(workDir, audience), countByProject).map(p => ({
          id: p.id, name: p.name, type: p.type, label: p.label || p.name, lastAt: p.lastAt || 0,
        }));
        return json(res, 200, { projects });
      } catch (e) {
        return json(res, 200, { projects: [], note: 'projects model unavailable' });
      }
    }

    // GET /project-decision?username=xxx&chatId=yyy[&task=...] — what the gateway should do when a
    // NEW dialog starts (issue #517): {action:'auto'|'create'|'ask', choices:[{id,name,label}], active}.
    // 'ask' -> gateway renders the inline picker and defers the task until the user chooses.
    // When `task` is provided and it's a project-agnostic quick command (engine switch, agent info,
    // etc.), returns action:'auto' immediately — no picker shown, task goes straight to /run.
    if (req.method === 'GET' && url.pathname === '/project-decision') {
      const username = url.searchParams.get('username');
      const chatId = url.searchParams.get('chatId') || null;
      // audience scopes the decision to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every project/session created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';
      const threadIdParam = Number(url.searchParams.get('threadId'));
      const decisionThreadId = Number.isInteger(threadIdParam) && threadIdParam > 0 ? threadIdParam : null;
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      // Quick commands don't belong to any project — skip picker entirely.
      // Regex mirrors ENGINE_SWITCH_INTENT + other global slash commands from runner.js.
      const taskParam = (url.searchParams.get('task') || '').trim();
      const GLOBAL_QUICK_COMMAND = /^\/?switch\s*2\s*(klod|codex|opencode|клод|кодекс)(?:@\S+)?(?=\s|$)|(?:переключ\S*|switch)\s+(?:меня\s+)?(?:на|to)\s+(klod|claude|codex|opencode|клод|кодекс)(?=\s|$)|^\/(?:get_agent_info|agent_info|oc_\S+|get_webpass|webpass|вебпароль|info)(?:@\S+)?(?=\s|$)/i;
      if (taskParam && GLOBAL_QUICK_COMMAND.test(taskParam)) {
        return json(res, 200, { action: 'quick', choices: [], active: null });
      }

      const workDir = path.join(BASE_USERS_DIR, username);
      try {
        const projects = require('./projects');
        const sessions = require('./session-store');

        // Session counts per project (metadata read, cheap) — computed up front so
        // decideNewSessionProject can order choices by usage (most-used first), not
        // just by recency.
        const allSess = sessions.listSessions(workDir, 1000, audience);
        const countByProject = {};
        for (const s of allSess) if (s.projectId) countByProject[s.projectId] = (countByProject[s.projectId] || 0) + 1;

        const d = projects.decideNewSessionProject(workDir, chatId, countByProject, audience, decisionThreadId);
        // No project-mismatch classifier any more: the bot never asks «какой проект?»
        // (owner decision 2026-09-26). Misfiled sessions are regrouped later by reproject.
        const out = { action: d.action, active: d.active || null, pinned: d.pinned ? d.project.id : null };

        const enrich = (p) => ({
          id: p.id, name: p.name, type: p.type || 'generic', label: p.label || p.name,
          summary: p.summary || null,
          sessionCount: countByProject[p.id] || 0,
          lastAt: p.lastAt || 0,
        });
        if (d.action === 'auto') out.choices = [enrich(d.project)];
        else out.choices = [];
        return json(res, 200, out);
      } catch (e) {
        return json(res, 200, { action: 'create', choices: [], active: null, note: 'projects model unavailable' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req, 32 * 1024 * 1024);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { username, task, context, sessionId, contextFromSession, forceClaude, forceNew, telegramUserId, initialMsgId, pinnedMsgId, projectId, projectPicked, newProjectName, fileBase64, fileName, fileMimeType, fileRefs, requestId, mode, threadId, initiatedAt, audience } = payload;
      // `chatId` is the canonical field for the Telegram chat to stream into (plan
      // generic-naming-conventions-refactoring, P1-C). `userId` is now a legacy wire
      // alias, normalized once right here — PR-D drops tg-bot's `userId` send, PR-E
      // (optional) will stop accepting it. Response bodies below are unchanged
      // (still `invalid userId`/`missing fields`) so this is not a client-visible
      // behavior change, only an internal rename.
      const chatId = payload.chatId ?? payload.userId;
      // Every /run rejection is logged with its reason: the tg-bot outbox turns a 4xx into
      // "⚠️ сервер отклонил (HTTP 400)" for the user, and an unlogged 400 is undiagnosable.
      const reject = (status, body) => {
        console.log(`[/run] ${status} ${body.error} user=${String(username).slice(0, 40)} requestId=${String(requestId || '-').slice(0, 140)}`);
        return json(res, status, body);
      };
      if (audience != null && (typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(audience))) return reject(400, { error: 'invalid audience' });
      if (initiatedAt != null && (!Number.isSafeInteger(initiatedAt) || initiatedAt < 0 || initiatedAt > Date.now() + 30000)) return reject(400, { error: 'invalid initiatedAt' });
      if (threadId != null && (!Number.isSafeInteger(threadId) || threadId < 1)) return reject(400, { error: 'invalid threadId' });
      if (!chatId || !username) return reject(400, { error: 'missing fields' });
      // task is optional when forceClaude=true (agent derives it from session's lastUserMessage)
      if (!task && !forceClaude && !fileBase64 && !(fileRefs && fileRefs.length)) return reject(400, { error: 'missing fields' });
      if (requestId && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))
        return reject(400, { error: 'invalid requestId' });
      if (!/^-?\d{1,20}$/.test(String(chatId))) {
        console.log('[/run] 400 invalid chatId (legacy field name userId):', chatId);
        return reject(400, { error: 'invalid userId' });
      }
      if (telegramUserId && !/^\d{1,20}$/.test(String(telegramUserId))) {
        console.log('[/run] 400 invalid telegramUserId:', telegramUserId);
        return reject(400, { error: 'invalid telegramUserId' });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username) || username.length > 32) {
        console.log('[/run] 400 invalid username:', username);
        return reject(400, { error: 'invalid username' });
      }
      // Quiet-mode group history (tg-bot src/group-history.js) arrives once; keep it so the
      // get_group_history MCP tool can still show it after the next run stops repeating it.
      if (Array.isArray(payload.groupHistory) && payload.groupHistory.length) {
        require('./group-history-store').appendGroupHistory(username, chatId, threadId ?? null, payload.groupHistory);
      }
      // Replay of an already-accepted request (lost ACK, outbox retry across a restart) is
      // acknowledged BEFORE content/delivery validation: the work already ran, so a stateful
      // check that fails now must not surface a false "сервер отклонил" to the user.
      if (requestId && typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
        const owner = audience && audience !== 'default' ? `${username}-${audience}` : username;
        const seenId = `${owner}-${requestId}`;
        const seenReceipt = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'accepted-requests', `${seenId}.json`);
        if (fs.existsSync(seenReceipt) || getPendingTasks().some(p => p.taskId === seenId)) {
          return json(res, 202, { taskId: seenId, requestId, durable: true, duplicate: true });
        }
      }
      if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId))
        return reject(400, { error: 'invalid sessionId' });
      if (contextFromSession && !/^[a-zA-Z0-9_-]+$/.test(contextFromSession))
        return reject(400, { error: 'invalid contextFromSession' });
      if (projectId && !isValidProjectId(projectId)) {
        console.log('[/run] 400 invalid projectId:', projectId);
        return reject(400, { error: 'invalid projectId' });
      }
      if (newProjectName && (typeof newProjectName !== 'string' || newProjectName.length > 200))
        return reject(400, { error: 'invalid newProjectName' });

      if (requestId && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId))) return reject(400, { error: 'invalid requestId' });
      // Validate delivery before accepting durable work; never leak replies to the default bot.
      try { deliverySecrets(secrets, audience); }
      catch (e) { return reject(/not configured/.test(e.message) ? 503 : 400, { error: e.message }); }
      const requestOwner = audience && audience !== 'default' ? `${username}-${audience}` : username;
      const dedupKey = requestId ? JSON.stringify([audience || 'default', username, String(chatId), requestId]) : null;
      // Per-key in-process mutex around check -> media -> journal -> receipt (#1302 §3.4):
      // two concurrent POSTs sharing (audience, username, chatId, requestId) must not both
      // pass the duplicate-receipt/pending check below before either has written anything.
      // This serializes only overlapping requests for the SAME key — distinct requests never
      // contend. It protects in-process concurrency only; a crash mid-sequence is still
      // recovered by the existing receipt/pending-journal records (durable dedup), not by
      // this lock — no separate admission DB is introduced.
      const admit = async () => {
        const taskId = requestId ? `${requestOwner}-${requestId}` : `${requestOwner}-${require('crypto').randomUUID()}`;
        const receipt = path.join(process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'accepted-requests', `${taskId}.json`);
        // Preserve ACK-loss deduplication for requests accepted before bot-scoped IDs.
        // Legacy receipts have no audience: conservatively acknowledge rather than replay work.
        if (requestId && audience && audience !== 'default') {
          const legacyId = `${username}-${requestId}`;
          const legacyReceipt = path.join(path.dirname(receipt), `${legacyId}.json`);
          if ((fs.existsSync(legacyReceipt) && !JSON.parse(fs.readFileSync(legacyReceipt, 'utf8')).audience) || getPendingTasks().some(p => p.taskId === legacyId && (!p.audience || p.audience === audience))) {
            return json(res, 202, { taskId: legacyId, requestId, durable: true, duplicate: true });
          }
        }
        if (requestId && (fs.existsSync(receipt) || getPendingTasks().some(p => p.taskId === taskId))) {
          return json(res, 202, { taskId, requestId, durable: true, duplicate: true });
        }
        const workDir = path.join(BASE_USERS_DIR, username);
        fs.mkdirSync(workDir, { recursive: true });

        // cwd defaults to workDir; the runner's project-binding block resolves the real
        // cwd from the bound project (projectId passed here, or the session's stored one).
        const cwd = workDir;

        // Owner canonical name = PROFILE (never «user»; see docs/PROFILE-RENAME-SPEC.md).
        // `profileId` is the owner identifier going forward; the gateway may send it
        // explicitly, but until it does we alias the existing `username` field (same
        // string value) so both repos migrate independently — no flag-day break.
        const profileId = payload.profileId ?? username;
        // audience scopes sessions/projects per bot/surface sharing this username+chatId
        // (see AUDIENCE-SCOPE-SPEC) — e.g. the recruiter bot passes 'recruiter' so its
        // sessions never mix with the general-purpose bot's. Defaults to 'default', which
        // is byte-for-byte identical to pre-audience behavior.
        const user = { id: chatId, name: username, username, profileId, workDir, cwd, telegramUserId: telegramUserId || null, audience: audience || 'default' };
        trackChat(chatId);

        // One media pipeline for every ingress: the external web bearer flow and /run
        // both copy durable refs + fsync + fold image OCR notes via intake-materializer.
        // OpenCode's models (minimax/GigaChat/DeepSeek) have no vision input, unlike Claude
        // Code whose own Read tool hands images to the model natively — Claude/Codex are left
        // alone: no known gap, and no point paying for a call the model doesn't need.
        const runEngine = profiles.getEngine(workDir, chatId);
        const { buildFileNote, materializeFileRefs } = require('./intake-materializer');

        // Save attached file (base64) to workDir and prepend path info to the task.
        let effectiveTask = task || '';
        if (fileBase64 && fileName) {
          const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
          const uploadsDir = path.join(workDir, 'media', 'intake');
          fs.mkdirSync(uploadsDir, { recursive: true });
          const filePath = path.join(uploadsDir, `${require('crypto').randomUUID()}-${safeName}`);
          try {
            const fd = fs.openSync(filePath, 'wx', 0o600);
            try { fs.writeFileSync(fd, Buffer.from(fileBase64, 'base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            const dirFd = fs.openSync(uploadsDir, 'r');
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
            const fileNote = await buildFileNote({
              filePath, mimeType: fileMimeType, engine: runEngine,
              openrouterKey: secrets.OPENROUTER_API_KEY,
            });
            effectiveTask = effectiveTask ? `${fileNote}\n\n${effectiveTask}` : fileNote;
          } catch (e) {
            console.error('[/run] file save error:', e.message);
            return json(res, 503, { error: 'attachment not persisted; retry with the same requestId' });
          }
        }

        // Durably-stored refs (photos/voice/docs referenced by id, written via
        // PUT /intake-files) use the same materialization/OCR implementation as the
        // external web bearer ingress. `fileRefs` is a destructured const, so
        // normalize into a fresh binding instead of reassigning it.
        let effectiveFileRefs = fileRefs;
        if (Array.isArray(fileRefs) && fileRefs.length) {
          try {
            const prepared = await materializeFileRefs({
              workDir, username, fileRefs, task: effectiveTask, engine: runEngine,
              openrouterKey: secrets.OPENROUTER_API_KEY,
              gatewayUrl: process.env.MEDIA_GATEWAY_URL, agentSecret: secrets.AGENT_SECRET,
            });
            effectiveTask = prepared.task;
            effectiveFileRefs = prepared.fileRefs;
          } catch (e) {
            if (e.statusCode === 400) return reject(400, { error: e.message });
            console.error('[/run] fileRef materialize error:', e.cause?.message || e.message);
            return json(res, 503, { error: 'attachment not persisted; retry with the same requestId' });
          }
        }

        // runTask journals synchronously, before any await or acknowledgement.
        const completion = runTask({ taskId, requestId: requestId || null, user, threadId, ...(Object.hasOwn(payload, 'initiatedAt') ? { initiatedAt } : {}), task: effectiveTask, context, sessionId: sessionId || null, contextFromSession: contextFromSession || null, forceClaude: !!forceClaude, forceNew: !!forceNew, initialMsgId: initialMsgId || null, pinnedMsgId: pinnedMsgId || null, secrets, fileRefs: effectiveFileRefs, mode: mode || null, projectId: projectId || null, projectPicked: projectPicked === true, newProjectName: newProjectName || null });
        completion.catch(err => console.error(`[${taskId}] runTask error:`, err.message));
        if (requestId) atomicJson(receipt, { taskId, audience: audience || 'default', acceptedAt: Date.now() });
        json(res, 202, { taskId, requestId, durable: true });
      };
      if (dedupKey) await withDedupLock(dedupKey, admit);
      else await admit();
      return;
    }

    // POST /action — call a single MCP tool directly, bypassing Claude Code entirely.
    // The "command → tool" fast path for parameterized Telegram quick-commands
    // (/eval, /review, /send_message, …). Does not touch session-store — this is
    // deliberately stateless, not a lightweight Claude session.
    if (req.method === 'POST' && url.pathname === '/action') {
      const start = Date.now();
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }

      const { username, tool, params } = body || {};
      if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) return json(res, 400, { error: 'invalid username' });
      if (!tool || typeof tool !== 'string') return json(res, 400, { error: 'tool required' });
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return json(res, 400, { error: 'params must be an object' });
      }

      const workDir = path.join(BASE_USERS_DIR, username);
      fs.mkdirSync(workDir, { recursive: true });

      try {
        const text = await runMcpTool({ tool, params: params || {}, username, workDir });
        let result = text;
        try { result = JSON.parse(text); } catch { /* tool returned plain text — keep as-is */ }
        return json(res, 200, { ok: true, result, ms: Date.now() - start });
      } catch (e) {
        const statusByCode = { bad_request: 400, tool_error: 400, timeout: 504 };
        const status = statusByCode[e.code] || 502;
        console.error('[/action]', username, tool, `${status}:`, e.message);
        return json(res, status, { error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/tokens') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      // Preflight: ZeroCreds tests reachability before showing the form to the user.
      // Respond immediately without writing anything. See isZeroCredsPreflight().
      if (isZeroCredsPreflight(payload, req.headers)) return json(res, 200, { ok: true, preflight: true });

      const userId = payload.userId || url.searchParams.get('userId');
      const label = payload.label || url.searchParams.get('label');
      const { value } = payload;
      if (!userId || !label || !value) return json(res, 400, { error: 'missing fields' });
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(userId))) return json(res, 400, { error: 'invalid userId' });
      if (!/^[a-zA-Z0-9_.-]+$/.test(label) || label.length > 64)
        return json(res, 400, { error: 'invalid label' });

      const tokensDir = path.join(dataPaths.TOKENS_ROOT, String(userId));
      fs.mkdirSync(tokensDir, { recursive: true });
      const storedValue = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      // If the target path is a directory (e.g. getcourse/ stores a Playwright session),
      // write new credentials inside it as credentials.json rather than overwriting the dir.
      let tokenFilePath = path.join(tokensDir, label);
      try {
        if (fs.statSync(tokenFilePath).isDirectory()) tokenFilePath = path.join(tokenFilePath, 'credentials.json');
      } catch { /* path doesn't exist yet — write flat file */ }
      fs.writeFileSync(tokenFilePath, storedValue, { mode: 0o600 });
      console.log(`[tokens] saved label="${label}" userId=${userId} path=${tokenFilePath}`);

      // Dispatch service-specific post-save actions (Playwright login, notifications, etc.)
      // Add new services here — no need to touch the handler logic below.
      const TOKEN_SERVICE_ACTIONS = {
        'tilda-creds': {
          guard: (c) => c?.email && c?.password,
          pendingMsg: '⏳ Данные получены — вхожу в Tilda...',
          run: (uid, c) => { const { startTildaLogin } = require('./tilda-login'); return startTildaLogin(uid, c.email, c.password); },
          ok: (r) => `✅ Tilda подключена! Сессия сохранена (${r.cookiesCount} cookies). Можно работать.`,
          err: (r) => `❌ Не удалось войти в Tilda: ${r.error}\n\nПроверь email/пароль и повтори: «подключи тильду»`,
        },
        'getcourse': {
          guard: (c) => c?.domain && (c?.login || c?.password),
          pendingMsg: '⏳ Данные получены — вхожу в GetCourse...',
          run: (uid, c) => {
            const { startGetcourseLogin } = require('./getcourse-login');
            const domain = c.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
            return startGetcourseLogin(uid, domain, c.login, c.password);
          },
          ok: (r) => `✅ GetCourse подключён! Сессия сохранена (${r.cookiesCount} cookies). Можно работать.`,
          err: (r) => `❌ Не удалось войти в GetCourse: ${r.error}\n\nПроверь логин/пароль и повтори: «подключи getcourse»`,
        },
      };

      const svcAction = TOKEN_SERVICE_ACTIONS[label];
      if (svcAction) {
        let creds;
        try { creds = JSON.parse(storedValue); } catch { /* not JSON — skip action */ }
        if (creds && svcAction.guard(creds)) {
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          const tgSend = (chatId, text) => fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
            method: 'POST', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
          }).catch(() => {});

          const chatId = readChatId(String(userId));
          if (chatId && secrets.BOT_TOKEN && !noticeAlreadySent(chatId, svcAction.pendingMsg)) tgSend(chatId, svcAction.pendingMsg);

          svcAction.run(String(userId), creds).then(result => {
            const chatId2 = readChatId(String(userId));
            const text = result.status === 'ok' ? svcAction.ok(result) : svcAction.err(result);
            if (chatId2 && secrets.BOT_TOKEN && !noticeAlreadySent(chatId2, text)) tgSend(chatId2, text);
          }).catch(e => console.error(`[tokens/${label}] action failed:`, e.message));
        }
      }

      // nalog-creds: trigger async Playwright login to Госуслуги (3-state: ok/need_code/error)
      if (label === 'nalog-creds') {
        let creds;
        try { creds = JSON.parse(storedValue); } catch { /* not JSON — skip */ }
        if (creds && creds.login && creds.password) {
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          const nalogChatId = readChatId(String(userId));
          if (nalogChatId && secrets.BOT_TOKEN && !noticeAlreadySent(nalogChatId, '⏳ Данные получены — вхожу в Госуслуги...')) {
            fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
              method: 'POST', signal: AbortSignal.timeout(8000),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: nalogChatId, text: '⏳ Данные получены — вхожу в Госуслуги...' }),
            }).catch(() => {});
          }
          ruEdgeNalogStartLogin(String(userId), creds.login, creds.password).then(result => {
            const chatId2 = readChatId(String(userId));
            if (!chatId2 || !secrets.BOT_TOKEN) return;
            let text;
            if (result.status === 'ok') {
              text = `✅ Налог.ру подключён! Токен действует до ${result.expires ? new Date(result.expires).toLocaleString('ru-RU') : '?'}.`;
            } else if (result.status === 'need_code') {
              const codeUrl = `${RU_EDGE_URL}/connect/nalog/code?sessionId=${result.sessionId}`;
              text = `📱 Введите код из SMS / приложения Госуслуги:\n\n👉 ${codeUrl}\n\nСсылка действительна 25 минут.`;
            } else {
              text = `❌ Не удалось войти в Госуслуги: ${result.error}\n\nПроверьте логин/пароль и повторите: «подключи налог»`;
            }
            if (!noticeAlreadySent(chatId2, text)) {
              fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
                method: 'POST', signal: AbortSignal.timeout(8000),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId2, text }),
              }).catch(() => {});
            }
          }).catch(e => console.error('[tokens/nalog-creds] login async failed:', e.message));
        }
      }

      // Fallback notification for unknown services (e.g. kinescope-creds, notion-login).
      // TOKEN_SERVICE_ACTIONS handles known services above; nalog-creds is handled separately.
      // For everything else: confirm receipt so the user knows what to do next.
      // Guard: skip if value is empty/trivial — ZeroCreds may POST non-preflight test calls
      // with empty or auto-generated data before the user fills the form.
      const hasRealValue = (() => {
        if (!storedValue || storedValue === '{}' || storedValue === '""' || storedValue === '') return false;
        try {
          const parsed = JSON.parse(storedValue);
          if (typeof parsed !== 'object' || parsed === null) return storedValue.length > 3;
          const vals = Object.values(parsed);
          return vals.length > 0 && vals.some(v => v && String(v).length > 0);
        } catch { return storedValue.length > 3; }
      })();
      if (!svcAction && label !== 'nalog-creds' && hasRealValue) {
        const fbChatId = readChatId(String(userId));
        const displayName = label.replace(/-creds?$/i, '').replace(/-/g, ' ');
        const serviceTitle = displayName.charAt(0).toUpperCase() + displayName.slice(1);
        const noticeText = `✅ Данные для ${serviceTitle} сохранены. Напиши «войди в ${serviceTitle}» — залогинюсь автоматически.`;
        if (fbChatId && secrets.BOT_TOKEN && !noticeAlreadySent(fbChatId, noticeText)) {
          const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
          fetch(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
            method: 'POST', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: fbChatId, text: noticeText }),
          }).catch(() => {});
        }
      }

      return json(res, 200, { ok: true });
    }

    // GET /sessions?username=xxx[&limit=N][&audience=xxx] — list sessions for a user
    if (req.method === 'GET' && url.pathname === '/sessions') {
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
      // audience scopes the list to the calling bot/surface (see AUDIENCE-SCOPE-SPEC);
      // omitted -> 'default', matching every session created before this feature existed.
      const audience = url.searchParams.get('audience') || 'default';
      const workDir = path.join(BASE_USERS_DIR, username);
      let sessionList = listSessions(workDir, limit, audience);
      // Lazily backfill durable summaries so external consumers (Telegram gateway,
      // web UI) get a meaningful {title, gist} — not a raw first-message truncation.
      // Mirrors the /sessions lazy-generation in runner.runQuickAnswer; this is the
      // HTTP entry point those UIs actually hit, so the class lives here too.
      const orKey = secrets.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
      const stale = sessionList.filter(s => needsSummary(s));
      if (stale.length && orKey) {
        await Promise.all(stale.map(async (s) => {
          try {
            const full = getSessionData(workDir, s.id);
            if (!full) return;
            const sum = await generateSummary(full.messages, { apiKey: orKey });
            if (sum) setSummary(workDir, s.id, sum, s.messageCount);
          } catch { /* best-effort; fall back to raw topic */ }
        }));
        sessionList = listSessions(workDir, limit, audience); // reload with fresh summaries
      }
      // Resolve projectId -> projectName so the gateway/web session lists can label
      // each dialog by its typed project (issue #517).
      try {
        const { getProject } = require('./projects');
        const nameCache = {};
        sessionList = sessionList.map(s => {
          if (!s.projectId) return s;
          if (!(s.projectId in nameCache)) {
            const p = getProject(workDir, s.projectId);
            nameCache[s.projectId] = p ? p.name : null;
          }
          return { ...s, projectName: nameCache[s.projectId] };
        });
      } catch { /* projects model unavailable — leave list as-is */ }
      return json(res, 200, { sessions: sessionList });
    }

    // POST /sessions/archive — remove sessions from the index
    if (req.method === 'POST' && url.pathname === '/sessions/archive') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { username, sessionIds } = payload;
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      if (!Array.isArray(sessionIds) || sessionIds.length === 0)
        return json(res, 400, { error: 'sessionIds must be a non-empty array' });
      const workDir = path.join(BASE_USERS_DIR, username);
      const archived = archiveSessions(workDir, sessionIds);
      return json(res, 200, { archived });
    }

    // GET /sessions/:id?username=xxx — get full session with messages
    const sessionMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const id = sessionMatch[1];
      const username = url.searchParams.get('username');
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });
      const workDir = path.join(BASE_USERS_DIR, username);
      const session = getSessionData(workDir, id);
      if (!session) return json(res, 404, { error: 'not found' });
      return json(res, 200, session);
    }

    // POST /classify — decide which session a message belongs to
    if (req.method === 'POST' && url.pathname === '/classify') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }

      const { message, sessions: sessionList } = payload;
      if (!message || !Array.isArray(sessionList) || sessionList.length === 0)
        return json(res, 400, { error: 'missing fields' });

      // Only classify against sessions active in the last 24 hours to avoid linking
      // new tasks to stale contexts from days ago.
      const SESSION_CLASSIFY_TTL_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const recentSessions = sessionList.filter(s => (now - s.lastAt) < SESSION_CLASSIFY_TTL_MS);

      if (recentSessions.length === 0) {
        return json(res, 200, { sessionId: null, confidence: 'low' });
      }

      try {
        const result = await classifyMessage(message, recentSessions, secrets.OPENROUTER_API_KEY);
        return json(res, 200, result);
      } catch (e) {
        console.error('[classify] error:', e.message);
        return json(res, 200, { sessionId: null, confidence: 'low' }); // fallback: show picker
      }
    }

    // POST /intake-gate — cheap completeness check for the debounce DO (ШАГ 1.2)
    if (req.method === 'POST' && url.pathname === '/intake-gate') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid json' }); }
      const { text } = payload;
      if (typeof text !== 'string') return json(res, 400, { error: 'missing text' });
      // #1542 P1: router SHADOW next to the legacy completeness gate — never awaited.
      const routerShadow = startInputRouterShadow({
        text, source: 'intake-gate', user: typeof payload.userId === 'string' || typeof payload.userId === 'number' ? String(payload.userId) : null,
        openrouterKey: secrets.OPENROUTER_API_KEY,
      });
      try {
        const result = await checkCompleteness(text, secrets.OPENROUTER_API_KEY);
        routerShadow.record({ completeness: result?.level || null, complete: !!result?.complete });
        return json(res, 200, result);
      } catch (e) {
        console.error('[intake-gate] error:', e.message);
        routerShadow.record({ completeness: 'error', complete: false });
        return json(res, 200, { level: 'insufficient', complete: false }); // preserve intake; manual launch remains available
      }
    }

    // GET /files?username=xxx&path=relative — list directory contents
    if (req.method === 'GET' && url.pathname === '/files') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.')) // hide dotfiles
          .map(e => {
            if (e.isDirectory()) {
              let count = 0;
              try { count = fs.readdirSync(path.join(target, e.name)).filter(n => !n.startsWith('.')).length; } catch {}
              return { name: e.name, type: 'dir', count };
            }
            let size = 0;
            try { size = fs.statSync(path.join(target, e.name)).size; } catch {}
            return { name: e.name, type: 'file', size };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return json(res, 200, { path: relPath, entries });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // GET /files/read?username=xxx&path=relative — read a file
    if (req.method === 'GET' && url.pathname === '/files/read') {
      const username = url.searchParams.get('username');
      const relPath  = url.searchParams.get('path') || '';
      if (!username || !/^[a-zA-Z0-9_-]+$/.test(username))
        return json(res, 400, { error: 'invalid username' });

      const workDir = path.join(BASE_USERS_DIR, username);
      const target  = path.resolve(path.join(workDir, relPath));
      if (target !== workDir && !target.startsWith(workDir + path.sep))
        return json(res, 400, { error: 'path traversal' });

      const ext = path.extname(target).toLowerCase();
      const READABLE = ['.md', '.json', '.txt', '.log', '.js', '.ts', '.yaml', '.yml', '.toml', '.env'];
      if (!READABLE.includes(ext))
        return json(res, 400, { error: 'not a readable file type' });

      try {
        const raw = fs.readFileSync(target, 'utf8');
        const MAX = 3500;
        return json(res, 200, {
          path: relPath,
          content: raw.length > MAX ? raw.slice(0, MAX) : raw,
          truncated: raw.length > MAX,
          size: raw.length,
        });
      } catch (e) {
        return json(res, 404, { error: 'not found' });
      }
    }

    // POST /webhooks/weeek-session — triggered by CF Worker when WEEEK_APP_COOKIE expires (401)
    // Auth: Bearer AGENT_SECRET (same as other endpoints)
    if (req.method === 'POST' && url.pathname === '/webhooks/weeek-session') {
      json(res, 202, { ok: true, message: 'Refresh started' });
      // Run refresh in background, send Telegram alert with result
      const refreshScript = path.join(__dirname, '..', 'scripts', 'refresh-weeek-session.js');
      const env = {
        ...process.env,
        TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN,
        CF_API_TOKEN: secrets.CF_API_TOKEN || '',
        OPERATOR_CHAT_ID: secrets.OPERATOR_CHAT_ID || '1714048',
      };
      const child = spawn('node', [refreshScript], { env, detached: true, stdio: 'inherit' });
      child.unref();
      console.log('[weeek-session] Refresh script started, pid:', child.pid);
      return;
    }

    // POST /admin/refresh-weeek-session — synchronous refresh, returns new cookie
    // Used by CF Workers (flexi-exhibition-deal-bot) to recover from 401/403 mid-request
    if (req.method === 'POST' && url.pathname === '/admin/refresh-weeek-session') {
      const { execSync } = require('child_process');
      const refreshScript = path.join(__dirname, '..', 'scripts', 'refresh-weeek-session.js');
      const body = await readBody(req).then(b => { try { return JSON.parse(b); } catch { return {}; } });
      const profiles = (body.profiles || 'flexi,flexi-consult').split(',').map(s => s.trim()).filter(Boolean);
      const env = {
        ...process.env,
        TELEGRAM_BOT_TOKEN: secrets.BOT_TOKEN,
        CF_API_TOKEN: secrets.CF_API_TOKEN || '',
        OPERATOR_CHAT_ID: secrets.OPERATOR_CHAT_ID || '1714048',
        WEEEK_SESSION_PROFILES: profiles.join(','),
      };
      try {
        execSync(`node "${refreshScript}"`, { env, timeout: 90000, stdio: 'pipe' });
        // Read back the freshly written cookie
        const cookiePath = path.join(os.homedir(), 'agent-tokens', profiles[0], 'weeek-session');
        const cookie = fs.existsSync(cookiePath) ? fs.readFileSync(cookiePath, 'utf8').trim() : '';
        if (!cookie) return json(res, 500, { ok: false, error: 'Refresh succeeded but cookie file is empty' });
        console.log('[weeek-session] Sync refresh done, profile=%s, cookie length=%d', profiles[0], cookie.length);
        return json(res, 200, { ok: true, cookie });
      } catch (e) {
        console.error('[weeek-session] Sync refresh failed:', e.message.slice(0, 200));
        return json(res, 500, { ok: false, error: e.message.slice(0, 300) });
      }
    }


    // ── ATS Template Editor (BEHIND Bearer gate) ──────────────────────────────
    if (isHhPath(url.pathname) && await handleHhAuthed(req, url, res, { ...hhCtx, secrets }) !== false) return;


    // POST /playwright-fetch moved to the RU edge service (src/ru-edge.js) — the
    // ru_browser_fetch/ru_browser_screenshot MCP skills already call
    // platform.recruiter-assistant.ru directly (src/mcp-skills/tools/22-ru-browser.js),
    // unchanged by this migration.

    // POST /report — create GitHub issue from user bug report / feature request
    if (req.method === 'POST' && url.pathname === '/report') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'bad json' }); }

      const { username, description, sessionId } = body || {};
      if (!username || !description) return json(res, 400, { error: 'username and description required' });

      const ghToken = secrets.GITHUB_BUG_REPORT_TOKEN;
      if (!ghToken) return json(res, 503, { error: 'bug reporting not configured (GITHUB_BUG_REPORT_TOKEN missing)' });

      // Collect session context (last 8 messages)
      let contextLines = [];
      try {
        const workDir = userWorkDir(username);
        if (sessionId) {
          const sessionFile = path.join(workDir, 'sessions', `${sessionId}.json`);
          if (fs.existsSync(sessionFile)) {
            const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            const messages = (session.messages || []).slice(-8);
            contextLines = messages.map(m => {
              const role = m.role === 'user' ? '👤 User' : '🤖 Claude';
              const text = (m.content || '').slice(0, 400);
              return `**${role}:** ${text}${(m.content || '').length > 400 ? '…' : ''}`;
            });
          }
        }
      } catch (e) {
        console.warn('[report] failed to load session context:', e.message);
      }

      const now = new Date().toISOString();
      const contextSection = contextLines.length
        ? `## Session context\n\n${contextLines.join('\n\n')}`
        : '## Session context\n\n_No session context available_';

      const issueBody = `## User report\n\n**User:** \`${username}\`  \n**Time:** ${now}  \n**Session:** \`${sessionId || 'unknown'}\`\n\n${description}\n\n---\n\n${contextSection}`;

      const title = description.length > 80 ? description.slice(0, 77) + '…' : description;

      try {
        const ghRes = await fetch('https://api.github.com/repos/trained-assist/trained-assist-agent/issues', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'trained-assist-agent',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ title, body: issueBody, labels: ['user-report'] }),
          signal: AbortSignal.timeout(15000),
        });
        if (!ghRes.ok) {
          const err = await ghRes.json().catch(() => ({}));
          console.error('[report] GitHub API error:', ghRes.status, err.message);
          return json(res, 502, { error: `GitHub API error: ${err.message || ghRes.statusText}` });
        }
        const issue = await ghRes.json();
        console.log(`[report] Issue created: #${issue.number} by ${username}`);
        return json(res, 200, { number: issue.number, url: issue.html_url });
      } catch (e) {
        console.error('[report] error creating issue:', e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // GET /publish/pages?username=X — list published pages for a user
    if (req.method === 'GET' && url.pathname === '/publish/pages') {
      const username = url.searchParams.get('username') || '';
      if (!username) return json(res, 400, { error: 'username required' });
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      const pages = fs.existsSync(indexFile)
        ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        : [];
      return json(res, 200, { pages });
    }

    // DELETE /publish/pages — delete a page by slug
    if (req.method === 'DELETE' && url.pathname === '/publish/pages') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const { username, slug } = body || {};
      if (!username || !slug) return json(res, 400, { error: 'username and slug required' });

      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const metaFile = path.join(dataDir, 'pages', slug, 'meta.json');
      if (!fs.existsSync(metaFile)) return json(res, 404, { error: 'page not found' });
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.owner !== username) return json(res, 403, { error: 'not your page' });

      fs.rmSync(path.join(dataDir, 'pages', slug), { recursive: true, force: true });

      const indexFile = path.join(dataDir, 'publish-owners', `${username}.json`);
      if (fs.existsSync(indexFile)) {
        const list = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(p => p.slug !== slug);
        fs.writeFileSync(indexFile, JSON.stringify(list));
      }
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[request-handler] unhandled error:', err);
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: 'internal server error' }));
    }
  });

  server.listen(PORT, () => {
    console.log(`assist-agent listening on :${PORT}`);
  });

  // A deploy rewrites the opencode-go auth.json to the pool's first key even when that key is
  // parked as dead/exhausted — without this, every restart re-broke Go for the whole VM (2026-09-26).
  {
    const goKeys = require('./opencode-go-keys');
    const healed = goKeys.ensureUsableActiveKey();
    console.log(healed
      ? `[opencode-go-keys] startup: active key#${healed.fromIndex} is parked — switched to key#${healed.toIndex} (${goKeys.activeKeyFingerprint()})`
      : `[opencode-go-keys] startup: active ${goKeys.activeKeyFingerprint()} of ${goKeys.readPool().length}`);
  }

  // Drive watcher: poll every 2 min for new files shared with the SA
  const driveOpts = { botToken: secrets.BOT_TOKEN, tgBase: process.env.TELEGRAM_API_URL };
  const drivePoll = () => {
    pollDriveChanges(driveOpts).catch(() => {});
  };
  drivePoll();
  setInterval(drivePoll, 2 * 60 * 1000);

  scheduleNalogExpiryChecks(secrets);
  if (hhNeg.scheduleHhBackgroundScoring) hhNeg.scheduleHhBackgroundScoring();
// Cold search runs on the generic cron (#1489 S7.1): one job per vacancy, managed by
// hh_proactive_schedule in hh-skill. No HH timer in core.
  if (process.env.TEST_MODE !== '1') scheduleGtdController(secrets);
  // Generic cron engine (#1489): ticks only on CRON_SCHEDULER_ROLE=primary, never on staging.
  if (process.env.TEST_MODE !== '1') require('./cron-runtime').startScheduler();


  // Restart is instant: no drain, no waiting for active work. Running tasks stay in the
  // pending-task journal (interruptForRestart keeps it) and the next process resumes them
  // silently — see resumePendingTasks. Losing a task's last minute is the accepted cost of
  // never blocking a deploy or a /restart.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    interruptForRestart();
    server.close();
    // `interruptForRestart()` settles every running task's promise, which fires
    // the fire-and-forget run-finished push — and `process.exit(0)` immediately
    // after would drop it mid-flight. The push is the ONLY way the gateway
    // learns a restart released a chat, so a restart must deliver it before
    // dying, otherwise every in-flight group chat stays `busy` until the
    // gateway's slow safety nets catch up (see gateway-callback.js). Bounded
    // by the fetches' own 5s timeout, so a restart stays quick.
    const flushed = require('./gateway-callback').flushRunFinished();
    // Never block the restart on a hung request: exit on whichever comes first.
    const exit = () => process.exit(0);
    setTimeout(exit, 6000).unref?.();
    flushed.then(exit, exit);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT',  shutdown);
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readBodyBuffer(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// True only when the vacancy's ats_config.interview_config has real, recruiter-provided
// availability — gates whether the outgoing-message guard allows naming a specific time.
// Implemented in hh-negotiations.js (issue #942 P0.6).


// ── HH review page ────────────────────────────────────────────────────────────



// Refresh an expired HH OAuth access_token using the stored refresh_token.
// Returns the new access_token on success, or null on failure (caller is expected
// to surface "HH re-auth required" to the recruiter).
// Implemented in hh-utils.js (refreshHhToken), imported above (issue #942 P0.6).

// Orphaned-server EPIPE guard (see src/stream-gone.js).
installCrashGuards();

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

// ── Instant-publish helpers ───────────────────────────────────────────────────

function publishPasswordForm(slug, error) {
  return `<!DOCTYPE html><html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Требуется пароль</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb}
  .box{background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center;max-width:360px;width:100%}
  h2{margin:0 0 16px;font-size:18px;color:#1a1a2e}
  input{width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:12px;box-sizing:border-box}
  button{width:100%;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
  button:hover{background:#1d4ed8}
  .err{color:#dc2626;font-size:14px;margin-bottom:12px}
</style></head><body>
<div class="box">
  <h2>Страница защищена паролем</h2>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form onsubmit="location.href='?password='+encodeURIComponent(document.getElementById('pw').value);return false">
    <input id="pw" type="password" placeholder="Введите пароль" autofocus>
    <button type="submit">Открыть</button>
  </form>
</div></body></html>`;
}



// ── Misha bot ─────────────────────────────────────────────────────────────────
// Direct Telegram webhook for @cmr_management_bot.
// Handles text, voice (Deepgram transcription), photos, /new_deal command.

