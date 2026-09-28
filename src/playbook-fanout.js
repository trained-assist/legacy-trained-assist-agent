'use strict';

// Fanout step (meta-playbooks, epic #1752): run one playbook over N elements.
//
// A batch is an ordinary durable plan (the PARENT) with one programmatic step whose
// `fanout_json` carries the batch config and its durable state. Every element is a
// full CHILD plan (playbook_run of the child playbook, its own project, parent_task_id
// set) — visible in task_list and repairable on its own. The GTD tick advances the
// fanout step before anything else touches it (gtd-controller.runDueDurable):
//
//   1. derive each running child's state from the store (done / failed / stalled);
//   2. on a state change call the SUPERVISOR — a cheap model that picks ONE action
//      from a closed menu (continue / retry_step / skip_item / pause_batch /
//      escalate_owner / wait), bounded by budgets; without a model a deterministic
//      policy decides the same menu;
//   3. spawn queued elements. There is no batch-level concurrency cap (owner decision
//      28.09.2026): children are ordinary plans, and the durable executor fires steps
//      only into free host slots, so host slot management is the only limit;
//   4. join: every element done or skipped → the step's `fanout_joined` validation
//      passes and the parent completes like any programmatic step.
//
// The model never decides WHEN to spawn (that is arithmetic); it only interprets a
// child's failure: «local to this element» vs «will repeat for every element».
// Child task hooks are suppressed (the parent reports once per event) and every
// pause / escalation is always delivered to the owner — a batch never fails silently.

const crypto = require('crypto');

const DEFAULT_POLL_MS = 60 * 1000;
const DEFAULT_STALL_SEC = 3 * 3600;
const DEFAULT_MAX_CHILD_RETRIES = 1;
const DEFAULT_MAX_SUPERVISOR_CALLS = 40;
const ACTIONS = ['continue', 'retry_step', 'skip_item', 'pause_batch', 'escalate_owner', 'wait'];
const TERMINAL = new Set(['done', 'skipped']);

function parseFanout(item) {
  const raw = item && item.fanout_json;
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' && Array.isArray(v.elements) ? v : null;
  } catch { return null; }
}

function saveFanout(store, itemId, state) {
  store.db.prepare('UPDATE task_items SET fanout_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(state), Date.now(), itemId);
}

function joined(state) {
  return !!state && state.elements.length > 0 && state.elements.every(e => TERMINAL.has(e.status));
}

// ── Child state (deterministic) ─────────────────────────────────────────────
// A step that exhausted its recovery budget stays `failed` while its task stays
// `active` (the executor never claims past it) — for the batch that IS a failed child.
function childState(store, childId, profileId, { now = Date.now(), stallMs = DEFAULT_STALL_SEC * 1000 } = {}) {
  const task = store.getTask(childId, profileId);
  if (!task) return { state: 'failed', error: 'child plan vanished' };
  const items = store.listTaskItems(childId, profileId);
  const total = items.length;
  const finished = items.filter(i => i.status === 'done' || i.status === 'skipped').length;
  const progress = { finished, total };
  if (task.status === 'done') return { state: 'done', progress };
  if (task.status === 'cancelled' || task.status === 'failed') {
    return { state: 'failed', progress, error: `plan ${task.status}${task.blocker_reason ? `: ${task.blocker_reason}` : ''}` };
  }
  if (task.status === 'blocked') return { state: 'failed', progress, error: task.blocker_reason || 'finalization blocked' };
  const failed = items.find(i => i.status === 'failed');
  if (failed) {
    return {
      state: 'failed', progress,
      failedItem: { id: failed.id, title: failed.title, stage: failed.stage, position: failed.position,
        error: String(failed.last_error || '').slice(0, 800), failureClass: failed.last_failure_class || null,
        attempts: failed.attempt_count || 0 },
    };
  }
  if (task.status === 'paused') return { state: 'paused', progress };
  const lastActivity = Math.max(task.updated_at || 0, ...items.map(i => i.updated_at || 0));
  const current = items.find(i => !['done', 'skipped'].includes(i.status));
  if (now - lastActivity > stallMs) {
    return { state: 'stalled', progress, lastActivity, current: current ? { id: current.id, title: current.title, status: current.status, error: current.last_error || null } : null };
  }
  return { state: 'running', progress, current: current ? { title: current.title, stage: current.stage, status: current.status } : null };
}

// ── Supervisor ──────────────────────────────────────────────────────────────
const SUPERVISOR_SYSTEM = [
  'Ты супервизор пакетного прогона плейбука по N элементам (например, выставкам). Каждый элемент — отдельный план.',
  'Тебе приходит одно событие по одному элементу и сводка по соседям. Выбери РОВНО ОДНО действие из меню:',
  '- continue: элемент закончил нормально (для события child_done).',
  '- retry_step: сбой локальный и, скорее всего, пройдёт при повторе (сеть/таймаут/парсер споткнулся) — перезапустить упавший шаг.',
  '- skip_item: у этого элемента нет решения (каталога участников нет, сайт выставки мёртв, выставка отменена) — пропустить с причиной.',
  '- pause_batch: сбой СИСТЕМНЫЙ, повторится у всех элементов (нет токена/ключа, упал общий API, квота модели, баг в инструменте) — остановить всю пачку и позвать владельца.',
  '- escalate_owner: непонятно, что делать, или нужен человек — позвать владельца по этому элементу.',
  '- wait: элемент просто долго работает/ждёт внешнего события, вмешательство не нужно (для child_stalled).',
  'Признак системного сбоя: соседи упали на том же шаге с похожей ошибкой, или ошибка про доступ/токен/ключ/квоту/недоступность общего сервиса.',
  'Необязательно: note_for_next — короткий урок для следующих элементов (например, «каталог у этой площадки на поддомене»).',
  'Ответ строго JSON: {"action": "<одно из меню>", "reason": "<1-2 предложения по-русски>", "note_for_next": "<или null>"}',
].join('\n');

function supervisorInput(event, element, state) {
  const neighbours = state.elements.filter(e => e.key !== element.key).map(e => ({
    key: e.key, status: e.status, last_event: e.lastEvent || null,
    failed_step: e.lastFailure?.title || null, error: e.lastFailure?.error ? e.lastFailure.error.slice(0, 200) : null,
  }));
  return JSON.stringify({
    event: event.type,
    element: { key: element.key, goal: element.goal, retries_used: element.retries || 0, max_retries: state.config.max_child_retries },
    child: event.child,
    neighbours,
    past_decisions: (state.journal || []).slice(-8),
  }, null, 1).slice(0, 12000);
}

// Deterministic policy — the fallback when no model answers, and the guard rails
// around a model answer (budgets are enforced here, never by the model).
function defaultDecision(event, element, state) {
  if (event.type === 'child_done') return { action: 'continue', reason: 'элемент завершён' };
  if (event.type === 'child_stalled') return { action: 'escalate_owner', reason: 'элемент давно не двигается' };
  const retries = element.retries || 0;
  if (retries < state.config.max_child_retries && event.child && event.child.failedItem) {
    return { action: 'retry_step', reason: 'первый сбой шага — повтор' };
  }
  // Same step failed for another element too → systemic.
  const sameStep = event.child?.failedItem && state.elements.some(e => e.key !== element.key
    && e.lastFailure && e.lastFailure.title === event.child.failedItem.title);
  if (sameStep) return { action: 'pause_batch', reason: `шаг «${event.child.failedItem.title}» упал и у другого элемента — похоже на общий сбой` };
  return { action: 'escalate_owner', reason: 'повторы исчерпаны' };
}

function sanitizeDecision(raw, event, element, state) {
  const fallback = defaultDecision(event, element, state);
  if (!raw || typeof raw !== 'object' || !ACTIONS.includes(raw.action)) return { ...fallback, by: 'policy' };
  const d = { action: raw.action, reason: String(raw.reason || '').slice(0, 400) || fallback.reason, by: 'model' };
  if (typeof raw.note_for_next === 'string' && raw.note_for_next.trim() && raw.note_for_next !== 'null') d.note_for_next = raw.note_for_next.trim().slice(0, 300);
  // A done child can only continue; a failed child cannot «continue»/«wait» past a failed step.
  if (event.type === 'child_done') return { ...d, action: 'continue' };
  if (event.type === 'child_failed' && (d.action === 'continue' || d.action === 'wait')) return { ...fallback, by: 'policy', reason: `${fallback.reason} (модель предложила ${d.action})` };
  if (d.action === 'retry_step' && ((element.retries || 0) >= state.config.max_child_retries || !event.child?.failedItem)) {
    return { action: 'escalate_owner', reason: `повтор недоступен (бюджет ${state.config.max_child_retries} исчерпан или нет упавшего шага): ${d.reason}`, by: 'policy' };
  }
  return d;
}

async function decide(event, element, state, { llm = null } = {}) {
  if (event.type === 'child_done') return { action: 'continue', reason: 'элемент завершён', by: 'policy' };
  state.supervisorCalls = state.supervisorCalls || 0;
  if (!llm || state.supervisorCalls >= state.config.max_supervisor_calls) {
    return { ...defaultDecision(event, element, state), by: 'policy' };
  }
  state.supervisorCalls += 1;
  let raw = null;
  try {
    raw = await llm({ system: SUPERVISOR_SYSTEM, user: supervisorInput(event, element, state), maxTokens: 300, timeoutMs: 20000, source: 'fanout-supervisor' });
  } catch (e) { console.warn('[fanout] supervisor:', e.message); }
  return sanitizeDecision(raw, event, element, state);
}

function defaultLlm() {
  try {
    const serviceLlm = require('./service-llm');
    return args => serviceLlm.serviceJson(args);
  } catch { return null; }
}

// ── Child actions ───────────────────────────────────────────────────────────
function retryChildStep(store, childId, profileId, failedItemId) {
  const now = Date.now();
  store.db.prepare(`UPDATE task_items SET status = 'pending', attempt_count = 0, due_at = ?,
      current_model_level = minimum_model_level, last_error = NULL, updated_at = ? WHERE id = ? AND task_id = ?`)
    .run(now, now, failedItemId, childId);
  const t = store.getTask(childId, profileId);
  if (t && t.status !== 'active') store.updateTask(childId, profileId, { status: 'active' });
}

function setChildPaused(store, childId, profileId, paused) {
  const t = store.getTask(childId, profileId);
  if (!t) return;
  if (paused && t.status === 'active') store.updateTask(childId, profileId, { status: 'paused' });
  if (!paused && t.status === 'paused') store.updateTask(childId, profileId, { status: 'active' });
}

// Spawn one element as a child plan: compile the child playbook for the element's
// goal, create its own project, skip the stages the batch excludes, activate.
function spawnChild(store, { parent, parentItem, state, element }) {
  const { PlaybookStore } = require('./playbook-store');
  const { compilePlaybook } = require('./playbook-compiler');
  const projects = require('./projects');
  const { userWorkDir } = require('./data-paths');
  const profileId = parent.profile_id;
  const cfg = state.config;
  const playbook = new PlaybookStore({ profileId }).get(cfg.playbook_id, cfg.playbook_version || undefined);
  if (!playbook) throw new Error(`playbook not found: ${cfg.playbook_id}`);
  const notes = (state.notes || []).slice(-5);
  const goal = notes.length
    ? `${element.goal}\n\n[Заметки пачки от предыдущих элементов: ${notes.join(' | ')}]`
    : element.goal;
  const compiled = compilePlaybook(playbook, { goal, vars: element.vars || {} });
  const workDir = userWorkDir(profileId);
  let projectId = null;
  if (cfg.project_mode !== 'parent') {
    const p = projects.createProject(workDir, { type: cfg.project_type || 'generic', name: element.name || element.key });
    projectId = p.id;
  } else {
    projectId = parent.project_id || null;
  }
  const policy = { ...(cfg.child_policy || {}), fanout_child: true };
  const created = store.createPlan({
    profile_id: profileId, project_id: projectId, goal: compiled.goal,
    playbook_id: playbook.id, playbook_version: playbook.version,
    user_value: compiled.user_value, acceptance_criteria: compiled.acceptance_criteria,
    items: compiled.items.map(i => ({ ...i, hooks: undefined })),
    execution_policy: policy, hooks: null,
  });
  const childId = created.task.id;
  store.db.prepare('UPDATE durable_tasks SET parent_task_id = ?, parent_item_id = ?, batch_item_key = ? WHERE id = ?')
    .run(parent.id, parentItem.id, element.key, childId);
  const skip = new Set(cfg.skip_stages || []);
  for (const it of created.items) {
    if (skip.has(it.stage)) store.skipItem(it.id, profileId, { reason: `этап «${it.stage}» исключён из пачки`, by: 'fanout' });
  }
  store.updateTask(childId, profileId, { status: 'active' });
  if (projectId) {
    try { store.writeProjection(childId, profileId, projects.projectDir(workDir, projectId)); } catch { /* projection is best-effort */ }
  }
  return { childId, projectId };
}

function fmtProgress(p) { return p && p.total ? `${p.finished}/${p.total}` : '—'; }

function eventText(state, element, event, decision) {
  const name = element.name || element.key;
  const step = event.child?.failedItem ? ` на шаге «${event.child.failedItem.title}»` : '';
  const err = event.child?.failedItem?.error || event.child?.error;
  switch (decision.action) {
    case 'continue': return `✅ Пачка «${state.config.title}»: «${name}» готово (${fmtProgress(event.child?.progress)} шагов).`;
    case 'retry_step': return null; // routine recovery — not worth a message
    case 'wait': return null;
    case 'skip_item': return `⏭ Пачка «${state.config.title}»: «${name}» пропущено — ${decision.reason}`;
    case 'pause_batch': return `⏸ Пачка «${state.config.title}» остановлена: «${name}» упало${step}. ${decision.reason}${err ? `\nОшибка: ${String(err).slice(0, 300)}` : ''}\nОстальные элементы на паузе, пока не решим причину.`;
    case 'escalate_owner': return `⚠️ Пачка «${state.config.title}»: «${name}» требует решения${step}. ${decision.reason}${err ? `\nОшибка: ${String(err).slice(0, 300)}` : ''}`;
    default: return null;
  }
}

function summaryText(state) {
  const lines = state.elements.map(e => `${e.status === 'done' ? '✅' : e.status === 'skipped' ? '⏭' : '•'} ${e.name || e.key} — ${e.status}${e.skipReason ? ` (${e.skipReason})` : ''}`);
  return `🏁 Пачка «${state.config.title}» завершена:\n${lines.join('\n')}`;
}

/**
 * Advance one fanout step. Mutates and persists its state. Returns
 * { joined, spawned, events } — the caller completes the step when joined.
 * `notify(text)` delivers to the owner; `llm` is the supervisor model (injectable).
 */
async function advanceFanout(store, { task, item, now = Date.now(), notify = null, llm, spawn = spawnChild } = {}) {
  const state = parseFanout(item);
  if (!state) return { joined: false, spawned: 0, events: [], error: 'no fanout state' };
  const profileId = task.profile_id;
  const stallMs = (state.config.stall_after_sec || DEFAULT_STALL_SEC) * 1000;
  const model = llm === undefined ? defaultLlm() : llm;
  const events = [];
  const messages = [];
  state.journal = state.journal || [];
  state.notes = state.notes || [];

  // 1-2. observe running children, react to changes.
  for (const el of state.elements) {
    if (!['running', 'escalated', 'retrying'].includes(el.status) || !el.childId) continue;
    const cs = childState(store, el.childId, profileId, { now, stallMs });
    el.progress = cs.progress || el.progress;
    // An escalated child the owner repaired by hand moves on by itself.
    if (el.status === 'escalated' && cs.state === 'running') { el.status = 'running'; continue; }
    if (el.status === 'escalated' && cs.state !== 'done') continue;
    if (cs.state === 'running' || cs.state === 'paused') { if (el.status === 'retrying') el.status = 'running'; continue; }
    if (cs.state === 'stalled' && el.stallNotedAt && now - el.stallNotedAt < stallMs) continue;
    const type = cs.state === 'done' ? 'child_done' : cs.state === 'stalled' ? 'child_stalled' : 'child_failed';
    const event = { type, child: cs };
    const decision = await decide(event, el, state, { llm: model });
    events.push({ key: el.key, type, action: decision.action });
    state.journal.push({ at: now, key: el.key, event: type, action: decision.action, reason: decision.reason, by: decision.by,
      step: cs.failedItem ? cs.failedItem.title : null });
    if (decision.note_for_next) state.notes.push(decision.note_for_next);
    el.lastEvent = type;
    if (cs.failedItem) el.lastFailure = { title: cs.failedItem.title, error: cs.failedItem.error };
    switch (decision.action) {
      case 'continue':
        el.status = cs.state === 'done' ? 'done' : el.status;
        el.finishedAt = now;
        break;
      case 'retry_step':
        el.retries = (el.retries || 0) + 1;
        retryChildStep(store, el.childId, profileId, cs.failedItem.id);
        el.status = 'retrying';
        break;
      case 'skip_item':
        el.status = 'skipped'; el.skipReason = decision.reason;
        try { store.updateTask(el.childId, profileId, { status: 'cancelled' }); } catch { /* already terminal */ }
        break;
      case 'pause_batch':
        state.paused = { at: now, reason: decision.reason, key: el.key };
        el.status = 'escalated';
        for (const other of state.elements) if (other.childId && other.status === 'running') setChildPaused(store, other.childId, profileId, true);
        break;
      case 'wait':
        el.stallNotedAt = now;
        break;
      case 'escalate_owner':
      default:
        el.status = 'escalated';
        if (type === 'child_stalled') el.stallNotedAt = now;
        break;
    }
    const text = eventText(state, el, event, decision);
    if (text) messages.push(text);
  }

  // 3. spawn queued elements (no batch cap — host slots gate the actual step fires).
  let spawned = 0;
  if (!state.paused) {
    const cap = Number.isFinite(state.config.concurrency) && state.config.concurrency > 0 ? state.config.concurrency : Infinity;
    let active = state.elements.filter(e => ['running', 'retrying', 'escalated'].includes(e.status)).length;
    for (const el of state.elements) {
      if (el.status !== 'queued') continue;
      if (active >= cap) break;
      try {
        const { childId, projectId } = spawn(store, { parent: task, parentItem: item, state, element: el });
        el.childId = childId; el.projectId = projectId; el.status = 'running'; el.startedAt = now;
        spawned += 1; active += 1;
        state.journal.push({ at: now, key: el.key, event: 'spawned', child: childId });
      } catch (e) {
        el.status = 'escalated'; el.lastFailure = { title: 'spawn', error: e.message };
        state.journal.push({ at: now, key: el.key, event: 'spawn_failed', error: e.message });
        messages.push(`⚠️ Пачка «${state.config.title}»: не смог запустить «${el.name || el.key}»: ${e.message}`);
      }
    }
  }

  const isJoined = joined(state);
  if (isJoined && !state.finishedAt) { state.finishedAt = now; messages.push(summaryText(state)); }
  state.updatedAt = now;
  // Persist BEFORE notifying: a crash between the two loses a message, never re-acts.
  saveFanout(store, item.id, state);
  if (notify) {
    for (const m of messages) {
      try { await notify(m); } catch (e) { console.warn('[fanout] notify:', e.message); }
    }
  }
  return { joined: isJoined, spawned, events, messages };
}

// ── Batch creation / control (used by the MCP tools) ────────────────────────
function normalizeElements(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('items: нужен непустой список элементов');
  const seen = new Set();
  return items.map((raw, i) => {
    const it = typeof raw === 'string' ? { goal: raw } : (raw || {});
    const goal = String(it.goal || '').trim();
    if (!goal) throw new Error(`items[${i}]: нужен goal`);
    let key = String(it.key || it.name || `item-${i + 1}`).trim().slice(0, 80);
    while (seen.has(key)) key = `${key}-${i + 1}`;
    seen.add(key);
    return { key, name: it.name ? String(it.name).slice(0, 120) : null, goal, vars: it.vars && typeof it.vars === 'object' ? it.vars : undefined, status: 'queued' };
  });
}

function createBatch(store, { profileId, playbook, elements, title = null, projectId = null, owner = null,
  skipStages = [], exclusiveStages = [], projectType = 'generic', projectMode = 'per_item', concurrency = null,
  maxChildRetries = DEFAULT_MAX_CHILD_RETRIES, maxSupervisorCalls = DEFAULT_MAX_SUPERVISOR_CALLS, stallAfterSec = DEFAULT_STALL_SEC,
  childPolicy = null }) {
  const els = normalizeElements(elements);
  const stageIds = new Set((playbook.stages || []).map(s => s.id));
  const unknown = [...skipStages, ...exclusiveStages].filter(s => !stageIds.has(s));
  if (unknown.length) throw new Error(`неизвестные этапы плейбука: ${unknown.join(', ')} (есть: ${[...stageIds].join(', ')})`);
  const batchTitle = title || `${playbook.title} × ${els.length}`;
  const created = store.createPlan({
    id: crypto.randomUUID(), profile_id: profileId, project_id: projectId,
    goal: `Пачка: ${batchTitle}`,
    playbook_id: 'batch', playbook_version: 1,
    user_value: `Плейбук «${playbook.title}» прогнан по ${els.length} элементам; каждый элемент доведён до конца или пропущен с причиной.`,
    acceptance_criteria: [{ id: 'batch-joined', description: 'все элементы пачки завершены или пропущены', validations: [{ validation: { fanout_joined: true } }] }],
    execution_policy: { validation_mode: 'programmatic' },
    items: [{
      title: `Прогнать «${playbook.id}» по ${els.length} элементам`, stage: 'fanout', execution_kind: 'programmatic',
      validation: { fanout_joined: true }, max_attempts: 1000, execution_timeout_seconds: 600,
    }],
  });
  const item = created.items[0];
  const state = {
    config: {
      title: batchTitle, playbook_id: playbook.id, playbook_version: playbook.version,
      skip_stages: skipStages, exclusive_stages: exclusiveStages, project_type: projectType, project_mode: projectMode,
      concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : null,
      max_child_retries: maxChildRetries, max_supervisor_calls: maxSupervisorCalls, stall_after_sec: stallAfterSec,
      child_policy: childPolicy || null,
    },
    owner, elements: els, journal: [], notes: [], createdAt: Date.now(),
  };
  saveFanout(store, item.id, state);
  store.updateTask(created.task.id, profileId, { status: 'active' });
  return { task: store.getTask(created.task.id, profileId), item: store.getTaskItem(item.id), state };
}

function findFanoutItem(store, taskId, profileId) {
  return store.listTaskItems(taskId, profileId).find(i => i.fanout_json) || null;
}

function batchStatus(store, taskId, profileId) {
  const task = store.getTask(taskId, profileId);
  if (!task) return { error: 'batch not found' };
  const item = findFanoutItem(store, taskId, profileId);
  const state = parseFanout(item);
  if (!state) return { error: 'task is not a batch' };
  return {
    task_id: task.id, status: task.status, title: state.config.title, paused: state.paused || null,
    elements: state.elements.map(e => {
      const cs = e.childId ? childState(store, e.childId, profileId) : null;
      return { key: e.key, name: e.name, goal: e.goal, status: e.status, child_task_id: e.childId || null, project_id: e.projectId || null,
        progress: cs?.progress || null, child_state: cs?.state || null, current: cs?.current || null, failed_step: cs?.failedItem || null,
        retries: e.retries || 0, skip_reason: e.skipReason || null };
    }),
    journal: state.journal.slice(-20), notes: state.notes,
  };
}

// Owner control: resume a paused batch, retry / skip one element.
function controlBatch(store, taskId, profileId, { action, key = null, reason = null }) {
  const item = findFanoutItem(store, taskId, profileId);
  const state = parseFanout(item);
  if (!state) return { error: 'task is not a batch' };
  const now = Date.now();
  const el = key ? state.elements.find(e => e.key === key) : null;
  if (key && !el) return { error: `element not found: ${key}` };
  if (action === 'resume') {
    state.paused = null;
    for (const e of state.elements) if (e.childId && e.status === 'running') setChildPaused(store, e.childId, profileId, false);
  } else if (action === 'retry') {
    if (!el) return { error: 'key required' };
    if (el.childId) {
      const cs = childState(store, el.childId, profileId);
      if (cs.failedItem) retryChildStep(store, el.childId, profileId, cs.failedItem.id);
      else setChildPaused(store, el.childId, profileId, false);
      el.status = 'running';
    } else el.status = 'queued';
  } else if (action === 'skip') {
    if (!el) return { error: 'key required' };
    el.status = 'skipped'; el.skipReason = reason || 'пропущено владельцем';
    if (el.childId) { try { store.updateTask(el.childId, profileId, { status: 'cancelled' }); } catch { /* terminal */ } }
  } else return { error: `unknown action: ${action}` };
  state.journal.push({ at: now, key, event: 'owner', action, reason: reason || null });
  saveFanout(store, item.id, state);
  store.db.prepare(`UPDATE task_items SET due_at = ?, status = CASE WHEN status = 'running' THEN status ELSE 'waiting' END WHERE id = ?`).run(now, item.id);
  return { ok: true, status: batchStatus(store, taskId, profileId) };
}

// ── Cross-child exclusivity ─────────────────────────────────────────────────
// A stage listed in config.exclusive_stages touches a SHARED external resource
// (e.g. acceptance cleans test entities in one CRM): while one sibling is inside
// that stage (started, not finished), no other sibling may enter it.
function stageLockedBySibling(store, task, item) {
  if (!task || !task.parent_task_id || !item || !item.stage) return false;
  let state;
  try {
    const pItem = task.parent_item_id ? store.getTaskItem(task.parent_item_id) : null;
    state = parseFanout(pItem);
  } catch { return false; }
  const stages = state?.config?.exclusive_stages || [];
  if (!stages.includes(item.stage)) return false;
  const row = store.db.prepare(`SELECT t.id FROM durable_tasks t
    WHERE t.parent_task_id = ? AND t.id != ? AND t.status = 'active'
      AND EXISTS (SELECT 1 FROM task_items i WHERE i.task_id = t.id AND i.stage = ? AND i.status IN ('running','done','failed'))
      AND EXISTS (SELECT 1 FROM task_items i WHERE i.task_id = t.id AND i.stage = ? AND i.status NOT IN ('done','skipped'))
    LIMIT 1`).get(task.parent_task_id, task.id, item.stage, item.stage);
  return !!row;
}

// A child's plan changed state — make its parent's fanout step due now.
function nudgeParent(store, task) {
  if (!task || !task.parent_item_id) return false;
  const r = store.db.prepare(`UPDATE task_items SET due_at = ? WHERE id = ? AND status = 'waiting'`).run(Date.now(), task.parent_item_id);
  return r.changes > 0;
}

function makeFanoutJoinedValidator({ getItem = null } = {}) {
  return async function fanoutJoined(ctx) {
    const id = ctx.item && ctx.item.id;
    if (!id) return { status: 'inconclusive', subject: null, evidence: { reason: 'no-item-id' } };
    let item;
    try {
      item = getItem ? getItem(id) : require('./gtd-controller').durableStore().getTaskItem(id);
    } catch (e) { return { status: 'inconclusive', subject: null, evidence: { reason: 'store-error', error: e.message } }; }
    const state = parseFanout(item);
    if (!state) return { status: 'fail', subject: { item_id: id }, evidence: { reason: 'no-fanout-state' } };
    const counts = {};
    for (const e of state.elements) counts[e.status] = (counts[e.status] || 0) + 1;
    return { status: joined(state) ? 'pass' : 'fail', subject: { item_id: id }, evidence: { counts } };
  };
}

module.exports = {
  parseFanout, saveFanout, joined, childState, advanceFanout, spawnChild, createBatch, batchStatus, controlBatch,
  stageLockedBySibling, nudgeParent, makeFanoutJoinedValidator, normalizeElements,
  defaultDecision, sanitizeDecision, decide, SUPERVISOR_SYSTEM, ACTIONS, DEFAULT_POLL_MS,
};
