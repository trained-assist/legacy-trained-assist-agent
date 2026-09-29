'use strict';

// Durable wait ("wait-until") for durable plan items — pure logic, no I/O.
//
// A plan step can sleep until something outside the run happens: CI goes green,
// a deploy is live, the user sends credentials, an error shows up in the logs
// again, another plan finishes, or simply a timer fires. The industry shape is
// Temporal's `await condition` / durable timer / signal, or Step Functions'
// wait state + callback token; here it is a column on the item (`wait_json`)
// that the existing 5-minute GTD tick polls — deterministic validators only, no
// model — until the condition passes, the item is woken, or the deadline hits.
//
// Two ways into a wait, one state shape:
//   • declared by the playbook on a programmatic step (`wait: {poll_every_sec,
//     timeout_sec}`): the condition is the step's own `validation`, and a pass
//     completes the step (then = 'complete');
//   • requested by an agent mid-step via MCP `task_item_wait` + a final
//     `DURABLE: waiting` line: the condition is `until` (any registered
//     validator keys), or a user answer (`awaiting_user`), or just a timer —
//     and when it resolves the SAME step is re-run with a note on what
//     happened (then = 'rerun').
//
// wait_json fields: then, until, awaiting_user, reason, poll_every_sec,
// timeout_sec, started_at, deadline_at, last_poll_at, last_poll, woken_at,
// woken_by, wake_message, resolved ('satisfied'|'woken'|'failed'|'timeout'), resolved_at,
// resolve_evidence.

const DEFAULT_POLL_SEC = 300;
// Floor of the wait tick (durable-wait-latency design §2.1): a waiting step may
// ask to be polled every 30s — matching the dedicated 30s wait tick in server.js.
const MIN_POLL_SEC = 30;
const DEFAULT_TIMEOUT_SEC = 24 * 3600;
const MAX_TIMEOUT_SEC = 30 * 24 * 3600;

function parseWait(item) {
  const raw = item && item.wait_json;
  if (!raw) return null;
  try {
    const wait = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return wait && typeof wait === 'object' && !Array.isArray(wait) ? wait : null;
  } catch { return null; }
}

// A wait the tick should still poll: declared/requested and not yet resolved.
function isActiveWait(wait) {
  return !!wait && !wait.resolved;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Fill started_at / deadline_at the first time a wait is seen (a playbook wait
// is armed when the step is first claimed, not when the plan is compiled).
function startWait(wait, now) {
  if (wait.started_at && wait.deadline_at) return wait;
  const timeoutSec = clampInt(wait.timeout_sec, MIN_POLL_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC);
  const startedAt = wait.started_at || now;
  return { ...wait, timeout_sec: timeoutSec, started_at: startedAt, deadline_at: startedAt + timeoutSec * 1000 };
}

/**
 * Normalize an agent's task_item_wait request. `registryKeys` is the list of
 * deterministic validator keys: an `until` naming anything else could never
 * pass, so it is rejected up front instead of silently sleeping to timeout.
 * @returns {{wait?: object, error?: string}}
 */
function normalizeAgentWait(req, { now, registryKeys = [] } = {}) {
  const r = req || {};
  const hasUntil = r.until != null;
  if (hasUntil && (typeof r.until !== 'object' || Array.isArray(r.until) || !Object.keys(r.until).length)) {
    return { error: 'until must be an object of validator keys, e.g. {"ci_green": "<PR url>"}' };
  }
  if (hasUntil) {
    const unknown = Object.keys(r.until).filter(k => !registryKeys.includes(k));
    if (unknown.length) {
      return { error: `unknown validator key(s) in until: ${unknown.join(', ')}. Known: ${registryKeys.join(', ')}` };
    }
  }
  const awaitingUser = r.awaiting_user === true;
  const sleepSec = r.sleep_sec != null ? clampInt(r.sleep_sec, MIN_POLL_SEC, MAX_TIMEOUT_SEC, null) : null;
  if (!hasUntil && !awaitingUser && !sleepSec) {
    return { error: 'give at least one of: until (a condition), awaiting_user=true (a user answer), sleep_sec (a timer)' };
  }
  const timeoutSec = clampInt(r.timeout_sec ?? sleepSec ?? DEFAULT_TIMEOUT_SEC, MIN_POLL_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC);
  const wait = {
    then: 'rerun',
    until: hasUntil ? r.until : null,
    awaiting_user: awaitingUser,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 1000) : null,
    poll_every_sec: clampInt(r.poll_every_sec, MIN_POLL_SEC, MAX_TIMEOUT_SEC, DEFAULT_POLL_SEC),
    timeout_sec: timeoutSec,
    started_at: now,
    deadline_at: now + timeoutSec * 1000,
  };
  return { wait };
}

/**
 * Decide what a poll means. `results` are deterministic validator verdicts for
 * the condition (null when the wait has no condition — a timer or user wait).
 * @returns {'satisfied'|'woken'|'failed'|'timeout'|'keep'}
 */
function decidePoll(wait, results, now) {
  if (wait.woken_at) return 'woken';
  if (Array.isArray(results) && results.length && results.every(r => r.status === 'pass')) return 'satisfied';
  // A validator may mark a fail as final (e.g. CI finished red): waiting longer
  // cannot turn it green, so wake now and let the step repair or fail.
  if (Array.isArray(results) && results.some(r => r.status === 'fail' && r.evidence && r.evidence.final === true)) return 'failed';
  if (now >= wait.deadline_at) return 'timeout';
  return 'keep';
}

// When to look again: the next poll for a condition, otherwise the deadline
// (a pure timer / user wait has nothing to poll — a wake moves due_at to now).
function nextDueAt(wait, now) {
  if (wait.until || wait.then === 'complete') {
    const poll = clampInt(wait.poll_every_sec, MIN_POLL_SEC, MAX_TIMEOUT_SEC, DEFAULT_POLL_SEC) * 1000;
    return Math.min(now + poll, wait.deadline_at);
  }
  return wait.deadline_at;
}

function summarizeResults(results) {
  return (results || []).map(r => ({ key: r.key, status: r.status, evidence: r.evidence ?? null }));
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 120) return `${min} мин`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} ч` : `${Math.round(h / 24)} дн`;
}

// Prompt section for a step resumed after a wait (then = 'rerun').
function resumeNote(wait, now = Date.now()) {
  if (!wait || !wait.resolved) return '';
  const waited = wait.started_at ? fmtDuration((wait.resolved_at || now) - wait.started_at) : null;
  const lines = ['[ПРОБУЖДЕНИЕ ПОСЛЕ ОЖИДАНИЯ]'];
  if (wait.reason) lines.push(`Ты ждал: ${wait.reason}`);
  if (waited) lines.push(`Ожидание длилось: ${waited}.`);
  if (wait.resolved === 'satisfied') {
    lines.push(`Условие выполнено: ${JSON.stringify(wait.until)}.`);
    if (wait.resolve_evidence) lines.push(`Evidence: ${JSON.stringify(wait.resolve_evidence).slice(0, 1500)}`);
  } else if (wait.resolved === 'woken') {
    lines.push(`Тебя разбудил: ${wait.woken_by || 'user'}.`);
    if (wait.wake_message) lines.push(`Сообщение: ${wait.wake_message}`);
  } else if (wait.resolved === 'failed') {
    lines.push(`Условие окончательно НЕ выполнилось (ждать дальше бессмысленно): ${JSON.stringify(wait.until)}.`);
    if (wait.resolve_evidence) lines.push(`Evidence: ${JSON.stringify(wait.resolve_evidence).slice(0, 1500)}`);
    lines.push('Разберись: почини причину (новый коммит/PR по правилам репо) и снова task_item_wait, либо DURABLE: failed: <почему>.');
  } else if (wait.resolved === 'timeout') {
    lines.push(wait.until || wait.awaiting_user
      ? 'Ожидание ИСТЕКЛО по таймауту — условие так и не выполнилось / ответа не было.'
      : 'Таймер сработал — время проверить результат.');
    if (wait.until || wait.awaiting_user) {
      lines.push('Реши сам: продолжить без этого, подождать ещё (task_item_wait), напомнить пользователю, или признать план неактуальным (DURABLE: failed: <почему>).');
    }
  }
  lines.push('Продолжи этот же шаг с того места, где остановился (прошлые результаты — в evidence плана/репозитории).');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_POLL_SEC, MIN_POLL_SEC, DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC,
  parseWait, isActiveWait, startWait, normalizeAgentWait, decidePoll, nextDueAt,
  summarizeResults, resumeNote,
};

// Chat-context notice: durable steps of this profile parked on a user answer.
// Injected into normal (non-durable) runs so a reply that arrives days later —
// "вот ключ", "да, делаем вариант B" — wakes the right plan via task_item_wake
// instead of being answered in isolation. '' when nothing is waiting (prompt
// unchanged). `store` is injectable; production uses the GTD singleton.
function buildAwaitingUserNotice(profileId, { store = null } = {}) {
  if (!profileId) return '';
  let rows;
  try {
    const s = store || require('./gtd-controller').durableStore();
    rows = s.listItemsAwaitingUser(String(profileId));
  } catch { return ''; }
  // Batches waiting for the owner: one reply resumes every element — list the batch once
  // and hide its children's individual asks (N identical «нужен токен» lines otherwise).
  let batches = [];
  try {
    const s = store || require('./gtd-controller').durableStore();
    batches = require('./playbook-fanout').listBatchesAwaitingOwner(s, profileId);
    if (batches.length) {
      const hidden = new Set(batches.flatMap(b => b.children));
      rows = (rows || []).filter(r => !hidden.has(r.task_id));
    }
  } catch { batches = []; }
  if ((!rows || !rows.length) && !batches.length) return '';
  const lines = ['[ПЛАНЫ ЖДУТ ОТВЕТА ПОЛЬЗОВАТЕЛЯ]',
    'Эти шаги durable-планов уснули до ответа пользователя. Если текущее сообщение отвечает на один из них — вызови task_item_wake(item_id, message: <ответ>), и план продолжится сам. Если не отвечает — ничего не делай с ними.'];
  for (const b of batches.slice(0, 3)) {
    const names = b.asks.map(a => a.name).join(', ');
    const why = (b.asks[0] && b.asks[0].ask) || (b.paused && b.paused.reason) || 'ответ';
    lines.push(`- ПАЧКА batch_task_id=${b.task_id} «${String(b.title).slice(0, 80)}»${b.paused ? ' (на паузе)' : ''} · ждут: ${names || '—'} · ${String(why).slice(0, 300)} → если сообщение отвечает на это (или причина устранена): playbook_batch_control(batch_task_id, action: "resume", message: <ответ>) — одним вызовом продолжит все элементы.`);
  }
  for (const r of rows.slice(0, 5)) {
    const w = parseWait(r) || {};
    lines.push(`- item_id=${r.id} · план «${String(r.goal).slice(0, 120)}» · шаг «${String(r.title).slice(0, 120)}» · ждём: ${String(w.reason || 'ответ').slice(0, 300)}`);
  }
  return lines.join('\n');
}

module.exports.buildAwaitingUserNotice = buildAwaitingUserNotice;
