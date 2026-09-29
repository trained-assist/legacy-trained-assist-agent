// GTD Controller — «get things done»: довести задачу до конца.
//
// НЕ «follow-up» (попробовал — не вышло — напомнил). GTD — про упорство:
// попробовал, попробовал по-другому, попробовал в третий раз — и добился, что
// работа реально доехала (прод/PR/деплой/результат), а не потерялась после
// первой итерации.
//
// ГЕЙТ ЗАПУСКА (см. #501/#502, ручной launch #505): детектор намерения зовётся
// ТОЛЬКО когда пользователь осознанно нажал «⏻ Запустить проработку» (workrun).
// На обычном reply/clarify мы ничего не детектируем — угадывать «довести до
// конца» на каждом ходе дорого и шумно. Гейт живёт в runner (вызов maybeSchedule
// обёрнут в `explicitMode==='deep'`), сам модуль остаётся чистым и тестируемым.
//
// Поток:
//   1. Intent-gate (дешёвая LLM) на завершённом workrun → {wanted, etaMinutes}.
//   2. Если wanted — durable-запись gtd/<sessionId>.json с dueAt.
//   3. Серверный tick: когда now>=dueAt И сессия idle (re-entrancy guard) —
//      переоткрываем ту же сессию с инструкцией «проверь/дожми, issue-first».
//   4. Терминал: итерация сказала done, ИЛИ iterations>=maxIterations
//      (это и есть «попробовал, по-другому, в третий раз» — hard cap на упорство).
//
// Дизайн-принципы (strict owner): durable на диске (переживает краш), отчёт по
// факту с диска, hard cap на самопинг (деньги/циклы), re-entrancy (не плодим
// дубль-claude на общем agent-data), issue-ledger в промпте переоткрытия.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { readTokenValue } = require('./token-value');
const { readCredentialFile } = require('./credential-store');
const { DurableTaskStore } = require('./durable-task-store');
const { criterionIdForItem } = require('./durable-task-plan');
const { durableTaskDbPath, userWorkDir, projectDir: projectDirPath, listProfiles } = require('./data-paths');
const { isBgNotifyEnabled, readBgNotify } = require('./bg-notify');
const { atomicText } = require('./atomic-json');
const { logDefect } = require('./playbook-defects-log');
const { resolveStepExecution, planLevelMap } = require('./playbook-executor');
const { traceIdFor, traceStoppedAt, isUserStoppedReply } = require('./stop-trace');

// Engines this step already failed on with credentials/config — retrying them is
// pointless, the fallback ladder skips them.
const HARD_ENGINE_FAILURES = new Set(['AUTH', 'CONFIG']);

// Pick the first usable rung of [primary, ...fallbacks]: engine not 'unavailable' in
// engine health and not already failed on by this step with AUTH/CONFIG. When the
// primary is unusable the step runs on a fallback rung (claude → codex → opencode
// master for doctor). Nothing usable → primary (it fails and recovery decides).
function pickUsableTarget(store, item, step, engineHealth) {
  const candidates = [
    { engine: step.engine, ocProfile: step.ocProfile, ocRole: step.ocRole },
    ...(Array.isArray(step.fallbacks) ? step.fallbacks : []),
  ];
  if (candidates.length < 2) return step;
  const hardFailed = new Set(store.db.prepare(`SELECT engine FROM executions
      WHERE task_item_id = ? AND engine IS NOT NULL AND error_class IN ('AUTH','CONFIG')`)
    .all(item.id).map(r => r.engine));
  const usable = c => {
    if (hardFailed.has(c.engine)) return false;
    try { return (engineHealth(c.engine) || {}).status !== 'unavailable'; } catch { return true; }
  };
  const idx = candidates.findIndex(usable);
  if (idx <= 0) return step;
  const why = hardFailed.has(step.engine) ? `${step.engine} failed on credentials/config` : `${step.engine} unavailable`;
  return { ...step, ...candidates[idx], degradedFrom: step.engine, degradeReason: why };
}

// Previous failed attempts of this step, oldest first — the next attempt must see
// why they failed (owner: «инфа о провале мега важна»).
function priorFailures(store, item) {
  return store.db.prepare(`SELECT engine, profile, model_level, error_class, error_text FROM executions
      WHERE task_item_id = ? AND status = 'failed' ORDER BY started_at`).all(item.id);
}

// Workspace label shared by every step of a plan (engineering_spawn_workspace is
// idempotent per root_task_id): without it each step invented its own label, so
// every step got its own worktree/branch and earlier steps' files were lost.
function planWorkspaceLabel(task) {
  return `plan-${String(task.id).slice(0, 8)}`;
}

// The session every step of a plan runs in (and resumes into after a restart).
function planSessionId(task) {
  return `s-plan-${String(task.id).slice(0, 8)}`;
}

function parsePolicy(task) {
  try { return task && task.execution_policy_json ? JSON.parse(task.execution_policy_json) : null; }
  catch { return null; }
}
const { executeHooks, parseHooks, resolveHookApproval } = require('./playbook-hooks');
const { recoverDurableItem, retryFailedItem } = require('./durable-recovery');
const fanout = require('./playbook-fanout');
const {
  evaluateItemValidationsModeAware, evaluateItemValidations, resolveValidationMode, getDefaultRegistry, DEFAULT_VALIDATION_MODE,
  parseValidation, FASTPASS_SKIP_MODE, parseFastpassSkip, checkRunsGreen,
} = require('./playbook-validators');
const {
  parseWait, isActiveWait, startWait, decidePoll, nextDueAt, summarizeResults, resumeNote,
} = require('./durable-wait');

// ── Разумные дефолты (небольшие, но осмысленные) ────────────────────────────
const DEFAULT_ETA_MIN = 60;   // через сколько минут после завершения проверить
const ETA_MIN_CLAMP   = 20;   // < этого — дребезг, пинг раньше, чем что-то доедет
const ETA_MAX_CLAMP   = 180;  // > этого — уже не «доведение», а отдельная задача
const DEFAULT_MAX_ITERATIONS = 3;   // hard cap на упорство (попробовал ×3 → стоп), без checklist.md
const CHECKLIST_MAX_ITERATIONS = 25; // hard ceiling даже для длинного чек-листа (деньги/циклы)
const INTENT_MODEL = process.env.GTD_INTENT_MODEL || 'google/gemini-2.5-flash';
const MAX_FIRES_PER_TICK = 3;  // не будим весь профиль-парк разом

// Fire-lease: когда tick стреляет сессию, runTask НЕ ожидается (loop идёт дальше),
// а dueAt переносится в .then()/settleResumedGtd только ПОСЛЕ завершения run'а —
// который легитимно длится десятки минут. Всё это время у записи dueAt<=now, и
// единственное, что удерживает её от повторного выстрела на каждом 5-мин тике —
// isSessionRunning. Но isSessionRunning возвращает false, если процесс убит между
// выстрелом и завершением (systemd KillMode=control-group рестартит нас в любой
// момент): исходный .then() умирает вместе с процессом, а pending-task journal мог
// быть уже очищен (runTask чистит его в finally) — тогда запись с dueAt<=now
// «хаммерится» каждый тик заново. Поэтому при выстреле СРАЗУ двигаем dueAt на
// FIRE_LEASE_MS вперёд: живой run успеет отчитаться раньше (и перепишет dueAt по
// факту), а потерянный — честно перезапустится через лизинг, не раньше и не позже.
const FIRE_LEASE_MS = 45 * 60 * 1000; // > CLAUDE_TIMEOUT_MS (40м); переживший run перепишет dueAt сам

// Guard против перекрытия тиков: runDue асинхронна и awaits GitHub-пречеки
// (до ~20с на запись). Если сеть тормозит, тик может не успеть завершиться до
// следующего setInterval-тика — два параллельных прохода прочитают один и тот же
// due-набор, оба увидят isSessionRunning=false (никто ещё не выстрелил) и
// продублируют выстрел. Модульный флаг сериализует проходы: пока один идёт,
// следующий тик — no-op (лог), запись подождёт своей очереди на следующем тике.
let _tickInFlight = false;
// Delivery secrets for the background step notices (owner 29.09). Set per pass by
// runDueDurable: reconcileOrphanedRunning runs synchronously inside
// claimNextDurableItem and cannot take them as an argument. null = no send.
let _bgSecrets = null;

// Heartbeat (issue #512 pt.3): the tick lives inside an in-process setInterval
// (server.js scheduleGtdController) — if it ever silently stopped firing
// (unhandled state outside the try/catch, event loop wedged), open records
// would sit forever with no external signal. This makes "when did the tick
// last actually run" observable via GET /internal/gtd-status instead of
// requiring someone to notice a stuck checklist by hand.
let _tickHeartbeat = { lastStartAt: null, lastFinishAt: null, lastDurationMs: null, lastError: null, tickCount: 0 };
function tickHeartbeat() { return { ..._tickHeartbeat }; }

// Cheap backlog counters for the heartbeat endpoint — no LLM/network, just what's on disk/in the DB.
function countOpenLegacy(baseUsersDir) {
  const users = listProfiles(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u));
  let open = 0;
  for (const username of users) {
    open += listGtd(path.join(baseUsersDir, username)).filter(r => r && r.status === 'open').length;
  }
  return { open, profiles: users.length };
}

function durableItemCounts(store = durableStore()) {
  const out = { pending: 0, waiting: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of store.db.prepare('SELECT status, COUNT(*) as n FROM task_items GROUP BY status').all()) {
    out[row.status] = row.n;
  }
  return out;
}

const GTD_DIR = 'gtd';
const CHECKLIST_FILE = 'checklist.md';
const TOKENS_ROOT = process.env.AGENT_TOKENS_ROOT || path.join(os.homedir(), 'agent-tokens');

// ── Durable-task scheduler wiring (Slice A, issue #1201) ────────────────────
// The SQLite DurableTaskStore is the source of truth for durable tasks; this
// slice makes the GTD tick EXECUTE its runnable items. Legacy gtd/*.json
// records keep flowing through the file-based path unchanged — both sources
// feed the same fire pipeline, migration of old records is deliberately last
// (spec §"не делать большой rewrite GTD одновременно").
//
// Shared singleton: MCP tools (101-durable-tasks.js) open the same DB file —
// better-sqlite3 with WAL handles multi-connection readers/writers on one
// process, and busy_timeout (5s) covers the rare write overlap. Reusing one
// instance per process avoids duplicating the open-migration cost.
let _durableStore = null;
function durableStore() {
  if (!_durableStore) _durableStore = new DurableTaskStore(durableTaskDbPath());
  return _durableStore;
}

// Items left status='running' by a crash/restart would never be claimed again
// (claimNextRunnable only selects pending/waiting) — the classic reboot gap.
// Called once per tick before claiming: orphaned runs older than the fire
// lease go back to pending with due_at=now, so the next claim re-executes them.
// Fresher orphans stay running (their run may still be alive in this process).
const RUNNING_ORPHAN_GRACE_MS = 45 * 60 * 1000; // mirrors FIRE_LEASE_MS
// `graceMs: 0` is the boot-time sweep: right after a (re)start no durable step can
// still be running — its engine was a child of the previous process — so every
// 'running' item is an orphan and goes back to the queue now, not after the
// 45-min grace. Its open execution rows are closed as interrupted.
function reconcileOrphanedRunning(store = durableStore(), { now = Date.now(), graceMs = RUNNING_ORPHAN_GRACE_MS, exceptItemIds = null } = {}) {
  const rows = store.db.prepare(`SELECT i.id, i.updated_at, i.title, t.profile_id, t.goal
    FROM task_items i
    JOIN durable_tasks t ON t.id = i.task_id
    WHERE i.status = 'running' AND t.status = 'active'`).all();
  const cutoff = now - graceMs;
  const except = exceptItemIds instanceof Set ? exceptItemIds : new Set(exceptItemIds || []);
  for (const row of rows) {
    if ((row.updated_at || 0) > cutoff) continue;
    if (except.has(row.id)) continue; // being resumed in its own engine session (#1671)
    store.updateTaskItem(row.id, { status: 'pending', due_at: now },
      store.db.prepare('SELECT profile_id FROM durable_tasks WHERE id = ?').get(
        store.db.prepare('SELECT task_id FROM task_items WHERE id = ?').get(row.id).task_id
      ).profile_id);
    if (graceMs === 0) {
      store.db.prepare(`UPDATE executions SET status = 'interrupted', finished_at = ?,
          error_text = 'interrupted by server restart' WHERE task_item_id = ? AND status = 'running'`)
        .run(now, row.id);
    }
    // Owner 29.09: «если что-то прервалось — тоже прервалось». A step cut off by a
    // restart is exactly the silence he is worried about, so say it out loud.
    void bgNotice(_bgSecrets, { profile_id: row.profile_id, goal: row.goal },
      `🔁 Прервано рестартом: шаг «${String(row.title || '').replace(/\s+/g, ' ').slice(0, 80)}» вернулся в очередь`);
  }
  return rows.filter(r => (r.updated_at || 0) <= cutoff && !except.has(r.id)).length;
}

// Profile ids that own runnable items right now, mapped to their claimable
// items. Legacy GTD scans per-profile directories; the store is profile-keyed,
// so we invert: claim globally, then resolve the profile per item.
function claimNextDurableItem(store = durableStore(), { now = Date.now() } = {}) {
  // Expired waiters must fail BEFORE reconcile/claim can hand them out again —
  // otherwise a 'waiting' step whose deadline passed defers forever.
  store.expireWaitingDeadlines(now);
  reconcileOrphanedRunning(store, { now });
  // Thread the injected tick time through so due_at selection is deterministic.
  return store.claimNextRunnable(now);
}


const FRESH_CLAIM_GRACE_MS = 30 * 1000; // just-claimed items: let the claiming tick run them

// The per-step attempt budget (P3a) and the recovery-policy ladder (P3c) both
// live in src/durable-recovery.js now — every failure branch below classifies the
// error, asks recovery-policy.js what to do, and maps that onto an existing
// mechanism (re-pend / model-level bump / engine fallback), bounded
// by max_attempts and DEFAULT_RECOVERY_BUDGET.

// Evaluate an item's declared validations through the registry and persist each
// verdict as a task_validation_results row (profile-scoped). Returns the raw
// results so the caller can decide complete vs fail. A validator that throws is
// recorded as inconclusive — a broken check must not look like a pass.
// `validationMode` (P3d-1b) selects whether an inconclusive deterministic verdict
// may be decided by the injectable cheap LLM validator.
async function recordItemValidations(store, { task, item, executionId, registry, projectDir, validationMode = DEFAULT_VALIDATION_MODE, llmValidate = null, planText = null, reply = null }) {
  let results;
  try {
    results = await evaluateItemValidationsModeAware(item, {
      task, profileId: task.profile_id, projectDir, registry, mode: validationMode, llmValidate, planText, reply,
    });
  } catch (e) {
    results = [{ key: '*', status: 'inconclusive', subject: null, evidence: { reason: 'evaluator-error', error: e.message } }];
  }
  for (const r of results) {
    try {
      store.recordValidation({
        task_id: task.id, profile_id: task.profile_id, task_item_id: item.id, execution_id: executionId,
        criterion_id: criterionIdForItem(task, item, r.key),
        contract_revision: task.contract_revision || 1,
        validator: r.key, status: r.status,
        subject_json: r.subject == null ? null : JSON.stringify(r.subject),
        evidence_json: r.evidence == null ? null : JSON.stringify(r.evidence),
      });
    } catch (e) {
      console.error(`[gtd-durable] recordValidation ${item.id.slice(0, 8)} ${r.key}:`, e.message);
    }
  }
  return results;
}

// P3d-1c: the explicit fast-pass escape. Under `programmatic+llm-fastpass` a step
// may bypass its validations when the full check is too heavy / is breaking
// something / an urgent fix is needed. The bypass is never silent: every declared
// validation is still written to `task_validation_results` — status 'pass' but
// evidence carrying {skipped:true, reason, mode} — so the audit trail shows the
// skipped check. A step with no declared validation still gets one row so the
// bypass itself is recorded. Deterministic validators ARE skippable here: the
// point of the escape is to unblock, and the recorded reason (not a hidden fail)
// is what keeps it honest. Only the agent (non-programmatic) path can skip — a
// programmatic step has no model to decide.
function recordStepException(store, { task, item, executionId, reason }) {
  const keys = Object.keys(parseValidation(item && item.validation_json != null ? item.validation_json : item && item.validation));
  for (const key of keys.length ? keys : ['exception']) {
    try {
      store.recordValidation({
        task_id: task.id, profile_id: task.profile_id, task_item_id: item.id, execution_id: executionId,
        criterion_id: criterionIdForItem(task, item, key), contract_revision: task.contract_revision || 1,
        validator: key, status: 'pass', subject_json: JSON.stringify({ key }),
        evidence_json: JSON.stringify({ exception: true, reason }),
      });
    } catch (e) { console.error(`[gtd-durable] recordStepException ${item.id.slice(0, 8)} ${key}:`, e.message); }
  }
}

function recordFastpassSkip(store, { task, item, executionId, reason }) {
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const keys = Object.keys(parseValidation(raw));
  const validators = keys.length ? keys : ['fastpass-skip'];
  for (const key of validators) {
    try {
      store.recordValidation({
        task_id: task.id, profile_id: task.profile_id, task_item_id: item.id, execution_id: executionId,
        criterion_id: criterionIdForItem(task, item, key),
        contract_revision: task.contract_revision || 1,
        validator: key, status: 'pass',
        subject_json: JSON.stringify({ key }),
        evidence_json: JSON.stringify({ skipped: true, reason, mode: FASTPASS_SKIP_MODE }),
      });
    } catch (e) {
      console.error(`[gtd-durable] recordFastpassSkip ${item.id.slice(0, 8)} ${key}:`, e.message);
    }
  }
  return validators;
}

// All items finished → close the task. Legacy (non-contract) tasks close by
// fiat; a contract plan must pass the P3d-2 finalization gate: every declared
// validation needs a matching 'pass' row (fast-pass skips are stored as pass).
// Returns 'done' only when this call actually settled the task, so task_done
// hooks fire on the transition (the hook log is also fire-once keyed).
// Soft finalization (owner 2026-09-28): 🔴 deterministic checks (a registered
// validator — PR opened, CI green, merged, command/HTTP/file probes…) block 'done';
// 🟡 semantic checks (judged by the LLM) do not — they are logged as defects so the
// checklist can be improved from real runs. execution_policy.finalization = 'strict'
// restores the old gate (every check blocks).
function isBlockingCheck(key) {
  return Object.hasOwn(getDefaultRegistry(), key);
}

function settleTaskCompletion(store, task) {
  const progress = store.progressSummary(task.id, task.profile_id);
  if (!(progress.total > 0 && progress.finished >= progress.total)) return null;
  if (!task.acceptance_criteria_json) {
    store.completeTask(task.id, task.profile_id, 'done');
    console.log(`[gtd-durable] task complete: ${task.id.slice(0, 8)}`);
    return 'done';
  }
  const strict = (parsePolicy(task) || {}).finalization === 'strict';
  const res = store.finalizePlan(task.id, task.profile_id, { blocking: strict ? null : isBlockingCheck });
  const fmt = list => (list || []).map(m => `${m.validator}=${m.got == null ? 'missing' : m.got}`).join(', ');
  const base = { profile_id: task.profile_id, task_id: task.id, playbook: task.playbook_id || null };
  if (res.finalized) {
    for (const m of res.unconfirmed || []) logDefect({ ...base, kind: 'unconfirmed', validator: m.validator, criterion_id: m.criterion_id, got: m.got });
    console.log(`[gtd-durable] task complete: ${task.id.slice(0, 8)}${(res.unconfirmed || []).length ? ` — 🟡 unconfirmed: ${fmt(res.unconfirmed)}` : ''}`);
    return 'done';
  }
  // Never a silent stall: all steps finished but a red check is unmet → blocked, logged.
  const reason = `finalization blocked — unmet checks: ${fmt(res.missing)}`;
  if (task.status !== 'blocked') {
    try { store.updateTask(task.id, task.profile_id, { status: 'blocked' }); } catch { /* status enum */ }
    try { store.db.prepare('UPDATE durable_tasks SET blocker_reason = ? WHERE id = ?').run(reason.slice(0, 1000), task.id); } catch { /* column */ }
    for (const m of res.missing || []) logDefect({ ...base, kind: 'blocked', validator: m.validator, criterion_id: m.criterion_id, got: m.got });
  }
  console.warn(`[gtd-durable] ${task.id.slice(0, 8)} ${reason}`);
  return 'blocked';
}

// ── Playbook hook execution (P4, #1459) ─────────────────────────────────────
// Hooks fire at plan boundaries: stage.on_enter (first item of a stage),
// step.on_complete/on_fail, stage.on_exit (last item of a stage) and the
// task-level task_done/task_failed. The boundary identity is (task, item, event,
// hook index) and the store records each firing once, so a tick replay never
// double-delivers. External-effect hooks need consent; without it they are
// recorded skipped and the task is unaffected (a notification is not part of the
// work's acceptance criteria).

// Owner chat for a notify hook: the profile's session attached to the task, or
// the last chat the profile talked from. Audience-aware delivery picks the bot.
function resolveOwnerTarget(store, task) {
  try {
    for (const s of store.listSessions(task.id, task.profile_id)) {
      const sess = require('./session-store').getSession(userWorkDir(task.profile_id), s.session_id);
      const chatId = sess ? (sess.liveChatId ?? sess.ownerChatId) : null;
      if (chatId != null) return { chatId, audience: sess.audience || 'default', threadId: sess.threadId || null };
    }
  } catch { /* fall through to .chatid */ }
  try {
    const c = fs.readFileSync(path.join(TOKENS_ROOT, String(task.profile_id), '.chatid'), 'utf8').trim();
    if (c) return { chatId: c, audience: 'default', threadId: null };
  } catch { /* no chat on record */ }
  return null;
}

// ── Background step notifications (owner 29.09) ─────────────────────────────
// Unlike a plan's `notify` hook (declared per plan, needs consent) this is a
// standing per-profile preference: «шаг начат / шаг готов / прервано», so the
// owner can watch the playbooks run instead of wondering whether the executor
// died. Off by default — no flag means no send; a failed send never fails a step.
async function bgNotice(secrets, task, text) {
  try {
    if (!task?.profile_id || !isBgNotifyEnabled(task.profile_id)) return { sent: false, reason: 'disabled' };
    const flag = readBgNotify(task.profile_id) || {};
    const owner = resolveOwnerTarget(durableStore(), task);
    const target = flag.chatId != null
      ? { chatId: flag.chatId, audience: flag.audience || owner?.audience || 'default', threadId: flag.threadId ?? owner?.threadId ?? null }
      : owner;
    if (!target) return { sent: false, reason: 'no_chat_id' };
    const routeSecrets = require('./bot-delivery').deliverySecrets(secrets || {}, target.audience || 'default');
    const token = routeSecrets?.TELEGRAM_BOT_TOKEN || routeSecrets?.BOT_TOKEN;
    if (!token) return { sent: false, reason: 'no_bot_token' };
    await _tgNotify(token, target.chatId, String(text), target.threadId || null);
    return { sent: true };
  } catch (e) {
    console.warn('[gtd] bg-notify:', e.message);
    return { sent: false, reason: e.message };
  }
}

// Short name of a plan for step notices. Several plans stream into one chat, and
// every playbook plan has the same step titles — without the plan's name «Шаг 1/15»
// of plan A right after «Шаг 2/15» of plan B reads as one plan looping. The name is
// the head of the goal: up to the first « — », «. » or newline, capped at 60 chars.
function planLabel(goal) {
  let s = String(goal || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  s = s.split(/ — | - |\. /)[0].trim();
  if (s.length > 60) s = `${s.slice(0, 59).replace(/\s+\S*$/, '')}…`;
  return s;
}

function bgStepText(task, item, kind, total, detail = '') {
  const title = String(item?.title || '').replace(/\s+/g, ' ').slice(0, 80);
  const label = planLabel(task?.goal);
  const head = `${kind} (шаг ${Number(item?.position ?? 0) + 1}/${total}): ${title}`
    + (label ? `\nПлан: ${label}` : '');
  return detail ? `${head}\n${String(detail).slice(0, 240)}` : head;
}

async function bgStep(secrets, task, item, kind, detail = '') {
  try {
    if (!task?.profile_id || !isBgNotifyEnabled(task.profile_id)) return;
    let total = '?';
    try { total = durableStore().progressSummary(task.id, task.profile_id).total; } catch { /* legacy row */ }
    await bgNotice(secrets, task, bgStepText(task, item, kind, total, detail));
  } catch (e) { console.warn('[gtd] bg-notify:', e.message); }
}

async function bgTask(secrets, task, kind, detail = '') {
  try {
    if (!task?.profile_id || !isBgNotifyEnabled(task.profile_id)) return;
    const goal = String(task.goal || '').replace(/\s+/g, ' ').slice(0, 160);
    await bgNotice(secrets, task, detail ? `${kind}: ${goal}\n${String(detail).slice(0, 240)}` : `${kind}: ${goal}`);
  } catch (e) { console.warn('[gtd] bg-notify:', e.message); }
}

// First step failure of a plan (#1725 root 4). A plan launched from chat used to go
// silent until the step's budget ran out (task_failed after the 3rd attempt), so the
// owner never learned the executor was stuck. This is the default, not the opt-in
// stream above: ONE message per plan, on the first failed attempt of any step.
//   - bg-notify configured → skip: enabled=true already streams every failure,
//     enabled=false is an explicit «не пиши мне».
//   - child plan of a batch → skip: the fanout supervisor reports its children.
//   - once per plan: the hook ledger's unique boundary_key is claimed BEFORE the
//     send (at-most-once — a crash or a concurrent settle can never double-send).
// `send` is injectable for tests; a failed send never fails the step.
async function firstFailureNotice(secrets, store, task, item, detail = '', { send = null, readFlag = readBgNotify } = {}) {
  try {
    if (!task?.id || !task.profile_id) return { sent: false, reason: 'no_task' };
    if (task.parent_task_id) return { sent: false, reason: 'batch_child' };
    if (readFlag(task.profile_id)) return { sent: false, reason: 'bg_notify_configured' };
    const boundary_key = `${task.id}:first-step-failure`;
    if (store.hasHookRun(boundary_key)) return { sent: false, reason: 'already_sent' };
    const target = resolveOwnerTarget(store, task);
    if (!target) return { sent: false, reason: 'no_chat_id' };
    const routeSecrets = require('./bot-delivery').deliverySecrets(secrets || {}, target.audience || 'default');
    const token = routeSecrets?.TELEGRAM_BOT_TOKEN || routeSecrets?.BOT_TOKEN;
    if (!send && !token) return { sent: false, reason: 'no_bot_token' };
    const claim = store.recordHookExecution({
      task_id: task.id, task_item_id: item?.id || null, event: 'first_step_failure', hook_index: 0,
      hook_type: 'notify', status: 'fired', detail: String(detail || '').slice(0, 500), boundary_key,
    });
    if (!claim.recorded) return { sent: false, reason: 'already_sent' };
    let total = '?';
    try { total = store.progressSummary(task.id, task.profile_id).total; } catch { /* legacy row */ }
    const goal = String(task.goal || '').replace(/\s+/g, ' ').slice(0, 120);
    const title = String(item?.title || '').replace(/\s+/g, ' ').slice(0, 80);
    const fresh = item?.id ? store.getTaskItem(item.id) : null;
    const tries = fresh && fresh.max_attempts ? ` (попытка ${fresh.attempt_count}/${fresh.max_attempts})` : '';
    const retry = fresh && fresh.status === 'failed'
      ? 'Попытки исчерпаны — план остановлен на этом шаге.'
      : 'Исполнитель повторит сам; следующие сбои этого плана сюда не пишу.';
    const why = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const text = `⚠️ План «${goal}»: шаг ${Number(item?.position ?? 0) + 1}/${total} «${title}» не удался${tries}.\n` +
      (why ? `Причина: ${why}\n` : '') + retry;
    await (send || ((t) => _tgNotify(token, target.chatId, t, target.threadId || null)))(text, target);
    return { sent: true, text };
  } catch (e) {
    console.warn('[gtd] first-failure notice:', e.message);
    return { sent: false, reason: e.message };
  }
}

// Default sinks. `notify` reuses the audience-aware bot delivery; check /
// create_issue / publish only run when a caller injects a sink (this slice does
// not reimplement GitHub/publish orchestration — no transport configured means
// the hook is recorded skipped, never faked).
function defaultHookSinks({ secrets = {}, store, task }) {
  return {
    notify: async ({ text }) => {
      const target = resolveOwnerTarget(store, task);
      if (!target) throw new Error('no owner chat for notification');
      const routeSecrets = require('./bot-delivery').deliverySecrets(secrets, target.audience);
      const token = routeSecrets?.TELEGRAM_BOT_TOKEN || routeSecrets?.BOT_TOKEN;
      if (!token) throw new Error('no telegram token for notification');
      await _tgNotify(token, target.chatId, text, target.threadId);
    },
  };
}

// Batch notifications (#1752) go to the chat that launched the batch (recorded on
// the batch), else to the plan owner's chat. Failures/pauses are always delivered.
function ownerNotifier(store, task, secrets, state) {
  return async (text) => {
    const target = (state && state.owner && state.owner.chatId != null) ? state.owner : resolveOwnerTarget(store, task);
    if (!target) throw new Error('no owner chat for notification');
    const routeSecrets = require('./bot-delivery').deliverySecrets(secrets, target.audience || 'default');
    const token = routeSecrets?.TELEGRAM_BOT_TOKEN || routeSecrets?.BOT_TOKEN;
    if (!token) throw new Error('no telegram token for notification');
    await _tgNotify(token, target.chatId, text, target.threadId || null);
  };
}

async function fireItemHooks(store, task, item, event, vars, sinks, approved) {
  const hooks = parseHooks(item && item.hooks_json)[event];
  if (!Array.isArray(hooks) || !hooks.length) return [];
  try {
    return await executeHooks({ store, task, item, event, hooks, vars, approved, sinks });
  } catch (error) {
    console.error(`[gtd-durable] hook ${event} task=${task.id.slice(0, 8)}:`, error.message);
    return [];
  }
}

async function fireTaskHooks(store, task, event, vars, sinks, approved) {
  const hooks = parseHooks(task && task.hooks_json)[event];
  if (!Array.isArray(hooks) || !hooks.length) return [];
  try {
    return await executeHooks({ store, task, event, hooks, vars, approved, sinks });
  } catch (error) {
    console.error(`[gtd-durable] hook ${event} task=${task.id.slice(0, 8)}:`, error.message);
    return [];
  }
}

// Fire a claimed durable item through the same pipeline as legacy GTD fires.
// Contract plans are executable once explicitly activated (P3a: draft→active via
// task_update); they stay unclaimable while draft. The step honors the item's
// own max_attempts / execution_timeout_seconds. delay_after_sec / wait_deadline_at
// shape when the store hands the item out (see durable-task-store.completeItem /
// expireWaitingDeadlines).
// Evidence text of the plan's earlier steps — how a later check finds what an
// earlier step produced (the PR URL "Open PR" printed, for "Wait for CI").
const PLAN_TEXT_MAX_CHARS = 20_000;
function planEvidenceText(store, task, item) {
  try {
    return store.listTaskItems(task.id, task.profile_id)
      .filter(i => i.position < item.position && i.evidence_json)
      .map(i => i.evidence_json)
      .join('\n')
      .slice(-PLAN_TEXT_MAX_CHARS);
  } catch { return ''; }
}

// Every step is a fresh run with no memory of the plan. Hand it a compact digest
// of what earlier steps reported (their replies end with an ИТОГ ШАГА block), the
// most recent steps first-class, so step 9 knows the issue/PR/decisions of 1–8.
const DIGEST_PER_STEP_CHARS = 900;
const DIGEST_TOTAL_CHARS = 7000;
function priorStepsDigest(store, task, item) {
  let rows;
  try {
    rows = store.listTaskItems(task.id, task.profile_id)
      .filter(i => i.position < item.position && (i.status === 'done' || i.status === 'skipped'));
  } catch { return ''; }
  if (!rows.length) return '';
  const parts = [];
  let total = 0;
  for (const i of rows.slice().reverse()) {
    let text = '';
    try {
      const ev = JSON.parse(i.evidence_json || '{}');
      if (typeof ev.reply === 'string') text = ev.reply;
      else if (Array.isArray(ev.validations)) text = ev.validations.map(v => `${v.key}=${v.status}`).join(', ');
    } catch { text = ''; }
    const marker = text.lastIndexOf('ИТОГ ШАГА');
    text = (marker >= 0 ? text.slice(marker) : text.slice(-DIGEST_PER_STEP_CHARS)).replace(/DURABLE:\s*\w+.*$/gim, '').trim();
    const line = `${i.position + 1}. ${i.title}${text ? `\n${text.slice(0, DIGEST_PER_STEP_CHARS)}` : ''}`;
    if (total + line.length > DIGEST_TOTAL_CHARS) { parts.push(`… (ещё ${rows.length - parts.length} шаг(ов) раньше — task_get)`); break; }
    parts.push(line);
    total += line.length;
  }
  return ['[ИТОГИ ПРЕДЫДУЩИХ ШАГОВ ПЛАНА — от последнего к первому]', ...parts].join('\n\n');
}

// Durable wait poll (src/durable-wait.js). Runs BEFORE an execution is started,
// so a poll never counts as an attempt or a fire. Returns:
//   'parked' — still waiting, the item is back to `waiting` with its next due_at;
//   'proceed' — the wait resolved; fall through to the normal step execution
//               (a programmatic step re-checks + completes, an agent step re-runs
//               with a resume note built from the resolved wait).
async function pollDurableWait(store, { task, item, wait, now, registry, projectDir, planText }) {
  const w = startWait(wait, now);
  let results = null;
  const condition = w.then === 'complete' ? parseValidation(item.validation_json) : w.until;
  if (condition && Object.keys(condition).length && !w.woken_at) {
    try {
      // Deterministic only: a poll must never ask an LLM "is CI green yet?".
      results = await evaluateItemValidations({ validation: condition, title: item.title, instructions: item.instructions, evidence_json: item.evidence_json },
        { task, profileId: task.profile_id, projectDir, registry, planText });
    } catch (e) {
      results = [{ key: '*', status: 'inconclusive', evidence: { reason: 'evaluator-error', error: e.message } }];
    }
  }
  let decision = decidePoll(w, results, now);
  // A programmatic wait woken by someone just means "look again now".
  if (w.then === 'complete' && decision === 'woken') {
    const { woken_at, woken_by, wake_message, ...rest } = w;
    store.parkItem(item.id, task.profile_id, { wait: { ...rest, last_poll_at: now }, dueAt: now });
    return 'parked';
  }
  if (decision === 'keep') {
    const polled = { ...w, last_poll_at: now, last_poll: results ? summarizeResults(results) : null };
    const pending = results ? results.filter(r => r.status !== 'pass').map(r => `${r.key}=${r.status}`).join(', ') : 'timer/user';
    store.parkItem(item.id, task.profile_id, { wait: polled, dueAt: nextDueAt(polled, now), lastError: `waiting: ${pending}` });
    return 'parked';
  }
  if (w.then === 'complete') {
    // satisfied → the normal programmatic path re-checks and completes the step
    // (the wait stays active, so a flake there simply resumes waiting on retry);
    // timeout / final fail → mark resolved so the failure path runs: recovery
    // budget, then on_fail/task_failed hooks tell the owner.
    if (decision === 'timeout' || decision === 'failed') {
      store.setItemWait(item.id, task.profile_id, { ...w, resolved: decision, resolved_at: now, resolve_evidence: results ? summarizeResults(results) : null });
      console.log(`[gtd-durable] wait ${decision} ${item.id.slice(0, 8)}`);
    }
    return 'proceed';
  }
  store.setItemWait(item.id, task.profile_id, {
    ...w, resolved: decision, resolved_at: now,
    resolve_evidence: results ? summarizeResults(results) : null,
  });
  console.log(`[gtd-durable] wait resolved ${item.id.slice(0, 8)}: ${decision}`);
  return 'proceed';
}

// The last DURABLE marker wins — a reply may quote an earlier marker in prose.
function lastDurableMarker(said) {
  const all = [...String(said || '').matchAll(/DURABLE:\s*(done|failed|waiting)/gi)];
  return all.length ? all[all.length - 1][1].toLowerCase() : null;
}

async function runDueDurable({ secrets, runTask, isTaskRunning, now = Date.now(), maxFires = MAX_FIRES_PER_TICK, registry = null, llmValidate = null, classifier = null, hookSinks = null, approveHooks = null, engineHealth = null }) {
  const healthOf = engineHealth || (engine => require('./engine-health').getEngineHealth(engine));
  const store = durableStore();
  _bgSecrets = secrets; // background step notices need the route inside reconcile()
  const validators = registry || getDefaultRegistry();
  // A programmatic step that fails is retried synchronously inside this pass
  // (no engine round-trip). Its re-pended due_at lands in the same tick, so
  // without this guard claimNextRunnable could hand it straight back and
  // double-fire it. Items fired as agent runs are 'running' and never re-claimed.
  const claimedThisPass = new Set();
  // `fired` = steps handled (the return value); `slotsUsed` = agent runs started —
  // only those take an engine slot, so only they count against `maxFires` (#1752).
  let fired = 0;
  let slotsUsed = 0;
  for (;;) {
    const item = claimNextDurableItem(store, { now });
    if (!item) return fired;
    const task = store.db.prepare('SELECT * FROM durable_tasks WHERE id = ?').get(item.task_id);
    if (!task) { store.failItem(item.id, '__system__', { error: 'task vanished' }); continue; }
    // P4: per-task consent for external-effect hooks + the sink transport.
    const hooksApproved = resolveHookApproval(task, approveHooks);
    const sinks = hookSinks || defaultHookSinks({ secrets, store, task });
    const hookVars = (extra = {}) => ({ goal: task.goal, stage: item.stage ?? null, error: null, ...extra });
    // P3d-1b/1c: per-step > per-plan policy > env > default programmatic+llm.
    const validationMode = resolveValidationMode({ task, item });
    if (claimedThisPass.has(item.id)) {
      // Past this pass's own clock too (an injected/time-travelled `now` must not
      // hand the same item straight back → endless pass).
      store.updateTaskItem(item.id, { status: 'waiting', due_at: Math.max(now, Date.now()) + FRESH_CLAIM_GRACE_MS }, task.profile_id);
      continue;
    }
    claimedThisPass.add(item.id);

    // Re-entrancy: a live session for this task must not be double-fired.
    const sessionRow = store.db.prepare(
      'SELECT session_id FROM task_sessions WHERE task_id = ? AND active = 1').get(task.id);
    if (sessionRow && isTaskRunning(null, sessionRow.session_id)) {
      // release the claim — put back to waiting with a short re-try delay
      store.updateTaskItem(item.id, { status: 'waiting', due_at: now + FRESH_CLAIM_GRACE_MS }, task.profile_id);
      continue;
    }

    // Fanout (#1752): advance the batch (observe children, supervisor, spawn). Not a
    // fire — no slot, no attempt. Joined → fall through so the programmatic path
    // records `fanout_joined` and completes the step like any other.
    if (item.fanout_json) {
      let adv = null;
      try {
        adv = await fanout.advanceFanout(store, { task, item, now, notify: ownerNotifier(store, task, secrets, fanout.parseFanout(item)) });
      } catch (e) { console.error(`[gtd-durable] fanout ${item.id.slice(0, 8)}:`, e.message); }
      if (!adv || !adv.joined) {
        store.updateTaskItem(item.id, { status: 'waiting', due_at: now + fanout.DEFAULT_POLL_MS }, task.profile_id);
        if (adv && (adv.spawned || adv.events.length)) console.log(`[gtd-durable] fanout ${item.id.slice(0, 8)}: spawned=${adv.spawned} events=${adv.events.map(e => `${e.key}:${e.type}→${e.action}`).join(',') || '-'}`);
        if (adv && adv.spawned) kickDurable();
        continue;
      }
    }
    // A stage that touches a shared external resource runs in one sibling at a time.
    if (task.parent_task_id && fanout.stageLockedBySibling(store, task, item)) {
      store.updateTaskItem(item.id, { status: 'waiting', due_at: now + 60 * 1000 }, task.profile_id);
      continue;
    }

    // Durable wait: poll the condition cheaply; only a resolved wait executes.
    const planText = planEvidenceText(store, task, item);
    const pollProjectDir = task.project_id ? projectDirPath(task.profile_id, task.project_id) : userWorkDir(task.profile_id);
    const activeWait = parseWait(item);
    if (isActiveWait(activeWait)) {
      const verdict = await pollDurableWait(store, {
        task, item, wait: activeWait, now, registry: validators, projectDir: pollProjectDir, planText,
      });
      if (verdict === 'parked') continue;
    }

    fired += 1;
    console.log(`[gtd-durable] fire item=${item.id.slice(0, 8)} task=${task.id.slice(0, 8)} tier=${item.current_tier}`);
    // Random suffix: an item can re-fire within the same ms (recovery retries) → PK collision.
    const executionId = `exec-${item.id.slice(0, 8)}-${now}-${crypto.randomBytes(3).toString('hex')}`;
    // P3b: contract plans resolve the step's contract to a concrete engine/profile;
    // legacy (non-contract) durable items keep the pre-P3b default engine. A plan's
    // execution_policy.level_map overrides the level→engine table for that plan only.
    let step = task.acceptance_criteria_json
      ? resolveStepExecution(item, { levelMap: planLevelMap(parsePolicy(task)), useRoleMap: !parsePolicy(task)?.level_map })
      : { executionKind: 'agent', engine: 'claude', ocProfile: null, ocRole: null, skipModels: [] };
    if (step.executionKind === 'agent') step = pickUsableTarget(store, item, step, healthOf);
    // No free engine slot left this pass: an agent step goes back to the queue
    // untouched (no attempt, no execution row); programmatic steps and batch
    // bookkeeping keep flowing — they need no slot.
    if (step.executionKind === 'agent' && slotsUsed >= maxFires) {
      fired -= 1;
      store.updateTaskItem(item.id, { status: 'waiting', due_at: now + FRESH_CLAIM_GRACE_MS }, task.profile_id);
      continue;
    }
    if (step.degradedFrom) console.log(`[gtd-durable] ${item.id.slice(0, 8)} runs on fallback ${step.engine}${step.ocProfile ? `/${step.ocProfile}` : ''}: ${step.degradeReason}`);
    // Record WHICH engine/profile/level actually ran the step — without it there is
    // no way to see (or test) that different levels really run on different engines.
    store.startExecution({
      id: executionId, task_id: task.id, task_item_id: item.id, session_id: sessionRow?.session_id || null, tier: item.current_tier,
      engine: step.engine || null, profile: step.ocProfile || null, model_level: step.modelLevel || null,
      executor_role: item.executor_role || null,
      provider: step.degradedFrom ? `fallback-from-${step.degradedFrom}` : null,
    });
    // Background step notifications (owner 29.09): opt-in only, never blocks a step.
    void bgStep(secrets, task, item, '▶️ Шаг начат');

    // P4: stage entry — fire stage.on_enter (carried by the stage's first item).
    await fireItemHooks(store, task, item, 'stage_enter', hookVars(), sinks, hooksApproved);
    // A durable step has no session chat but DOES have a profile workspace. Passing
    // it (instead of null) is both correct context and required: writeMcpConfig
    // path.join()s the workDir, so null crashed every real durable fire.
    const workDir = userWorkDir(task.profile_id);
    // Deterministic checks (file_exists / command_exit_zero) resolve against the
    // plan's project dir; a project-less plan falls back to the profile workspace.
    const itemProjectDir = task.project_id ? projectDirPath(task.profile_id, task.project_id) : workDir;

    // P3d-1: a programmatic step is executed deterministically — never spawned as
    // an agent prompt. Its `validation` keys are evaluated by the registry, each
    // verdict recorded, and the step completes only when every check passes.
    if (step.executionKind === 'programmatic') {
      const results = await recordItemValidations(store, {
        task, item, executionId, registry: validators, projectDir: itemProjectDir, validationMode, llmValidate, planText,
      });
      const allPass = results.length > 0 && results.every(r => r.status === 'pass');
      store.setItemEvidence(item.id, task.profile_id, {
        evidence_json: JSON.stringify({ validations: results.map(r => ({ key: r.key, status: r.status, evidence: r.evidence })) }),
        completed_at: allPass ? Date.now() : null,
      });
      if (allPass) {
        store.completeItem(item.id, task.profile_id, { executionId });
        store.finishExecution(executionId, { status: 'success' });
        console.log(`[gtd-durable] programmatic item done: ${item.id.slice(0, 8)}`);
        void bgStep(secrets, task, item, '✅ Шаг готов');
        // P4: step completed → on_complete, and stage_exit on the stage's last item.
        await fireItemHooks(store, task, item, 'on_complete', hookVars(), sinks, hooksApproved);
        await fireItemHooks(store, task, item, 'stage_exit', hookVars(), sinks, hooksApproved);
      } else {
        const failedKeys = results.filter(r => r.status !== 'pass').map(r => r.key).join(', ');
        const errText = `programmatic validation not passed: ${failedKeys || 'no validations'}`;
        store.failItem(item.id, task.profile_id, { executionId, error: errText });
        const rec = await recoverDurableItem({
          store, task, itemId: item.id, errorText: errText, classifier,
          escalate: false, retryDelayMs: FRESH_CLAIM_GRACE_MS,
        });
        store.finishExecution(executionId, {
          status: 'failed', error_class: rec.failureClass,
          error_text: `${rec.action || 'terminal'}: ${failedKeys}`.slice(0, 500),
        });
        if (rec.recovered) {
          console.log(`[gtd-durable] programmatic recovery ${item.id.slice(0, 8)} ${rec.failureClass}→${rec.action} (${rec.attempts}/${rec.maxAttempts})`);
          void bgStep(secrets, task, item, '⚠️ Шаг не удался — повтор', `попытка ${rec.attempts}/${rec.maxAttempts}: ${errText}`);
          void firstFailureNotice(secrets, store, task, item, errText);
        } else {
          console.log(`[gtd-durable] programmatic item failed, ${rec.reason} (${rec.attempts}/${rec.maxAttempts}) class=${rec.failureClass}: ${item.id.slice(0, 8)}`);
          void bgStep(secrets, task, item, '🛑 Шаг не удался (бюджет исчерпан)', errText);
          void firstFailureNotice(secrets, store, task, item, errText);
          // P4: terminal step failure → on_fail + task_failed.
          await fireItemHooks(store, task, item, 'on_fail', hookVars({ error: errText }), sinks, hooksApproved);
          await fireTaskHooks(store, task, 'task_failed', hookVars({ error: errText }), sinks, hooksApproved);
        }
      }
      const settled = settleTaskCompletion(store, task);
      if (settled === 'done') {
        void bgTask(secrets, task, '🏁 Задача готова');
        await fireTaskHooks(store, task, 'task_done', hookVars(), sinks, hooksApproved);
      } else if (settled === 'blocked') {
        const fresh = store.getTask(task.id, task.profile_id) || task;
        void bgTask(secrets, task, '⛔ Задача не завершена — проверки не пройдены', fresh.blocker_reason || 'finalization blocked');
        await fireTaskHooks(store, task, 'task_failed', hookVars({ error: fresh.blocker_reason || 'finalization blocked' }), sinks, hooksApproved);
      }
      continue;
    }

    // Only an agent run takes an engine slot — programmatic steps never count
    // against the per-tick budget (which is the host's free slots, see runDue).
    slotsUsed += 1;
    const freshForPrompt = store.getTaskItem(item.id) || item;
    const resumed = resumeNote(parseWait(freshForPrompt), now);
    const digest = task.acceptance_criteria_json ? priorStepsDigest(store, task, item) : '';
    const prompt = [
      '[DURABLE TASK — auto-execution]',
      resumed,
      `Task: ${task.goal}`,
      `Plan id: ${task.id}`,
      digest ? `\n${digest}\n` : '',
      `Step (${item.position + 1}/${store.progressSummary(task.id, task.profile_id).total}): ${item.title}`,
      `Step id: ${item.id}`,
      ...(() => {
        const fails = priorFailures(store, item);
        if (!fails.length) return [];
        return ['\nПРОШЛЫЕ ПОПЫТКИ ЭТОГО ШАГА НЕ ПРОШЛИ — не повторяй их ошибок:',
          ...fails.map((f, i) => `${i + 1}. [${f.model_level || '?'} ${f.engine || '?'}${f.profile ? `/${f.profile}` : ''}${f.error_class ? ` ${f.error_class}` : ''}] ${String(f.error_text || '').replace(/\s+/g, ' ').slice(0, 300)}`)];
      })(),
      step.degradedFrom ? `\nЭтот шаг рассчитан на уровень ${item.current_model_level || item.minimum_model_level}, но выполняется на запасном движке (${step.degradeReason}). Будь особенно внимателен к проверке результата.` : '',
      item.instructions ? `\nInstructions: ${item.instructions}` : '',
      item.validation_json
        ? `\nValidation (must pass before completion): ${item.validation_json}` : '',
      '\nПроверка шага (validation_mode). Текущий режим шага: ' + validationMode + '.',
      'Ты можешь выбрать режим для этого шага через task_item_update(item_id: "<Step id>", validation_mode: "...").',
      'Режимы: "programmatic" — только детерминированные проверки; "programmatic+llm" — детерминированные + дешёвый LLM-судья; "programmatic+llm-fastpass" — самый мягкий.',
      'Настоятельно рекомендуется "programmatic+llm" (полная проверка) — особенно на дешёвых моделях: не пропускай проверку молча.',
      'Fast-pass — это ЗАПИСЫВАЕМЫЙ escape hatch, а не тихий обход. Только в режиме "programmatic+llm-fastpass" ты можешь пропустить проверку, если она слишком тяжёлая, ломает работу или нужен срочный фикс — добавь финальной строкой: VALIDATION: fastpass-skip: <причина>. Пропуск попадёт в audit trail с причиной.',
      `Папка артефактов плана (единственный artifact root): ${itemProjectDir}. Относительные пути проверок (file_exists, cwd command_exit_zero) резолвятся ОТ НЕЁ — все артефакты плана (отчёты, prod-check/*, deck/* и т.п.) клади сюда, а не в git-workspace.`,
      `Один план = один git-workspace. Если шагу нужен репозиторий — engineering_spawn_workspace(repository_url, root_task_id: "${planWorkspaceLabel(task)}"): тот же root_task_id на всех шагах плана даёт ТОТ ЖЕ workspace и ветку (при BRANCH_COLLISION — это твой план: engineering_workspace_status с тем же root_task_id). Не придумывай свою метку. Всё, что шаг создал в репо, закоммить в эту ветку до конца шага — незакоммиченное следующий шаг не увидит. Инженерный git-workspace — только для кода репозитория; артефакты плана — в папке выше.`,
      `План можно легально править по ходу: нужен дополнительный шаг — task_item_add(task_id: "${task.id}", after_item_id: "<Step id>", title, execution_kind, executor_role, minimum_model_level, context_budget, validation, instructions) — он выполнится сразу после этого шага; следующий шаг не имеет смысла для этой задачи — task_item_skip(item_id, reason) с конкретной причиной.`,
      'Если пункт чек-листа для этой задачи не применим или ты сделал иначе — не подгоняй: вызови task_item_exception(item_id: "<Step id>", reason: "<почему>") и заверши DURABLE: done. Исключение видно владельцу и попадёт в журнал.',
      'Каждый шаг — новый ран без памяти: следующий шаг увидит только твой итог. Перед финальной строкой DURABLE дай блок «ИТОГ ШАГА» (≤10 строк): что сделано, ссылки (issue/PR/файлы/ветка), принятые решения, что важно следующему шагу.',
      'Выполни этот шаг. Если шаг выполнен и проверка прошла — ответь финальной строкой: DURABLE: done.',
      'Если шаг не удался — опиши ошибку и ответь финальной строкой: DURABLE: failed: <причина>.',
      'Если шагу нужно ДОЖДАТЬСЯ чего-то внешнего (деплой, CI, креды/ответ пользователя, повтор ошибки в логах, другой план, просто время) — НЕ жди внутри рана и не проваливай шаг:',
      'вызови task_item_wait(item_id: "<Step id>", until: {<validator>: <значение>} | awaiting_user: true | sleep_sec: N, timeout_sec, reason) и ответь финальной строкой: DURABLE: waiting.',
      'План уснёт; сервер сам дёшево проверяет условие каждые poll_every_sec и перезапустит этот же шаг, когда оно выполнится, пользователь ответит или истечёт таймаут.',
    ].filter(Boolean).join('\n');

    const itemSnap = { ...item };
    const fireNow = now;
    // P3a: the step's own wall-clock budget. `stepTimeoutMs` makes claude-runner
    // hard-kill this run at that budget (clamped to the 40-min global cap) and
    // suppresses auto-continuation — a step that overruns is a step failure to be
    // retried per max_attempts, not vaguely continued 10×.
    const stepTimeoutMs = Number.isFinite(item.execution_timeout_seconds) && item.execution_timeout_seconds > 0
      ? item.execution_timeout_seconds * 1000 : null;
    const settleCtx = {
      store, task, itemSnap, executionId, validators, itemProjectDir, llmValidate, planText,
      sinks, hooksApproved, hookVars, classifier, secrets,
    };
    runTask({
      taskId: `durable-${task.profile_id}-${item.id.slice(0, 8)}-${fireNow}`,
      user: { id: null, name: task.profile_id, username: task.profile_id, workDir },
      // P3b: forceClaude is only meaningful for a Claude step (it widens context +
      // skips quick answers). An OpenCode step must not be treated as Claude.
      // One session per PLAN (#playbooks-e2e): without it a chat-less step fell onto the
      // profile's current chat session — every plan of the profile queued behind one
      // admission lane and mixed contexts with the user's chat. Exact session: never
      // healed onto a chat pointer, never moves the chat's live session.
      sessionId: planSessionId(task), webExactSession: true,
      // P0-a (#1752): the step runs INSIDE its plan's project (cwd + project rules) —
      // the same folder its file checks resolve against. Exact binding: the runner
      // never moves the chat's current/pinned project for a durable step.
      projectId: task.project_id || null,
      task: prompt, forceClaude: step.engine === 'claude', engine: step.engine, secrets, internalGtd: true,
      ocProfile: step.ocProfile || null, ocRole: step.ocRole || null,
      stepTimeoutMs,
      // Resume sink (#1671): lets a run cut off by a restart be resumed in the SAME
      // engine session, with its reply settled by settleDurableReply.
      resumeSink: { kind: 'durable', taskId: task.id, itemId: item.id, executionId, profileId: task.profile_id },
    }).then(reply => settleDurableReply(settleCtx, reply))
      .catch(e => settleDurableCrash(settleCtx, e));
  }
}

// ── Durable step reply handling (extracted for restart resume, #1671) ─────────
// The completion of one fired durable step: parse the DURABLE marker, record
// validations/evidence, complete/fail/park the item, run recovery and hooks.
// Called from runDueDurable's .then — and, after a restart, from
// resumeDurableReply with a context rebuilt from ids.
async function _settleDurableReply(ctx, reply) {
  const { store, task, itemSnap, executionId, validators, itemProjectDir, llmValidate, planText, sinks, hooksApproved, hookVars, classifier, secrets } = ctx;
  const said = typeof reply === 'string' ? reply : '';
  // R4 / SS-04: «⛔ Остановлено…» — волеизъявление пользователя, а не провал шага.
  // Раньше ответ без DURABLE-маркера уходил в recoverDurableItem, и остановленный
  // шаг ретраили. USER_STOP должен быть терминальным (recovery-policy.js уже
  // возвращает для него null) — помечаем прямо здесь, не достигая recovery.
  if (isUserStoppedReply(said)) {
    const errText = 'user stopped (⛔)';
    store.failItem(itemSnap.id, task.profile_id, { executionId, error: errText });
    store.updateTaskItem(itemSnap.id, { last_failure_class: 'USER_STOP', last_recovery_action: 'terminal' }, task.profile_id);
    store.finishExecution(executionId, { status: 'failed', error_class: 'USER_STOP', error_text: errText });
    console.log(`[gtd-durable] item ${itemSnap.id.slice(0, 8)}: user stop — terminal, no retry`);
    return;
  }
  if (lastDurableMarker(said) === 'waiting') {
    // The agent parked the step on a durable wait (task_item_wait during the
    // run). Not a failure: the attempt is refunded and nothing is completed.
    const fresh = store.getTaskItem(itemSnap.id) || itemSnap;
    const w = parseWait(fresh);
    if (isActiveWait(w) && w.then === 'rerun') {
      const waitNow = Date.now();
      store.parkItem(itemSnap.id, task.profile_id, {
        wait: w, dueAt: nextDueAt(w, waitNow), refundAttempt: true, lastError: `waiting: ${w.reason || 'condition'}`,
      });
      store.setItemEvidence(itemSnap.id, task.profile_id, {
        evidence_json: JSON.stringify({ reply: said.slice(0, 4000), waiting: true }), completed_at: null,
      });
      store.finishExecution(executionId, { status: 'waiting' });
      console.log(`[gtd-durable] item parked ${itemSnap.id.slice(0, 8)} until ${new Date(w.deadline_at).toISOString()}: ${w.reason || ''}`);
      return;
    }
    // "waiting" without a registered wait is a protocol error — bounded like a failure.
    const errText = 'DURABLE: waiting without task_item_wait (no wait registered)';
    store.failItem(itemSnap.id, task.profile_id, { executionId, error: errText });
    const rec = await recoverDurableItem({ store, task, itemId: itemSnap.id, errorText: errText, classifier });
    store.finishExecution(executionId, { status: 'failed', error_class: rec.failureClass, error_text: errText });
    if (!rec.recovered) {
      await fireItemHooks(store, task, itemSnap, 'on_fail', hookVars({ error: errText }), sinks, hooksApproved);
      await fireTaskHooks(store, task, 'task_failed', hookVars({ error: errText }), sinks, hooksApproved);
    }
    return;
  }
  if (/DURABLE:\s*done/i.test(said)) {
    // P3d-1: record the step's validations (registered → verdict, self-reported
    // → inconclusive) + the reply as evidence BEFORE completing the item, so a
    // finalizer that reads rows (P3d-2) never sees a completed step with no
    // verdict. The tick is fire-and-forget: this runs in the run's completion
    // callback, not on the tick's critical path.
    // P3d-1c: re-read the item so a per-step validation_mode the agent set
    // during the run is honoured, and allow the fast-pass escape under that mode.
    // #1861 Fix B: `gate` holds a failed registered check; it suppresses `done`.
    let gate = null;
    try {
      const freshItem = store.getTaskItem(itemSnap.id) || itemSnap;
      const mode = resolveValidationMode({ task, item: freshItem });
      const skipReason = mode === FASTPASS_SKIP_MODE ? parseFastpassSkip(said) : null;
      let exception = null;
      try { exception = freshItem.exception_json ? JSON.parse(freshItem.exception_json) : null; } catch { /* malformed */ }
      if (exception && exception.reason) {
        // Agent-declared exception (task_item_exception): no judge; checks pass as an
        // exception and the defect is logged for checklist improvement.
        recordStepException(store, { task, item: freshItem, executionId, reason: exception.reason });
        logDefect({ profile_id: task.profile_id, task_id: task.id, playbook: task.playbook_id || null, kind: 'exception',
          item_id: freshItem.id, step: freshItem.title, stage: freshItem.stage, level: freshItem.current_model_level || freshItem.minimum_model_level,
          reason: exception.reason });
        console.log(`[gtd-durable] exception ${itemSnap.id.slice(0, 8)}: ${exception.reason}`);
      } else if (skipReason) {
        recordFastpassSkip(store, { task, item: freshItem, executionId, reason: skipReason });
        console.log(`[gtd-durable] fastpass skip ${itemSnap.id.slice(0, 8)}: ${skipReason}`);
      } else {
        // The reply joins the plan text: a step that just opened a PR is
        // validated (pr_opened / ci_green) against the URL it printed.
        const results = await recordItemValidations(store, {
          task, item: itemSnap, executionId, registry: validators, projectDir: itemProjectDir,
          validationMode: mode, llmValidate, planText: `${planText}\n${said}`, reply: said,
        });
        // #1861 Fix B: a FAILED registered (deterministic) check must not be
        // swallowed by `DURABLE: done`. registered → isBlockingCheck; semantic /
        // inconclusive verdicts still fall through (soft finalization). Keep the
        // verdict so the step is failed with the check's own key/path.
        const bad = results.find(r => r.status === 'fail' && isBlockingCheck(r.key));
        if (bad) gate = bad;
      }
      store.setItemEvidence(itemSnap.id, task.profile_id, {
        evidence_json: JSON.stringify(gate
          ? { reply: said.slice(0, 4000), failed_validation: gate.key, subject: gate.subject ?? null }
          : { reply: said.slice(0, 4000) }),
        completed_at: gate ? null : Date.now(),
      });
    } catch (e) {
      console.error(`[gtd-durable] recordValidations ${itemSnap.id.slice(0, 8)}:`, e.message);
    }
    if (gate) {
      const detail = gate.subject != null ? JSON.stringify(gate.subject) : '';
      const errText = `deterministic validation failed: ${gate.key}${detail ? ` (${detail})` : ''}`;
      store.failItem(itemSnap.id, task.profile_id, { executionId, error: errText.slice(0, 500) });
      const rec = await recoverDurableItem({ store, task, itemId: itemSnap.id, errorText: errText, classifier, quality: true });
      store.finishExecution(executionId, {
        status: 'failed', error_class: rec.failureClass,
        error_text: `${rec.action || 'terminal'}: ${errText}`.slice(0, 500),
      });
      if (rec.recovered) {
        console.log(`[gtd-durable] gated check ${itemSnap.id.slice(0, 8)} failed (${gate.key}) → ${rec.failureClass}/${rec.action} (${rec.attempts}/${rec.maxAttempts})`);
        void bgStep(secrets, task, itemSnap, '⚠️ Шаг не удался — повтор', `проверка не пройдена: ${gate.key}`);
      } else {
        console.log(`[gtd-durable] item blocked by failed check, ${rec.reason} (${rec.attempts}/${rec.maxAttempts}) class=${rec.failureClass}: ${itemSnap.id.slice(0, 8)}`);
        void bgStep(secrets, task, itemSnap, '🛑 Шаг не удался — проверка не пройдена', errText);
        await fireItemHooks(store, task, itemSnap, 'on_fail', hookVars({ error: errText }), sinks, hooksApproved);
        await fireTaskHooks(store, task, 'task_failed', hookVars({ error: errText }), sinks, hooksApproved);
      }
      return;
    }
    store.completeItem(itemSnap.id, task.profile_id, { executionId });
    store.finishExecution(executionId, { status: 'success' });
    console.log(`[gtd-durable] item done: ${itemSnap.id.slice(0, 8)}`);
    // P4: step completed → on_complete, and stage_exit on the stage's last item.
    await fireItemHooks(store, task, itemSnap, 'on_complete', hookVars(), sinks, hooksApproved);
    await fireItemHooks(store, task, itemSnap, 'stage_exit', hookVars(), sinks, hooksApproved);
  } else if (/DURABLE:\s*failed/i.test(said)) {
    store.failItem(itemSnap.id, task.profile_id, { executionId, error: said.slice(0, 500) });
    const rec = await recoverDurableItem({ store, task, itemId: itemSnap.id, errorText: said, classifier, quality: true });
    store.finishExecution(executionId, {
      status: 'failed', error_class: rec.failureClass,
      error_text: `${rec.action || 'terminal'}: ${said}`.slice(0, 500),
    });
    if (rec.recovered) console.log(`[gtd-durable] recovery ${itemSnap.id.slice(0, 8)} ${rec.failureClass}→${rec.action} (${rec.attempts}/${rec.maxAttempts})`);
    else {
      console.log(`[gtd-durable] item failed, ${rec.reason} (${rec.attempts}/${rec.maxAttempts}) class=${rec.failureClass}: ${itemSnap.id.slice(0, 8)}`);
      await fireItemHooks(store, task, itemSnap, 'on_fail', hookVars({ error: said.slice(0, 500) }), sinks, hooksApproved);
      await fireTaskHooks(store, task, 'task_failed', hookVars({ error: said.slice(0, 500) }), sinks, hooksApproved);
    }
  } else {
    // no terminal marker — treat as failure, bounded by the item's own max_attempts
    // The reply itself is the error text: an engine that printed "Not logged in"
    // must classify as AUTH (fallback ladder), not as a quality miss.
    const errText = `no DURABLE terminal marker in reply: ${said.slice(-300)}`;
    store.failItem(itemSnap.id, task.profile_id, { executionId, error: errText.slice(0, 500) });
    const rec = await recoverDurableItem({ store, task, itemId: itemSnap.id, errorText: errText, classifier, quality: true });
    store.finishExecution(executionId, {
      status: 'failed', error_class: rec.failureClass,
      error_text: `${rec.action || 'terminal'}: no marker`.slice(0, 500),
    });
    if (!rec.recovered) {
      console.log(`[gtd-durable] item failed (no marker), ${rec.reason} (${rec.attempts}/${rec.maxAttempts}) class=${rec.failureClass}: ${itemSnap.id.slice(0, 8)}`);
      await fireItemHooks(store, task, itemSnap, 'on_fail', hookVars({ error: errText }), sinks, hooksApproved);
      await fireTaskHooks(store, task, 'task_failed', hookVars({ error: errText }), sinks, hooksApproved);
    }
  }
  // Keep the task row's revision ticking so projections/UI notice progress.
  const settled = settleTaskCompletion(store, task);
  if (settled === 'done') {
    void bgTask(secrets, task, '🏁 Задача готова');
    await fireTaskHooks(store, task, 'task_done', hookVars(), sinks, hooksApproved);
  } else if (settled === 'blocked') {
    const fresh = store.getTask(task.id, task.profile_id) || task;
    void bgTask(secrets, task, '⛔ Задача не завершена — проверки не пройдены', fresh.blocker_reason || 'finalization blocked');
    await fireTaskHooks(store, task, 'task_failed', hookVars({ error: fresh.blocker_reason || 'finalization blocked' }), sinks, hooksApproved);
  }
}

async function _settleDurableCrash(ctx, e) {
  const { store, task, itemSnap, executionId, validators, itemProjectDir, llmValidate, planText, sinks, hooksApproved, hookVars, classifier, secrets } = ctx;
  console.error(`[gtd-durable] runTask ${itemSnap.id.slice(0, 8)}:`, e.message);
  store.failItem(itemSnap.id, task.profile_id, { executionId, error: e.message.slice(0, 500) });
  // Engine/env crash: same bounded recovery as a marker failure, but without
  // tier escalation (a crash is not an item-quality signal) and with the
  // crash-retry backoff; after the budgets are spent the item stays failed.
  const rec = await recoverDurableItem({
    store, task, itemId: itemSnap.id, errorText: e.message, classifier,
    retryDelayMs: 5 * 60 * 1000, escalate: false,
  });
  store.finishExecution(executionId, {
    status: 'failed', error_class: rec.failureClass,
    error_text: `${rec.action || 'terminal'}: ${e.message}`.slice(0, 500),
  });
  if (!rec.recovered) {
    console.log(`[gtd-durable] item crashed, ${rec.reason} (${rec.attempts}/${rec.maxAttempts}) class=${rec.failureClass}: ${itemSnap.id.slice(0, 8)}`);
    await fireItemHooks(store, task, itemSnap, 'on_fail', hookVars({ error: e.message.slice(0, 500) }), sinks, hooksApproved);
    await fireTaskHooks(store, task, 'task_failed', hookVars({ error: e.message.slice(0, 500) }), sinks, hooksApproved);
  }
}

// Rebuild a settle context from ids after a restart (the fire-time closure died
// with the old process). Same defaults the tick uses.
// After ANY settle: a fanout child's parent looks at it now (not at its next poll),
// and the next step of this plan is claimed now instead of at the next 5-min tick.
function afterDurableSettle(ctx) {
  try {
    const fresh = ctx.store.getTask(ctx.task.id, ctx.task.profile_id) || ctx.task;
    fanout.nudgeParent(ctx.store, fresh);
  } catch (e) { console.warn('[gtd-durable] nudge parent:', e.message); }
  kickDurable();
}
async function settleDurableReply(ctx, reply) {
  let out;
  try { out = await _settleDurableReply(ctx, reply); } finally { afterDurableSettle(ctx); }
  await bgAfterStep(ctx);
  return out;
}
async function settleDurableCrash(ctx, e) {
  let out;
  try { out = await _settleDurableCrash(ctx, e); } finally { afterDurableSettle(ctx); }
  await bgAfterStep(ctx);
  return out;
}

// Post-settle step notice — ONE place for an agent step's outcome, so every
// terminal branch (done / failed+retry / failed terminal / parked-waiting /
// user stop / crash) is reported without repeating the message in each branch.
async function bgAfterStep(ctx) {
  try {
    if (!ctx?.task?.profile_id) return;
    const fresh = ctx.store.getTaskItem(ctx.itemSnap.id);
    if (!fresh) return;
    const detail = String(fresh.last_error || '').trim().slice(0, 240);
    if (!isBgNotifyEnabled(ctx.task.profile_id)) {
      // Default path (#1725): only the plan's first failed attempt reaches the chat.
      if ((fresh.status === 'failed' || fresh.status === 'pending') && fresh.last_error) {
        await firstFailureNotice(ctx.secrets, ctx.store, ctx.task, fresh, fresh.last_error);
      }
      return;
    }
    if (fresh.status === 'done') return bgStep(ctx.secrets, ctx.task, ctx.itemSnap, '✅ Шаг готов');
    if (fresh.status === 'failed') return bgStep(ctx.secrets, ctx.task, ctx.itemSnap, '🛑 Шаг не удался', detail);
    if (fresh.status === 'pending') return bgStep(ctx.secrets, ctx.task, ctx.itemSnap, '⚠️ Шаг не удался — повтор', detail);
    if (fresh.status === 'waiting') return bgStep(ctx.secrets, ctx.task, ctx.itemSnap, '⏸ Шаг ждёт');
  } catch (e) { console.warn('[gtd] bg-notify:', e.message); }
}

function durableSettleContext({ taskId, itemId, executionId }, { secrets = {}, store = durableStore(), registry = null, llmValidate = null, hookSinks = null } = {}) {
  const task = store.db.prepare('SELECT * FROM durable_tasks WHERE id = ?').get(taskId);
  const item = store.getTaskItem(itemId);
  if (!task || !item) return null;
  const workDir = userWorkDir(task.profile_id);
  return {
    store, task, itemSnap: { ...item }, executionId,
    validators: registry || getDefaultRegistry(),
    itemProjectDir: task.project_id ? projectDirPath(task.profile_id, task.project_id) : workDir,
    llmValidate,
    planText: planEvidenceText(store, task, item),
    sinks: hookSinks || defaultHookSinks({ secrets, store, task }),
    hooksApproved: resolveHookApproval(task, null),
    hookVars: (extra = {}) => ({ goal: task.goal, stage: item.stage ?? null, error: null, ...extra }),
    classifier: null,
    secrets,
  };
}

// A resumed durable run crashed: same bounded recovery as a crash at fire time.
async function resumeDurableCrash(sink, err, opts = {}) {
  const ctx = durableSettleContext(sink, opts);
  if (!ctx) return;
  await settleDurableCrash(ctx, err);
}

// A durable run resumed after a restart finished: settle its reply exactly like
// the original fire would have.
async function resumeDurableReply(sink, reply, opts = {}) {
  const ctx = durableSettleContext(sink, opts);
  if (!ctx) { console.warn(`[gtd-durable] resume: plan/step gone for ${sink && sink.itemId}`); return; }
  await settleDurableReply(ctx, reply);
}

// ── Mirror into checklist.trainedassist.store (2026-09-21) ─────────────────
// checklist.md in projectDir stays the ONE source of truth the tick loop reads/writes —
// this only pushes a read-only-for-the-loop copy so the human sees GTD auto-tracking
// checklists in the SAME UI as their manual ones (was two unrelated things sharing the
// word "checklist": this file's own /active_checklist list vs the standalone app).
// Best-effort: unconfigured or unreachable → silently skipped, never blocks a GTD tick.
const CHECKLIST_API_BASE = process.env.CHECKLIST_API_BASE || 'https://checklist.trainedassist.store';

async function mirrorGtdChecklist({ username, sessionId, checklist, rec }) {
  const apiKey = process.env.CHECKLIST_API_KEY;
  if (!apiKey || !checklist || !checklist.items.length) return;
  const externalKey = `gtd:${username}:${sessionId}`;
  const name = (checklist.goal || rec?.originalTask || 'GTD чек-лист').slice(0, 200);
  const headers = { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const opts = { signal: AbortSignal.timeout(8000) };
  try {
    const createRes = await fetch(`${CHECKLIST_API_BASE}/api/checklists`, {
      ...opts, method: 'POST', headers,
      body: JSON.stringify({ name, external_key: externalKey, source: 'agent' }),
    });
    if (!createRes.ok) return;
    const { id } = await createRes.json();
    await fetch(`${CHECKLIST_API_BASE}/api/checklists/${id}/sync-items`, {
      ...opts, method: 'POST', headers,
      body: JSON.stringify({ items: checklist.items.map(i => ({ text: i.text, done: i.done })) }),
    });
  } catch (e) {
    console.warn('[gtd] mirrorGtdChecklist:', e.message);
  }
}

// Returns a one-click login URL for checklist.trainedassist.store (sets the same session
// cookie /api/login would), or null if unreachable/unconfigured. The agent only ever holds
// CHECKLIST_API_KEY (machine bearer) — the worker's /api/autologin-link mints the link
// server-side so the human's CHECKLIST_PASSWORD never has to leave the worker.
async function checklistAutologinUrl() {
  const apiKey = process.env.CHECKLIST_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${CHECKLIST_API_BASE}/api/autologin-link`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const { url } = await res.json();
    return url || null;
  } catch (e) {
    console.warn('[gtd] checklistAutologinUrl:', e.message);
    return null;
  }
}

// Дешёвый pre-gate: без хотя бы одного из этих сигналов LLM не зовём —
// ложный пинг дороже пропуска, а большинство задач контроля не просят.
const CONTROL_HINT = /(проконтролир|доведи|довед[её]шь|до конца|убедись|удостовер|проследи|проверь(?:\s+(?:потом|позже|через|что))|перепровер|дойд[её]т ли|доехал|на\s+прод|в\s+прод|задеплой|раскат|не\s+забуд|напомни(?:\s+(?:проверить|мне))|follow.?up|make sure|double.?check|verify later|check (?:back|later|it landed))/i;

function _dir(workDir) { return path.join(workDir, GTD_DIR); }
function _file(workDir, sessionId) { return path.join(_dir(workDir), `${sessionId}.json`); }

function readGtd(workDir, sessionId) {
  try {
    const fp = _file(workDir, sessionId);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.warn('[gtd] read:', e.message); return null; }
}

function writeGtd(workDir, rec) {
  try {
    fs.mkdirSync(_dir(workDir), { recursive: true });
    atomicText(_file(workDir, rec.sessionId), JSON.stringify(rec, null, 2));
    return true;
  } catch (e) { console.error('[gtd] write:', e.message); return false; }
}

function clearGtd(workDir, sessionId) {
  try { fs.unlinkSync(_file(workDir, sessionId)); } catch { /* already gone */ }
}

function listGtd(workDir) {
  try {
    return fs.readdirSync(_dir(workDir))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(_dir(workDir), f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── checklist.md convention ──────────────────────────────────────────────
// Формат: `Goal: <текст>` (опционально) + строки `- [ ] пункт` / `- [x] пункт`.
// Живёт в корне ПРОЕКТА (projectDir, см. projects.js), не в user.workDir —
// это артефакт конкретной задачи, а не профиля. Читается ЗАНОВО на каждой
// итерации (не кэшируется в gtd-записи), чтобы видеть отмеченные пункты.
//
// Файл — это ЖУРНАЛ: каждая новая задача дописывается новой `Goal:`-секцией в
// конец. Поэтому активна ровно одна секция — последняя по порядку в файле, у
// которой есть пункты; только её goal и items и возвращаются. Раньше пункты
// ВСЕХ секций склеивались в один список, а goal брался из ПЕРВОЙ секции: GTD
// вёл давно закрытую цель и вкидывал агенту весь бэклог проекта (инцидент
// PR #1422 — агент трижды ответил «это не входит», GTD закрылся
// complexity-escalated). Append-only порядок — надёжный признак «текущей»
// секции; старые (в т.ч. отложенные) секции больше не воскрешаются.
//
// Каждый пункт несёт `line` (0-based номер строки в файле) — writeChecklistDone
// правит чекбоксы ровно по этим строкам; иначе отметка активной секции
// наложилась бы на первые N чекбоксов более старой секции.
// goals (#1517): цели, которые отслеживает запись GTD. Их пункты объединяются с
// последней секцией — агент, дописавший новую секцию («Goal: инцидент», вся в [x]),
// не должен этим «закрыть» ещё открытые пункты отслеживаемой цели.
//
// Владелец секции (#1729, BV-08): строка `Owner-session: <sessionId>` внутри секции
// (обычно сразу под `Goal:`). Отметка отмены: `Cancelled: <дата>` (кнопка «✖️ Отменить»
// у осиротевшего чек-листа). Обе строки — метаданные ТЕКУЩЕЙ секции; отменённая секция
// остаётся активной (старые секции не воскрешаются), просто считается закрытой.
const OWNER_LINE_RE = /^\s*(?:[-*]\s*)?owner-session:\s*([A-Za-z0-9_.:-]+)\s*$/i;
const CANCELLED_LINE_RE = /^\s*(?:[-*]\s*)?cancelled:\s*(.*)$/i;
function _parseChecklistSections(raw) {
  const lines = raw.split('\n');
  const sections = [];
  let cur = { goal: null, goalLine: -1, owner: null, ownerLine: -1, cancelled: false, items: [] };
  sections.push(cur);
  for (let i = 0; i < lines.length; i++) {
    const g = lines[i].match(/^\s*#*\s*goal:\s*(.+)$/i);
    if (g) { cur = { goal: g[1].trim(), goalLine: i, owner: null, ownerLine: -1, cancelled: false, items: [] }; sections.push(cur); continue; }
    const o = lines[i].match(OWNER_LINE_RE);
    if (o) { cur.owner = o[1]; cur.ownerLine = i; continue; }
    if (CANCELLED_LINE_RE.test(lines[i])) { cur.cancelled = true; continue; }
    const item = lines[i].match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (item) cur.items.push({ text: item[2].trim(), done: item[1].toLowerCase() === 'x', line: i });
  }
  return { lines, sections };
}

function _activeSection(sections) {
  for (let s = sections.length - 1; s >= 0; s--) if (sections[s].items.length) return sections[s];
  return null;
}

function readChecklist(projectDir, { goals = null } = {}) {
  if (!projectDir) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(projectDir, CHECKLIST_FILE), 'utf8'); } catch { return null; }
  const { sections } = _parseChecklistSections(raw);
  const last = _activeSection(sections);
  if (last) {
    const meta = { owner: last.owner, cancelled: last.cancelled };
    const tracked = new Set((goals || []).map(g => String(g).trim()).filter(Boolean));
    if (!tracked.size) return { goal: last.goal, items: last.items, ...meta };
    const items = sections.filter(x => x === last || (x.goal && tracked.has(x.goal)))
      .flatMap(x => x.items).sort((a, b) => a.line - b.line);
    return { goal: last.goal, items, ...meta };
  }
  // Ни одного чекбокса — отдаём последний объявленный goal (fallback для
  // originalTask) с пустыми items.
  return { goal: sections[sections.length - 1].goal, items: [], owner: null, cancelled: false };
}

// Пишет/заменяет строку `Owner-session:` активной секции (или добавляет `Cancelled:`).
// Строка встаёт сразу под `Goal:` (или в начало файла для секции без Goal). Возвращает
// true, если файл изменён. Правит только активную секцию — чужие старые не трогает.
function _editActiveSection(projectDir, mutate) {
  const fp = path.join(projectDir, CHECKLIST_FILE);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return false; }
  const { lines, sections } = _parseChecklistSections(raw);
  const sec = _activeSection(sections);
  if (!sec) return false;
  if (!mutate(lines, sec)) return false;
  try { atomicText(fp, lines.join('\n')); return true; }
  catch (e) { console.error('[gtd] edit checklist section:', e.message); return false; }
}

function setChecklistOwner(projectDir, sessionId) {
  if (!projectDir || !sessionId || !/^[A-Za-z0-9_.:-]+$/.test(String(sessionId))) return false;
  return _editActiveSection(projectDir, (lines, sec) => {
    if (sec.owner === sessionId) return false;
    const line = `Owner-session: ${sessionId}`;
    if (sec.ownerLine >= 0) lines[sec.ownerLine] = line;
    else lines.splice(sec.goalLine + 1, 0, line);
    return true;
  });
}

function markChecklistCancelled(projectDir, { now = Date.now() } = {}) {
  if (!projectDir) return false;
  return _editActiveSection(projectDir, (lines, sec) => {
    if (sec.cancelled) return false;
    const at = sec.ownerLine >= 0 ? sec.ownerLine + 1 : sec.goalLine + 1;
    lines.splice(at, 0, `Cancelled: ${new Date(now).toISOString().slice(0, 10)}`);
    return true;
  });
}

// Фолбэк владельца (#1729): агент/тул дописал новую секцию без `Owner-session:` в ЭТОМ
// ране — сессия рана и есть её автор. Признак «в этом ране»: mtime checklist.md не
// раньше старта рана. Не трогаем секцию, если её уже ведёт чужая открытая GTD-запись
// (например, её прекчек переписал файл во время нашего рана) или если она уже
// числится осиротевшей раньше старта рана (legacy-секция, а не свежая).
function claimFreshChecklist({ workDir, projectDir, sessionId, since }) {
  if (!workDir || !projectDir || !sessionId || !Number.isFinite(since)) return false;
  let mtime;
  try { mtime = fs.statSync(path.join(projectDir, CHECKLIST_FILE)).mtimeMs; } catch { return false; }
  if (mtime < since) return false;
  const cl = readChecklist(projectDir);
  if (!cl || cl.owner || cl.cancelled || !cl.items.some(i => !i.done)) return false;
  if (listGtd(workDir).some(r => r.status === 'open' && r.projectDir === projectDir && r.sessionId !== sessionId)) return false;
  try {
    const known = require('./orphan-checklists').findRecord(workDir, projectDir, cl.goal);
    if (known && known.firstSeenAt < since) return false;
  } catch { /* store unreadable → treat as unknown */ }
  const ok = setChecklistOwner(projectDir, sessionId);
  if (ok) console.log(`[gtd] claimed checklist section «${(cl.goal || '').slice(0, 60)}» in ${projectDir} for session=${sessionId}`);
  return ok;
}

// Чек-лист записи GTD (#1517): запоминаем цель текущей последней секции в
// rec.goals (мутирует rec — вызывающий сохраняет через writeGtd) и читаем
// объединение всех отслеживаемых секций. Старые записи без goals засеиваются
// originalTask (для checklist-записей это goal на момент открытия).
const MAX_TRACKED_GOALS = 20;
function trackedChecklist(rec) {
  if (!rec || !rec.projectDir) return null;
  const last = readChecklist(rec.projectDir);
  if (!last) return null;
  const goals = Array.isArray(rec.goals) ? rec.goals.slice() : (rec.originalTask ? [rec.originalTask] : []);
  if (last.goal && !goals.includes(last.goal)) goals.push(last.goal);
  rec.goals = goals.slice(-MAX_TRACKED_GOALS);
  return readChecklist(rec.projectDir, { goals: rec.goals });
}

// Незакрытые пункты + цель, для инъекции в reopen-промпт вместо усечённого task.
function checklistSummary(checklist) {
  if (!checklist || !checklist.items.length) return null;
  const done = checklist.items.filter(i => i.done).length;
  const unchecked = checklist.items.filter(i => !i.done);
  return [
    checklist.goal ? `Цель: ${checklist.goal}` : null,
    `Чек-лист (${done}/${checklist.items.length} закрыто), файл checklist.md в корне проекта:`,
    unchecked.length
      ? unchecked.map(i => `- [ ] ${i.text}`).join('\n')
      : '(все пункты отмечены [x] — перепроверь по факту, что каждый реально доехал, прежде чем писать GTD: done)',
  ].filter(Boolean).join('\n');
}

// ── Intent-gate (дешёвая LLM, консервативная) ───────────────────────────────
// Возвращает {wanted:boolean, etaMinutes:number}. Сомнение → wanted:false.
async function detectIntent(task, { apiKey, timeoutMs = 12000 } = {}) {
  const t = String(task || '').trim();
  if (t.length < 8) return { wanted: false };
  if (!CONTROL_HINT.test(t)) return { wanted: false }; // pre-gate: не жжём LLM зря
  const serviceLlm = require('./service-llm');
  if (!serviceLlm.available(apiKey)) return { wanted: false };

  const system = [
    'Ты классифицируешь: просит ли пользователь ДОВЕСТИ задачу до конца',
    '(добиться, чтобы работа реально доехала до прода/PR/деплоя/результата), чтобы ассистент сам вернулся позже и проверил/дожал — а не только сделал первый шаг.',
    'НЕ считается: обычная просьба «сделай X», вопрос, разовое «проверь сейчас».',
    'Считается: «проконтролируй что дойдёт», «доведи до конца», «убедись что задеплоится», «проследи», «напомни проверить».',
    'Отвечай СТРОГО одним JSON: {"wanted": true|false, "etaMinutes": <int 20..180>}.',
    'etaMinutes — через сколько минут разумно вернуться и проверить (деплой ~30-60, долгий процесс больше). Сомневаешься в намерении → wanted:false.',
  ].join(' ');

  try {
    // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
    const obj = await serviceLlm.serviceJson({ system, user: t.slice(0, 1500), maxTokens: 60, timeoutMs, apiKey, source: 'gtd-intent' });
    if (!obj || obj.wanted !== true) return { wanted: false };
    let eta = Number(obj.etaMinutes);
    if (!Number.isFinite(eta)) eta = DEFAULT_ETA_MIN;
    eta = Math.min(ETA_MAX_CLAMP, Math.max(ETA_MIN_CLAMP, Math.round(eta)));
    return { wanted: true, etaMinutes: eta };
  } catch (e) {
    console.warn('[gtd] detectIntent:', e.message);
    return { wanted: false };
  }
}

// Длинный чек-лист заслуживает больше попыток, чем "попробовал ×3" дефолт;
// всё ещё жёстко ограничено CHECKLIST_MAX_ITERATIONS (деньги/циклы).
function computeMaxIterations(checklist) {
  if (!checklist || !checklist.items.length) return DEFAULT_MAX_ITERATIONS;
  const unchecked = checklist.items.filter(i => !i.done).length;
  return Math.max(DEFAULT_MAX_ITERATIONS, Math.min(CHECKLIST_MAX_ITERATIONS, unchecked + 2));
}

// Вызывается на успешном завершении WORKRUN (гейт в runner). Если юзер просил
// довести до конца — пишем durable-запись. Идемпотентно перезаписывает открытую
// запись сессии (новый workrun с контролем → свежий отсчёт).
async function maybeSchedule({ workDir, sessionId, chatId, username, task, apiKey, projectDir, audience, threadId = null }) {
  if (!workDir || !sessionId) return null;
  const intent = await detectIntent(task, { apiKey });
  if (!intent.wanted) return null;
  const chatIdStr = chatId != null ? String(chatId) : null;
  if (chatIdStr) {
    const conflict = listGtd(workDir).find(r => r.status === 'open' && r.chatId === chatIdStr && !closeIfStopped(workDir, r));
    if (conflict) {
      console.warn(`[gtd] skip: open GTD for chatId=${chatIdStr} already exists (session=${conflict.sessionId})`);
      return conflict;
    }
  }
  const now = Date.now();
  const checklist = readChecklist(projectDir);
  const maxIterations = computeMaxIterations(checklist);
  const rec = {
    sessionId, chatId: chatId != null ? String(chatId) : null,
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
    username: username || null,
    audience: audience || 'default',
    createdAt: now,
    dueAt: now + intent.etaMinutes * 60 * 1000,
    etaMinutes: intent.etaMinutes,
    iterations: 0,
    maxIterations,
    status: 'open',
    originalTask: String(task || '').slice(0, 300),
    goals: checklist && checklist.goal ? [checklist.goal] : [],
    projectDir: projectDir || null,
    lastFiredAt: null,
    closedReason: null,
    consecutiveNoProgress: 0,
  };
  writeGtd(workDir, rec);
  console.log(`[gtd] scheduled session=${sessionId} user=${username} eta=${intent.etaMinutes}m maxIterations=${maxIterations}${checklist ? ' (checklist.md)' : ''} due=${new Date(rec.dueAt).toISOString()}`);
  return rec;
}

// Чек-лист в корне проекта — уже осознанный авторский сигнал («кто-то написал
// `- [ ] ...`»), в отличие от detectIntent (угадывание намерения по свободному
// тексту). Поэтому не требует ни LLM-гейта, ни ограничения на deep-режим — сам
// факт незакрытого checklist.md достаточен, чтобы довести дело до конца.
// Используется как дефолт для PR-задач: «создал PR → checklist.md с 3 пунктами
// (CI/merge/деплой) → трекается автоматически», без явной фразы «доведи до конца».
//
// Владелец (#1729, BV-08): доводку получает только сессия-владелец активной секции
// (`Owner-session:`). Чужая секция или legacy-секция без владельца к сессии A не
// цепляется (инцидент 28.09: вчерашняя доводка tg-bot#290 всплыла в чужом разговоре).
// Если такая секция никем не ведётся — она «осиротевшая» и уходит в orphan-store
// (src/orphan-checklists.js): одно напоминание через 30 мин с «▶️ Делать»/«✖️ Отменить».
async function scheduleFromChecklist({ workDir, sessionId, chatId, username, projectDir, audience, threadId = null, isSessionRunning = null }) {
  if (!workDir || !sessionId || !projectDir) return null;
  const checklist = readChecklist(projectDir);
  if (!checklist || !checklist.items.length || !checklist.items.some(i => !i.done)) return null;
  if (checklist.cancelled) return null; // «✖️ Отменить» — секция закрыта человеком
  const existing = readGtd(workDir, sessionId);
  const ownedByUs = checklist.owner === sessionId;
  // Legacy без владельца: ведём дальше, только если A уже ведёт этот projectDir.
  const legacyOurs = !checklist.owner && existing && existing.status === 'open' && existing.projectDir === projectDir;
  if (!ownedByUs && !legacyOurs) {
    try {
      require('./orphan-checklists').noteSkipped({
        workDir, projectDir, checklist, username, audience, chatId, threadId, isSessionRunning,
      });
    } catch (e) { console.warn('[gtd] orphan note:', e.message); }
    console.log(`[gtd] skip(checklist): section owner=${checklist.owner || '(none)'} != session=${sessionId} in ${projectDir}`);
    return null;
  }
  // уже трекается — не сбрасываем прогресс/backoff. Кроме записи, приговорённой
  // Стопом (D2): её возврат оставил бы новую работу этой сессии без доводки.
  if (existing && existing.status === 'open' && !closeIfStopped(workDir, existing)) return existing;
  // Один трекер на работу (#1719): у сессии есть активный durable-план → его ведёт
  // durable-исполнитель со своей проекцией; второй GTD-цикл по корневому
  // checklist.md гонял бы ту же работу параллельно. Ошибка стора → fail-open.
  if (username) {
    try {
      const plan = durableStore().activeTaskForSession(String(username), sessionId);
      if (plan) {
        console.warn(`[gtd] skip(checklist): session=${sessionId} has active durable plan ${plan.id}`);
        return null;
      }
    } catch (e) { console.warn('[gtd] active-plan check:', e.message); }
  }
  const chatIdStr = chatId != null ? String(chatId) : null;
// Dedup by projectDir: same checklist.md already tracked by another session
  const projectConflict = listGtd(workDir).find(r => r.status === 'open' && r.projectDir === projectDir && r.sessionId !== sessionId && !closeIfStopped(workDir, r));
  if (projectConflict) {
    console.warn(`[gtd] skip(checklist): open GTD for projectDir=${projectDir} already exists (session=${projectConflict.sessionId})`);
    return projectConflict;
  }
  if (chatIdStr) {
    const conflict = listGtd(workDir).find(r => r.status === 'open' && r.chatId === chatIdStr && r.sessionId !== sessionId && !closeIfStopped(workDir, r));
    if (conflict) {
      console.warn(`[gtd] skip(checklist): open GTD for chatId=${chatIdStr} already exists (session=${conflict.sessionId})`);
      return conflict;
    }
  }
  const now = Date.now();
  const maxIterations = computeMaxIterations(checklist);
  const rec = {
    sessionId, chatId: chatId != null ? String(chatId) : null,
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
    username: username || null,
    audience: audience || 'default',
    createdAt: now,
    dueAt: now + ETA_MIN_CLAMP * 60 * 1000, // чек-лист = обычно быстрые объективные проверки (CI/деплой)
    etaMinutes: ETA_MIN_CLAMP,
    iterations: 0,
    maxIterations,
    status: 'open',
    originalTask: checklist.goal || '(см. checklist.md)',
    goals: checklist.goal ? [checklist.goal] : [],
    projectDir,
    lastFiredAt: null,
    closedReason: null,
    consecutiveNoProgress: 0,
  };
  writeGtd(workDir, rec);
  console.log(`[gtd] scheduled(checklist) session=${sessionId} user=${username} eta=${ETA_MIN_CLAMP}m maxIterations=${maxIterations} due=${new Date(rec.dueAt).toISOString()}`);
  mirrorGtdChecklist({ username, sessionId, checklist, rec }).catch(() => {});
  return rec;
}

// ── Дешёвая пре-проверка (без LLM, без спавна Claude) ───────────────────────
// Объективные факты — «CI зелёный», «замержено в main» — берём напрямую из
// GitHub API. «Задеплоено и проверено вживую» намеренно НЕ автоматизируем: единого
// health-эндпоинта across репозиториев нет, это остаётся на агента (реальная
// проверка, не рутинный polling — там эскалация до дорогого Claude оправдана).
const CI_ITEM_RE = /\bci\b|зелен|green\s*(check|ci)?/i;
const MERGED_ITEM_RE = /merg|смерж|замерж|влит/i;
const PR_REF_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

function _ghToken(username) {
  try {
    const p = path.join(TOKENS_ROOT, String(username), 'github');
    if (fs.existsSync(p)) return readTokenValue(readCredentialFile(p));
  } catch { /* no token on disk */ }
  return null;
}

async function _ghFetch(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'trained-assist-agent-gtd' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function checklistCheapPrecheck(checklist, { username } = {}) {
  const raw = [checklist.goal, ...checklist.items.map(i => i.text)].filter(Boolean).join('\n');
  const m = raw.match(PR_REF_RE);
  if (!m) return { changed: false, items: checklist.items };
  const token = username ? _ghToken(username) : null;
  if (!token) return { changed: false, items: checklist.items };
  const [, owner, repo, numStr] = m;

  let pr;
  try { pr = await _ghFetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${numStr}`, token); }
  catch (e) { console.warn('[gtd] precheck PR fetch:', e.message); return { changed: false, items: checklist.items }; }
  if (!pr) return { changed: false, items: checklist.items };

  let ciGreen = null;
  if (pr.head?.sha) {
    try {
      const checks = await _ghFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, token);
      const runs = checks?.check_runs || [];
      // Same rule as the ci_green validator (checkRunsGreen): conditional jobs
      // (autofix/notify-merge-queue/close-original) skip by design — they must
      // not keep the checklist's CI box unticked forever.
      if (runs.length) ciGreen = checkRunsGreen(runs);
    } catch (e) { console.warn('[gtd] precheck checks fetch:', e.message); }
  }

  let changed = false;
  const items = checklist.items.map(item => {
    if (item.done) return item;
    if (CI_ITEM_RE.test(item.text) && ciGreen === true) { changed = true; return { ...item, done: true }; }
    if (MERGED_ITEM_RE.test(item.text) && pr.merged === true) { changed = true; return { ...item, done: true }; }
    return item;
  });
  return { changed, items };
}

// Флипает только чекбоксы, не трогая остальной текст — безопасно для
// произвольного содержимого checklist.md (заголовки, Goal:, заметки).
// Пункты из readChecklist несут `line` — правим ровно эти строки. Порядковый
// проход по всему файлу наложил бы активную секцию на первые её чекбоксы в
// начале файла, т.е. затёр бы чужую (старшую) секцию. Для items без линии
// (легаси-вызовы, тесты) остаётся прежний порядковый фолбэк.
function writeChecklistDone(projectDir, items) {
  const fp = path.join(projectDir, CHECKLIST_FILE);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return false; }
  const doneRe = /^(\s*-\s*\[)([ xX])(\]\s*)(.+)$/;
  const lines = raw.split('\n');
  if (items.length && items.every(it => Number.isInteger(it.line))) {
    for (const it of items) {
      const m = lines[it.line] && lines[it.line].match(doneRe);
      if (!m) continue;
      lines[it.line] = `${m[1]}${it.done ? 'x' : ' '}${m[3]}${m[4]}`;
    }
  } else {
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(doneRe);
      if (!m) continue;
      const upd = items[idx]; idx++;
      if (!upd) continue;
      lines[i] = `${m[1]}${upd.done ? 'x' : ' '}${m[3]}${m[4]}`;
    }
  }
  try { atomicText(fp, lines.join('\n')); return true; }
  catch (e) { console.error('[gtd] writeChecklistDone:', e.message); return false; }
}

// Forum topics (#255): a delayed GTD notification must return to the topic it was
// created from. threadId omitted entirely when absent (private/non-forum unchanged).
// extra (optional): доп. поля sendMessage, напр. reply_markup (кнопки напоминания об
// осиротевшем чек-листе). Возвращает message_id отправленного сообщения или null.
async function _tgNotify(botToken, chatId, text, threadId = null, extra = null) {
  if (!botToken || !chatId) return null;
  const base = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const body = { chat_id: chatId, text, ...(extra || {}) };
  if (Number.isInteger(threadId) && threadId > 0) body.message_thread_id = threadId;
  try {
    const res = await fetch(`${base}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    // Отказ Telegram (не тот бот, чат недоступен) не должен пропадать молча (#1517).
    if (res && !res.ok) {
      let desc = '';
      try { desc = (await res.json()).description || ''; } catch { /* not JSON */ }
      console.warn(`[gtd] tgNotify chat=${chatId} failed: HTTP ${res.status} ${desc}`.trim());
      return null;
    }
    try { const data = await res.json(); return data?.result?.message_id ?? null; } catch { return null; }
  } catch (e) { console.warn('[gtd] tgNotify:', e.message); return null; }
}

const REOPEN_INTRO = '[GTD — авто-доведение задачи до конца]';

function buildReopenMessage(rec) {
  // Перечитываем checklist.md заново каждую итерацию — так видим пункты,
  // отмеченные [x] предыдущей попыткой, вместо статичного усечённого task.
  const checklist = trackedChecklist({ ...rec });
  const summary = checklistSummary(checklist);
  // Предупреждение об усложнении появляется начиная со 2-й попытки — первая
  // попытка имеет право попробовать; если не получилось дважды, скорее всего
  // задача сложнее оценки и дальнейшее упорство только создаёт больше кода.
  const escalateWarning = rec.iterations >= 2
    ? `\n\nЕсли задача оказалась заметно крупнее оценки — не раздувай её. Просто напиши строкой: GTD: escalated`
    : '';
  return [
    REOPEN_INTRO,
    `Продолжаем задачу (итерация ${rec.iterations} из ${rec.maxIterations}) — доводим до конца без спешки.${escalateWarning}`,
    '',
    'Проверь по ФАКТУ (с диска / из сети, не по памяти): всё ли реально доехало — прод/PR/деплой/результат, а не только «лежит в коде»?',
    summary
      ? '• Если всё готово — отметь оставшиеся пункты `- [x]` в checklist.md, кратко подтверди и в самом конце ответа напиши строкой: GTD: done'
      : '• Если всё готово — кратко подтверди что сделано и в самом конце ответа напиши строкой: GTD: done',
    summary
      ? '• Если нет — сделай ещё одну попытку (можно другим путём, чем прошлая). ПЕРЕД работой создай GitHub issue на то, что собираешься сделать'
        + '\n  (или подними уже открытый issue с прошлого шага и двигай его), потом выполни, отмечая закрытые пункты в checklist.md. В конце напиши строкой: GTD: continue'
      : '• Если нет — сделай ещё одну попытку (можно другим путём, чем прошлая). ПЕРЕД работой создай GitHub issue на то, что собираешься сделать'
        + '\n  (или подними уже открытый issue с прошлого шага и двигай его), потом выполни. В конце напиши строкой: GTD: continue',
    '• Если задача оказалась существенно сложнее первоначальной оценки (нужно намного больше кода, затрагивает много новых компонентов) — не усложняй. Напиши строкой: GTD: escalated',
    '• Если всё оставшееся — шаг, который может сделать ТОЛЬКО человек (живая проверка в чате, ручное решение), НЕ эскалируй и не выдумывай себе работу. Напиши строкой: GTD: blocked-on-human',
    // BV-08: секция без владельца к этой сессии не прицепится — пусть агент подписывает свои.
    rec.sessionId ? `• Если дописываешь в checklist.md новую секцию \`Goal:\` — сразу под ней поставь строку \`Owner-session: ${rec.sessionId}\`.` : null,
    // Доводка осиротевшего чек-листа («▶️ Делать»): сессия новая и может стоять в другой папке.
    rec.source === 'orphan-checklist' && rec.projectDir ? `• Чек-лист лежит здесь: ${path.join(rec.projectDir, CHECKLIST_FILE)}` : null,
    '',
    summary || `Исходная задача: ${rec.originalTask || '(см. историю сессии)'}`,
  ].filter(l => l !== null).join('\n');
}

const DONE_RE      = /GTD:\s*done/i;
const ESCALATED_RE = /GTD:\s*escalated/i;
// Последний шаг — за человеком (живая проверка/ручное решение): GTD не может его
// доделать и НЕ должен закрывать это как «задача сложнее, чем думали» — иначе
// авто-цикл вхолостую жжёт попытки и врёт про сложность.
const BLOCKED_RE   = /GTD:\s*blocked[-_ ]?on[-_ ]?human|GTD:\s*жд[её]т\s+человека/i;

// Итог GTD-итерации, перезапущенной после рестарта (resumePendingTasks): исходный
// .then() из runDue умер вместе с процессом, поэтому «GTD: done» некому разобрать —
// запись оставалась open, футер «Чеклист активен» висел под ответом «сделано».
function settleResumedGtd(workDir, sessionId, reply, { now = Date.now() } = {}) {
  const rec = readGtd(workDir, sessionId);
  if (!rec || rec.status !== 'open') return null;
  const said = typeof reply === 'string' ? reply : '';
  // Ответ остановки — терминал, а не «поставить dueAt заново» (иначе остановленная
  // доводка перерождается на следующем тике, ровно инцидент §0).
  if (isUserStoppedReply(said)) rec.closedReason = 'user-stop';
  else if (DONE_RE.test(said)) rec.closedReason = 'done';
  else if (ESCALATED_RE.test(said)) rec.closedReason = 'complexity-escalated';
  else if (BLOCKED_RE.test(said)) rec.closedReason = 'awaiting-human';
  else { rec.dueAt = now + rec.etaMinutes * 60 * 1000; writeGtd(workDir, rec); return rec; }
  rec.status = 'closed';
  writeGtd(workDir, rec);
  console.log(`[gtd] closed ${sessionId}: ${rec.closedReason} (resumed after restart)`);
  return rec;
}

// «Стоп» и GTD — ОДИН предикат для всех мест (тик, /tasks/stop, конфликт при
// планировании): запись остановлена, если трейс её диалога помечен Стопом НЕ
// раньше её создания. Запись, созданная после Стопа (новая задача юзера, K1),
// не трогается. Координаты — как у тика: rec.* приоритетнее сессии (#1302 §3.3).
function gtdTraceOf(workDir, rec, session) {
  const sess = session === undefined ? require('./session-store').getSession(workDir, rec.sessionId) : session;
  const chatId = rec.chatId || sess?.liveChatId || sess?.ownerChatId || null;
  const audience = rec.audience ?? sess?.audience ?? 'default';
  return traceIdFor({ chatId, audience, threadId: rec.threadId || null, username: rec.username, sessionId: rec.sessionId });
}

function isGtdStopped(workDir, rec, { session, trace } = {}) {
  if (!rec || rec.status !== 'open') return false;
  const t = trace !== undefined ? trace : gtdTraceOf(workDir, rec, session);
  const stoppedAt = traceStoppedAt(t);
  if (stoppedAt == null) return false;
  // Запись без createdAt (до этого поля) создана заведомо раньше отметки.
  const createdAt = Number.isFinite(rec.createdAt) ? rec.createdAt : 0;
  return stoppedAt >= createdAt;
}

function closeGtdAsStopped(workDir, rec) {
  rec.status = 'closed'; rec.closedReason = 'user-stop';
  writeGtd(workDir, rec);
}

// D2 анализа дедлоков: «конфликтующая» open-запись, которую Стоп уже приговорил
// (тик её ещё не дошёл), не должна заслонять новую проработку юзера — иначе
// maybeSchedule вернёт старую запись, тик закроет её как user-stop, и новая
// задача останется без доводки. true = запись закрыта, конфликта нет.
function closeIfStopped(workDir, rec) {
  try {
    if (!isGtdStopped(workDir, rec)) return false;
    closeGtdAsStopped(workDir, rec);
    console.log(`[gtd] closed ${rec.sessionId}: user-stop (stale, found at scheduling)`);
    return true;
  } catch { return false; } // не смогли проверить — прежнее поведение (конфликт)
}

// /tasks/stop: закрыть ровно те open-записи, чьи трейсы только что помечены
// Стопом (тот же предикат, что у тика — просто раньше, чтобы ответ шлюзу был
// честным). В отличие от clearAllGtd не трогает соседние чаты/боты профиля:
// трейс включает бота+чат+топик, а метятся только трейсы владельца Стопа.
function closeStoppedGtd(workDir) {
  let count = 0;
  for (const rec of listGtd(workDir)) {
    try {
      if (!isGtdStopped(workDir, rec)) continue;
      closeGtdAsStopped(workDir, rec);
      console.log(`[gtd] closed ${rec.sessionId}: user-stop (via /tasks/stop)`);
      count++;
    } catch (e) { console.warn(`[gtd] closeStoppedGtd ${rec?.sessionId}: ${e.message}`); }
  }
  return count;
}

// Cancel all open GTD records for a profile (all its chats). Only meant for a
// genuinely profile-wide caller — most /stop-style commands should use
// clearGtdForChat below, since one profile's workDir is shared across chats.
function clearAllGtd(workDir) {
  const recs = listGtd(workDir);
  let count = 0;
  for (const rec of recs) {
    if (rec.status === 'open') {
      rec.status = 'closed';
      rec.closedReason = 'user-stop';
      writeGtd(workDir, rec);
      count++;
    }
  }
  return count;
}

// Cancel open GTD records belonging to sessions attached to ONE chat (e.g. on
// /stop typed in that chat). A profile's workDir — and therefore its gtd/
// records — is shared across every chat of that profile, so naively closing
// "all open records" from a single chat's /stop cancels проработка running in
// other chats too. Resolve each record's owning session and only touch it if
// that session is currently live in this chat. Returns count of cancelled records.
function clearGtdForChat(workDir, chatId, threadId = null) {
  if (!chatId) return 0;
  const { getSession } = require('./session-store');
  const recs = listGtd(workDir);
  let count = 0;
  for (const rec of recs) {
    if (rec.status !== 'open') continue;
    // Forum topics (#255): a stop in topic A must not cancel topic B's tracking.
    if (Number.isInteger(threadId) && threadId > 0 && rec.threadId != null && Number(rec.threadId) !== Number(threadId)) continue;
    const sess = getSession(workDir, rec.sessionId);
    const attachedChatId = sess ? (sess.liveChatId ?? sess.ownerChatId) : null;
    if (attachedChatId == null || String(attachedChatId) !== String(chatId)) continue;
    rec.status = 'closed';
    rec.closedReason = 'user-stop';
    writeGtd(workDir, rec);
    count++;
  }
  return count;
}

// ── Durable fire budget + immediate claim (#1752) ─────────────────────────────
// Budget = free engine slots when the host reports them, else the legacy cap.
function durableBudget(freeSlots) {
  if (typeof freeSlots !== 'function') return MAX_FIRES_PER_TICK;
  try { const n = Number(freeSlots()); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_FIRES_PER_TICK; }
  catch { return MAX_FIRES_PER_TICK; }
}
// One durable pass at a time: the 5-min tick and the post-settle kick share a chain,
// so two passes never claim over each other.
let _durableChain = Promise.resolve();
function runDurableSerialized(opts) {
  const p = _durableChain.then(() => runDueDurable(opts));
  _durableChain = p.catch(() => {});
  return p;
}
// A settled step claims the plan's next step now instead of at the next tick.
// Debounced; a no-op until the first tick has recorded the runtime deps.
let _kickDeps = null;
let _kickTimer = null;
const KICK_DEBOUNCE_MS = Number(process.env.DURABLE_KICK_DEBOUNCE_MS || 3000);
function kickDurable() {
  if (!_kickDeps || _kickTimer) return;
  _kickTimer = setTimeout(() => {
    _kickTimer = null;
    const d = _kickDeps;
    runDurableSerialized({ secrets: d.secrets, runTask: d.runTask, isTaskRunning: d.isTaskRunning, now: Date.now(), maxFires: durableBudget(d.freeSlots) })
      .catch(e => console.error('[gtd-durable] kick error:', e.message));
  }, KICK_DEBOUNCE_MS);
  _kickTimer.unref?.();
}
function _setKickDeps(d) { _kickDeps = d; }

// Серверный tick. Аргументы инжектятся из server.js, чтобы модуль не тянул
// зависимости и был тестируем: { secrets, baseUsersDir, isTaskRunning, runTask, getSession }.
// Обёртка сериализует проходы (см. _tickInFlight): перекрывающийся тик — no-op.
async function runDue(deps) {
  if (_tickInFlight) { console.warn('[gtd] tick skipped: previous tick still in flight'); return; }
  _tickInFlight = true;
  const startedAt = Date.now();
  _tickHeartbeat.lastStartAt = startedAt;
  try {
    const result = await _runDueInner(deps);
    _tickHeartbeat.lastError = null;
    return result;
  } catch (e) {
    _tickHeartbeat.lastError = e.message;
    throw e;
  } finally {
    _tickInFlight = false;
    _tickHeartbeat.lastFinishAt = Date.now();
    _tickHeartbeat.lastDurationMs = _tickHeartbeat.lastFinishAt - startedAt;
    _tickHeartbeat.tickCount += 1;
  }
}

async function _runDueInner({ secrets, baseUsersDir, isTaskRunning, runTask, getSession, canRunSession = () => true, freeSlots = null, now = Date.now() }) {
  // Slice A: durable-task scheduler runs alongside the legacy file scan.
  // #1752: durable steps fire into the host's FREE engine slots (no fixed 3/tick) —
  // slot management is the only limit; a full host fires nothing and the steps wait.
  _kickDeps = { secrets, runTask, isTaskRunning, freeSlots };
  try { await runDurableSerialized({ secrets, runTask, isTaskRunning, now, maxFires: durableBudget(freeSlots) }); }
  catch (e) { console.error('[gtd-durable] tick error:', e.message); }

  // BV-08: одно напоминание об осиротевшем чек-листе (не раньше 30 мин после
  // обнаружения). Тот же тик — никаких новых таймеров/кронов (#1489).
  try {
    await require('./orphan-checklists').remindDue({
      secrets, baseUsersDir, now,
      isSessionRunning: (username, sid) => { try { return !!isTaskRunning(username, sid); } catch { return false; } },
    });
  } catch (e) { console.error('[orphan-checklists] tick error:', e.message); }

  const users = listProfiles(baseUsersDir).filter(u => /^[a-zA-Z0-9_-]+$/.test(u));

  // Flatten + sort by dueAt (oldest-overdue-first) BEFORE applying MAX_FIRES_PER_TICK.
  // fs.readdirSync order is filesystem-arbitrary but stable across ticks — without this
  // sort, whichever users/records happen to list first would win every tick's fire slots
  // while later ones starve indefinitely (checklists that silently never progress).
  const due = [];
  for (const username of users) {
    const workDir = path.join(baseUsersDir, username);
    for (const rec of listGtd(workDir).filter(r => r && r.status === 'open' && r.dueAt <= now)) {
      due.push({ username, workDir, rec });
    }
  }
  due.sort((a, b) => a.rec.dueAt - b.rec.dueAt);

  let fired = 0;
  for (const { username, workDir, rec } of due) {
    if (fired >= MAX_FIRES_PER_TICK) break;

    // Re-entrancy guard: тот же sessionId уже обрабатывается — не переоткрываем.
      // Проверяем по sessionId, а не по username, чтобы разные GTD одного профиля
      // могли стрелять параллельно (разные чаты, разные задачи).
      if (isTaskRunning(username, rec.sessionId)) { console.log(`[gtd] skip ${rec.sessionId}: task running for this session`); continue; }

      if (!canRunSession(username, rec.sessionId)) continue;
      const session = getSession(workDir, rec.sessionId);
      // rec.audience is durable and wins once set — a session's audience must never
      // silently override an already-recorded GTD record (see #1302 §3.3). Falls back
      // to session.audience for legacy GTD records that predate this field.
      const audience = rec.audience ?? session?.audience ?? 'default';
      let routeSecrets;
      try { routeSecrets = require('./bot-delivery').deliverySecrets(secrets, audience); }
      catch (e) { console.error('[gtd] delivery unavailable:', e.message); continue; }
      if (!session) { clearGtd(workDir, rec.sessionId); continue; }

      // Дешёвая пре-проверка ПЕРЕД тем как будить дорогого Claude/Codex: объективные
      // факты (CI зелёный / замержено) берём напрямую из GitHub API. Если чек-лист
      // закрылся целиком уже на этом шаге — не расходуем ни итерацию, ни Claude-сессию.
      if (rec.projectDir) {
        const checklist = trackedChecklist(rec);
        if (checklist && checklist.items.length) {
          let pre = { changed: false, items: checklist.items };
          try { pre = await checklistCheapPrecheck(checklist, { username }); }
          catch (e) { console.warn(`[gtd] precheck ${rec.sessionId}:`, e.message); }
          if (pre.changed) writeChecklistDone(rec.projectDir, pre.items);
          mirrorGtdChecklist({ username, sessionId: rec.sessionId, checklist: { ...checklist, items: pre.items }, rec }).catch(() => {});
          if (pre.items.every(i => i.done)) {
            rec.status = 'closed'; rec.closedReason = 'done-precheck';
            writeGtd(workDir, rec);
            console.log(`[gtd] closed ${rec.sessionId}: done-precheck (no Claude spent)`);
            const notifyChatId = rec.chatId || session.liveChatId || session.ownerChatId;
            _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, notifyChatId,
              `✅ Чек-лист закрыт автопроверкой (CI/merge через GitHub API, без затрат на Claude):\n${pre.items.map(i => `✓ ${i.text}`).join('\n')}`,
              rec.threadId
            ).catch(() => {});
            continue;
          }
        }
      }

      const chatId = rec.chatId || session.liveChatId || session.ownerChatId; // liveChatId (was ownerChatId); read-compat

      if (!chatId) { // некому отвечать — не будим сессию вслепую (проверяем ДО инкремента)
        rec.status = 'closed'; rec.closedReason = 'no-owner-chat';
        writeGtd(workDir, rec);
        continue;
      }

      // R3/SK-04: «Стоп» в этом диалоге закрывает доводку. Проверяем ДО
      // инкремента, чтобы остановленная запись не сжигала итерацию и не
      // будила Claude. Записи, созданные ПОСЛЕ отметки Стопа (rec.createdAt
      // > stoppedAt) — новая задача юзера — продолжают работать (K1).
      {
        const trace = traceIdFor({
          chatId, audience, threadId: rec.threadId || null, username, sessionId: rec.sessionId,
        });
        if (isGtdStopped(workDir, rec, { trace })) {
          closeGtdAsStopped(workDir, rec);
          console.log(`[gtd] closed ${rec.sessionId}: user-stop (trace stopped)`);
          continue;
        }
      }

      // Инкремент + persist ДО запуска — durable, переживает краш итерации.
      rec.iterations += 1;
      rec.lastFiredAt = now;
      // Fire-lease: сразу двигаем dueAt вперёд (см. FIRE_LEASE_MS). Живой run
      // перепишет dueAt по факту в .then(); потерянный (краш процесса) честно
      // перезапустится через лизинг — не хаммерится каждый тик и не застревает.
      rec.dueAt = now + FIRE_LEASE_MS;
      if (rec.iterations > rec.maxIterations) {
        rec.status = 'closed';
        rec.closedReason = 'max-iterations';
        writeGtd(workDir, rec);
        console.log(`[gtd] closed ${rec.sessionId}: max-iterations`);
        _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
          `⚠️ GTD: авто-доведение остановлено — превышен лимит попыток. Задача: «${(rec.originalTask || '').slice(0, 100)}»`,
          rec.threadId
        ).catch(() => {});
        continue;
      }
      writeGtd(workDir, rec);

      const user = { id: chatId, name: username, username, workDir, audience };
      // sessionId in the id: sessions fired in one tick share `now`, and taskId keys the pending
      // journal and the active-run map — a shared id would merge two concurrent runs into one.
      const taskId = `${username}-gtd-${rec.sessionId}-${now}`;
      fired += 1;
      console.log(`[gtd] fire session=${rec.sessionId} iter=${rec.iterations}/${rec.maxIterations}`);

      // GTD fire label — visible marker so the user knows this reply is a scheduled check.
      _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
        `🔄 GTD — авто-проверка · итерация ${rec.iterations}/${rec.maxIterations}`,
        rec.threadId
      ).catch(() => {});

      // Snapshot done-count before run, for progress-check after.
      const checklistBefore = trackedChecklist(rec);
      const doneCountBefore = checklistBefore ? checklistBefore.items.filter(i => i.done).length : -1;

      // Fire without awaiting — loop continues to next session immediately.
      // Completion logic runs in .then()/.catch() once Claude responds.
      const _recSnap = { ...rec };
      runTask({
        taskId, user, task: buildReopenMessage(_recSnap),
        sessionId: _recSnap.sessionId, forceClaude: true, engine: 'claude',
        secrets, internalGtd: true, threadId: _recSnap.threadId || null,
      }).then(reply => {
        // backoff считаем от РЕАЛЬНОГО времени завершения, а не от stale-now момента
        // выстрела: run легитимно длится десятки минут, иначе следующая проверка
        // назначалась бы в прошлом и стреляла бы мгновенно на ближайшем тике.
        const doneAt = Date.now();
        // Терминал: итерация сказала done/escalated, либо исчерпали cap.
        const said = typeof reply === 'string' ? reply : '';
        const stoppedNow = isUserStoppedReply(said);
        const doneNow      = DONE_RE.test(said);
        const escalatedNow = ESCALATED_RE.test(said);
        const blockedNow   = BLOCKED_RE.test(said);
        // Запись исчезла (сессия удалена / user-stop → clearGtd) — НЕ воскрешаем её
        // записью in-memory снапшота: намеренно закрытое должно остаться закрытым.
        const fresh = readGtd(workDir, _recSnap.sessionId);
        if (!fresh) { console.log(`[gtd] ${_recSnap.sessionId}: record gone at completion — not resurrecting`); return; }
        if (fresh.status !== 'open') { console.log(`[gtd] ${_recSnap.sessionId}: already ${fresh.status} at completion — leaving as-is`); return; }
        if (stoppedNow) {
          // R3: итерация вернулась «⛔ Остановлено…» (гейт либо живой kill).
          // Запись закрывается, а не переносится на dueAt — иначе доводка
          // «перерождается» на следующем тике (инцидент §0).
          fresh.status = 'closed'; fresh.closedReason = 'user-stop';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: user-stop (iteration replied with a stop)`);
        } else if (doneNow) {
          fresh.status = 'closed'; fresh.closedReason = 'done';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: done`);
        } else if (escalatedNow) {
          fresh.status = 'closed'; fresh.closedReason = 'complexity-escalated';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: complexity-escalated`);
          _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
            `⚠️ GTD остановлен — задача оказалась сложнее первоначальной оценки.\n`
            + `Агент остановил попытки (было ${fresh.iterations}), чтобы не усложнять.\n`
            + `Рассмотрите задачу отдельно: ${(fresh.originalTask || '').slice(0, 200) || '(см. сессию)'}`,
            _recSnap.threadId
          ).catch(() => {});
        } else if (blockedNow) {
          fresh.status = 'closed'; fresh.closedReason = 'awaiting-human';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: awaiting-human`);
          _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
            `⏳ GTD остановлен — дальше только шаг за тобой (живая проверка/ручное действие).\n`
            + `Задача: «${(fresh.originalTask || '').slice(0, 200) || '(см. сессию)'}»\n`
            + `Авто-доведение выключено, чтобы не гонять попытки вхолостую.`,
            _recSnap.threadId
          ).catch(() => {});
        } else if (fresh.iterations >= fresh.maxIterations) {
          fresh.status = 'closed'; fresh.closedReason = 'max-iterations';
          writeGtd(workDir, fresh);
          console.log(`[gtd] closed ${_recSnap.sessionId}: max-iterations (post-run)`);
        } else {
          // Progress-check: if checklist exists and no new items were checked off, track stall.
          if (_recSnap.projectDir && doneCountBefore >= 0) {
            const checklistAfter = trackedChecklist(fresh);
            mirrorGtdChecklist({ username, sessionId: _recSnap.sessionId, checklist: checklistAfter, rec: fresh }).catch(() => {});
            const doneCountAfter = checklistAfter ? checklistAfter.items.filter(i => i.done).length : doneCountBefore;
            if (doneCountAfter > doneCountBefore) {
              fresh.consecutiveNoProgress = 0;
            } else {
              fresh.consecutiveNoProgress = (fresh.consecutiveNoProgress || 0) + 1;
              if (fresh.consecutiveNoProgress >= 2) {
                fresh.status = 'closed'; fresh.closedReason = 'no-progress';
                writeGtd(workDir, fresh);
                console.log(`[gtd] closed ${_recSnap.sessionId}: no-progress (${fresh.consecutiveNoProgress} consecutive stalled iterations)`);
                _tgNotify(routeSecrets?.TELEGRAM_BOT_TOKEN, chatId,
                  `⚠️ GTD: остановлен — нет прогресса за 2 итерации. Задача: «${(fresh.originalTask || '').slice(0, 100)}»`,
                  _recSnap.threadId
                ).catch(() => {});
                return;
              }
            }
          }
          fresh.dueAt = doneAt + fresh.etaMinutes * 60 * 1000; // backoff от времени завершения
          writeGtd(workDir, fresh);
        }
      }).catch(e => {
        console.error(`[gtd] runTask ${_recSnap.sessionId}:`, e.message);
        // Не закрываем — попробуем на следующем tick (в пределах maxIterations).
        // Так же, как в .then(): не воскрешаем удалённую/закрытую запись.
        const r = readGtd(workDir, _recSnap.sessionId);
        if (!r || r.status !== 'open') return;
        r.dueAt = Date.now() + r.etaMinutes * 60 * 1000;
        writeGtd(workDir, r);
      });
  }
}

module.exports = {
  detectIntent, maybeSchedule, scheduleFromChecklist, runDue, buildReopenMessage,
  readGtd, writeGtd, clearGtd, clearGtdForChat, clearAllGtd, closeStoppedGtd, isGtdStopped, listGtd, settleResumedGtd,
  readChecklist, trackedChecklist, checklistSummary, computeMaxIterations,
  setChecklistOwner, markChecklistCancelled, claimFreshChecklist, _tgNotify,
  checklistCheapPrecheck, writeChecklistDone, mirrorGtdChecklist, CHECKLIST_API_BASE, checklistAutologinUrl,
  _ghToken, _ghFetch,
  durableStore, runDueDurable, reconcileOrphanedRunning, claimNextDurableItem, retryFailedItem,
  resumeDurableReply, resumeDurableCrash, planWorkspaceLabel, kickDurable, durableBudget, _setKickDeps,
  tickHeartbeat, countOpenLegacy, durableItemCounts, firstFailureNotice, planLabel, bgStepText,
  DEFAULT_MAX_ITERATIONS, ETA_MIN_CLAMP,
  CHECKLIST_MAX_ITERATIONS, MAX_FIRES_PER_TICK, FIRE_LEASE_MS,
};
