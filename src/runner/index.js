const { taskDelivery } = require('../bot-delivery');
const { startShadow: startInputRouterShadow } = require('../input-router');
const { atomicJson } = require('../atomic-json');
let restartShutdown = false;
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeRunMcpConfig } = require('../browser');
const { isolationConfig } = require('../agent-isolation');
const sessions = require('../session-store');
const answerActions = require('../answer-actions');
const { getCurrentSessionId, setCurrentSessionId } = require('../session-store');
const projects = require('../projects');
const { isAuthError, setAuthFailedFlag, clearAuthFailedFlag } = require('../auth-flag');
const { isTerminalQuickCrash, engineFallbackNotice, engineAuthNotice } = require('../engine-crash-policy');
const ocLadder = require('../opencode-ladder-provider');
const { MAX_RETRIES: MAX_INCOMPLETE_RETRIES, getRetryDelayMs } = require('../retry-policy');
const { recordUsage } = require('../usage-store');
const promptAudit = require('../prompt-audit');
const { classifyDeterministic: classifyFailureDeterministic } = require('../failure-classifier');
const executionHistory = require('../execution-history');
const { markEngineSuccess, markEngineFailure, isCredentialInvalidClass } = require('../engine-health');
const { randomUUID } = require('crypto');
const { recordQuickExchange, escalateRows } = require('../quick-reply');
const {
  loadUserTokens,
  listConnectedServices,
  generateConnectLink,
} = require('../user-tokens');
const { initLog, readLog } = require('../requirements-log');
const { hhLib, hhAvailable } = require('../domains/hh/lib');
const { writeVacancyState } = hhLib('hh-vacancy');
// Read on every run — no hh-skill checkout → no vacancy state (core keeps working).
const readVacancyState = (workDir) => (hhAvailable('hh-vacancy') ? hhLib('hh-vacancy').readVacancyState(workDir) : null);
const persona = require('../persona');
const profiles = require('../profiles');
const { TOKENS_ROOT } = require('../data-paths');
const answerRouter = require('../answer-router');
const promptDomains = require('../prompt-domains');
// Slice C of #1573: offer the audience-default playbook at the start of a
// development-like task. Returns '' unless a playbook is actually available, so
// profiles without one get a byte-identical prompt.
const { buildDevPlaybookSuggestion } = require('../dev-task-playbook-suggestion');
const { buildAwaitingUserNotice } = require('../durable-wait');
const skillsShadow = require('../skills/shadow');
// Telegram send/edit + markdown-degradation ladder chokepoint live in
// tg-stream.js (issue #942 P1.4). The module owns the format/send/edit
// primitives; runner.js keeps orchestration (queueing, retries around them).
const { TG_API, tgSend, tgEdit } = require('./tg-stream');
const { notifyRunFinished } = require('../gateway-callback');
const {
  getQuickAnswer,
  verifyQuickAnswerIntent,
  runQuickAnswer,
  STOP_TASK_INTENT,
  GTD_STOP_INTENT,
  ACTIVE_CHECKLIST_INTENT,
  FORGOTTEN_CHECKLISTS_INTENT,
  CHECKLIST_EDIT_INTENT,
  WAKEUP_INTENT,
  SKIP_TASK_INTENT,
  PING_INTENT,
  HELP_INTENT,
  SESSIONS_INTENT,
  SESSION_DETAIL_INTENT,
  USAGE_INTENT,
  SECRETS_LIST_INTENT,
  SECRETS_LOG_INTENT,
  CONTEXT_OFF_INTENT,
  CONTEXT_ON_INTENT,
  PERSONA_INTENT,
  SETTINGS_INTENT,
  PROJECT_INTENT,
  AGENT_INFO_INTENT,
  MODEL_INFO_INTENT,
  BUG_OR_FEATURE_INTENT,
  isPreQueueQuickIntent,
  shouldAttemptQuickAnswer,
  HH_MY_VACANCIES_INTENT,
  HH_FUNNEL_INTENT,
  HH_RESPONSES_INTENT,
  HH_ATS_EDITOR_INTENT,
  HH_REVIEW_PAGE_INTENT,
  ENGINE_SWITCH_INTENT,
} = require('./intent-engine');

// Engine execution (spawn + stream-json + timeout/close) lives in claude-runner.js
// (issue #942 P1.3) so the process machinery is a self-contained testable unit.
const { runEngineProcess, buildEngineCommand, inputInspectionRows, resolveEngineCwd } = require('./claude-runner');
// «Стоп»: реальный kill дерева процессов под run-as изоляцией + trace-тумбстоуны
// (spec: docs/user-scenarios/core/02-stop-and-supplement.md §2/§2а).
const { stopEngineProcess } = require('./engine-stop');
const { traceIdFor, markTraceStopped, isRunStopped } = require('../stop-trace');

const STREAM_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 3000;
const STOP_BUTTON_AFTER_SECS = 5;
const MAX_MSG_LEN = 3500;

// Telegram cards report token usage only; monetary estimates are not displayed.
//
// The model reads the WHOLE prompt every step (fresh input + cache read + cache
// write), so reporting only input_tokens made a ~57K-step look like "вход 6K"
// and misled the owner into doubting the system-prompt size (#149 follow-up,
// owner decision 27.09.2026 "давай да поправим"). When any cache part is
// present we show the honest total with a breakdown; with no cache at all the
// footer is unchanged (total === input anyway).
function formatCostFooter(usage) {
  if (!usage) return '';
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cr  = usage.cache_read_input_tokens || 0;
  const cw  = usage.cache_creation_input_tokens || 0;
  const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fmtK = n => n >= 1e6 ? `${Math.round(n / 1e4) / 100}M`
    : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const parts = [inputPart(inp, cr, cw, fmt, fmtK), `выход ${fmt(out)}`];
  return `\n\nИспользование: ${parts.join(' · ')}`;
}

// "вход N" when no cache; "вход всего T (новых N, из кэша R, в кэш +W)" otherwise.
function inputPart(inp, cr, cw, fmt, fmtK) {
  if (cr <= 0 && cw <= 0) return `вход ${fmt(inp)}`;
  const bits = [`новых ${fmtK(inp)}`];
  if (cr > 0) bits.push(`из кэша ${fmtK(cr)}`);
  if (cw > 0) bits.push(`в кэш +${fmtK(cw)}`);
  return `вход всего ${fmtK(inp + cr + cw)} (${bits.join(', ')})`;
}

// breakdown: [{ agent, model, input, output, cacheRead, cacheWrite, cost }]
// Одна строка, словами, без иконок. Показываем только реально использованную
// модель (в проде из всего конфига профиля реально работает одна).
function formatOcFooter(usage, breakdown) {
  if (!usage) return '';
  const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const fmtK = n => n >= 1e6 ? `${Math.round(n / 1e4) / 100}M`
    : n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  let model = '';
  if (breakdown) {
    for (const s of breakdown) {
      if (s.model) { model = s.model.split('/').pop().replace(/:free$/, ''); break; }
    }
  }
  const inp = usage.input || 0;
  const cr  = usage.cacheRead || 0;
  const cw  = usage.cacheWrite || 0;
  const parts = [inputPart(inp, cr, cw, fmt, fmtK), `выход ${fmt(usage.output)}`];
  const m = model ? ` ${model}` : '';
  return `\n\nИспользование${m}: ${parts.join(' · ')}`;
}

// Pick the text shown to the user. Prefer Claude's clean result-event string; otherwise
// the last complete assistant turn; only as a last resort the whole accumulated stream
// (the scratchpad). This stops "Let me confirm… Now writing…" narration leaking as final.
function pickFinalText(claudeResult, lastAssistantMsg, fullText) {
  const clean = typeof claudeResult === 'string' ? claudeResult.trim() : '';
  if (clean) return clean;
  const last = (lastAssistantMsg || '').trim();
  if (last) return last;
  return (fullText || '').trim();
}

// True when pickFinalText() has nothing but the raw scratchpad to fall back on — no clean
// result-event string, no captured coherent turn. What's shown is mid-thought narration
// ("Смотрю X:", tool calls interleaved with text), not a concluded answer. The SIGTERM/
// user-stop paths already frame their message as interrupted, but the normal completion
// path (exitCode 0, no timeout/stop) has nothing else signaling this — it must mark it
// explicitly instead of presenting a cut-off narration as if it were the final answer (#577
// follow-up: #577 fixed narration only leaking via lastAssistantMsg, not this scratchpad gap).
function isScratchpadFallback(claudeResult, lastAssistantMsg) {
  const clean = typeof claudeResult === 'string' ? claudeResult.trim() : '';
  const last = (lastAssistantMsg || '').trim();
  return !clean && !last;
}

const CLAUDE_TIMEOUT_MS = 40 * 60 * 1000; // 40 min hard limit
// Единый ответ на заблокированный гейтом Стопа хоп и на consumePendingStop —
// isUserStoppedReply (stop-trace.js) матчит его, поэтому GTD/durable закрывают
// запись как user-stop, а не уходят в ретрай (R3/R4).
const STOP_NOT_STARTED_MSG = '⛔ Остановлено до начала выполнения.';
const WARN_TIMEOUT_MS  = 38 * 60 * 1000; // 38 min — graceful SIGTERM + Telegram warning before hard kill
const MAX_CONTINUATIONS = 10; // auto-resume after timeout up to 10 times
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min silence → kill + auto-restart (all engines)
const QUICK_CRASH_MS = 15 * 1000; // crash faster than this after launch → likely transient, worth 1 retry
const MAX_QUICK_RETRIES = 1; // cap so a repeatable crash doesn't loop forever
// #1474: a provider-side fault (rejected key, quota/usage limit, rate limit, 5xx) says nothing
// about the engine SESSION — the transcript is intact, only the upstream call failed. Such an
// error must not trigger the native-resume fallback (which drops the engine session and restarts
// from a rebuilt context — the "lost history" users saw after the 2026-09-26 dead-key restarts).
// 'context' (prompt too long) is deliberately NOT a provider fault: a fresh rebuilt context is the
// right answer there.
function isProviderFault(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/invalid credential|invalid api key|unauthori[sz]ed|\b401\b/i.test(t)) return true;
  if (/usage limit|purchase more credits|rate.?limit|too many requests|\b429\b|\b5\d\d\b|overloaded|upstream request failed|unexpected server error|bad\s*request/i.test(t)) return true;
  const workerFailure = ocLadder.classifyWorkerFailure(t);
  return !!workerFailure && workerFailure !== 'context';
}
const MAX_RESUME_ATTEMPTS = 3; // cap on auto-retries for a task resumed after a server restart — a
// restart is our fault, not the user's, so it's worth retrying automatically, but bounded: without
// this, a task whose resume keeps crashing (e.g. a genuinely broken session) would retry forever
// across restarts. resumePendingTasks() in server.js reads/writes this same cap.
// MAX_INCOMPLETE_RETRIES (from retry-policy, shared with the resume-after-restart backoff below)
// bounds the OTHER dead-end: a run that exits without a confirmed final answer for reasons that
// aren't a restart, a quota/ladder hit, or an auth failure (those have their own specific retry
// paths below) — e.g. a bare crash mid-task, or the engine just not emitting a completion event.
// Previously this dead-ended immediately with "напиши продолжай", pushing a transient hiccup onto
// the human. getRetryDelayMs() gives the same 30s/3min/10min (ms in TEST_MODE) backoff as the
// restart-resume path, so a provider blip gets a chance to pass before we ask a human to retry.

// ── Pending-task journal — survives process restart ──────────────────────────
const PENDING_DIR = path.join(
  process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'),
  'pending-tasks'
);

function savePendingTask(taskId, params) {
  const file = path.join(PENDING_DIR, `${taskId}.json`);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  atomicJson(file, { ...previous, ...params, threadId: params.threadId ?? previous?.threadId ?? null,
    // Identity survives phase rewrites and restart-resume (epic #1365 CH-08): the first
    // taskId/requestId of a request stay attached to every later attempt.
    rootTaskId: previous?.rootTaskId ?? params.rootTaskId ?? taskId,
    requestId: previous?.requestId ?? params.requestId ?? null,
    // Retries and transition to running must never refresh the original intent.
    initiatedAt: previous ? (Object.hasOwn(previous, 'initiatedAt') ? previous.initiatedAt : null) : (Object.hasOwn(params, 'initiatedAt') ? params.initiatedAt : null) });
}

function recordTaskActivity(_opts, _at = Date.now()) {
  // no-op: restart-activity tracking removed
}

function bindTaskActivity(taskId, user, sessionId) {
  const file = path.join(PENDING_DIR, `${taskId}.json`);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  atomicJson(file, { ...pending, sessionId, activitySessionId: sessionId });
  if (Number.isFinite(pending.initiatedAt)) recordTaskActivity({ user, sessionId, threadId: pending.threadId }, pending.initiatedAt);
}

function clearPendingTask(taskId) {
  try { fs.unlinkSync(path.join(PENDING_DIR, `${taskId}.json`)); } catch (e) { console.warn('[runner] clearPendingTask:', e.message); }
}

function getPendingTasks() {
  if (!fs.existsSync(PENDING_DIR)) return [];
  // One malformed journal entry must not abort resume for every OTHER task —
  // this runs once at boot (resumePendingTasks) and used to let a single bad
  // JSON.parse throw out of the whole function, silently stranding every
  // legitimately-resumable session (including GTD turns) behind it.
  return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); }
      catch (e) { console.warn(`[runner] getPendingTasks: skipping malformed ${f}:`, e.message); return null; }
    })
    .filter(Boolean);
}

// Legacy timers are retired on startup; completed answers never authorize new work.
const { retireSoftContinuations } = require('./retire-soft-continuations');
async function reconcileSoftContinuations(secrets) {
  return retireSoftContinuations({ editMessage: (record, text) =>
    tgEdit(secrets.BOT_TOKEN, record.chatId, record.msgId, text, { reply_markup: { inline_keyboard: [] } }) });
}

// ── Concurrency model ────────────────────────────────────────────────────────
//
// Two layers, each with a different scope:
//
//  1. perChatQueue (Map<chatId, Promise>) — ONE TASK AT A TIME PER CHAT.
//     The top-level invariant: tasks from the same Telegram chat/group always
//     queue behind each other, regardless of which session they belong to.
//     Different chats (even sharing the same workDir/profile) run in parallel.
//     chatId=0 (internal/web calls) is excluded. This lock is deliberate and
//     must stay: in one Telegram chat there can't be more than one task at a
//     time — the chat is the single stream the user reads from.
//
//  2. Global semaphore + RAM watchdog — OOM GUARD.
//     Bounds how many live `claude` processes run in total (MAX_CONCURRENT_TASKS)
//     and holds off spawning while free RAM is low (task-queue.js).
//
// There are deliberately NO per-session, per-profile or per-workDir locks.
// A profile may run as many tasks as it likes across its chats; different
// sessions and sessions sharing a workDir all run in parallel. Safe because
// context is rebuilt from the session store (no `claude --resume`), so
// parallel claudes never share a transcript file.
//
// Per-chat serialization (layer 1) + the global RAM-aware concurrency
// semaphore (layer 2) live in src/runner/task-queue.js so admission logic is
// unit-testable without pulling in the whole runner.
const {
  admission,
  _acquireSlot,
  _releaseSlot,
  _waitForRam,
} = require('./task-queue');
const { legacyAdmissionScopes } = require('../core/execution-context');
const { fromLegacyTelegram } = require('../core/conversation-ref');
// Shadow-only (epic #1365 PR2b): compares, logs, never decides.
const sessionShadow = require('../core/conversation-session-index').createConversationSessionIndex({ store: sessions });

// Active task timer state — allows Claude to extend its own session via MCP tool.
// Map<taskId, { killFn, killTimer, extendCount, proc }>
const activeTimers = new Map();

// Ownership matcher for a specific taskId (#1303). Aligned with the #1302 §3.2
// rule used by stopUserTask/killTaskByUsername: EXACT username (never a taskId
// string-prefix), audience normalized to 'default', and chatId compared only
// when both the task state and the caller carry one — a private-chat chatId is
// the Telegram user's own id, identical no matter which bot is messaged, so it
// cannot disambiguate audiences by itself. Kept in one place so the taskId stop
// path can never drift from the username-scoped path.
function taskOwnedBy(state, owner) {
  if (!state || !owner || typeof owner.username !== 'string' || !owner.username) return false;
  if (state.username !== owner.username) return false;
  if ((state.audience || 'default') !== (owner.audience || 'default')) return false;
  if (owner.chatId != null && state.chatId != null && String(state.chatId) !== String(owner.chatId)) return false;
  // Forum topics (#255): when the caller scopes to a topic, only a task started in
  // that same topic matches — stop in topic A must never kill a task in topic B.
  // A threadId-less caller (owner.threadId == null) keeps the legacy chat-wide scope.
  if (owner.threadId != null && state.threadId != null && Number(state.threadId) !== Number(owner.threadId)) return false;
  return true;
}

/**
 * Stop one running task by its exact taskId.
 *
 * `owner` is REQUIRED (#1303): AGENT_SECRET is shared by every first-party
 * gateway and therefore proves nothing about who owns a taskId. Without an
 * owner match, any caller that knows a taskId could SIGTERM another profile's
 * or another bot's task. owner = { username (required), audience?, chatId? },
 * matched by taskOwnedBy. A missing or mismatching owner returns
 * { ok:false, forbidden:true } and the task keeps running.
 */
function stopTask(taskId, owner = null) {
  const s = activeTimers.get(taskId);
  if (!s?.proc) return { ok: false, error: 'task not found or already finished' };
  if (!taskOwnedBy(s, owner)) {
    console.warn(`[runner] stopTask refused: owner missing/mismatch for ${taskId}`);
    return { ok: false, forbidden: true, error: 'forbidden: task belongs to another owner' };
  }
  stopEngineProcess(s);
  // Координаты берём из САМОГО рана, а не из запроса: адрес диалога должен
  // совпадать с тем, что посчитал гейт, иначе retry этой задачи ускользнёт.
  stopTracesFor({ username: s.username, chatId: s.chatId, audience: s.audience, threadId: s.threadId ?? null, sessionId: s.sessionId });
  console.log(`[${taskId}] stopped by user`);
  return { ok: true };
}

// Stop running task(s) for a given username (used by the /stop quick command).
// One profile's workDir is deliberately shared across multiple Telegram chats
// (see runTask's queueKey comment) AND — since #1302 — across multiple bots
// (audience: 'default', 'recruiter', 'freelance', ...) sharing that same profile.
// chatId alone cannot disambiguate bots: in a private chat, chatId is the
// Telegram user's own id, identical no matter which bot they're messaging — so
// audience must scope the kill too, not just chatId. Pass chatId to scope to the
// chat that actually started the task; omit chatId only for genuinely
// profile-wide callers (e.g. /gtd_stop's explicit hard-stop) within that audience.
// Omitting audience scopes to 'default' — never "every audience" (#1302 §3.2/§2).
function stopUserTask(username, chatId = null, audience = null, threadId = null) {
  const scopedAudience = audience || 'default';
  let stopped = false;
  for (const [taskId, s] of activeTimers.entries()) {
    if (!s.proc) continue;
    // Single shared ownership rule (#1303) — exact username + audience (+ chatId
    // when both sides carry one), never a taskId prefix. Keeps this path and
    // stopTask(taskId, owner) from drifting apart.
    if (!taskOwnedBy(s, { username, audience: scopedAudience, chatId, threadId })) continue;
    stopEngineProcess(s);
    console.log(`[${taskId}] stopped by user command`);
    stopped = true;
  }

  // Fallback: kill orphaned Claude processes (e.g. from before a service restart)
  // The mcp-config path contains the username, so we can grep the process list.
  // Orphans carry no chat/audience attribution, so this fallback only runs for a
  // genuinely profile-wide default-audience stop (chatId omitted, audience
  // omitted/default) — otherwise it would kill another chat's or another bot's
  // orphan under a scoped "стоп", recreating the cross-chat/cross-bot leak this guards.
  if (!stopped && !chatId && scopedAudience === 'default') {
    try {
      const { execSync } = require('child_process');
      // Find PIDs of claude processes for this user by mcp-config path
      const pattern = `/users/${username}/`;
      const out = execSync(`pgrep -f "claude.*${pattern}" 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      for (const pid of out.split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
          console.log(`[runner] stopUserTask killed orphan PID ${pid} for ${username}`);
          stopped = true;
        } catch (e) {
          console.warn(`[runner] stopUserTask orphan kill ${pid}:`, e.message);
        }
      }
    } catch (e) {
      console.warn('[runner] stopUserTask orphan search failed:', e.message);
    }
  }

  return stopped;
}

/**
 * Extend the timeout for a running task by another CLAUDE_TIMEOUT_MS.
 * Called from server.js POST /tasks/:taskId/extend-timeout which the
 * session_extend_timeout MCP tool invokes.
 */
function extendTaskTimeout(taskId) {
  const s = activeTimers.get(taskId);
  if (!s?.proc) return { ok: false, error: 'task not found or already finished' };
  if (s.extendCount >= 8) return { ok: false, error: 'max 8 extensions (2h total) reached' };
  clearTimeout(s.killTimer);
  s.extendCount++;
  s.killTimer = setTimeout(s.killFn, CLAUDE_TIMEOUT_MS);
  console.log(`[${taskId}] timeout extended (${s.extendCount}/8)`);
  return { ok: true, extendCount: s.extendCount, extensionsLeft: 8 - s.extendCount, newDeadlineMins: 15 };
}

// audience omitted -> 'default' only, never "any audience" (#1302 §3.2/§2).
function isTaskRunning(username, audience = null) {
  const scopedAudience = audience || 'default';
  for (const s of activeTimers.values()) {
    if (s.username === username && (s.audience || 'default') === scopedAudience) return true;
  }
  return false;
}

// True while this exact session is either spawned-and-streaming OR still queued
// waiting for a turn — checks activeTimers (live process) AND queuedSessions
// (accepted, waiting behind this chat's current task / RAM / global slot). Used
// by gtd-controller's re-entrancy guard: the journal-based check it used before
// had a 30-min TTL heuristic while real runs can legitimately take up to
// CLAUDE_TIMEOUT_MS (40min) plus up to 8 extend-timeout calls (2h+), so a
// long-running GTD turn could age out of the guard and get double-fired by the
// next tick — fixed by switching to this live in-process check (#1062).
// activeTimers only gets an entry once the process actually spawns
// (claude-runner.js, after every admission wait), while the session is added to
// queuedSessions synchronously the instant runTask() is called and stays until
// the queued work finishes. Under load (global slot / RAM busy), a GTD turn can
// sit queued for minutes with activeTimers still empty — the next 5-min tick
// would see "not running" and fire a duplicate queued turn for the same
// session. Checking queuedSessions too closes that window. This is a read-only
// membership set, NOT a lock: it serializes nothing, so unlimited tasks per
// session/profile may still run concurrently.
const queuedSessions = new Set(); // Set<sessionId(string)>
// Stop before spawn (web e2e 2026-09-25): a Stop for a session whose task is
// accepted but has no process yet (admission wait, prompt build) used to 409
// "not running" and the task then ran anyway. Owner-scoped: queued runs are
// counted per `${username}\0${sessionId}`; a pending stop is honored at the
// admission gate and again the moment the engine process registers.
const queuedByOwner = new Map(); // key -> count of accepted-not-finished runs
const pendingSessionStops = new Set(); // keys with a Stop waiting for the process
const ownerKey = (username, sessionId) => `${username}\0${sessionId}`;
// Chat-scoped accepted-not-finished counter (epic #1527 PR1). Incremented
// SYNCHRONOUSLY at runTask entry — before any await — so it is already >0 when
// the gateway receives the 202 ack, and decremented in the same finally that
// emits run-finished. This is what GET /tasks/running?chatId= reads: it stays
// true through admission waits (before activeTimers has an entry) and drops to
// false exactly when the run settles or the process dies (in-memory reset).
const acceptedByChat = new Map(); // chatId(number|string) -> count
function _bumpAcceptedByChat(chatId) {
  if (chatId == null) return;
  acceptedByChat.set(chatId, (acceptedByChat.get(chatId) || 0) + 1);
}
function _releaseAcceptedByChat(chatId) {
  if (chatId == null) return;
  const n = (acceptedByChat.get(chatId) || 1) - 1;
  if (n > 0) acceptedByChat.set(chatId, n);
  else acceptedByChat.delete(chatId);
}
// True while any run accepted for this chat has not yet settled — regardless
// of phase (queued, admission wait, spawned).
function isChatTaskRunning(chatId) {
  if (chatId == null) return false;
  if ((acceptedByChat.get(chatId) || 0) > 0) return true;
  for (const s of activeTimers.values()) {
    if (String(s.user?.id ?? s.chatId ?? '') === String(chatId)) return true;
  }
  return false;
}

// ── Live-run registry — координаты всех принятых, ещё не завершённых ранов ──
// Нужен только для одного: кнопка Стоп приходит от шлюза как `{username}` без
// chatId/threadId (agent-client.js:316), а чтобы поставить trace-тумбстоун
// нужен адрес диалога. activeTimers видит только УЖЕ заспавненные процессы;
// ран в admission-очереди, в retry-backoff'е или в resume-бэкоффе процесса не
// имеет и для Стопа был бы невидим — ровно R1/R2 («перерождается»).
//
// Ключ — уникальный на каждый вызов runTask (не chainId: реестр отвечает только
// на вопрос «какие диалоги сейчас заняты», адрес диалога и так выводится из
// координат). Вставка синхронная, ДО первого await — иначе Стоп, пришедший
// сразу после 202, не нашёл бы ран. Снятие — на settle внешнего промиса
// runTask'а, который включает `queuedRetry`: реестр живёт через весь
// retry-backoff, пока таймер ещё не стрельнул.
const liveRuns = new Map(); // runKey -> { username, chatId, threadId, audience, sessionId, taskId }
let liveRunSeq = 0;

function registerLiveRun(opts) {
  const runKey = `${opts.taskId || 'run'}#${++liveRunSeq}`;
  liveRuns.set(runKey, {
    username: opts.user?.username ?? null,
    chatId: opts.user?.id ?? null,
    threadId: Number.isInteger(opts.threadId) && opts.threadId > 0 ? opts.threadId : null,
    audience: opts.user?.audience || 'default',
    sessionId: opts.sessionId || null,
    taskId: opts.taskId || null,
  });
  return runKey;
}

// Правило владельца — то же, что taskOwnedBy (#1303): точный username, audience,
// chatId только когда он есть у ОБЕИХ сторон, threadId — только когда есть у обеих.
function _liveRunMatches(m, owner) {
  if (!owner?.username || m.username !== owner.username) return false;
  if ((m.audience || 'default') !== (owner.audience || 'default')) return false;
  if (owner.chatId != null && m.chatId != null && String(m.chatId) !== String(owner.chatId)) return false;
  if (owner.threadId != null && m.threadId != null && Number(m.threadId) !== Number(owner.threadId)) return false;
  if (owner.sessionId != null && m.sessionId != null && m.sessionId !== owner.sessionId) return false;
  return true;
}

/**
 * Тумбстоун для Стопа: адреса диалогов, которые этот владелец сейчас занимает.
 *
 * Три источника, все дедуплицируются по trace:
 *   1. owner сам по себе — если у него есть chatId/sessionId (чат-скоуп Стопа
 *      даже когда сейчас ничего не бежит: tombstone защищает и GTD, и resume);
 *   2. liveRuns — принятные раны без процесса (очередь, backoff);
 *   3. pending-tasks — журнал, переживающий рестарт (K14: resume не поднимет
 *      цепочку, остановленную до рестарта).
 *
 * Fail-open внутри markTraceStopped: не записалось → просто не блокируем.
 */
function stopTracesFor(owner = {}) {
  const traces = new Set();
  const add = (coords) => {
    const t = traceIdFor(coords);
    if (t) traces.add(t);
  };
  if (owner.chatId != null || owner.sessionId != null) add(owner);
  for (const m of liveRuns.values()) if (_liveRunMatches(m, owner)) add(m);
  for (const p of getPendingTasks()) {
    const coords = {
      username: p.username, chatId: p.userId ?? null, threadId: p.threadId ?? null,
      audience: p.audience || 'default', sessionId: p.sessionId || null,
    };
    if (_liveRunMatches(coords, owner)) add(coords);
  }
  let n = 0;
  for (const t of traces) {
    if (markTraceStopped(t, { username: owner.username ?? null, chatId: owner.chatId ?? null, threadId: owner.threadId ?? null })) n++;
  }
  if (n) console.log(`[stop] tombstoned ${n} trace(s) for ${owner.username || '?'}${owner.chatId != null ? ` chat=${owner.chatId}` : ''}`);
  return n;
}

// Release the chat counter and push run-finished to the gateway. Called exactly
// once per runTask invocation from the runTask wrapper below — every code path
// (quick answer, stop, admission, error) funnels through there.
function _finishAcceptedChatRun(chatId, opts, outcome) {
  try { _releaseAcceptedByChat(chatId); } catch (e) { console.warn('[runner] release acceptedByChat:', e.message); }
  if (!opts) return;
  notifyRunFinished({
    chatId,
    threadId: Number.isInteger(opts.threadId) && opts.threadId > 0 ? opts.threadId : null,
    requestId: opts.requestId || null,
    taskId: opts.taskId || null,
    outcome,
    secret: opts.secrets?.AGENT_SECRET || process.env.AGENT_SECRET,
  }).catch(e => console.warn('[runner] notifyRunFinished:', e.message));
}
function consumePendingStop(username, sessionId) {
  return !!(username && sessionId) && pendingSessionStops.delete(ownerKey(username, sessionId));
}

function isSessionRunning(sessionId) {
  if (!sessionId) return false;
  for (const s of activeTimers.values()) {
    if (s.sessionId === sessionId) return true;
  }
  if (queuedSessions.has(sessionId)) return true;
  return false;
}

// Exact-session stop for web/API callers. Deliberately has NO profile-wide
// fallback: failure to find the requested session must never kill a sibling
// Telegram/web task that happens to share the same profile.
function stopSessionTask(username, sessionId) {
  if (!username || !sessionId) return false;
  let stopped = false;
  for (const [taskId, state] of activeTimers.entries()) {
    if (state.username !== username || !state?.proc) continue;
    if (state.sessionId !== sessionId) continue;
    stopEngineProcess(state);
    stopped = true;
    console.log(`[${taskId}] stopped by exact session ${sessionId}`);
  }
  if (!stopped && queuedByOwner.get(ownerKey(username, sessionId))) {
    pendingSessionStops.add(ownerKey(username, sessionId));
    console.log(`[runner] stop queued for ${username} session ${sessionId} (no process yet)`);
    stopped = true;
  }
  // Тумбстоун web-трейса: без него retry/продолжение этой сессии перезапустится
  // после «остановлено» — web-раны приходят не из POST /run, поэтому гейт по
  // fromUser их не пропускает, и защита должна идти от отметки.
  stopTracesFor({ username, sessionId });
  return stopped;
}

function isSessionQueuedFor(username, sessionId) {
  return !!queuedByOwner.get(ownerKey(username, sessionId));
}

/**
 * Kill any running Claude process for a given username, scoped to one audience.
 * audience omitted -> 'default' only, never "every audience" (#1302 §3.2/§2) —
 * killing every bot's task for a profile in one call is a deliberately separate,
 * explicit action this function does not perform.
 * Returns how many tasks were killed.
 */
function killTaskByUsername(username, audience = null) {
  const scopedAudience = audience || 'default';
  let killed = 0;
  for (const [taskId, state] of activeTimers.entries()) {
    // Same shared ownership rule (#1303); this caller is deliberately profile-wide
    // within one audience, so it passes no chatId.
    if (!taskOwnedBy(state, { username, audience: scopedAudience })) continue;
    try {
      if (state.proc) {
        stopEngineProcess(state);
        killed++;
        console.log(`[runner] killTaskByUsername: killed ${taskId}`);
      }
    } catch (e) {
      console.warn(`[runner] killTaskByUsername error on ${taskId}:`, e.message);
    }
  }
  // Профильный скоуп без chatId: трейсы берутся из реестра живых ранов и
  // журнала pending. Вызывается только из явных Stop-путей (/tasks/stop) —
  // killTaskByUsername как таковой не «Стоп», а его профильный фолбэк.
  return killed;
}

/**
 * Подтверждение остановки (spec SS-03): ждём, пока процессы, подходящие под
 * owner, действительно выйдут — до `waitMs`. Нужно, чтобы шлюз мог отличить
 * «⛔ Остановлено» от «⚠️ не подтвердилось» вместо слепого `killed > 0`.
 *
 * Под изоляцией прямой ребёнок — sudo-обёртка: она завершается вместе с
 * движком, так что исчезновение записи из activeTimers (либо ненулевой
 * exitCode/signalCode) честно означает «двигатель мёртв».
 * true = всё вышло (или нечему было выходить), false = ждали и не дождались —
 * эскалация SIGKILL уходит по таймеру из stopEngineProcess.
 */
async function confirmStopped(owner, waitMs = 2500) {
  const deadline = Date.now() + Math.max(0, waitMs);
  const aliveMatches = () => {
    for (const s of activeTimers.values()) {
      if (!s.proc || !taskOwnedBy(s, owner)) continue;
      if (s.proc.exitCode === null && s.proc.signalCode === null) return true;
    }
    return false;
  };
  while (aliveMatches()) {
    if (Date.now() >= deadline) {
      console.warn(`[stop] not confirmed within ${waitMs}ms for ${owner.username || '?'} — SIGKILL escalation is armed`);
      return false;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}

/**
 * Runs `claude --dangerously-skip-permissions` for a task,
 * streams output to Telegram by editing a "thinking" message.
 * Tasks for the same user are serialised — each waits for the previous to finish.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.user   - { id, name, username, workDir }
 * @param {string} opts.task
 * @param {string|null} opts.context
 * @param {string|null} opts.sessionId  - existing session to append to
 * @param {object} opts.secrets - { BOT_TOKEN, ANTHROPIC_API_KEY, ... }
 */
// Epic #1527 PR1: thin wrapper around the real runTask. Bumps the chat's
// accepted-not-finished counter SYNCHRONOUSLY (before any await — so it is
// already >0 when the caller receives its 202) and, when the returned promise
// settles on ANY path (success, error, stop, quick answer), releases the
// counter and pushes run-finished to the gateway. The gateway holds the chat's
// IntakeBuffer `busy` for exactly this window.
function runTask(opts) {
  const delivery = taskDelivery(opts);
  // Telegram group/supergroup ids are NEGATIVE — only 0 is the internal/web
  // sentinel (no real chat). Restricting this to >0 silently dropped every
  // group run from the counter and the run-finished push, so a group chat's
  // IntakeBuffer stayed `busy` for BUSY_MAX_MS (45 min) after each run
  // (#1534 regression: «▶️ Запустить» dead in every group).
  const rawChatId = Number(delivery.user?.id);
  const acceptedChatId = Number.isSafeInteger(rawChatId) && rawChatId !== 0 ? rawChatId : null;
  _bumpAcceptedByChat(acceptedChatId);
  // Реестр живых ранов — синхронно, до первого await: Стоп, пришедший сразу
  // после 202, обязан найти координаты рана. Ключ пробрасывается в _runTaskInner
  // через opts (taskDelivery копирует поля), там он добирается sessionId.
  delivery._liveRunKey = registerLiveRun(delivery);
  let ret;
  try {
    ret = _runTaskInner(delivery);
  } catch (e) {
    ret = Promise.reject(e);
  }
  // ret — это current.then(result => result?.queuedRetry || result): он
  // разрешается только после ВСЕЙ retry-цепочки, т.е. через бэкофф. Реестр
  // живёт ровно столько же — иначе Стоп во время 30с/3м/10м ожидания не найдёт
  // координат (R1).
  Promise.resolve(ret).then(
    () => { delivery._liveRunKey && liveRuns.delete(delivery._liveRunKey); _finishAcceptedChatRun(acceptedChatId, delivery, 'done'); },
    () => { delivery._liveRunKey && liveRuns.delete(delivery._liveRunKey); _finishAcceptedChatRun(acceptedChatId, delivery, 'error'); },
  ).catch(e => console.warn(`[${opts.taskId}] run-finished side chain: ${e.message}`));
  return ret;
}

function _runTaskInner(opts) {
  opts = taskDelivery(opts);
  // Forum topic identity for every outbound on this run (#255). Null for private
  // chats and non-forum groups — nothing thread-related is then emitted.
  const runThreadId = Number.isInteger(opts.threadId) && opts.threadId > 0 ? opts.threadId : null;
  // Topic-aware new-message send: edit targets an existing message (already in the
  // right topic) so it stays thread-less; only a fresh send carries the thread.
  const sendTo = (token, chatId, text, extra = {}) => tgSend(token, chatId, text, extra, runThreadId);
  // A durable plan step / GTD re-open is a MACHINE prompt (internalGtd): the chat
  // intents below are for what a human typed. Matching them against a long step
  // prompt hijacked the run — e.g. "…поправь… чек-лист…" in a playbook step got the
  // checklist-autologin link back instead of an engine run (3 attempts in 2 s, and the
  // autologin token leaked into the step evidence). Found by the playbooks e2e.
  const humanInput = !opts.internalGtd;
  // Stop commands bypass the queue — kill the running task immediately.
  if (humanInput && STOP_TASK_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const workDir = opts.user.workDir;
    const chatId = opts.user.id;
    // Chat- and audience-scoped: a plain "стоп" typed in one chat must only touch
    // this chat's task/GTD tracking, not a profile-mate's or another bot's —
    // workDir is shared across chats AND audiences (#1302 §3.2).
    const stopped = stopUserTask(username, chatId, opts.user.audience, runThreadId);
    // Явный «Стоп» → тумбстоун: retry/продолжение этого диалога не переродятся.
    // (wakeup/skip зовут stopUserTask, но НЕ ставят отметку — их контракт
    // «убить и дать очереди поех дальше», а не «закрыть цепочку».)
    stopTracesFor({ username, chatId, audience: opts.user.audience, threadId: runThreadId });
    let gtdCancelled = 0;
    if (workDir) {
      try { gtdCancelled = require('../gtd-controller').clearGtdForChat(workDir, chatId, runThreadId); }
      catch (e) { console.warn('[runner] stop gtd clear:', e.message); }
    }
    const parts = [];
    if (stopped) parts.push('⛔ Задача остановлена.');
    if (gtdCancelled > 0) parts.push(`GTD-трекинг отменён (${gtdCancelled} проверок).`);
    if (!parts.length) parts.push('Нет активной задачи для остановки.');
    const msg = parts.join(' ');
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const markup = { reply_markup: { inline_keyboard: [] } };
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, markup).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
      else     sendTo(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // GTD hard-stop: cancel this chat's open GTD tracking + kill its running task.
  // Chat-scoped for the same reason as STOP_TASK_INTENT above (#leak-between-chats).
  if (humanInput && GTD_STOP_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const workDir = opts.user.workDir;
    const chatId = opts.user.id;
    stopUserTask(username, chatId, opts.user.audience, runThreadId);
    stopTracesFor({ username, chatId, audience: opts.user.audience, threadId: runThreadId });
    let gtdCancelled = 0;
    if (workDir) {
      try { gtdCancelled = require('../gtd-controller').clearGtdForChat(workDir, chatId, runThreadId); }
      catch (e) { console.warn('[runner] gtd_stop clear:', e.message); }
    }
    const msg = gtdCancelled > 0
      ? `🛑 GTD остановлен — ${gtdCancelled} запланированных проверок отменено.`
      : '🛑 Нет активных GTD-проверок для отмены.';
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, {}).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
      else     sendTo(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // /show_active_cheklist — list all open GTD records for this user, plus a one-click
  // link into checklist.trainedassist.store (no password needed, see checklistAutologinUrl).
  if (humanInput && ACTIVE_CHECKLIST_INTENT.test((opts.task || '').trim())) {
    return (async () => {
      const workDir = opts.user.workDir;
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
      const chatId = opts.user.id;
      let msg;
      if (!workDir) {
        msg = '📋 Нет активных чек-листов.';
      } else {
        const openRecs = (() => { try { return require('../gtd-controller').listGtd(workDir).filter(r => r.status === 'open'); } catch { return []; } })();
        if (!openRecs.length) {
          msg = '📋 Нет активных чек-листов.';
        } else {
          const lines = [`📋 Активных чек-листов: ${openRecs.length}`];
          for (const r of openRecs) {
            const task = (r.originalTask || '').slice(0, 80);
            lines.push(`• «${task}» · ${_relativeTime(r.dueAt)} · итерация ${r.iterations}/${r.maxIterations}`);
          }
          msg = lines.join('\n');
        }
      }
      const link = await require('../gtd-controller').checklistAutologinUrl().catch(() => null);
      if (link) msg += `\n\n✏️ Править: ${link}`;
      if (botToken) {
        const im = opts.initialMsgId;
        if (im) await tgEdit(botToken, chatId, im, msg, {}).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
        else     await sendTo(botToken, chatId, msg).catch(() => {});
      }
      return msg;
    })();
  }

  // /all_forgotten_checklists (BV-08a, #1729) — осиротевшие чек-листы профиля, у каждого
  // «▶️ Делать» / «✖️ Отменить» (callback ocl|…). Детерминированно, без LLM. Заголовок —
  // правкой placeholder-сообщения, каждая запись — отдельным сообщением с кнопками, чтобы
  // тап правил только свою запись.
  if (humanInput && FORGOTTEN_CHECKLISTS_INTENT.test((opts.task || '').trim())) {
    return (async () => {
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
      const chatId = opts.user.id;
      let entries = [];
      try {
        entries = require('../orphan-checklists').listForgotten({
          workDir: opts.user.workDir, username: opts.user.username, audience: opts.user.audience || 'default',
          chatId, threadId: runThreadId, isSessionRunning: (_u, sid) => isSessionRunning(sid),
        });
      } catch (e) { console.warn('[runner] forgotten checklists:', e.message); }
      const MAX_SHOWN = 10;
      const header = entries.length
        ? `🗂 Забытых чек-листов: ${entries.length}${entries.length > MAX_SHOWN ? ` (показываю ${MAX_SHOWN})` : ''}`
        : 'Забытых чек-листов нет';
      if (botToken) {
        const im = opts.initialMsgId;
        if (im) await tgEdit(botToken, chatId, im, header, {}).catch(() => sendTo(botToken, chatId, header).catch(() => {}));
        else     await sendTo(botToken, chatId, header).catch(() => {});
        const oc = require('../orphan-checklists');
        for (const e of entries.slice(0, MAX_SHOWN)) {
          await sendTo(botToken, chatId, oc.listEntryText(e), { reply_markup: oc.keyboard(e.id) }).catch(() => {});
        }
      }
      const oc = require('../orphan-checklists');
      return [header, ...entries.slice(0, MAX_SHOWN).map(e => oc.listEntryText(e))].join('\n\n');
    })();
  }

  // Natural-language "хочу поправить чек-лист" — hand back a one-click autologin link
  // instead of asking the user to type a password (checklist.trainedassist.store).
  if (humanInput && CHECKLIST_EDIT_INTENT.test((opts.task || '').trim())) {
    return (async () => {
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
      const chatId = opts.user.id;
      const link = await require('../gtd-controller').checklistAutologinUrl().catch(() => null);
      const msg = link
        ? `✏️ Правь чек-лист здесь — вход автоматический: ${link}`
        : '⚠️ Не смог получить ссылку на чек-лист (сервис недоступен или не настроен пароль). Попробуй чуть позже.';
      if (botToken) {
        const im = opts.initialMsgId;
        if (im) await tgEdit(botToken, chatId, im, msg, {}).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
        else     await sendTo(botToken, chatId, msg).catch(() => {});
      }
      return msg;
    })();
  }

  // Control commands bypass lanes and admission. Available to every authenticated profile.
  // /restart is immediate: interrupted tasks are journaled and resumed silently by the
  // new process (see server.js resumePendingTasks) — no drain, no pause, no status chatter.
  if (/^\/restart(?:@\w+)?$/i.test((opts.task || '').trim())) {
    const msg = '🔄 Перезапускаюсь.';
    opts.outputCallback?.(msg);
    const token = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
    const ack = token && opts.user.id !== 0 ? sendTo(token, opts.user.id, msg).catch(() => {}) : Promise.resolve();
    return ack.then(() => {
      interruptForRestart();
      setTimeout(() => process.exit(0), 100).unref?.();
      return msg;
    });
  }

  // Wakeup command — kill stuck task + clear the queue so new messages can flow through.
  if (humanInput && WAKEUP_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const chatId = opts.user.id;
    const hadActive = activeTimers.size > 0;
    const stopped = stopUserTask(username, chatId, opts.user.audience, runThreadId);
    // A killed owner releases its lane itself once the process exits. Only a
    // lane with NO live process (stale holder) is force-released here —
    // otherwise the next task would become a second writer next to it.
    if (!stopped) {
      for (const scope of legacyAdmissionScopes({ chatId, audience: opts.user.audience, threadId: runThreadId })) {
        admission.forceRelease(scope);
      }
    }
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    const msg = stopped
      ? '🔄 Зависший процесс убит, очередь очищена. Можешь писать снова.'
      : hadActive
        ? '🔄 Очередь очищена. Активных задач не было.'
        : '✅ Всё чисто, активных задач нет.';
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
      else     sendTo(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // Skip command — kill current task, let next queued task run automatically.
  // Unlike /stop (which is a dead-end), /skip advances the chat queue.
  if (humanInput && SKIP_TASK_INTENT.test((opts.task || '').trim())) {
    const username = opts.user.username;
    const chatId = opts.user.id;
    const stopped = stopUserTask(username, chatId, opts.user.audience, runThreadId);
    const msg = stopped
      ? '⏭ Текущая задача пропущена. Следующая начнётся автоматически.'
      : '✅ Нет активной задачи для пропуска.';
    const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      const im = opts.initialMsgId;
      if (im) tgEdit(botToken, chatId, im, msg, {}).catch(() => sendTo(botToken, chatId, msg).catch(() => {}));
      else     sendTo(botToken, chatId, msg).catch(() => {});
    }
    return Promise.resolve(msg);
  }

  // Pure-info quick answers (/agent_info, /secrets_list, /usage, ...) bypass the queue
  // entirely, same as /stop above — they read local state synchronously and don't touch
  // Claude or the session transcript, so there's no reason to make them wait behind
  // whatever this chat's admission queue is currently running (issue: "/agent_info waits
  // for the previous task to finish, but it doesn't need to call the agent at all").
  // forceClaude means the user explicitly wants Claude (e.g. a "proработка" button tap on
  // one of these commands' replies) — respect that and fall through to the normal path.
  if (humanInput && !opts.forceClaude && isPreQueueQuickIntent((opts.task || '').trim())) {
    const quick = getQuickAnswer(opts.task, opts.user.username, opts.user.workDir, false, opts.user.id, opts.user.telegramUserId, opts.user.audience || 'default', runThreadId);
    if (quick) {
      // Never invisible: an accepted task answered here leaves no other trace (#1479).
      console.log('[%s] pre-queue quick-answer len=%d', opts.taskId, quick.length);
      const msg = `⚡ ${quick}`;
      const botToken = opts.secrets?.TELEGRAM_BOT_TOKEN || opts.secrets?.BOT_TOKEN;
      const chatId = opts.user.id;
      // Every ⚡ reply is one tap from the agent (src/quick-reply.js).
      const qaSessionId = recordQuickExchange(opts.user.workDir, {
        username: opts.user.username, chatId, threadId: runThreadId, audience: opts.user.audience,
        projectId: opts.projectId || null, task: opts.task, reply: quick,
      });
      const extra = { reply_markup: { inline_keyboard: escalateRows(qaSessionId) } };
      return (async () => {
        if (botToken) {
          const im = opts.initialMsgId;
          try {
            if (im) await tgEdit(botToken, chatId, im, msg, extra).catch(() => sendTo(botToken, chatId, msg, extra));
            else     await sendTo(botToken, chatId, msg, extra);
          } catch (e) { console.warn('[runner] pre-queue quick-answer send:', e.message); }
        }
        return quick;
      })();
    }
    // Matched the whitelist regex but getQuickAnswer returned nothing (shouldn't happen for
    // this fixed set of intents) — fall through to the normal queued path as a safety net.
  }

  // A session of ANOTHER chat/topic of this profile is never ours (the gateway's remembered
  // id can leak across chats, e.g. its session classifier picks a sibling chat's dialog).
  // resolveRunSession already drops it for the run itself — drop it HERE too, before the
  // admission scopes and activity are derived from it, or this chat queues behind the
  // other chat's live run ("Ожидаю завершения предыдущей работы" with nothing running).
  if (opts.sessionId && !opts.webExactSession && !opts.forceNew && opts.user.id) {
    const claimed = sessions.getSession(opts.user.workDir, opts.sessionId);
    if (claimed && !sessions.belongsToConversation(claimed, opts.user.id, runThreadId)) {
      console.warn('[%s] foreign session %s dropped for chat=%s thread=%s', opts.taskId, opts.sessionId, opts.user.id, runThreadId);
      opts.sessionId = null;
      if (opts.activitySessionId === claimed.id) delete opts.activitySessionId;
    }
  }
  if (!Object.hasOwn(opts, 'activitySessionId')) opts.activitySessionId = opts.sessionId || getCurrentSessionId(opts.user.workDir, opts.user.id, opts.user.audience, runThreadId) || null;
  // sessionId резолвится уже внутри _runTaskInner — добиваем им запись реестра,
  // чтобы Stop по sessionId (web) нашёл координаты. Для TG sessionId в trace не
  // входит, так что здесь просто добивается полнота меты.
  if (opts._liveRunKey && liveRuns.has(opts._liveRunKey) && (opts.sessionId || opts.activitySessionId)) {
    const rec = liveRuns.get(opts._liveRunKey);
    if (!rec.sessionId) rec.sessionId = opts.sessionId || opts.activitySessionId;
  }
  if (opts.sessionId && !opts.forceNew && opts.user.id) {
    try {
      const ref = fromLegacyTelegram({ chatId: opts.user.id, audience: opts.user.audience, threadId: runThreadId });
      if (ref) sessionShadow.shadowCompare({ workDir: opts.user.workDir, ref, authoritySessionId: opts.sessionId, taskId: opts.taskId });
    } catch (e) { console.warn(`[${opts.taskId}] session-shadow:`, e.message); }
  }
  if (!Object.hasOwn(opts, 'initiatedAt')) opts.initiatedAt = opts.acceptedAt || Date.now();
  if (Number.isFinite(opts.initiatedAt)) recordTaskActivity(opts, opts.initiatedAt);
  // Гейт «Стопа», первая из двух проверок (spec §2/§2а). Ловит хоп ДО того, как
  // он попадёт в журнал и в очередь: retry после backoff'а, продолжение после
  // таймаута, resume после рестарта (K14). Хоп считается «цепочкой остановленной»,
  // если его initiatedAt (момент исходного запроса юзера) не позже отметки Стопа
  // в trace-тумбстоуне. fromUser-раны (POST /run, web) проходят всегда — K1 и
  // удержанные сообщения шлюза (SS-05) не должны блокироваться. Вторая проверка —
  // в admission.run: хоп мог стоять в очереди, когда Стоп пришёл.
  const runTrace = traceIdFor({
    chatId: opts.user.id, audience: opts.user.audience, threadId: runThreadId,
    username: opts.user.username, sessionId: opts.sessionId || opts.activitySessionId,
  });
  if (isRunStopped({ traceId: runTrace, initiatedAt: opts.initiatedAt, fromUser: opts.fromUser })) {
    // Без правки сообщения: до этого Стоп уже ответил в чат, а убитое
    // продолжение не имеет права стирать сохранённый частичный результат (SS-02).
    console.log(`[${opts.taskId}] stop-gate: blocked before queue (trace=${runTrace || 'none'})`);
    return Promise.resolve(STOP_NOT_STARTED_MSG);
  }
  // Journal BEFORE waiting: a restart must not silently lose accepted work.
  savePendingTask(opts.taskId, {
    phase: 'queued', activitySessionId: opts.activitySessionId, taskId: opts.taskId, rootTaskId: opts.rootTaskId, requestId: opts.requestId, userId: opts.user.id, username: opts.user.username, threadId: opts.threadId,
    workDir: opts.user.workDir, task: opts.task, context: opts.context,
    sessionId: opts.sessionId, contextFromSession: opts.contextFromSession,
    forceClaude: opts.forceClaude, forceNew: opts.forceNew, webExactSession: opts.webExactSession, mode: opts.mode, userMessageRecorded: opts.userMessageRecorded,
    projectId: opts.projectId, projectPicked: opts.projectPicked, newProjectName: opts.newProjectName, engine: opts.engine,
    initialMsgId: opts.initialMsgId, pinnedMsgId: opts.pinnedMsgId, fileRefs: opts.fileRefs,
    profileId: opts.user.profileId, telegramUserId: opts.user.telegramUserId, audience: opts.user.audience,
    continuationCount: opts.continuationCount, retryCount: opts.retryCount, internalGtd: opts.internalGtd,
    resumedAfterRestart: opts.resumedAfterRestart, resumeAttempts: opts.resumeAttempts,
    startedAt: opts.acceptedAt || Date.now(), initiatedAt: opts.initiatedAt,
    // Where the result goes (#1671): telegram (userId) | web | durable. Lets a restart
    // resume the run whatever its surface, not only a Telegram chat.
    resumeSink: opts.resumeSink || null,
    ocProfile: opts.ocProfile || null, ocRole: opts.ocRole || null, stepTimeoutMs: opts.stepTimeoutMs || null,
  });
  const status = require('../admission-status').createAdmissionStatus(opts, { edit: tgEdit, send: tgSend });
  // No per-profile / per-project / per-workDir locks: a stale promise in those
  // left chats saying "waiting for previous work" with nothing running. Tasks of
  // one profile run concurrently across dialogs and sessions — context is rebuilt
  // from the session store (no `claude --resume`), so parallel claudes never
  // share a transcript file.
  // Scopes held for the whole run (epic #1365 §2.3): the Telegram dialog lane
  // (endpoint+chat+topic — different sessions in one dialog wait for each other)
  // and the session writer guard (every channel, incl. Web: one writer per
  // history). Never profile/project/workDir.
  const admissionScopes = legacyAdmissionScopes({
    chatId: opts.user.id, audience: opts.user.audience, threadId: runThreadId,
    profileId: opts.user.username, sessionId: opts.webExactSession ? opts.sessionId : opts.forceNew ? null : (opts.sessionId || opts.activitySessionId),
  });
  if (admission.isBusy(admissionScopes)) status.waiting(
    '↪️ Ожидаю завершения предыдущей работы. В этом диалоге выполняю задачи по очереди. Начну автоматически; повторно отправлять не нужно.'
  );

  // Postmortem diagnostics for issue #1015 ("session hung, no evidence of where
  // the time went"): stamp how long each admission stage actually took. Cheap
  // (a handful of Date.now() calls + one console.log per stage) but turns a
  // future "it was stuck" report into a log grep instead of guesswork.
  const stageT0 = Date.now();
  const logStage = (stage, since) => console.log(`[${opts.taskId}] stage=${stage} tookMs=${Date.now() - since}`);
  // Track the session as "queued" the instant we accept the task — the GTD
  // re-entrancy guard (isSessionRunning) relies on this window before the
  // process spawns. Read-only membership, not a lock.
  if (opts.sessionId) queuedSessions.add(opts.sessionId);
  const qKey = opts.sessionId ? ownerKey(opts.user.username, opts.sessionId) : null;
  if (qKey) queuedByOwner.set(qKey, (queuedByOwner.get(qKey) || 0) + 1);
  const current = admission.run(admissionScopes, async () => {
    try {
      // Гейт «Стопа», вторая точка (R2): хоп уже прошёл верхний гейт и стоял в
      // очереди/на RAM- или slot-ожидании, когда пришёл Стоп. Проверяем прямо
      // перед расходом слота — иначе остановленная цепочка заберёт ресурс и
      // проспавнится. Второй вызов дешёвый: читает файл только если trace
      // действительно останавливался (ENOENT — быстрый промах).
      if (isRunStopped({ traceId: runTrace, initiatedAt: opts.initiatedAt, fromUser: opts.fromUser })) {
        console.log(`[${opts.taskId}] stop-gate: blocked in admission queue (trace=${runTrace || 'none'})`);
        await status.finish(STOP_NOT_STARTED_MSG);
        return STOP_NOT_STARTED_MSG;
      }
      // Global admission control: wait for a free slot + enough RAM before we
      // actually spawn `claude`. This is the OOM guard — the only remaining gate.
      const ramT0 = Date.now();
      await _waitForRam();
      logStage('ram_wait', ramT0);
      const slotT0 = Date.now();
      await _acquireSlot();
      logStage('global_slot_wait', slotT0);
      try {
        if (consumePendingStop(opts.user.username, opts.sessionId)) {
          console.log(`[${opts.taskId}] stopped before start`);
          await status.finish(STOP_NOT_STARTED_MSG);
          return STOP_NOT_STARTED_MSG;
        }
        await status.finish('🧠 Начинаю работу…');
        const runT0 = Date.now();
        try {
          return await _runTask(opts);
        } finally {
          logStage('run_task', runT0);
        }
      } finally {
        _releaseSlot();
      }
    } finally {
      logStage('total', stageT0);
    }
  }).catch(async err => {
    const msg = '❌ Не удалось запустить или завершить работу. Попробуй запустить задачу ещё раз.';
    await status.finish(msg);
    console.error(`[${opts.taskId}] unhandled queue error:`, err.message);
  });
  current.finally(() => {
    // A task cut off by a restart keeps its journal entry: the next process resumes it.
    if (!restartShutdown) clearPendingTask(opts.taskId);
    if (opts.sessionId) queuedSessions.delete(opts.sessionId);
    if (qKey) {
      const n = (queuedByOwner.get(qKey) || 1) - 1;
      if (n > 0) queuedByOwner.set(qKey, n);
      else { queuedByOwner.delete(qKey); pendingSessionStops.delete(qKey); }
    }
  });
  // Await retries for callers, but never hold their predecessor lane/lease.
  return current.then(result => result?.queuedRetry || result);
}

function _relativeTime(ts) {
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return 'сейчас';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `через ${mins} мин`;
  return `через ${Math.round(mins / 60)} ч`;
}

// Time-of-day context, injected into every run's prompt. All user-facing times are
// Moscow (МСК, UTC+3) — the pinned context card and session-store.buildContext both
// format in Europe/Moscow — but the engine shell inherited the VM's clock (UTC on GCP)
// with no explicit "now" anywhere in the prompt. The agent then glued a МСК target to a
// UTC `date` and scheduled a wall-clock wait ~3h late (incident 2026-09-27: «задание
// ждёт 21:53» ran `date -u` and waited until 00:55 МСК). One authoritative line, in the
// same zone the UI uses, plus the TZ=Europe/Moscow engine env (claude-runner.js), removes
// the guesswork. `now` is injectable for tests.
function currentTimeSection(now = new Date()) {
  const msk = now.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const utc = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `[Сейчас: ${msk} МСК (UTC+3) | ${utc}. Все времена в интерфейсе и дедлайны — московские; шелл работает в TZ=Europe/Moscow, поэтому обычный \`date\` уже даёт МСК. Не ставь московскую цель под \`date -u\` (UTC) — это разница +3ч. Если ждать дольше ~2 минут (CI, деплой): короткие проверки до ~2 мин каждая ИЛИ сохрани состояние на диск и заверши ход — продолжение придёт само (deep: автопродолжение; GTD: следующая итерация). cron_create сейчас недоступен (#1489) — на него не рассчитывай.]`;
}

// Search-results files are named by date (search-results-2026-09-22.json), not by
// vacancy_id — each file's own content carries the vacancy_id it was searched for
// (see hh-proactive-search.js runProactiveSearch). With one tracked vacancy that
// distinction doesn't matter (vacancyId=null → any file counts, matching the old
// singleton behavior); with several, showing the "Поиск" link for a vacancy that's
// never been searched would send the recruiter to an empty page.
function _hasProactiveResults(dataDir, username, vacancyId) {
  const dir = path.join(dataDir, 'hh', String(username), 'proactive');
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('search-results-') && f.endsWith('.json'));
  if (!vacancyId) return files.length > 0;
  return files.some(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.vacancy_id === vacancyId; }
    catch { return false; }
  });
}

// Returns context card string, or null if no skills configured (no pin needed). Quick-answer
// commands (/ping etc.) are contractually one-message-only (see runner-e2e.test.js) — this must
// stay opt-in via connected services, never fire unconditionally on every task completion.
// actualModel: the model the just-finished run really used (claudeModel from the engine
// stream). Optional — callers that don't have it (tests, older paths) fall back to env.
function buildContextCard(username, workDir, chatId, actualModel = null, threadId = null) {
  // Built even with nothing connected: the card always carries the chat's current project.
  const services = (username && listConnectedServices(username)) || [];

  // Build service labels, merging inline details where available
  const gcConfig = path.join(TOKENS_ROOT, String(username), 'getcourse', 'config.json');
  let gcDomain = null;
  if (fs.existsSync(gcConfig)) {
    try { gcDomain = JSON.parse(fs.readFileSync(gcConfig, 'utf8')).accountDomain || null; } catch (e) { console.warn('[runner] gcConfig parse:', e.message); }
  }

  const serviceLabels = services.map(s => {
    if (s.file === 'getcourse' && gcDomain) return `getcourse: ${gcDomain}`;
    return s.name;
  });

  // Illustrate is stored as a flag in workDir, not in agent-tokens — check separately
  const illustrateFlagPath = path.join(workDir, 'contexts', 'illustrate', '.enabled');
  if (fs.existsSync(illustrateFlagPath)) serviceLabels.push('🎨 иллюстрации');

  const lines = ['📌 Контекст', ''];

  // Chat's CURRENT project — first line of the card. The bot never asks which project
  // (owner decision 2026-09-26): silence keeps it, /project changes it.
  try {
    const d = chatId ? projects.decideNewSessionProject(workDir, chatId, undefined, undefined, threadId) : null;
    const pmeta = d && d.action === 'auto' ? d.project : null;
    const name = pmeta ? `${pmeta.name}${pmeta.type && pmeta.type !== 'generic' ? ` · ${pmeta.label}` : ''}` : (d ? projects.DEFAULT_PROJECT_NAME : null);
    // Brand-new profile (no project yet, nothing connected): no card — a /ping must not
    // spawn a pinned message. The first real run creates «Все подряд», then the card shows.
    if (!pmeta && !serviceLabels.length) return null;
    if (name) {
      lines.push(`📁 Проект: ${name}`);
      lines.push('/project — список, перейти на другой, добавить новый');
    }
  } catch (e) { console.warn('[runner] project pin line:', e.message); }
  if (serviceLabels.length) lines.push(`🔗 Подключено: ${serviceLabels.join(' · ')}`);

  // HH: active vacancy(ies) + ATS config / scoring status.
  // A profile can track several vacancies at once (active_vacancies[], see 90-hh.js);
  // the legacy singleton active_vacancy.json is the fallback for profiles that never
  // adopted the array. With >1 vacancy each gets its own block + vacancy_id-scoped
  // links, so the recruiter switches vacancies via tabs on the web page, not Telegram.
  try {
    const hhVacsFile = path.join(workDir, 'contexts', 'hh', 'active_vacancies.json');
    let vacancies = fs.existsSync(hhVacsFile)
      ? (JSON.parse(fs.readFileSync(hhVacsFile, 'utf8'))?.value || [])
      : [];
    if (!vacancies.length) {
      const hhVacFile = path.join(workDir, 'contexts', 'hh', 'active_vacancy.json');
      if (fs.existsSync(hhVacFile)) {
        const vac = JSON.parse(fs.readFileSync(hhVacFile, 'utf8'))?.value;
        if (vac?.title) vacancies = [vac];
      }
    }
    if (vacancies.length) {
      const multi = vacancies.length > 1;
      const agentSecret = process.env.AGENT_SECRET || '';
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const base = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
      let tok = null;
      if (agentSecret) {
        const { createHmac } = require('crypto');
        tok = createHmac('sha256', agentSecret).update(String(username)).digest('hex').slice(0, 16);
      }
      if (multi) lines.push(`💼 Активные вакансии (${vacancies.length}):`);
      vacancies.forEach((vac, i) => {
        if (!vac?.title) return;
        const perVacancyAts = vac.id ? path.join(workDir, 'contexts', 'hh', `ats_config:${vac.id}.json`) : null;
        const legacyAts = path.join(workDir, 'contexts', 'hh', 'ats_config.json');
        const hasAts = (perVacancyAts && fs.existsSync(perVacancyAts)) || (!multi && fs.existsSync(legacyAts));
        lines.push(multi ? `${i + 1}. ${vac.title}` : `💼 ${vac.title}`);
        lines.push(hasAts ? '⚡ Скоринг активен' : '⏸ Скоринг выключен — нет ATS конфига');
        if (tok && vac.id) {
          const vacQs = multi ? `&vacancy_id=${encodeURIComponent(vac.id)}` : '';
          const hasProactive = _hasProactiveResults(dataDir, username, multi ? vac.id : null);
          const proactiveLink = hasProactive ? ` · [Поиск →](${require('../review-links').proactiveUrl(username, multi ? vac.id : null)})` : '';
          lines.push(`🔗 [Кандидаты →](${require('../review-links').reviewUrl(username, vac.id)}) · [История →](${base}/hh/sync-log?username=${encodeURIComponent(username)}&token=${tok}${vacQs}) · [ATS →](${base}/hh/ats-editor?username=${encodeURIComponent(username)}&token=${tok}${vacQs})${proactiveLink}`);
        }
      });
    }
  } catch (e) { console.warn('[runner] hh pin parse:', e.message); }

  const PINNED_CONTEXTS = [
    { skill: 'gdrive', key: 'pinned_folder', label: '📁' },
  ];
  for (const { skill, key, label } of PINNED_CONTEXTS) {
    const file = path.join(workDir, 'contexts', skill, `${key}.json`);
    if (fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (d.value) {
          const v = typeof d.value === 'string' ? d.value : JSON.stringify(d.value);
          lines.push(`${label} ${v.slice(0, 80)}`);
        }
      } catch (e) { console.warn('[runner] pinned context parse:', e.message); }
    }
  }

  // Engine / model line
  const eng = chatId ? profiles.getEngine(workDir, chatId) : 'claude';
  if (eng === 'opencode') {
    // Per-workDir profile (profiles.getOcProfile), NOT the old shared
    // ~/.config/opencode/.current-profile file — that file is machine-wide and went stale
    // once #1045 scoped /oc_* switching to each profile individually.
    const ocProfile = profiles.getOcProfile(workDir);
    // The llm-ladder worker model id this profile runs on (issue #1687), e.g. ladder/deepseek:build.
    const ocModel = process.env.OPENCODE_MODEL || ocLadder.modelFor(ocProfile);
    lines.push(`⚙️ OpenCode · ${ocProfile}${ocModel ? ` (${ocModel})` : ''}`);
  } else if (eng === 'codex') {
    lines.push('⚙️ Codex CLI');
  } else {
    // Prefer the model this run actually used (claudeModel from the engine stream,
    // claude-runner.js) over the static ANTHROPIC_MODEL env. The env can name a model
    // Claude Code doesn't end up running (e.g. a retired/unauthorised id falls back to the
    // CLI default), so the card used to advertise a model that never ran.
    const rawModel = actualModel || process.env.ANTHROPIC_MODEL || 'claude-sonnet';
    const m = rawModel.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    lines.push(`⚙️ Claude · ${m}`);
  }

  // GTD section: show when ≥1 open record exists
  if (workDir) {
    try {
      const openRecs = require('../gtd-controller').listGtd(workDir).filter(r => r.status === 'open');
      if (openRecs.length === 1) {
        const r = openRecs[0];
        const preview = (r.originalTask || '').slice(0, 40);
        lines.push(`📋 Чеклист: «${preview}» · ${_relativeTime(r.dueAt)} · /show_active_cheklist · /checklist_turn_off`);
      } else if (openRecs.length > 1) {
        const next = openRecs.reduce((a, b) => a.dueAt < b.dueAt ? a : b);
        lines.push(`📋 ${openRecs.length} чек-листа · след. ${_relativeTime(next.dueAt)} · /show_active_cheklist · /checklist_turn_off`);
      }
    } catch (e) { console.warn('[runner] gtd pin:', e.message); }
  }
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  lines.push('');
  lines.push(`⏱ ${time} МСК`);

  return lines.join('\n');
}

const NO_PIN_HINT = '\n\n💡 Дай мне права Admin в группе — буду обновлять без спама. Или /context_off чтобы скрыть.';

// Reads the pin store, keyed per conversation: { chats: { "<chatId>": {...} } }.
// One profile can serve many Telegram chats, so each chat keeps its own pinned card.
// Forum topics (#255): a topic keys as "<chatId>:<threadId>" so card A never edits
// card B's message id; no valid threadId keeps the bare "<chatId>" key exactly.
// Migrates the legacy flat format ({ msgId, chatId, lastCard, noPin }) transparently.
function pinStoreKey(chatId, threadId = null) {
  return Number.isInteger(threadId) && threadId > 0 ? `${chatId}:${threadId}` : String(chatId);
}
function readPinStore(pinFile) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[runner] pin state parse:', e.message);
  }
  if (!raw || typeof raw !== 'object') return { chats: {} };
  if (raw.chats && typeof raw.chats === 'object') return raw;
  // Legacy flat format → migrate under its chatId (drop it if the chat is unknown).
  const store = { chats: {} };
  if (raw.msgId && raw.chatId != null) {
    store.chats[String(raw.chatId)] = { msgId: raw.msgId, lastCard: raw.lastCard || null, noPin: !!raw.noPin };
  }
  return store;
}

// Creates or silently updates the context pin after task completion.
// State is stored per-chat in workDir/.pin_state.json (see readPinStore).
// botPinnedMsgId: the pinned message ID known to the bot — used to seed state when we have none.
async function updateContextPin(token, chatId, workDir, card, botPinnedMsgId = null, threadId = null) {
  const pinFile = path.join(workDir, '.pin_state.json');
  const store = readPinStore(pinFile);
  const key = pinStoreKey(chatId, threadId);
  let entry = store.chats[key] || null;
  const save = (next) => {
    store.chats[key] = next;
    fs.writeFileSync(pinFile, JSON.stringify(store));
  };

  // Seed from bot's authoritative pinned message when this chat has no local state.
  if (!entry?.msgId && botPinnedMsgId) {
    entry = { msgId: botPinnedMsgId, lastCard: null };
  }

  // In no-pin mode (bot lacks admin rights): just edit the message in-place with a hint.
  // Never attempt pinChatMessage again — it would fail and spam the chat.
  if (entry?.noPin) {
    const cardWithHint = card + NO_PIN_HINT;
    if (entry?.msgId) {
      const edited = await tgEdit(token, chatId, entry.msgId, cardWithHint).catch(() => null);
      if (edited?.ok || edited?.description?.includes('message is not modified')) {
        save({ ...entry, lastCard: cardWithHint });
        return;
      }
    }
    // Previous message was deleted — send a new one (still no pin attempt).
    const msg = await tgSend(token, chatId, cardWithHint, {}, threadId);
    const newId = msg?.result?.message_id;
    if (newId) save({ msgId: newId, lastCard: cardWithHint, noPin: true });
    return;
  }

  if (entry?.msgId) {
    const edited = await tgEdit(token, chatId, entry.msgId, card).catch(() => null);
    if (edited?.ok || edited?.description?.includes('message is not modified')) {
      save({ msgId: entry.msgId, lastCard: card });
      return;
    }
    // Edit failed (message deleted) — fall through to create new.
  }

  // No existing pin (or edit failed) — send new card message and try to pin it.
  const msg = await tgSend(token, chatId, card, {}, threadId);
  const newId = msg?.result?.message_id;
  if (!newId) return;

  // Always save msgId so next run edits in-place instead of sending another new message.
  save({ msgId: newId, lastCard: card });

  const res = await fetch(`${TG_API}/bot${token}/pinChatMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: newId, disable_notification: false }),
  });
  const pinData = await res.json();
  if (!pinData.ok) {
    console.error(`[pin] pinChatMessage failed chat=${chatId}:`, JSON.stringify(pinData));
    if (pinData.description?.includes('not enough rights')) {
      // Enter no-pin mode: add hint to the existing message and remember the flag.
      const cardWithHint = card + NO_PIN_HINT;
      await tgEdit(token, chatId, newId, cardWithHint).catch(() => {});
      save({ msgId: newId, lastCard: cardWithHint, noPin: true });
    }
  }
}

function ensureProfileLayoutSkill(workDir, username) {
  const skillsDir = path.join(workDir, 'skills');
  const skillFile = path.join(skillsDir, 'profile-layout.md');
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  try {
    const stat = fs.existsSync(skillFile) && fs.statSync(skillFile);
    if (stat && (Date.now() - stat.mtimeMs) < MAX_AGE_MS) return;
    fs.mkdirSync(skillsDir, { recursive: true });
    const { execSync } = require('child_process');
    const tree = execSync(
      `find ${workDir} -maxdepth 3 -not -path "*/sessions/*" -not -path "*/.git/*" | sort`,
      { timeout: 5000 }
    ).toString().trim();
    const tokenDir = path.join(TOKENS_ROOT, username);
    const tokens = fs.existsSync(tokenDir)
      ? fs.readdirSync(tokenDir).filter(f => !f.startsWith('.')).join(', ')
      : '(нет)';
    const content = [
      '# Карта профиля агента (auto-generated)',
      '',
      `> Обновлено: ${new Date().toISOString()}`,
      '',
      '## Рабочая директория (workDir)',
      '',
      '```',
      tree,
      '```',
      '',
      '## Токены и секреты (только чтение)',
      '',
      `\`${tokenDir}/\` — файлы: ${tokens}`,
      '',
      '## Правила сохранения',
      '',
      '| Данные | Путь |',
      '|---|---|',
      `| WEEEK настройки | \`${workDir}/contexts/weeek/{filename}.json\` |`,
      `| Навыки и справочники | \`${workDir}/skills/<название>.md\` |`,
      '',
      '**НИКОГДА не сохранять в** токен-файлы (только чтение)',
      '',
      '## Структура contexts/ по доменам',
      '',
      '```',
      'contexts/',
      '  weeek/           ← WEEEK CRM настройки',
      '```',
    ].join('\n');
    fs.writeFileSync(skillFile, content, 'utf8');
  } catch (e) {
    console.warn(`[profile-layout] skill gen failed for ${username}:`, e.message);
  }
}

// §C (#530): дешёвая LLM смотрит финал ГЛУБОКОГО ответа — описан ли в нём ПЛАН
// дальнейших действий («дальше предлагаю сделать так и так», перечень шагов к
// реализации). Если да — под ответом покажем «▶️ Действуй дальше по плану». Строго
// консервативно: сомнение / короткий ответ / нет ключа → false (кнопку не показываем).
async function detectPlanInAnswer(text, apiKey, { timeoutMs = 10000 } = {}) {
  const t = String(text || '').trim();
  // Порог был 200 — резал короткие, но настоящие планы («Дальше предлагаю: 1)…2)…»
  // укладывается в ~120 символов) и текст молчал про план, хотя реально его описывал
  // (баг от 2026-09-15). Выровняли с detectMenuInAnswer (100) — там та же дешёвая
  // LLM и тот же риск ложных срабатываний на коротком тексте, отдельного порога не нужно.
  if (t.length < 100) return false;
  const serviceLlm = require('../service-llm');
  if (!serviceLlm.available(apiKey)) return false;
  const system = [
    'Ты смотришь на ответ ассистента и решаешь: описан ли в нём ПЛАН дальнейших действий,',
    'который ассистент предлагает выполнить СЛЕДУЮЩИМ шагом («дальше предлагаю сделать…»,',
    'перечень конкретных шагов к реализации, «следующие шаги», «дальше нужно…»).',
    'План = есть конкретные предлагаемые действия ВПЕРЁД, которые можно пойти и выполнить.',
    'НЕ план: итог/объяснение уже сделанного, ответ на вопрос, список фактов без действий,',
    'вопрос к пользователю без шагов.',
    'Ответь СТРОГО одним JSON: {"plan": true|false}. Сомневаешься → false.',
  ].join(' ');
  try {
    // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
    const obj = await serviceLlm.serviceJson({ system, user: t.slice(0, 3000), maxTokens: 20, timeoutMs, apiKey, source: 'plan-detect' });
    return obj?.plan === true;
  } catch (e) {
    console.warn('[plan-detect]', e.message);
    return false;
  }
}

// §D (мультикнопочное меню, 2026-09-14): та же дешёвая-LLM механика, что и
// detectPlanInAnswer, но ловит другой случай — Claude в тексте предлагает
// пользователю ЯВНЫЙ ВЫБОР из 2-4 самостоятельных альтернатив («вариант А / вариант
// Б», «можем так, а можем эдак — что выбираешь?»), а не единый план шагов. Claude
// умеет только говорить текст — никакого отдельного «менюшного» API у него нет,
// поэтому кнопки строим постобработкой поверх обычной прозы, как и с планом.
// Тап по кнопке шлёт короткий маркер выбора (без текста варианта — сессия читает
// СВОЙ ЖЕ последний ответ и знает, что означает вариант N); байт callback_data не
// тратим на длинные ярлыки. Сомнение / короткий ответ / нет ключа → null (без меню).
async function detectMenuInAnswer(text, apiKey, { timeoutMs = 10000 } = {}) {
  const t = String(text || '').trim();
  if (t.length < 100) return null;
  const serviceLlm = require('../service-llm');
  if (!serviceLlm.available(apiKey)) return null;
  const system = [
    'Ты смотришь на ответ ассистента и решаешь: предлагает ли он пользователю ЯВНЫЙ ВЫБОР',
    'из 2-4 конкретных самостоятельных альтернатив (напр. "Вариант А: ... Вариант Б: ...",',
    'или "можем сделать так, а можем эдак — что выбираешь?"). Каждая альтернатива —',
    'законченный отдельный путь действия, а не шаг одного общего плана.',
    'НЕ меню: единая последовательность шагов одного плана, вопрос да/нет,',
    'список фактов без выбора, один рекомендованный вариант без альтернатив.',
    'Служебные команды /command и управление чеклистом НЕ являются меню вариантов.',
    'Если это меню — верни короткие ярлыки (2-4 слова, БЕЗ номеров и слова "вариант"),',
    'по одному на альтернативу, в порядке появления в тексте.',
    'Ответь СТРОГО JSON: {"menu": true, "labels": ["...", "..."]} или {"menu": false}.',
    'Сомневаешься → menu:false.',
  ].join(' ');
  try {
    const obj = await serviceLlm.serviceJson({ system, user: t.slice(0, 3000), maxTokens: 150, timeoutMs, apiKey, source: 'menu-detect' });
    if (obj?.menu !== true || !Array.isArray(obj.labels)) return null;
    const labels = obj.labels.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4);
    return labels.length >= 2 ? labels : null;
  } catch (e) {
    console.warn('[menu-detect]', e.message);
    return null;
  }
}

// Builds a runtime capabilities addendum for OpenCode system prompt.
// OpenCode uses non-Claude models that don't auto-read CLAUDE.md, so we inject what's available.
function buildOcCapabilitiesBlock(secrets) {
  const lines = ['## Возможности системы (runtime)'];

  if (secrets && secrets.DEEPGRAM_API_KEY) {
    lines.push(
      '',
      '**Транскрибация аудио:** доступна (Deepgram nova-2)',
      '• Поддерживает русский и другие языки',
      '• Форматы: mp3, wav, ogg, m4a, голосовые сообщения Telegram',
      '• Быстро, точнее Whisper, с пунктуацией и разбивкой по абзацам',
      '• Пользователь присылает аудиофайл → бот транскрибирует → текст попадает к тебе',
    );
  }

  if (secrets && secrets.OPENROUTER_API_KEY) {
    lines.push(
      '',
      '**Распознавание изображений:** доступно (Gemini 2.5 Flash)',
      '• Ты сам не видишь картинки — но текст/описание с фото уже распознан заранее',
      '• Присланное фото приходит вместе с заметкой «[Файл сохранён: …]» и, если что-то распозналось,',
      '  блоком «[Распознано на изображении: …]» прямо под ней — читай его, отдельно открывать файл не нужно',
      '• Если блока с распознаванием нет — на фото не нашлось ни текста, ни узнаваемой сцены',
    );
  }

  lines.push(
    '',
    '**Инструменты (MCP):** доступны только compress-on-input и Neon (Postgres).',
    'Кастомные скилы (HH, Weeek, nalog, gdrive и др.) для OpenCode НЕ подключены.',
    'Для задач с кастомными скилами пользователь должен переключиться на Claude (/switch2klod).',
  );

  return lines.join('\n');
}

// Failure Event recording (issue #1175, PR #1179 follow-up) — Phase A: observational only. Every
// branch of the crash/retry maze below calls this right before it acts, so execution-history.js
// builds a real per-executionId attempt chain from live production failures instead of unit-test
// fixtures. Deliberately does NOT feed recovery-policy.js back into any decision here — the
// existing branches below keep steering exactly as before; this only records what they saw and
// chose, so the classifier/history can be validated against real traffic before a later, separate
// PR is trusted to let recovery-policy.js actually make the call (see PR #1179's own DoD note and
// the #1172/#1173 lesson — this hot path does not get a second unreviewed behavioral change).
// Stage A (classifyDeterministic) only — free, synchronous, no added latency/cost on a path that
// runs on every real task failure; Stage B's cheap-LLM fallback is for cold-start unmatched text
// and stays opt-in via failure-classifier.classify() for callers who need it.
// Never throws: classifyDeterministic is pure, and execution-history's own recordAttempt already
// catches+warns internally rather than letting a history-write failure take down the retry itself.
// Ladder call log (src/ladder-log.js): one line per OpenCode run — which worker ladder/role ran
// and the outcome. Rung order, failover and the served rung are the llm-ladder worker's (#1687).
// Never throws.
function _logOcLadderCall(ocProfileName, ocRole, model, outcome, errorText) {
  try {
    require('../ladder-log').logCall({
      source: `runner:${ocProfileName}`,
      ladder: ocLadder.ladderFor(ocProfileName) || ocProfileName,
      rungsTotal: null,
      outcome,
      attempts: [{
        model, rung: null, outcome,
        ...(errorText ? { error: String(errorText).slice(0, 200) } : {}),
      }],
      extra: { role: ocRole },
    });
  } catch (e) {
    console.warn('[runner] ladder call log failed:', e.message);
  }
}

function _recordFailureAttempt(executionId, { taskId, projectId, sessionId, engine, provider, model, exitCode, errorText, action }) {
  try {
    const cls = classifyFailureDeterministic(errorText);
    const failureClass = cls?.class || 'UNKNOWN';
    executionHistory.recordAttempt(executionId, {
      taskId, projectId, sessionId, engine, provider, model, exitCode,
      errorText,
      failureClass,
      classificationSource: cls ? 'rule' : 'none',
      action,
    });
    // Move engine health in lockstep with the recorded event. markEngineFailure is a no-op for
    // non-relevant classes (USER_STOP/UNKNOWN) and for a missing engine — see engine-health.js.
    if (engine) markEngineFailure(engine, { failureClass, message: errorText });
  } catch (e) {
    console.warn('[runner] _recordFailureAttempt failed:', e.message);
  }
}

// Which session a run writes into, and whose history seeds its context.
// Returns { activeSessionId, contextSessionId } — contextSessionId set only
// when an existing session is continued. Side effect: claims an unattached
// legacy session for the Telegram chat (#489).
function resolveRunSession(sessions, getCurrent, { workDir, sessionId, chatId, audience, threadId, forceNew = false, webExactSession = false }) {
  let activeSessionId = null;
  let contextSessionId = null;
  if (sessionId) {
    // Explicit session ID from bot — honor it, but a session belonging to another chat
    // of this profile is dropped rather than used (see the non-blocking fallback below).
    // Sign-robust: the gateway's remembered id can diverge from disk (chatId
    // sign-split — KV holds `s-1003…`, real content lives under `s--1003…`).
    // resolveChatSession falls back to this chat's durable current-session
    // pointer instead of spawning a blank session and orphaning the ТЗ.
    // forceNew is the gateway's explicit "start a fresh session" intent (e.g.
    // the /sessions "new" flow, or a NEW_SESSION_SIGNALS phrase) — that id is
    // SUPPOSED to have no file on disk yet, so it must never heal back onto
    // the chat's old pointer, or "start new session" would silently reattach
    // to the stale one.
    activeSessionId = (forceNew || webExactSession) ? sessionId : (sessions.resolveChatSession(workDir, sessionId, chatId, audience, threadId) || sessionId);
    const existing = sessions.getSession(workDir, activeSessionId);
    if (existing && webExactSession) {
      // Web ConversationRef (#1365 PR3): the Web dialog IS this session. The
      // authenticated profile owner writes into it exactly — never healed onto
      // a chat-0 pointer, never dropped because a Telegram chat holds it, and
      // its liveChatId is left untouched (no silent Telegram pointer movement).
      contextSessionId = activeSessionId;
    } else if (existing) {
      // Chat isolation is NON-BLOCKING. A live session is attached to exactly one chat;
      // if the gateway handed us one that belongs to a DIFFERENT chat of this profile
      // (its remembered id can leak across a profile's chats), we must not reject the
      // message — that stranded the user with an error and no answer. Instead treat the
      // foreign session as unavailable here and fall through to THIS chat's own current
      // session, or start fresh. The foreign session is left untouched so the other chat
      // keeps its context. liveChatId (was ownerChatId): read-compat with pre-rename files.
      // Same for forum topics (#1409): the conversation is the pair (Telegram chat,
      // message_thread_id) — a session of a sibling topic in the same group is foreign too.
      const attachedChatId = existing.liveChatId ?? existing.ownerChatId;
      if (!sessions.belongsToConversation(existing, chatId, threadId)) {
        activeSessionId = null;
      } else {
        // Legacy / unattached session (#489): a null liveChatId would otherwise let ANY
        // chat adopt it and mix contexts. Claim it for the current chat (and topic) on first touch.
        if (chatId && (!attachedChatId || sessions.threadOf(existing) === undefined)) {
          sessions.claimLiveChatId(workDir, activeSessionId, chatId, sessions.normThreadId(threadId));
        }
        contextSessionId = activeSessionId;
      }
    }
  }

  if (!activeSessionId && !((forceNew || webExactSession) && sessionId)) {
    // No usable explicit session (none given, or a foreign one was dropped above) —
    // continue the most recent one for THIS chat (within 4h), or start a fresh session.
    const currentId = getCurrent(workDir, chatId, audience, threadId);
    const current = currentId && sessions.getSession(workDir, currentId);
    if (current && (!chatId || sessions.belongsToConversation(current, chatId, threadId))) {
      if (chatId && sessions.threadOf(current) === undefined) {
        sessions.claimLiveChatId(workDir, currentId, chatId, sessions.normThreadId(threadId));
      }
      activeSessionId = currentId;
      contextSessionId = currentId;
    }
  }
  return { activeSessionId, contextSessionId };
}

// GTD scheduling hook, run AFTER terminal delivery. Extracted out of _runTask so
// it is directly callable from tests: previously it lived inline inside a
// try/catch that swallowed a ReferenceError, so any wiring break silently killed
// GTD scheduling for EVERY run with only a `[gtd] hook: ...` warn (2026-09-25:
// `runThreadId` referenced from _runTask, where only the `threadId` param exists).
// Returns the scheduling promise (fire-and-forget at the call site); a null return
// means "nothing scheduled" (internal re-run / no session / no checklist).
function scheduleGtdAfterRun({ internalGtd, activeSessionId, explicitMode, task, secrets, workDir, username, projectDir, audience, chatId, threadId, runStartedAt = null }) {
  if (internalGtd || !activeSessionId) return null;
  const gtd = require('../gtd-controller');
  // BV-08 (#1729): секция, которую этот ран дописал без `Owner-session:` (агент забыл
  // строку / тул её не пишет), принадлежит этой сессии — подписываем до проверки
  // владельца. Legacy-секции (файл не менялся в этом ране) остаются без владельца.
  if (projectDir && Number.isFinite(runStartedAt)) {
    try { gtd.claimFreshChecklist({ workDir, projectDir, sessionId: activeSessionId, since: runStartedAt }); }
    catch (e) { console.warn('[gtd] claim checklist:', e.message); }
  }
  const checklistArgs = {
    workDir, sessionId: activeSessionId, chatId,
    username, projectDir: projectDir || null, audience: audience || 'default',
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
    isSessionRunning: (_username, sid) => isSessionRunning(sid),
  };
  if (explicitMode === 'deep') {
    // Осознанный launch — «⏻ Запустить проработку» (workrun). Свободный текст
    // задачи ("доведи до конца") гоняем через LLM-гейт (#501/#502/#505); если
    // фраза не совпала, но в проекте уже лежит незакрытый checklist.md — тот сам
    // по себе достаточное основание трекать (checklist ⇒ intent).
    return gtd.maybeSchedule({ ...checklistArgs, task, apiKey: secrets?.OPENROUTER_API_KEY })
      .then(rec => rec || gtd.scheduleFromChecklist(checklistArgs))
      .catch(e => { console.warn('[gtd] schedule:', e.message); return null; });
  }
  // Обычный reply/clarify: НЕ зовём LLM-гейт на каждый ход (дорого/шумно,
  // #501/#502) — но checklist.md уже сам по себе авторский сигнал, и его
  // достаточно, чтобы трекать (дефолт для PR: «создал PR → checklist.md с 3
  // пунктами → GTD подхватывает» без явной фразы «доведи до конца»).
  return gtd.scheduleFromChecklist(checklistArgs)
    .catch(e => { console.warn('[gtd] schedule:', e.message); return null; });
}

async function _runTask({ taskId, user, task: rawTask, context, engine: acceptedEngine = null, userMessageRecorded = false, initiatedAt = null, threadId = null, sessionId, contextFromSession, forceClaude, forceNew = false, webExactSession = false, initialMsgId, pinnedMsgId, secrets,     continuationCount = 0, retryCount = 0, outputCallback = null, onProgress = null, internalGtd = false, mode = null, projectId = null, projectPicked = false, newProjectName = null, engineFallbackDone = false, resumedAfterRestart = false, resumeAttempts = 0, incompleteRetryAttempts = 0, executionId = randomUUID(), lastAttemptError = null, resumeSessionId = null, resumeFallbackDone = false, stepTimeoutMs = null, ocProfile: forcedOcProfile = null, ocRole: forcedOcRole = null, resumeSink = null }) {
  // Strip @botname suffix from slash commands once at intake so all INTENT regexes match cleanly.
  let task = rawTask ? rawTask.replace(/^(\/\S+?)@\S+/, '$1') : rawTask;
  // Старт рана для claimFreshChecklist (BV-08): initiatedAt — момент запроса у шлюза
  // (переживает авто-продолжения и резюм), иначе — сейчас.
  const runStartedAt = Number.isFinite(initiatedAt) ? Math.min(initiatedAt, Date.now()) : Date.now();
  // Явный режим ответа из inline-кнопки: 'deep' (⏻ проработка, sticky) | 'clarify'
  // (❓ уточнить, транзиентно этот ход). Нормализуем; неизвестное → null (дефолт one-shot).
  const explicitMode = answerRouter.normalizeMode(mode);

  // Кнопки явных действий под ответом. Единый путь ЗАПУСКА проработки — накопитель
  // ввода (кнопка «▶️ Запустить проработку» в шлюзе, callback intake_run). «❓ Уточнить»
  // убрана реверсом владельца (INTAKE-REFACTOR-SPEC §9.2) — см. answerRouter.oneshotActionMarkup.
  const actionButtons = answerRouter.oneshotActionMarkup;
  const { BOT_TOKEN } = secrets;
  const chatId = user.id;
  // The gateway sent the task placeholder ("📨 Передаю задачу агенту…") and passed its
  // id as initialMsgId; remember it so /clean_up_flood can delete it too (same bot token).
  try { require('../sent-messages').record(BOT_TOKEN, chatId, initialMsgId); } catch { /* best-effort */ }
  // Scopes session/project lookups to the calling bot/surface (see AUDIENCE-SCOPE-SPEC)
  // — e.g. the recruiter bot sets user.audience='recruiter' so its sessions never mix
  // with the general-purpose bot's for the same shared username+chatId. Defaults to
  // 'default', identical to every existing session/project on disk.
  const audience = user.audience || 'default';

  savePendingTask(taskId, {
    phase: 'running', taskId, userId: user.id, username: user.username, workDir: user.workDir, audience,
    profileId: user.profileId, telegramUserId: user.telegramUserId, continuationCount, retryCount, internalGtd,
    task, context, sessionId, contextFromSession, forceClaude, forceNew, webExactSession, mode, projectId, projectPicked, newProjectName,
    initialMsgId, pinnedMsgId, initiatedAt, threadId, resumedAfterRestart, resumeAttempts,
    resumeSink, ocProfile: forcedOcProfile, ocRole: forcedOcRole, stepTimeoutMs,
    startedAt: Date.now(),
  });

  // Watchdog step 1b (issue #942 [011], 1/4): this function has many early returns (chat
  // mismatch, nalog-expired, user-stop, crash/retry branches, auto-continuation, ...) between
  // the phase='running' write above and normal completion. Historically, any exit path that
  // forgot to call clearPendingTask()/set a more specific terminal phase left the journal
  // entry stranded at phase='running' forever if the process then died before the outer
  // runTask() wrapper's own finally (src/runner/index.js runTask()) ran — e.g. a hard kill.
  // This is a safety net only: paths that already correctly clear/finalize the file are
  // unaffected (the guard below is a no-op once the file is gone or has a specific phase).
  let _runTaskError;
  try {
  initLog(user.workDir);
  ensureProfileLayoutSkill(user.workDir, user.username);

  // Resolve session context without writing to disk yet.
  // Session creation / message appending is deferred until we know this is not a utility command.
  let activeSessionId = null;
  let sessionContext = context;
  let sessionExists = false; // true when continuing an existing session (not creating)

  // forceClaude (тап по inline-кнопке проработки/уточнения) gets a wider context window so
  // long data like requisites or HH descriptions aren't truncated in the session history.
  // 8 messages = 4 user turns + 4 replies — enough to cover typical deep/clarify scenarios.
  const ctxLimit = forceClaude ? 1500 : 500;
  const ctxMsgCount = forceClaude ? 8 : 6;

  const picked = resolveRunSession(sessions, getCurrentSessionId, { workDir: user.workDir, sessionId, chatId, audience, threadId, forceNew, webExactSession });
  activeSessionId = picked.activeSessionId;
  if (picked.contextSessionId) {
    sessionExists = true;
    const fromSession = sessions.buildContext(user.workDir, picked.contextSessionId, ctxLimit, ctxMsgCount);
    if (fromSession) sessionContext = context ? `${fromSession}\n\n${context}` : fromSession;
  }

  if (contextFromSession && !sessionExists) {
    const sourceCtx = sessions.buildContext(user.workDir, contextFromSession, ctxLimit, ctxMsgCount);
    if (sourceCtx) sessionContext = context ? `${sourceCtx}\n\n${context}` : sourceCtx;
  }

  // Fresh session in a chat with recent history (4h window expired / new topic):
  // session-scoped context is empty, so without this the model has no idea what
  // the user said an hour ago in the SAME chat ("с той задачей разобрались…").
  // Compact reference block of the chat's last 24h across its other sessions.
  if (!sessionExists && !contextFromSession && chatId && !webExactSession) {
    try {
      const recentBlock = require('../chat-history').buildRecentChatBlock(
        path.join(user.workDir, 'sessions'), chatId, { excludeSessionId: activeSessionId, threadId: sessions.normThreadId(threadId) });
      if (recentBlock) sessionContext = sessionContext ? `${recentBlock}\n\n${sessionContext}` : recentBlock;
    } catch (e) { console.warn('[runner] recent chat block:', e.message); }
  }

  // ── Project binding (always on — no opt-in gate) ────────────────────────────
  // Every session lives inside a typed PROJECT (see projects.js): its cwd is the
  // project folder and the project's PROFILE.md domain rules fold into the system
  // prompt. This is now the SINGLE project mechanism — the old raw-subfolder picker
  // (projectDir string) is retired (issue #517, no backward-compat).
  //
  // Continuing session -> keep the project stored on the session (never re-ask).
  // New session:
  //   - gateway already resolved the choice -> opts.projectId is passed in -> bind it.
  //   - otherwise decideNewSessionProject: pinned → last used → default «Все подряд»
  //     (created if missing). Never asks; the result becomes the chat's current project.
  let boundProjectId = null;
  let pinProject = false; // explicit user choice → becomes the chat's pinned project (#1312)
  try {
    const continuing = !!(sessionExists && activeSessionId);
    const s = continuing ? sessions.getSession(user.workDir, activeSessionId) : null;
    const r = projects.resolveRunProject(user.workDir, {
      chatId, audience, continuing, continuingProjectId: s && s.projectId,
      projectId, projectPicked, newProjectName, threadId,
    });
    boundProjectId = r.projectId;
    pinProject = r.pin;
    if (boundProjectId) {
      const dir = projects.resolveProjectDir(user.workDir, boundProjectId);
      if (dir) {
        projects.setActiveProjectId(user.workDir, boundProjectId, chatId, { audience, pinned: pinProject, threadId });
        user.cwd = dir; // session runs inside its project
      } else {
        // Project folder is gone — e.g. archived/merged by a projects reorg since this
        // session last ran. Previously this fell through silently, leaving user.cwd at
        // whatever it already was (wrong project, or the bare profile root) with zero
        // indication to the user. Clear the stale binding so the NEXT message resolves
        // fresh instead of repeating this every turn, and tell Claude so it can explain
        // instead of quietly working in the wrong place.
        console.warn('[runner] project %s has no folder — clearing stale binding (session %s)', boundProjectId, activeSessionId || '(new)');
        if (activeSessionId) sessions.setSessionProject(user.workDir, activeSessionId, null);
        task = `[Системное уведомление: папка проекта этой сессии была перенесена или архивирована (реструктуризация проектов) и больше не существует по старому пути. Работаю в профиле по умолчанию — прежние файлы не удалены, ищи в projects/_archive/. Сообщи об этом пользователю одной короткой фразой в начале ответа.]\n\n${task}`;
        boundProjectId = null;
      }
    }
  } catch (e) {
    console.warn('[runner] project binding:', e.message);
  }

  // forceClaude=true (тап по inline-кнопке): деривируем задачу из сессии и обрамляем её
  // под выбранное действие. deep (⏻ проработка): быстрый ответ уже дан, нужен полный
  // разбор того же запроса — прежний ответ прикладываем как контекст. clarify (❓): рамку
  // задаёт CLARIFY-блок промпта, задачу не трогаем. Без mode — задача как есть.
  if (forceClaude && activeSessionId && sessionExists) {
    // A ⚡ side session (src/quick-reply.js) becomes a real dialog once escalated.
    sessions.promoteSideSession(user.workDir, activeSessionId);
    const sess = sessions.getSession(user.workDir, activeSessionId);
    if (!task) task = sess?.lastUserMessage || '';
    if (task && sess && explicitMode === 'deep') {
      const msgs = sess.messages || [];
      const lastAssistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
      const prevReply = lastAssistantMsg ? `\nБыстрый ответ уже был дан: "${lastAssistantMsg.content.slice(0, 800)}".` : '';
      task = `[Пользователь запустил проработку того же запроса.${prevReply}\nЗапрос: "${task}"]`;
    }
  }

  // If vacancy messages were collected but not yet generated, inject them so Claude can generate the vacancy.
  // vacancy-state.messages live in a separate file, not in session history — Claude wouldn't see them otherwise.
  if (forceClaude && user.workDir) {
    try {
      const vs = readVacancyState(user.workDir);
      if (vs?.messages?.length > 0 && ['generating', 'collecting'].includes(vs.status)) {
        const blocks = vs.messages.map((m, i) => `[Блок ${i + 1}]: ${m.slice(0, 500)}`).join('\n\n');
        task = `[Материалы вакансии, собранные пользователем:\n${blocks}]\n\n${task}`;
      }
    } catch (e) { if (e.code !== 'ENOENT') console.warn('[runner] readVacancyState:', e.message); }
  }

  // Persist chatId early — needed by OAuth callbacks (e.g. HH, GDrive) that fire
  // after a quick-answer early-return and never reach the Claude path below.
  try {
    const tDir = path.join(TOKENS_ROOT, String(user.username));
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(tDir, '.chatid'), String(chatId), { mode: 0o600 });
    const oldChatDir = path.join(TOKENS_ROOT, String(user.id));
    if (fs.existsSync(oldChatDir)) {
      // Only write .username if the folder has no existing owner or already belongs to us.
      // Overwriting a different profile's marker would cause loadUserTokens to migrate
      // that profile's tokens into ours (cross-profile isolation leak).
      const markerPath = path.join(oldChatDir, '.username');
      let existingOwner = null;
      try { existingOwner = fs.readFileSync(markerPath, 'utf8').trim() || null; } catch { /* no marker yet */ }
      if (!existingOwner || existingOwner === String(user.username)) {
        fs.writeFileSync(markerPath, String(user.username), { mode: 0o600 });
      } else {
        console.warn('[runner] skipped .username overwrite: chatId=%s owned by "%s", current user "%s"', user.id, existingOwner, user.username);
      }
    }
  } catch (e) { console.warn('[runner] persist chatId:', e.message); }

  // Quick answer — bypass Claude. Utility commands skip session logging entirely.
  // forceClaude=true skips quick answers for ambiguous prose (user explicitly wants Claude /
  // restart-resume), but NOT for slash commands — a command is unambiguous and must never be
  // replayed to the LLM. See shouldAttemptQuickAnswer (intent-engine).
  const dispatchQuick = () => runQuickAnswer(task, user.username, user.workDir, secrets.OPENROUTER_API_KEY, sessionExists, chatId, user.telegramUserId, activeSessionId, audience, threadId);
  // #1542 P1: input router in SHADOW mode — started concurrently, never awaited,
  // only logged next to the legacy quick-intent decision (src/input-router.js).
  const routerShadow = startInputRouterShadow({
    text: task, source: 'quick', user: user.username, sessionId: activeSessionId || null,
    openrouterKey: secrets.OPENROUTER_API_KEY, ctx: { sessionExists },
  });
  // Machine prompts (durable steps, GTD re-opens) never take a quick answer: an OpenCode
  // step has forceClaude=false, so its prose prompt reached the quick-answer matcher.
  const quickAttempted = !internalGtd && shouldAttemptQuickAnswer(forceClaude, task);
  const quickReply = quickAttempted ? await dispatchQuick() : null;
  routerShadow.record({ quick: !!quickReply, attempted: quickAttempted, slash: /^\//.test(String(task || '').trim()), forceClaude: !!forceClaude });
  if (quickReply) {
    console.log('[%s] quick-answer len=%d', taskId, quickReply.length);
    const isUtility = PING_INTENT.test(task) || HELP_INTENT.test(task) ||
      SESSIONS_INTENT.test(task) || SESSION_DETAIL_INTENT.test(task) || USAGE_INTENT.test(task) ||
      SECRETS_LIST_INTENT.test(task) || SECRETS_LOG_INTENT.test(task) ||
      CONTEXT_OFF_INTENT.test(task) || CONTEXT_ON_INTENT.test(task) ||
      PERSONA_INTENT.test(task) || PROJECT_INTENT.test(task) || SETTINGS_INTENT.test(task) || AGENT_INFO_INTENT.test(task) ||
      MODEL_INFO_INTENT.test(task) || BUG_OR_FEATURE_INTENT.test(task);

    if (!isUtility) {
      if (sessionExists) {
        if (!userMessageRecorded) sessions.appendUserMessage(user.workDir, activeSessionId, task);
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      } else {
        // New conversation — create session with first exchange
        activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined, chatId, projectId: boundProjectId, audience, threadId });
        sessions.appendReply(user.workDir, activeSessionId, quickReply);
      }
      bindTaskActivity(taskId, user, activeSessionId);
      setCurrentSessionId(user.workDir, activeSessionId, chatId, audience, threadId);
    }
    // Escalate-button (requirements-log [062], 2026-09-15): §9.2 killed the generic
    // one-shot action markup (oneshotActionMarkup — see answer-router.js), but a quick
    // answer is a template match, not an LLM plan — detectPlanInAnswer never runs on it,
    // so it can never earn a «▶️ Действуй дальше по плану» button. Without a button here,
    // a quick answer that missed the point is a dead end: it IS saved to session history
    // (below), but nothing lets the user hand that exact exchange to Claude — they'd have
    // to retype the question into the accumulator and hope it resolves to the same session.
    // qa_more|{sessionId} (tg-bot callbacks.js) reruns this session with forceClaude+deep;
    // runner.js's own forceClaude-deep wrap (below, "Пользователь запустил проработку того
    // же запроса") already attaches the quick reply as prior context — no new plumbing
    // needed there.
    // Utility replies are not in the chat's session, so they escalate from a side session
    // (recordQuickExchange) — every ⚡ reply gets the button, none is a dead end.
    const escalateSessionId = isUtility
      ? recordQuickExchange(user.workDir, { username: user.username, chatId, threadId, audience, projectId: boundProjectId, task, reply: quickReply })
      : activeSessionId;
    const quickExtra = { reply_markup: { inline_keyboard: [
      ...escalateRows(escalateSessionId), ...inputInspectionRows(initialMsgId, activeSessionId),
    ] } };
    if (initialMsgId) {
      await tgEdit(BOT_TOKEN, chatId, initialMsgId, `⚡ ${quickReply}`, quickExtra).catch(() => tgSend(BOT_TOKEN, chatId, `⚡ ${quickReply}`, quickExtra, threadId));
    } else {
      await tgSend(BOT_TOKEN, chatId, `⚡ ${quickReply}`, quickExtra, threadId);
    }
    return quickReply;
  }

  // Claude path — finalize session (create or append user message)
  if (sessionExists) {
    if (!userMessageRecorded) sessions.appendUserMessage(user.workDir, activeSessionId, task);
  } else {
    activeSessionId = sessions.createSession(user.workDir, { task, id: activeSessionId || undefined, chatId, projectId: boundProjectId, audience, threadId });
  }

  bindTaskActivity(taskId, user, activeSessionId);

  // Answer router (manual launch): глубина выбирается ЯВНОЙ кнопкой, не угадывается.
  // «⏻ Запустить проработку» → mode='deep' пишется в durable-сайдкар (sticky: держится
  // на всех последующих ходах). 'clarify' транзиентен — не пишем. Дефолт (нет кнопки) —
  // one-shot, сайдкар не трогаем.
  if (explicitMode === 'deep' && activeSessionId) {
    answerRouter.writeMode(user.workDir, activeSessionId, { mode: 'deep', source: 'workrun' });
    console.log('[%s] answer-router mode=deep (workrun)', taskId);
  }

  // Use bot's pinned placeholder if provided; otherwise send our own
  let msgId = initialMsgId || null;
  if (!msgId) {
    const thinkMsg = await tgSend(BOT_TOKEN, chatId, '🧠 Думаю…', threadId);
    msgId = thinkMsg?.result?.message_id;
  }
  const thinkingStart = Date.now();

  const userTokens = loadUserTokens(user.username, user.id);

  // Expired nalog token — tell user immediately, don't waste Claude on it
  const needsNalog = /nalog|налог|нпд|lknpd|самозан|чек|фнс/i.test(task);
  if (needsNalog && userTokens.NALOG_TOKEN_EXPIRES && new Date(userTokens.NALOG_TOKEN_EXPIRES) < new Date()) {
    const expiredMsg = [
      '🔒 Токен Налог.ру истёк.',
      '',
      'Чтобы обновить:',
      '1. Открой lknpd.nalog.ru в Chrome',
      '2. Нажми иконку cloud-auth-bridge → «Send token»',
      '',
      'После этого повтори запрос.',
    ].join('\n');
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, expiredMsg).catch(() => tgSend(BOT_TOKEN, chatId, expiredMsg, threadId));
    else await tgSend(BOT_TOKEN, chatId, expiredMsg, threadId);
    return expiredMsg;
  }

  // Inject requirements log so Claude can track and update user requirements
  const MAX_SECTION_CHARS = 10_000;
  const reqLogRaw = readLog(user.workDir);
  const reqLog = reqLogRaw && reqLogRaw.length > MAX_SECTION_CHARS
    ? reqLogRaw.slice(0, MAX_SECTION_CHARS) + '\n...[лог обрезан]'
    : reqLogRaw;
  const reqLogSection = reqLog
    ? `[REQUIREMENTS LOG — обновляй в конце каждой задачи]\n${reqLog}`
    : '';

  // Inject per-user agent notes (adaptive logic refinements written by the agent itself)
  const notesPath = path.join(user.workDir, 'agent-notes.md');
  const agentNotesRaw = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
  const agentNotes = agentNotesRaw.length > MAX_SECTION_CHARS
    ? agentNotesRaw.slice(0, MAX_SECTION_CHARS) + '\n...[заметки обрезаны]'
    : agentNotesRaw;
  const notesSection = agentNotes
    ? `[AGENT NOTES — твои собственные заметки о логике/решениях для этого юзера]\n${agentNotes}`
    : '';

  // Inject per-project agent notes (learned knowledge scoped to the bound project, e.g.
  // client preferences, past decisions — distinct from PROFILE.md's hand-authored domain
  // rules). Mirrors agent-notes.md above but keyed by project so it doesn't leak across
  // a profile's sibling projects. Write with the Write/Edit tool at
  // projects/<id>/agent-project-notes.md when you learn something worth keeping for next time.
  const projectNotesRaw = boundProjectId ? projects.notesText(user.workDir, boundProjectId) : null;
  const projectNotes = projectNotesRaw && projectNotesRaw.length > MAX_SECTION_CHARS
    ? projectNotesRaw.slice(0, MAX_SECTION_CHARS) + '\n...[заметки обрезаны]'
    : projectNotesRaw;
  const projectNotesSection = projectNotes
    ? `[AGENT PROJECT NOTES — твои заметки о накопленном опыте в этом проекте]\n${projectNotes}`
    : '';

  // Voice 2026-09-23 (simplest version): this run is an automatic retry of the SAME task after
  // it crashed/hung — tell the agent what happened last time instead of blindly re-running the
  // identical input. In-memory only (passed through the recursive runTask() call, see the three
  // retry sites below), never written to disk — unlike the reverted per-project ledger (#1173),
  // there is no cross-session file/schema to own; it only lives for this one retry chain.
  const lastAttemptErrorSection = lastAttemptError
    ? `[⚠️ ПРОШЛАЯ ПОПЫТКА ЭТОЙ ЖЕ ЗАДАЧИ УПАЛА — это автоматический повтор]\nПричина: ${lastAttemptError.reason}\nОшибка: ${String(lastAttemptError.errorText || '').slice(0, 1000)}\nЗадача ниже — тот же запрос, что и в прошлый раз. Учти причину сбоя и действуй по своему усмотрению: попробуй иначе, обойди проблему или доведи до конца другим способом.`
    : '';

  // If a quick-answer API call just failed, inject the error so Claude knows what happened.
  // The error is written to vacancy state before returning null; read it once here and clear it.
  let vacancyApiErrorSection = '';
  if (user.workDir) {
    const vsErr = readVacancyState(user.workDir);
    if (vsErr?.api_error) {
      const draftPath = path.join(user.workDir, 'contexts', 'hh', 'vacancy_draft.json');
      vacancyApiErrorSection = [
        '[⚠️ ОШИБКА HH API — предыдущая быстрая попытка упала]',
        `Ошибка: ${vsErr.api_error}`,
        `Черновик вакансии: ${draftPath}`,
        'Прочитай черновик, исправь причину ошибки и опубликуй через HH API самостоятельно.',
      ].join('\n');
      writeVacancyState(user.workDir, { ...vsErr, api_error: null });
    }
  }

  // Skills are now available via trained-skills MCP (tools/list → list_skills).
  // No prompt injection needed — Claude discovers and calls tools directly.
  //
  // Context ordering: notes → requirements log → session history → current user message.
  // "Пользователь:" prefix on the current task is critical when session context is
  // present — without it Claude reads the last session message as the current request.
  const artifactsSection = [
    'Инструменты хранилища знаний (trained-skills MCP):',
    '- agent_store_artifact(type, content, metadata) — сохрани важный факт о пользователе (контакт, решение, ключ, ссылку)',
    '- agent_query_artifacts(query, type) — найди ранее сохранённое',
    '- agent_knowledge_summary() — сводка всего что сохранено',
    '',
    'При старте новой задачи вызови agent_knowledge_summary() чтобы вспомнить контекст.',
    'При получении новой важной инфы (контакт, ключ, решение) — сразу вызови agent_store_artifact().',
    '',
    'Публикация длинного контента (publish_page):',
    'Если твой ответ — это отчёт, аналитика, таблица, обзор кандидата, предложение, резюме с разделами, или он длиннее ~800 символов — ОБЯЗАТЕЛЬНО используй publish_page вместо отправки текстом в Telegram.',
    'Как: вызови publish_page(content=..., slug=..., title=...), затем ответь пользователю только ссылкой + одно предложение о содержимом.',
    'Slug — короткий, через дефис. Например: candidate-review-ivanov, flexi-proposal-sept, analytics-week-36.',
    'Исключение: если пользователь явно просит «напиши сюда» или «отправь текстом» — отвечай текстом.',
  ].join('\n');
  const timeoutSection = `[Ход не вечный: ~40 минут. Если время выйдет — процесс прервётся, но это не потеря: сохраняй промежуточные результаты в файлы, продолжение (авто до 10 раз / GTD) подхватит с места остановки.]`;

  // (Legacy /bugreport mode removed — bug reports now go through the `bugs-and-features`
  //  project + cross-profile collector; no in-session GitHub issue creation. See intent-engine
  //  BUG_OR_FEATURE_INTENT and src/bugs-collector.js.)

  // Slice C (#1573): if this is a development-like user task and the profile can
  // actually see the audience-default playbook, inject a short offer so the agent
  // proposes the process scaffold. Never for durable playbook steps themselves
  // (internalGtd) — that would be recursive — and '' for anything else, so the
  // prompt is unchanged when no playbook is available (opt-in-safe).
  const playbookSuggestionSection = (!internalGtd && user?.username)
    ? buildDevPlaybookSuggestion({ task, profileId: user.username, audience: user.audience || 'default' })
    : '';

  // Durable steps parked on a user answer (task_item_wait awaiting_user): tell
  // the chat run so the answer wakes the plan (task_item_wake). '' when none.
  const awaitingUserSection = (!internalGtd && user?.username)
    ? buildAwaitingUserNotice(user.username)
    : '';

  let baseContext = [currentTimeSection(), timeoutSection, notesSection, projectNotesSection, lastAttemptErrorSection, reqLogSection, vacancyApiErrorSection, playbookSuggestionSection, awaitingUserSection, artifactsSection].filter(Boolean).join('\n\n');
  if (sessionContext) baseContext = baseContext ? `${baseContext}\n\n${sessionContext}` : sessionContext;
  const currentTask = sessionContext ? `Пользователь: ${task}` : task;
  let prompt = baseContext ? `${baseContext}\n\n${currentTask}` : currentTask;
  // Guard against E2BIG: OS ARG_MAX is 2MB; cap at 1MB to leave room for env vars.
  const MAX_PROMPT_CHARS = 1_000_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    console.warn('[%s] prompt too large (%d chars), truncating to %d', taskId, prompt.length, MAX_PROMPT_CHARS);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n...[промпт обрезан из-за размера]';
  }

  const sessionFilePath = activeSessionId
    ? path.join(user.workDir, 'sessions', `${activeSessionId}.json`)
    : '';

  // Per-chat engine switch (claude|codex) — see ENGINE_SWITCH_INTENT / profiles.getEngine.
  // codex and opencode now get the same MCP tools as claude too (wired via per-invocation
  // `-c mcp_servers.*` overrides for codex, OPENCODE_CONFIG for opencode — see buildEngineCommand
  // / runEngineProcess in claude-runner.js). Both still have no separate system-prompt flag —
  // the system prompt is folded into the prompt text instead.
  const engine = acceptedEngine || profiles.getEngine(user.workDir, chatId);

  // Write per-user MCP config — gives Claude access only to this user's Chrome profile.
  // With isolation on (issue #1649) the file names only the MCP bridge client; the real
  // server specs (with server-side env) stay in memory as bridgedServers.
  const { mcpConfig, servers: bridgedServers } = writeRunMcpConfig(user.workDir, user.username, {
    userName: user.name, userHandle: user.username,
  }, { bridged: isolationConfig().envAllowlist });

  // Strip ANTHROPIC_API_KEY so Claude uses OAuth from ~/.claude/.credentials.json.
  // The API key account is out of credits; OAuth (Mac subscription) has no per-token billing.
  const { ANTHROPIC_API_KEY: _stripped, ...cleanEnv } = process.env;

  const basePromptFile = path.join(__dirname, '..', 'agent-system-prompt.txt');
  // Merge the user's per-profile persona into the system prompt (returns base file if none set).
  let systemPromptFile = persona.buildSystemPromptFile(user.workDir, basePromptFile, user.audience);
  // Fold the bound project's PROFILE.md (domain rules) on top of the persona-merged prompt.
  try {
    const profileTxt = boundProjectId ? projects.profileText(user.workDir, boundProjectId) : null;
    if (profileTxt) {
      const meta = projects.getProject(user.workDir, boundProjectId);
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt +
        `\n\n# ПРОЕКТ: ${meta ? meta.name : boundProjectId} (${meta ? meta.label : 'project'}) — доменные правила\n` +
        profileTxt + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      fs.writeFileSync(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] project profile merge:', e.message); }

  // Domain skill rules (src/prompt-domains): only for skills this user actually has —
  // gated by the same isReady() as the tools in .mcp.json (system-prompt diet).
  const domainReport = {};
  try {
    const domainBlock = promptDomains.buildDomainBlock(mcpConfig, { report: domainReport });
    if (domainBlock) {
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const out = path.join(user.workDir, '.system-prompt.txt');
      fs.writeFileSync(out, baseTxt + '\n\n' + domainBlock, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] prompt domains:', e.message); }

  // Skills shadow (#1537 PR-A): resolve the skill catalog and log its diff against what
  // was just exposed above. Observation only — runShadow never throws, changes nothing.
  try {
    skillsShadow.runShadow({ workDir: user.workDir, username: user.username, audience: user.audience,
      mcpConfigPath: mcpConfig, domainReport });
  } catch { /* never affects the run */ }

  // Answer router: вставить блок режима в системный промпт для этого хода.
  //  • clarify (транзиентно, этот ход) → блок вопросов, приоритетнее deep.
  //  • deep (sticky, из durable-сайдкара) → снять cap «2-3 предложения».
  //  • иначе → one-shot, промпт без изменений.
  try {
    const deepSticky = answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep';
    // internalGtd ходы — уже «дожим до конца», им oneshot-гард про research не нужен.
    // Но если это internalGtd ВНУТРИ deep-сессии, кнопка «Действуй дальше» всё равно
    // программно подавлена (см. §C ниже) — предупреждаем Claude отдельной заметкой,
    // иначе он пишет про кнопку, которой не будет (баг от 2026-09-15).
    const block = explicitMode === 'clarify' ? answerRouter.buildClarifyBlock()
                : deepSticky && internalGtd   ? answerRouter.buildDeepBlock() + '\n' + answerRouter.buildGtdNoButtonNote()
                : deepSticky                  ? answerRouter.buildDeepBlock()
                : internalGtd                 ? null
                : answerRouter.buildOneshotBlock();
    if (block) {
      const baseTxt = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';
      const merged = baseTxt + '\n' + block + '\n';
      const out = path.join(user.workDir, '.system-prompt.txt');
      fs.writeFileSync(out, merged, { mode: 0o600 });
      systemPromptFile = out;
    }
  } catch (e) { console.warn('[runner] answer-router block:', e.message); }

  const systemPromptText = systemPromptFile && fs.existsSync(systemPromptFile) ? fs.readFileSync(systemPromptFile, 'utf8') : '';

  // OpenCode uses non-Claude models (DeepSeek, GigaChat, etc.) that don't auto-read CLAUDE.md.
  // Inject a runtime capabilities block so they know what's actually available.
  const ocCapBlock = engine === 'opencode' ? buildOcCapabilitiesBlock(secrets) : '';
  const ocSystemPrompt = ocCapBlock
    ? (systemPromptText ? `${systemPromptText}\n\n${ocCapBlock}` : ocCapBlock)
    : systemPromptText;

  // «Посмотреть инпут»: persist the REAL model input for this run (system prompt +
  // context/task, exactly what the engine receives) keyed by taskId, so the
  // gateway's button can show it instead of the gateway-side task text. The
  // document is the raw input, verbatim — no wrapper/commentary (taskId lives in
  // the filename, time in mtime). Best-effort: a write failure must never block
  // the run — it degrades to a 404/fallback.
  try {
    const runInputStore = require('../run-input-store');
    runInputStore.writeInput(user.workDir, taskId, runInputStore.buildDocument({
      systemPrompt: ocSystemPrompt || systemPromptText,
      prompt,
    }));
  } catch (e) { console.warn('[runner] run-input snapshot:', e.message); }

  const opencodeModel = process.env.OPENCODE_MODEL || null;
  // Resolve the code cwd ONCE and hand the identical value to the argv builder
  // (codex `-C` on the fresh path) and the process spawner (spawn.cwd) — see
  // resolveEngineCwd. This is what keeps `-C` and the actual process cwd from
  // silently diverging once a distinct per-run code cwd (workspace/A2) exists.
  const codeCwd = resolveEngineCwd(user);
  const [engineBin, engineArgs] = buildEngineCommand({
    engine, prompt, systemPromptText, ocSystemPrompt, opencodeModel,
    mcpConfig, systemPromptFile, user, cwd: codeCwd, resumeSessionId,
    // P3b: only a durable contract step names an agent role; pass it through only
    // when explicitly set so every other caller's argv stays bit-identical.
    ocRole: forcedOcRole || null,
  });

  // Per-profile OpenCode model routing: the profile maps to an llm-ladder worker ladder
  // (src/opencode-ladder-provider.js, issue #1687) and the `ladder` provider + per-role model ids
  // are folded into the per-invocation OPENCODE_CONFIG in runEngineProcess/writeOpencodeMcpConfig.
  // Failover between rungs happens inside the worker — nothing to degrade here.
  let ocProfileOverrides = null;
  let ocProfileName = null;
  // P3b: the ladder role for this run. A durable step pins it from its contract
  // (researcher→explore, reviewer→review); every other caller keeps the historical
  // `build` role. `ocActiveModel` is that role's resolved rung (falling back to
  // build) — the model failure reporting keys on.
  const ocRole = forcedOcRole || 'build';
  let ocActiveModel = null;
  if (engine === 'opencode') {
    try {
      // P3b: a durable step may pin an explicit OpenCode profile from its contract
      // (bachelor/master → value/max). Otherwise the profile's own choice wins.
      ocProfileName = forcedOcProfile || profiles.getOcProfile(user.workDir);
      ocProfileOverrides = ocLadder.buildOcProfileOverrides(ocProfileName);
      ocActiveModel = ocProfileOverrides?.agent?.[ocRole]?.model || ocProfileOverrides?.model || null;
      // The profile (and so the worker ladder) can change between two turns of the SAME
      // session. Compare against the model recorded for this session's last turn.
      // This is internals traceability only: the earlier user-facing «Модель сменилась»
      // chat message was debug noise and was removed on owner request (2026-09-27) — log
      // it internally, never message the chat or append it to the session transcript.
      if (activeSessionId && ocActiveModel) {
        const prevModel = sessions.getLastOcModel(user.workDir, activeSessionId, ocRole);
        if (prevModel && prevModel !== ocActiveModel) {
          console.log(`[runner] oc model changed mid-session (role ${ocRole}, session ${activeSessionId}, profile «${ocProfileName}»): ${prevModel} → ${ocActiveModel}`);
        }
        sessions.setLastOcModel(user.workDir, activeSessionId, ocRole, ocActiveModel);
      }
    } catch (e) { console.warn('[runner] ocProfileOverrides:', e.message); }
  }

  // Engine execution (spawn + stream-json + timeout/close) lives in
  // claude-runner.js (issue #942 P1.3). The module owns the process lifecycle
  // and the progress edits; this block interprets its result: on timeout →
  // auto-continuation (needs runTask recursion, so it stays in the runner),
  // otherwise the post-processing below (retry, incomplete detection, usage).
  const engineResult = await runEngineProcess({
    engine, taskId, chatId, thinkingStart, msgId, BOT_TOKEN, secrets, user, threadId,
    cleanEnv, userTokens, sessionFilePath, sessionId: activeSessionId,
    restartShutdown: () => restartShutdown,
    activeTimers, tgEdit, tgSend, outputCallback, onProgress,
    consumePendingStop: () => consumePendingStop(user.username, activeSessionId),
    engineBin, engineArgs, mcpConfig, ocProfileOverrides, bridgedServers,
    cwd: codeCwd,
    // Watchdog step 1a (issue #942 [011]): heartbeat the pending-task journal on the
    // same 30s tick claude-runner.js already runs for the inactivity check, so a
    // future watchdog (step 2+) can tell "still alive, just slow" apart from "the
    // OS process died and nobody ever wrote a terminal state". savePendingTask does
    // a partial merge ({...previous, ...params}) so this only touches the one field.
    onHeartbeat: () => savePendingTask(taskId, { lastHeartbeatAt: Date.now() }),
    // Persist the engine's native session id the moment it appears (#1234): to the durable
    // session record (source of truth for resume) AND the pending journal (read by
    // resumePendingTasks before the session is loaded). Written mid-run so a deploy SIGKILL
    // can't lose it — that is exactly the restart case resume exists for.
    onEngineSessionId: (sid) => {
      if (activeSessionId) sessions.setEngineSessionId(user.workDir, activeSessionId, engine, sid);
      savePendingTask(taskId, { engineSessionId: sid, engine });
    },
    // P3a: a durable step's declared wall-clock budget. undefined/null keeps the
    // historical fixed 40-min cap.
    timeoutMs: stepTimeoutMs,
  });
  const {
    fullOutput, lastAssistantMsg, claudeResult, claudeErrorText, engineSessionId, terminalSuccess,
    claudeUsage, opencodeUsage, opencodeBreakdown, claudeModel,
    lastActivity, exitCode, processSignal, processError, timedOut,
    inactivityKill, loopKilled, outputPersistenceError, codexErrorMsg, sessionState,
  } = engineResult;

  // Loop guard (#1583): the engine kept repeating identical output/tool calls — the
  // model is stuck, NOT making progress. Unlike a plain timeout this must NOT auto-
  // continue (the continuation would just re-enter the same loop); fail the run with
  // an explicit message so the user can retry differently (e.g. /switch2klod).
  if (loopKilled) {
    const partialText = fullOutput.text.trim();
    if (activeSessionId && partialText) {
      sessions.appendReply(user.workDir, activeSessionId, `[прервано: модель зациклилась]\n${partialText}`);
      setCurrentSessionId(user.workDir, activeSessionId, chatId, audience, threadId);
    }
    const loopMsg = '⛔ Остановлено: модель зациклилась (повторяла одно и то же действие N раз, реальный вызов не выполнялся). Публикация не выполнена. Переключись на Claude: /switch2klod и повтори запрос.';
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, loopMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, loopMsg, threadId));
    else await tgSend(BOT_TOKEN, chatId, loopMsg, threadId);
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
      errorText: codexErrorMsg || 'loop guard: repeated identical output',
      action: null,
    });
    executionHistory.finalizeExecution(executionId, 'FAILED');
    return;
  }

  // Timeout / inactivity kill → durable partial + auto-continuation.
  // R5: userStopped приоритетнее timedOut. Стоп, пришедший во время уже
  // посланного warn-SIGTERM/inactivity-kill, раньше падал в ветку автопродолжения
  // и «перерождал» задачу через 10 ретраев. Теперь такая задача уходит в ветку
  // sessionState.userStopped ниже — частичный результат + CANCELLED.
  if (timedOut && !sessionState?.userStopped) {
    const nextCount = continuationCount + 1;
    const partialText = fullOutput.text.trim();
    // Durable record keeps the full progress; the Telegram summary shows only
    // the last coherent turn so scratchpad narration never leaks to the user.
    const partialDisplay = pickFinalText(null, lastAssistantMsg, partialText);

    // Save partial progress so the next run sees what was done
    if (activeSessionId && partialText) {
      sessions.appendReply(user.workDir, activeSessionId, `[${inactivityKill ? 'прервано: молчал 5 мин' : 'прервано таймаутом'}]\n${partialText}`);
      setCurrentSessionId(user.workDir, activeSessionId, chatId, audience, threadId);
    }

    // P3a durable step: a run carrying its own `stepTimeoutMs` is a single step
    // with a declared budget + its own retry budget (max_attempts), owned by the
    // durable executor. Never auto-continue it 10× — overrunning the step budget
    // is a step failure. Returning no DURABLE marker lets runDueDurable's failure
    // branch fail the item and retry per max_attempts.
    if (stepTimeoutMs) {
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, engine,
        errorText: `step timeout: ${Math.round(stepTimeoutMs / 1000)}s budget exhausted`,
        action: 'step_failed',
      });
      executionHistory.finalizeExecution(executionId, 'FAILED');
      return;
    }

    if (continuationCount < MAX_CONTINUATIONS) {
      const statusLine = inactivityKill
        ? `⏱ Молчал 5 мин — перезапускаю (${nextCount}/${MAX_CONTINUATIONS})...`
        : `⏱ Прервал по 40-мин. таймауту, автоматически продолжаю (${nextCount}/${MAX_CONTINUATIONS})...`;
      const tgMsg = partialDisplay.length > 20
        ? `🧠 ${partialDisplay.slice(-MAX_MSG_LEN)}\n\n${statusLine}`
        : statusLine;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, tgMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, tgMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, tgMsg, threadId);

      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
        errorText: inactivityKill ? 'inactivity kill: silent 5min' : 'timeout: 40min budget',
        action: 'auto_continue',
      });
      const continuationTask = inactivityKill
        ? `[ПРОДОЛЖЕНИЕ ${nextCount}/${MAX_CONTINUATIONS}] Процесс завис (молчал 5 мин без вывода) и был перезапущен автоматически. Посмотри историю сессии — там видно что уже сделано. Продолжи с того места, где остановился. Оригинальная задача:\n${task}`
        : `[ПРОДОЛЖЕНИЕ ${nextCount}/${MAX_CONTINUATIONS}] Тебя прервал 40-минутный таймаут — процесс был остановлен и перезапущен автоматически. Посмотри историю сессии — там видно что уже сделано. Продолжи с того места, где остановился. Оригинальная задача:\n${task}`;
      runTask({
        taskId: `${user.username}-${Date.now()}`,
        user,
        task: continuationTask, initiatedAt, threadId,
        context: '',
        sessionId: activeSessionId, webExactSession,
        forceClaude: true,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        continuationCount: nextCount, mode, projectId, internalGtd, engine,
        executionId,
      });
    } else {
      const limitMsg = `⏱ Задача прервана по таймауту. Лимит автопродолжений (${MAX_CONTINUATIONS}) достигнут. Отправь задачу ещё раз чтобы продолжить.`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, limitMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, limitMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, limitMsg, threadId);
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
        errorText: 'timeout: auto-continuation budget exhausted',
        action: null,
      });
      executionHistory.finalizeExecution(executionId, 'FAILED');
    }
    return;
  }


  if (outputPersistenceError) throw outputPersistenceError;
  if (sessionState.restartInterrupted) {
    const partial = fullOutput.text.trim();
    if (activeSessionId && partial) sessions.appendReply(user.workDir, activeSessionId, `[прервано рестартом]\n${partial}`);
    return { deferred: true };
  }

  // User pressed Stop — show partial result and exit cleanly
  if (sessionState.userStopped) {
    const partial = fullOutput.text.trim();
    const partialDisplay = pickFinalText(null, lastAssistantMsg, partial);
    const stoppedMsg = partialDisplay
      ? `⛔ Остановлено\n\n${partialDisplay.slice(-MAX_MSG_LEN)}`
      : '⛔ Остановлено. Можешь задать новый вопрос.';
    const clearMarkup = { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } };
    if (msgId) {
      await tgEdit(BOT_TOKEN, chatId, msgId, stoppedMsg, clearMarkup).catch(() => tgSend(BOT_TOKEN, chatId, stoppedMsg, threadId));
    } else {
      await tgSend(BOT_TOKEN, chatId, stoppedMsg, threadId);
    }
    if (activeSessionId && partial) {
      sessions.appendReply(user.workDir, activeSessionId, `[остановлено пользователем]\n${partial}`);
      setCurrentSessionId(user.workDir, activeSessionId, chatId, audience, threadId);
    }
    executionHistory.recordAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
      errorText: 'user stopped', failureClass: 'USER_STOP', classificationSource: 'rule', action: null,
    });
    executionHistory.finalizeExecution(executionId, 'CANCELLED');
    return stoppedMsg;
  }

  // If claude crashed with non-zero exit and produced almost no output — show crash error.
  // A crash within QUICK_CRASH_MS of launch looks like a transient environment blip (process
  // spawn race, brief resource contention) rather than the task's own logic — worth one silent
  // retry before bothering the user. Capped at MAX_QUICK_RETRIES so a genuinely broken task
  // doesn't loop; a crash after the process has been running longer is treated as real and
  // surfaced immediately (a slow failure is much more likely to be about the task itself).
  // Whether this near-empty non-zero-exit run is a TERMINAL quick crash is decided by
  // engine-crash-policy: an auth/quota/usage-limit error on an engine that can still fall back
  // returns false here, so the run falls through to the engine-fallback branch below instead of
  // dead-ending with "Переключись на другой движок". See that module for the 2026-09-25 bug.
  if (isTerminalQuickCrash({
    exitCode, timedOut,
    outputLength: fullOutput.text.trim().length,
    hasResult: !!claudeResult,
    engine, engineFallbackDone,
    errorText: codexErrorMsg || claudeErrorText,
  })) {
    const crashDurationMs = Date.now() - thinkingStart;
    const isUsageLimit = codexErrorMsg && /usage limit|purchase more credits/i.test(codexErrorMsg);
    if (!isUsageLimit && !restartShutdown && crashDurationMs < QUICK_CRASH_MS && retryCount < MAX_QUICK_RETRIES) {
      const retryMsg = `⚡ Быстрый сбой (код ${exitCode} через ${Math.round(crashDurationMs / 1000)}с) — пробую ещё раз...`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, retryMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, retryMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, retryMsg, threadId);
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine, exitCode,
        errorText: codexErrorMsg || `exit ${exitCode}`, action: 'quick_crash_retry',
      });
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-${Date.now()}`,
        user,
        task,
        context,
        sessionId: activeSessionId, webExactSession,
        forceClaude,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        retryCount: retryCount + 1,
        continuationCount, mode, projectId, internalGtd, engine,
        executionId,
        lastAttemptError: { reason: `быстрый сбой при запуске (код ${exitCode})`, errorText: codexErrorMsg || `exit ${exitCode}` },
      });
      return { queuedRetry };
    }
    // Surface the underlying engine error when available (e.g. Codex usage limit).
    const usageLimitHit = codexErrorMsg && /usage limit|purchase more credits/i.test(codexErrorMsg);
    const crashMsg = usageLimitHit
      ? `⛔ ${engine === 'codex' ? 'Codex' : 'OpenCode'}: ${codexErrorMsg}\n\nПереключись на другой движок: /switch2klod (Claude) или /switch2opencode (OpenCode)`
      : codexErrorMsg && (engine === 'codex' || engine === 'opencode')
      ? `⚠️ ${engine === 'codex' ? 'Codex' : 'OpenCode'} завершился с ошибкой: ${codexErrorMsg}`
      : retryCount > 0
      ? `⚠️ Процесс снова завершился с ошибкой (код ${exitCode}) сразу после запуска. Похоже на реальный сбой, а не случайность — попробуй ещё раз позже или измени формулировку.`
      : `⚠️ Процесс завершился с ошибкой (код ${exitCode}). Попробуй ещё раз.`;
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, crashMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, crashMsg, threadId));
    else await tgSend(BOT_TOKEN, chatId, crashMsg, threadId);
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine, exitCode,
      errorText: codexErrorMsg || `exit ${exitCode}`, action: null,
    });
    executionHistory.finalizeExecution(executionId, 'FAILED');
    return crashMsg;
  }

  // OpenCode clean exit with accumulated text but no step_finish (e.g. error event surfaced text) —
  // show what was accumulated rather than the generic "no confirmed final answer" message.
  if (engine === 'opencode' && !terminalSuccess && exitCode === 0 && !processSignal && !processError && fullOutput.text.trim()) {
    terminalSuccess = true;
    claudeResult = fullOutput.text.trim();
  }

  // terminalSuccess = engine emitted its completion event (result / step_finish / turn.completed).
  // That is the authoritative signal — exit code and OS signal are secondary.
  // Exception: a Node-level processError (spawn fail, pipe break) overrides terminalSuccess.
  const interrupted = !terminalSuccess || processError;
  const answer = terminalSuccess ? pickFinalText(claudeResult, lastAssistantMsg, '') : '';
  const incomplete = interrupted || !answer;
  let result = answer;
  let incompleteReason = null; // hoisted so the generic-retry check below (after the
  // engine-specific classifiers) can build its status message without recomputing it
  if (incomplete) {
    const reason = processSignal
      ? (restartShutdown ? 'сервер перезапускается' : `сигнал ${processSignal}`)
      : exitCode !== 0 ? `код ${exitCode}`
      : processError ? `ошибка запуска`
      : 'нет подтверждённого финального ответа';
    incompleteReason = reason;

    // Native-resume fallback (#1234 Sub-2): a `--resume <id>` attempt can fail fast when the
    // engine session is gone (expired transcript, cwd changed, engine GC'd it). Fall back ONCE
    // to the pre-#1234 path — a fresh run with rebuilt context — instead of burning the whole
    // restart-retry budget on a resume that cannot succeed. resumeSessionId is NOT carried into
    // the retry, so the next attempt takes the normal context-rebuild path; resumeFallbackDone
    // is belt-and-braces against re-entering this branch.
    const resumeErrText = codexErrorMsg || fullOutput.text.trim().slice(-1000);
    const providerFault = isProviderFault(resumeErrText);
    if (resumeSessionId && !resumeFallbackDone && !restartShutdown && !providerFault) {
      console.warn(`[${taskId}] resume: fallback reason=native_resume_failed engine=${engine} (${reason})`);
      const fallbackMsg = '↩️ Не удалось продолжить сессию движка — перезапускаю с восстановленным контекстом.';
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, fallbackMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, fallbackMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, fallbackMsg, threadId);
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine, exitCode,
        errorText: reason, action: 'native_resume_fallback',
      });
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-resume-fb-${Date.now()}`,
        user, task, context,
        sessionId: activeSessionId, webExactSession,
        forceClaude, initialMsgId: msgId, pinnedMsgId, secrets,
        resumedAfterRestart, resumeAttempts,
        continuationCount, mode, projectId, internalGtd, engine,
        executionId,
        resumeFallbackDone: true,
        lastAttemptError: { reason: `нативный resume не удался (${reason})`, errorText: codexErrorMsg || fullOutput.text.trim().slice(-1000) },
      });
      return { queuedRetry };
    }

    // A task resumed after a server restart that fails again is our fault, not the
    // user's task — auto-retry a bounded number of times instead of dead-ending on
    // "напиши продолжай". resumePendingTasks() (server.js) already drops the pre-restart
    // pending record right after firing this attempt, so recursing here is the only path
    // that can re-fire it — bounded by MAX_RESUME_ATTEMPTS so a genuinely broken resume
    // can't loop forever across restarts.
    if (resumedAfterRestart && resumeAttempts < MAX_RESUME_ATTEMPTS && !restartShutdown) {
      if (providerFault) console.warn(`[${taskId}] resume: provider fault — keeping engine session ${resumeSessionId || '-'} (${resumeErrText.slice(0, 200)})`);
      const retryMsg = `🔄 Восстановление после перезапуска сервера не удалось (${reason}) — пробую ещё раз (${resumeAttempts + 1}/${MAX_RESUME_ATTEMPTS})…`;
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, retryMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, retryMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, retryMsg, threadId);
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine, exitCode,
        errorText: reason, action: 'resume_after_restart_retry',
      });
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-resume-${Date.now()}`,
        user, task, context,
        sessionId: activeSessionId, webExactSession,
        forceClaude, initialMsgId: msgId, pinnedMsgId, secrets,
        resumedAfterRestart: true, resumeAttempts: resumeAttempts + 1,
        // Provider fault → the engine session is intact: resume it natively again, don't rebuild.
        resumeSessionId: providerFault ? resumeSessionId : null, resumeFallbackDone,
        continuationCount, mode, projectId, internalGtd, engine,
        executionId,
        lastAttemptError: { reason: `восстановление после перезапуска сервера не удалось (${reason})`, errorText: codexErrorMsg || fullOutput.text.trim().slice(-1000) },
      });
      return { queuedRetry };
    }

    result = resumedAfterRestart
      ? `⚠️ Не удалось восстановить сессию после перезапуска сервера (${reason}) — ${Math.min(resumeAttempts + 1, MAX_RESUME_ATTEMPTS)} из ${MAX_RESUME_ATTEMPTS} автоматических попыток не помогли. Это сбой сервера, а не твоей задачи — отправь «продолжай», чтобы попробовать вручную ещё раз.`
      : incompleteRetryAttempts > 0
      ? `⚠️ Работа прервана (${reason}) — не помогло и после ${incompleteRetryAttempts} автоматических попыток. Отправь «продолжай», чтобы попробовать вручную ещё раз.`
      : `⚠️ Работа прервана (${reason}). Завершение задачи не подтверждено. Отправь «продолжай», чтобы продолжить эту сессию.`;
    console.warn(`[${taskId}] incomplete engine=${engine} exit=${exitCode} signal=${processSignal || '-'} terminal=${terminalSuccess} resumedAfterRestart=${resumedAfterRestart} resumeAttempts=${resumeAttempts} incompleteRetryAttempts=${incompleteRetryAttempts}`);
  }

  // OpenCode-only: a failure on the llm-ladder worker side (issue #1687). The worker already walked
  // every rung of the ladder (failover, per-model health, Go key rotation, paid tail) before
  // answering, so there is nothing left to try in-process — no local fallback ladder. The run
  // fails with a clear category instead:
  //   worker_unreachable — the worker never served the call (network / rejected token) → BLOCKED
  //   ladder_exhausted   — the worker answered 502 ladder_error, every rung failed      → BLOCKED
  //   context            — the prompt did not fit the model; ask to split the task     → FAILED
  // Checked before isAuthError below, which would otherwise treat "401"/"rate limit" text as a
  // total engine auth loss. codexErrorMsg (the error event's own message) is the most reliable
  // source of the real provider error text.
  const preLadderText = codexErrorMsg || claudeResult || fullOutput.text || result;

  // Call log for every failed OpenCode run, before any branch below can return early.
  if (engine === 'opencode' && ocProfileName && ocActiveModel) {
    _logOcLadderCall(ocProfileName, ocRole, ocActiveModel, 'error', preLadderText);
  }
  const workerFailure = engine === 'opencode' && ocActiveModel?.startsWith(`${ocLadder.PROVIDER_ID}/`)
    ? ocLadder.classifyWorkerFailure(preLadderText) : null;
  if (workerFailure) {
    const ladderName = ocLadder.ladderFor(ocProfileName) || ocProfileName;
    const failMsg = workerFailure === 'context'
      ? `⛔ Запрос слишком большой для модели лестницы «${ladderName}» — разбей задачу на более мелкие части и отправь по шагам.`
      : workerFailure === 'ladder_exhausted'
      ? `⛔ Вся лестница моделей «${ladderName}» временно недоступна (все ступени отказали в llm-ladder) — попробуй позже.`
      : `⛔ Сервис моделей llm-ladder недоступен (лестница «${ladderName}») — задача не выполнена, попробуй позже.`;
    console.warn(`[${taskId}] opencode ${workerFailure} (ladder ${ladderName}): ${String(preLadderText || '').slice(0, 300)}`);
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, failMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, failMsg, threadId));
    else await tgSend(BOT_TOKEN, chatId, failMsg, threadId);
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, failMsg);
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine: 'opencode', model: ocActiveModel,
      errorText: `${workerFailure}: ${preLadderText || ''}`, action: null,
    });
    executionHistory.finalizeExecution(executionId, workerFailure === 'context' ? 'FAILED' : 'BLOCKED');
    return failMsg;
  }

  // Detect an auth/quota failure for the current engine. Claude and Codex additionally get ONE
  // automatic fallback to OpenCode for this task (issue #1061 Фаза 3) instead of just waiting on
  // repair; engineFallbackDone guards against looping if OpenCode itself later trips isAuthError.
  //
  // Only GENUINE provider error text may be treated as an auth/quota failure — never the final
  // answer prose. Previously this read `claudeResult || fullOutput.text || result`, so a
  // successful run whose answer merely mentioned "rate limit"/"quota" (e.g. an explanation of a
  // Telegram 429 fix) raised a false auth flag and bounced a healthy task to the OpenCode
  // fallback (#1227). codexErrorMsg is set only on a turn.failed/error event, claudeErrorText
  // only on an is_error result event; both are real errors, so nothing else is needed.
  //
  // isAuthError is deliberately broad (its patterns also cover quota/rate-limit) because the
  // fallback-to-another-provider behaviour is right for both. But the AUTH FLAG (credentials)
  // is set only when the unified classifier says the class is actually credential-invalid (AUTH):
  // QUOTA/RATE_LIMIT degrade engine health via _recordFailureAttempt below, they do NOT mean the
  // credentials broke (spec §7 — this conflation is what made the old flag lie).
  const authText = codexErrorMsg || claudeErrorText || '';
  if (isAuthError(authText)) {
    const authClass = classifyFailureDeterministic(authText)?.class || 'AUTH';
    if (isCredentialInvalidClass(authClass)) {
      setAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: authText, engine });
    }
    const engineLabel = engine === 'codex' ? 'Codex' : engine === 'opencode' ? 'OpenCode' : 'Claude Code';

    if ((engine === 'claude' || engine === 'codex') && !engineFallbackDone) {
      const fallbackMsg = engineFallbackNotice(engineLabel, authClass);
      if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, fallbackMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, fallbackMsg, threadId));
      else await tgSend(BOT_TOKEN, chatId, fallbackMsg, threadId);
      if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, fallbackMsg);
      _recordFailureAttempt(executionId, {
        taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
        errorText: authText, action: 'engine_fallback_to_opencode',
      });
      const queuedRetry = runTask({
        initiatedAt, threadId,
        taskId: `${user.username}-${Date.now()}`,
        user,
        task,
        context,
        sessionId: activeSessionId, webExactSession,
        forceClaude,
        initialMsgId: msgId,
        pinnedMsgId,
        secrets,
        retryCount,
        continuationCount, mode, projectId, internalGtd,
        engine: 'opencode',
        engineFallbackDone: true,
        executionId,
      });
      return { queuedRetry };
    }

    const authMsg = engineAuthNotice(engineLabel, authClass);
    if (msgId) {
      await tgEdit(BOT_TOKEN, chatId, msgId, authMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, authMsg, threadId));
    } else {
      await tgSend(BOT_TOKEN, chatId, authMsg, threadId);
    }
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, authMsg);
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine,
      errorText: authText, action: null,
    });
    executionHistory.finalizeExecution(executionId, 'BLOCKED');
    return authMsg;
  }

  // Generic mid-task dead-end retry — reached only when the run is incomplete but none of the
  // classifiers above claimed it (not a restart-resume, not an llm-ladder worker failure, not an
  // auth failure): a bare crash, a dropped connection, or the engine just not emitting a
  // completion event. Previously this dead-ended immediately with "напиши продолжай"; now it
  // retries the same task/session on the same engine, bounded by MAX_INCOMPLETE_RETRIES with the
  // shared backoff schedule, before handing it back to a human. Switching models is the llm-ladder
  // worker's job (#1687), so there is no extra "alternative rung" attempt here any more.
  if (incomplete && !resumedAfterRestart && !restartShutdown && incompleteRetryAttempts < MAX_INCOMPLETE_RETRIES) {
    const nextAttempt = incompleteRetryAttempts + 1;
    // TEST_MODE collapses the backoff to milliseconds so retry tests stay fast.
    const delayMs = getRetryDelayMs(nextAttempt) || 0;
    const retryMsg = `🔄 Работа прервана (${incompleteReason}) — пробую ещё раз (${nextAttempt}/${MAX_INCOMPLETE_RETRIES})…`;
    if (msgId) await tgEdit(BOT_TOKEN, chatId, msgId, retryMsg, { reply_markup: { inline_keyboard: inputInspectionRows(initialMsgId, activeSessionId) } }).catch(() => tgSend(BOT_TOKEN, chatId, retryMsg, threadId));
    else await tgSend(BOT_TOKEN, chatId, retryMsg, threadId);
    if (activeSessionId) sessions.appendReply(user.workDir, activeSessionId, retryMsg);
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, webExactSession, engine, exitCode,
      errorText: incompleteReason, action: 'generic_incomplete_retry',
    });
    const fireRetry = () => runTask({
      initiatedAt, threadId,
      taskId: `${user.username}-retry-${Date.now()}`,
      user, task, context,
      sessionId: activeSessionId, webExactSession,
      forceClaude, initialMsgId: msgId, pinnedMsgId, secrets,
      incompleteRetryAttempts: nextAttempt,
      continuationCount, mode, projectId, internalGtd, engine,
      executionId,
      lastAttemptError: { reason: `работа прервана (${incompleteReason})`, errorText: codexErrorMsg || fullOutput.text.trim().slice(-1000) },
    });
    const queuedRetry = delayMs > 0
      ? new Promise((resolve, reject) => setTimeout(() => { fireRetry().then(resolve, reject); }, delayMs))
      : fireRetry();
    return { queuedRetry };
  }

  // Record token usage for billing
  if (engine === 'opencode' && opencodeUsage) {
    recordUsage(user.workDir, {
      taskId, sessionId: activeSessionId, webExactSession,
      engine: 'opencode', model: opencodeModel || 'opencode-config',
      input_tokens: opencodeUsage.input || 0,
      output_tokens: opencodeUsage.output || 0,
      cache_read_input_tokens: opencodeUsage.cacheRead || 0,
      cache_creation_input_tokens: opencodeUsage.cacheWrite || 0,
      cost_usd: opencodeUsage.cost,
      breakdown: opencodeBreakdown,
    });
  } else if (claudeUsage) {
    recordUsage(user.workDir, {
      taskId,
      sessionId: activeSessionId, webExactSession,
      engine: engine || 'claude',
      model: claudeModel || process.env.ANTHROPIC_MODEL || 'claude',
      input_tokens: claudeUsage.input_tokens || 0,
      output_tokens: claudeUsage.output_tokens || 0,
      cache_read_input_tokens: claudeUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: claudeUsage.cache_creation_input_tokens || 0,
    });
  }

  // Prompt-effectiveness instrumentation (§5.1–5.2): one JSONL line per task with the
  // assembled prompt's section sizes + deterministic adherence flags on the final
  // answer. Feeds the weekly prompt-KPI report (adherence, prompt weight, cost) —
  // see src/prompt-audit.js. Never throws; pure observation.
  try {
    const effectiveMode = (explicitMode === 'deep'
      || answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep')
      ? 'deep' : (explicitMode || 'oneshot');
    promptAudit.recordPromptAudit(user.workDir, {
      taskId, sessionId: activeSessionId, webExactSession,
      at: Date.now(), engine,
      mode: effectiveMode,
      model: engine === 'opencode' ? (opencodeModel || 'opencode-config') : (claudeModel || process.env.ANTHROPIC_MODEL || 'claude'),
      input_tokens: engine === 'opencode' ? (opencodeUsage?.input || 0) : (claudeUsage?.input_tokens || 0),
      output_tokens: engine === 'opencode' ? (opencodeUsage?.output || 0) : (claudeUsage?.output_tokens || 0),
      cache_read: engine === 'opencode' ? (opencodeUsage?.cacheRead || 0) : (claudeUsage?.cache_read_input_tokens || 0),
      cache_write: engine === 'opencode' ? (opencodeUsage?.cacheWrite || 0) : (claudeUsage?.cache_creation_input_tokens || 0),
      cost_usd: engine === 'opencode' ? (opencodeUsage?.cost ?? null) : null,
      section_tokens: promptAudit.computeSectionTokens({
        base: systemPromptText,
        oc_capabilities: ocCapBlock,
        notes: notesSection,
        project_notes: projectNotesSection,
        reqlog: reqLogSection,
        history: sessionContext,
        current_task: currentTask,
      }),
      adherence: promptAudit.adherenceFlags(result, { mode: effectiveMode }),
    });
  } catch (e) { console.warn('[runner] prompt-audit:', e.message); }
  const costFooter = engine === 'opencode'
    ? formatOcFooter(opencodeUsage, opencodeBreakdown)
    : formatCostFooter(claudeUsage, claudeModel);
  const gtdFooter = (!internalGtd && !incomplete && user.workDir)
    ? (() => { try { return require('../gtd-controller').listGtd(user.workDir).filter(r => r.status === 'open').length > 0 ? '\n\n📋 Чеклист активен — /show_active_cheklist · /checklist_turn_off' : ''; } catch { return ''; } })()
    : '';
  // #1542 P3: a wall of text is re-split into paragraphs (word-coverage guarded, fail-soft).
  if (!internalGtd && !incomplete && process.env.ANSWER_FORMAT !== '0') {
    result = await answerActions.paragraphize(result, secrets.OPENROUTER_API_KEY);
  }
  const final = (result + costFooter).slice(-MAX_MSG_LEN) + gtdFooter;

  // Terminal record for every chain that reaches here without an earlier branch already
  // recording+finalizing its own outcome (auth/ladder/quick-crash/timeout dead-ends above all
  // return before this point). Covers both success and the generic "handed back to the human,
  // resumable via продолжай" incomplete give-up — recordAttempt/finalizeExecution never throw.
  if (incomplete) {
    _recordFailureAttempt(executionId, {
      taskId, projectId, sessionId: activeSessionId, engine, exitCode,
      errorText: incompleteReason || 'incomplete', action: null,
    });
    executionHistory.finalizeExecution(executionId, 'INTERRUPTED');
  } else {
    executionHistory.finalizeExecution(executionId, 'COMPLETED');
    // Self-heal (spec §9): a successful authenticated engine call resets engine health to
    // healthy and clears the current auth failure. Failure history is untouched — it lives in
    // execution-history.js and last_failure_* on the health row. Never let a health-store error
    // take down the success path.
    if (engine) {
      try {
        markEngineSuccess(engine);
        clearAuthFailedFlag(engine);
      } catch (e) {
        console.warn('[runner] engine-health self-heal failed:', e.message);
      }
    }
    if (engine === 'opencode' && ocActiveModel) _logOcLadderCall(ocProfileName, ocRole, ocActiveModel, 'ok');
  }

  // Кнопки действий под финальным ответом. Не показываем «Запустить проработку», если
  // сессия уже deep (проработка только что и была). После clarify — показываем (чтобы
  // юзер мог запустить проработку по уточнённому ТЗ).
  const finalDeep = explicitMode === 'deep' ||
    answerRouter.readMode(user.workDir, activeSessionId)?.mode === 'deep';
  // §C (#530), расширено 2026-09-14: под ЛЮБЫМ ответом (deep И one-shot), если в нём
  // описан план дальнейших действий, показываем «▶️ Действуй дальше по плану» (callback
  // plan|{sid}). Тап безопасен из one-shot — callback сам форсирует deep+forceClaude
  // (см. tg-bot callbacks.js), так что кнопка не обязана ждать явного deep-режима.
  // Плана нет → кнопки нет (actionButtons/oneshotActionMarkup и так null, §9.2).
  // Classify only the model answer. Runtime cost/GTD footers are controls,
  // not proposals, and are absent from the model conversation on a later tap.
  let finalMarkup = null;
  let buttonReason = internalGtd ? 'internalGtd-suppressed' : 'no-session';
  if (!internalGtd && !incomplete) {
    // #1542 P3: one extraction call → concrete action buttons (act|sid|n) named after
    // what the answer actually proposes. null = LLM unavailable → legacy plan/menu path.
    const extracted = activeSessionId && process.env.ANSWER_ACTIONS !== '0'
      ? await answerActions.extractAnswerActions(result, secrets.OPENROUTER_API_KEY)
      : null;
    if (extracted) {
      finalMarkup = extracted.actions.length
        ? answerActions.actionsMarkup(activeSessionId, extracted.actions)
        : actionButtons(activeSessionId, { deep: finalDeep });
      buttonReason = extracted.actions.length ? `actions:${extracted.kind}` : 'none';
    } else if (activeSessionId) {
      const hasPlan = await detectPlanInAnswer(result, secrets.OPENROUTER_API_KEY);
      if (hasPlan) {
        finalMarkup = { inline_keyboard: [[{ text: '▶️ Действуй дальше по плану', callback_data: `plan|${activeSessionId}` }]] };
        buttonReason = 'plan';
      } else {
        const menuLabels = await detectMenuInAnswer(result, secrets.OPENROUTER_API_KEY);
        finalMarkup = menuLabels
          ? { inline_keyboard: menuLabels.map((label, idx) => [{ text: `${idx + 1}. ${label}`.slice(0, 60), callback_data: `menu|${activeSessionId}|${idx}` }]) }
          : actionButtons(activeSessionId, { deep: finalDeep });
        buttonReason = menuLabels ? 'menu' : 'none';
      }
    } else {
      finalMarkup = actionButtons(activeSessionId, { deep: finalDeep });
      buttonReason = 'no-session';
    }
  }
  if (initialMsgId && !internalGtd) {
    finalMarkup ||= { inline_keyboard: [] };
    finalMarkup.inline_keyboard.push(...inputInspectionRows(initialMsgId, activeSessionId));
  }
  const finalExtra = { reply_markup: finalMarkup || { inline_keyboard: [] } };

  // Retro-checkable audit trail (2026-09-15): раньше "была ли кнопка на самом деле
  // в сообщении X" нельзя было проверить постфактум — reply_markup нигде не логировался.
  // Одна строка на каждый исходящий ответ: session/причина/что реально прикреплено.
  const buttonLabels = (finalMarkup?.inline_keyboard || []).flat().map(b => b.text);
  console.log(`[buttons] session=${activeSessionId || '-'} internalGtd=${internalGtd} reason=${buttonReason} textLen=${final.length} attached=${JSON.stringify(buttonLabels)}`);

  // Preserve interrupted progress for continuation, distinctly from the user-facing status.
  if (incomplete && activeSessionId && fullOutput.text.trim()) {
    sessions.appendReply(user.workDir, activeSessionId, `[Незавершённый ход; промежуточный текст, не итог]\n${fullOutput.text.trim()}`);
  }
  {
  // Append assistant reply to session history
  if (activeSessionId) {
    sessions.appendReply(user.workDir, activeSessionId, result);
    setCurrentSessionId(user.workDir, activeSessionId, chatId, audience, threadId);

  }

  // Send result (clear stop button; attach action buttons unless suppressed)
  if (msgId) {
    await tgEdit(BOT_TOKEN, chatId, msgId, `🧠 ${final}`, finalExtra).catch(() =>
      tgSend(BOT_TOKEN, chatId, `🧠 ${final}`, finalExtra, threadId)
    );
  } else {
    await tgSend(BOT_TOKEN, chatId, `🧠 ${final}`, finalExtra, threadId);
  }

  // A completed answer is terminal. Do not classify prose to schedule another
  // paid run or promise a timer. Explicit continuation and durable recovery of
  // interrupted tasks remain separate paths.

  }

  // Update context pin after task (skipped when user ran /context_off)
  const contextDisabled = fs.existsSync(path.join(user.workDir, '.context_disabled'));
  if (!contextDisabled) {
    const card = buildContextCard(user.username, user.workDir, chatId, claudeModel, threadId);
    // Awaited (after the answer is already delivered): the run ends with the card settled,
    // so no card send leaks past the run — every user now has a project card.
    if (card) await updateContextPin(BOT_TOKEN, chatId, user.workDir, card, pinnedMsgId, threadId).catch(() => {});
  }

  // Schedule durable GTD checks after terminal delivery (extracted to
  // scheduleGtdAfterRun for testability). Fire-and-forget: never blocks the reply.
  try {
    scheduleGtdAfterRun({
      internalGtd, activeSessionId, explicitMode, task, secrets,
      workDir: user.workDir, username: user.username, projectDir: user.cwd || null,
      audience: user.audience || 'default', chatId, threadId, runStartedAt,
    });
  } catch (e) { console.warn('[gtd] hook:', e.message); }

  return result;
  } catch (e) {
    _runTaskError = e;
    throw e;
  } finally {
    // Terminal-write safety net (watchdog step 1b): if the journal entry for THIS taskId is
    // still sitting at phase='running', no exit path above already gave it a more specific
    // terminal phase or cleared it (e.g. clearPendingTask on the chat-mismatch guard, or the
    // outer runTask() wrapper's own finally on the common return paths) — write an explicit
    // terminal phase instead of leaving it to rot. Deliberately does NOT delete the file (that
    // would just reproduce today's silent-delete semantics).
    //
    // Skip entirely during a server restart: sessionState.restartInterrupted's `return
    // { deferred: true }` path (above) deliberately LEAVES phase='running' so the next
    // process's resumePendingTasks() picks the task back up — writing 'interrupted' here
    // would not break resumability (isTaskResumable only looks at age, not phase) but would
    // still be wrong/misleading for a path that is not actually a gap, just an intentional
    // handoff. restartShutdown is the same module-level flag runTask()'s own finally already
    // checks for the identical reason (src/runner/index.js runTask()).
    if (!restartShutdown) {
      try {
        const file = path.join(PENDING_DIR, `${taskId}.json`);
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current && current.phase === 'running') {
          savePendingTask(taskId, { phase: _runTaskError !== undefined ? 'error' : 'interrupted' });
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[${taskId}] terminal-phase safety net failed:`, e.message);
      }
    }
  }
}

function interruptForRestart() {
  restartShutdown = true;
  for (const state of activeTimers.values()) {
    state.restartInterrupted = true;
    clearTimeout(state.killTimer);
    try { state.proc?.kill('SIGTERM'); } catch {}
  }
}

module.exports = {
  interruptForRestart, MAX_RESUME_ATTEMPTS, isProviderFault,
  runTask, getQuickAnswer, runQuickAnswer, shouldAttemptQuickAnswer, generateConnectLink, getPendingTasks, clearPendingTask,
  resolveRunSession,
  isTaskRunning, isChatTaskRunning, isSessionRunning, isSessionQueuedFor, stopSessionTask, extendTaskTimeout, stopTask, stopUserTask, killTaskByUsername,
  stopTracesFor, confirmStopped,
  reconcileSoftContinuations,
  // Exported for intent-coverage tests only
  _intents: { HH_MY_VACANCIES_INTENT, HH_FUNNEL_INTENT, HH_RESPONSES_INTENT, HH_ATS_EDITOR_INTENT, HH_REVIEW_PAGE_INTENT, ENGINE_SWITCH_INTENT },
  // Exported for pin-state tests only
  _pin: { updateContextPin, readPinStore, buildContextCard },
  // Exported for time-context tests only
  _time: { currentTimeSection },
  // Exported for final-text-selection tests only
  _final: { pickFinalText, isScratchpadFallback },
  // Exported for oc-footer tests only
  _footer: { formatOcFooter, formatCostFooter },
  // Exported for isSessionRunning tests only — the real Map backing activeTimers
  _activeTimers: activeTimers,
  // Exported for stop-trace tests only — the live-run registry (spec §2а)
  _liveRuns: liveRuns,
  // Exported for isSessionRunning tests only — the real Set of queued sessions
  _queuedSessions: queuedSessions, _queuedByOwner: queuedByOwner, _consumePendingStop: consumePendingStop, _ownerKey: ownerKey,
  // Exported for provider-alternation wiring tests only (unified crash-retry, issue #1132 follow-up)
  // Exported for failure-brain wiring tests only (issue #1175, PR #1179 follow-up)
  _recordFailureAttempt,
  // Exported for GTD scheduling-hook wiring tests only (regression: inline hook
  // referenced an out-of-scope `runThreadId`, silently killing all GTD scheduling)
  _gtd: { scheduleGtdAfterRun },
};
