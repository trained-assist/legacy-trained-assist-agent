// Durable Task Store — SQLite source of truth for durable/GTD tasks (spec:
// durable-task-orchestrator-v1). better-sqlite3, WAL, foreign_keys ON.
// checklist.md is only a generated file projection; the DB is authoritative.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { validateItem, declaredValidations, criterionIdForItem } = require('./durable-task-plan');
const { atomicText } = require('./atomic-json');

const TASK_STATUSES = ['draft', 'paused', 'blocked', 'active', 'awaiting_input', 'done', 'failed', 'cancelled'];
// Alive = the plan still runs (claimable / visible in notices). `awaiting_input`
// is alive too — it only says a step of it is parked on the owner (#87 B1.4).
const TASK_STATUSES_ALIVE = ['active', 'awaiting_input'];
const ITEM_STATUSES = ['pending', 'running', 'waiting', 'done', 'failed', 'skipped'];
const ITEM_STATUSES_TERMINAL = ['done', 'failed', 'skipped'];
const TIERS = ['free', 'standard', 'strong'];
const TIER_RANK = { free: 0, standard: 1, strong: 2 };
// P3c: the contract model ladder a step may be escalated through (matches
// playbook-executor LEVELS — the executor resolver reads current_model_level).
const MODEL_LEVELS = ['bachelor', 'master', 'doctor'];

function nowMs() { return Date.now(); }

// A signal's payload as text (task_signals.payload_json holds JSON — a string
// message today, a structured payload later).
function signalText(signal) {
  if (!signal || signal.payload_json == null) return null;
  try {
    const v = JSON.parse(signal.payload_json);
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch { return String(signal.payload_json); }
}

function describeMissing(missing) {
  return missing
    .map(m => `${m.criterion_id}/${m.validator}=${m.got == null ? 'missing' : m.got}`)
    .join(', ');
}

class DurableTaskStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this._migrate();
    require('./durable-task-migrations')(this.db);
    this._stmts = {};
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_tasks (
        id          TEXT PRIMARY KEY,
        profile_id  TEXT NOT NULL,
        project_id  TEXT,
        goal        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft','active','awaiting_input','paused','blocked','done','failed','cancelled')),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_items (
        id                  TEXT PRIMARY KEY,
        task_id             TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
        position            INTEGER NOT NULL,
        title               TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','waiting','done','failed','skipped')),
        execution_tier      TEXT NOT NULL DEFAULT 'free'
                            CHECK (execution_tier IN ('free','standard','strong')),
        current_tier        TEXT NOT NULL DEFAULT 'free'
                            CHECK (current_tier IN ('free','standard','strong')),
        escalation_count    INTEGER NOT NULL DEFAULT 0,
        delay_after_sec     INTEGER NOT NULL DEFAULT 0,
        due_at              INTEGER,
        last_execution_id   TEXT,
        last_error          TEXT,
        claim_generation    INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_items_due
        ON task_items(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_task_items_task
        ON task_items(task_id, position);
      CREATE TABLE IF NOT EXISTS task_sessions (
        task_id     TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        profile_id  TEXT NOT NULL,
        attached_at INTEGER NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, session_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sessions_one_active
        ON task_sessions(profile_id, session_id) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS executions (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
        task_item_id   TEXT REFERENCES task_items(id) ON DELETE SET NULL,
        session_id     TEXT,
        engine         TEXT,
        model          TEXT,
        tier           TEXT CHECK (tier IN ('free','standard','strong')),
        status         TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        error_class    TEXT,
        error_text     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_executions_task
        ON executions(task_id, started_at);
    `);
  }

  _prep(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  // ── Tasks ──────────────────────────────────────────────────────────────
  createTask({ id, profile_id, project_id = null, goal }) {
    if (!profile_id) throw new Error('profile_id is required (ownership/isolation)');
    if (!goal) throw new Error('goal is required');
    const ts = nowMs();
    return this.db.transaction(() => {
      this._prep(`INSERT INTO durable_tasks
          (id, profile_id, project_id, goal, status, created_at, updated_at, revision)
          VALUES (?, ?, ?, ?, 'active', ?, ?, 0)`)
        .run(id, profile_id, project_id, goal, ts, ts);
      this.recordEvent({ task_id: id, type: 'task_created', payload: { goal: String(goal).slice(0, 200) } });
      return this.getTask(id, profile_id);
    })();
  }

  /** Persist the complete planner contract in one transaction. No execution. */
  createPlan({ id = crypto.randomUUID(), profile_id, project_id = null, goal,
    playbook_id = null, playbook_version = null, user_value, acceptance_criteria,
    items, session_id = null, origin_chat = null, execution_policy = null, request_id = null, hooks = null }) {
    if (typeof user_value !== 'string' || !user_value.trim()) throw new Error('user_value required');
    if (!Array.isArray(acceptance_criteria) || !acceptance_criteria.length || acceptance_criteria.some(c => !c || typeof c !== 'object' || Array.isArray(c) || !Object.keys(c).length)) throw new Error('acceptance_criteria required');
    if (!Array.isArray(items) || !items.length) throw new Error('items required');
    return this.db.transaction(() => {
      this.createTask({ id, profile_id, project_id, goal });
      this._prep(`UPDATE durable_tasks SET status='draft', playbook_id=?, playbook_version=?,
        user_value=?, acceptance_criteria_json=?, execution_policy_json=?, request_id=?, hooks_json=?,
        origin_session_id=?, origin_chat_json=? WHERE id=?`)
        .run(playbook_id, playbook_version, user_value, JSON.stringify(acceptance_criteria),
          execution_policy == null ? null : JSON.stringify(execution_policy), request_id,
          hooks == null ? null : JSON.stringify(hooks), session_id || null,
          origin_chat == null ? null : JSON.stringify(origin_chat), id);
      items.forEach((item, position) => {
        validateItem(item);
        const itemId = crypto.randomUUID();
        this.createTaskItem({ id: itemId, task_id: id, title: item.title, position,
          delay_after_sec: item.delay_after_sec ?? 0 });
        this._prep(`UPDATE task_items SET stage=?, instructions=?, execution_kind=?, executor_role=?,
          minimum_model_level=?, current_model_level=?, context_budget=?, validation_json=?,
          max_attempts=?, execution_timeout_seconds=?, hooks_json=?, wait_json=?, already_done_json=? WHERE id=?`)
          .run(item.stage ?? null, item.instructions ?? null, item.execution_kind,
            item.executor_role ?? null, item.minimum_model_level ?? null, item.minimum_model_level ?? null,
            item.context_budget ?? null, JSON.stringify(item.validation), item.max_attempts ?? 3,
            item.execution_timeout_seconds ?? 600,
            item.hooks == null ? null : JSON.stringify(item.hooks),
            item.wait == null ? null : JSON.stringify({ then: 'complete', ...item.wait }),
            item.already_done == null ? null : JSON.stringify(item.already_done), itemId);
      });
      // #1886: session_id is the plan's owner chat (origin_session_id), not an
      // attachment — task_sessions allows one active task per session, so a second
      // plan from the same chat used to throw «already has an active task».
      return { task: this.getTask(id, profile_id), items: this.listTaskItems(id, profile_id) };
    })();
  }

  /**
   * A running plan edits itself (legal): insert a fully-contracted step right after
   * `afterItemId` (later steps shift down one position), or append when omitted.
   * Contract plans only — the step goes through the same validateItem as createPlan,
   * so it routes by the plan's level map like any compiled step.
   */
  insertPlanItem(taskId, profileId, { afterItemId = null, item }) {
    return this.db.transaction(() => {
      const task = this.getTask(taskId, profileId);
      if (!task) throw new Error('task not found (or not owned by this profile)');
      if (!task.acceptance_criteria_json) throw new Error('not a contract plan — use the legacy item fields');
      if (['done', 'failed', 'cancelled'].includes(task.status)) throw new Error(`plan is ${task.status}`);
      validateItem(item);
      let position;
      if (afterItemId) {
        const after = this._itemOwnedBy(afterItemId, profileId);
        if (!after || after.task_id !== taskId) throw new Error('after_item_id is not a step of this plan');
        position = after.position + 1;
        this._prep('UPDATE task_items SET position = position + 1, updated_at = ? WHERE task_id = ? AND position >= ?')
          .run(nowMs(), taskId, position);
      } else {
        position = this._prep('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM task_items WHERE task_id = ?').get(taskId).p;
      }
      const itemId = crypto.randomUUID();
      this.createTaskItem({ id: itemId, task_id: taskId, title: item.title, position, delay_after_sec: item.delay_after_sec ?? 0 });
      this._prep(`UPDATE task_items SET stage=?, instructions=?, execution_kind=?, executor_role=?,
        minimum_model_level=?, current_model_level=?, context_budget=?, validation_json=?,
        max_attempts=?, execution_timeout_seconds=?, already_done_json=? WHERE id=?`)
        .run(item.stage ?? null, item.instructions ?? null, item.execution_kind,
          item.executor_role ?? null, item.minimum_model_level ?? null, item.minimum_model_level ?? null,
          item.context_budget ?? null, JSON.stringify(item.validation), item.max_attempts ?? 3,
          item.execution_timeout_seconds ?? 600,
          item.already_done == null ? null : JSON.stringify(item.already_done), itemId);
      this._bump(taskId);
      return this.getTaskItem(itemId);
    })();
  }

  /**
   * A running plan drops a step that does not apply (legal, audited): only a step
   * that has not started (pending/waiting). Its declared validations are recorded as
   * 'pass' with evidence {skipped:true, reason, by} — like a fast-pass skip — so the
   * finalization gate is not blocked forever, while the skip stays visible.
   */
  skipItem(itemId, profileId, { reason, by = 'agent' }) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason required');
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(itemId, profileId);
      if (!item) throw new Error('item not found (or not owned by this profile)');
      if (!['pending', 'waiting'].includes(item.status)) throw new Error(`only a step that has not started can be skipped (status=${item.status})`);
      const task = this.getTask(item.task_id, profileId);
      this._prep(`UPDATE task_items SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?`)
        .run(`skipped: ${reason.trim()}`.slice(0, 500), nowMs(), itemId);
      this.recordEvent({ task_id: item.task_id, task_item_id: itemId, type: 'item_skipped',
        payload: { reason: reason.trim().slice(0, 300), by } });
      this._prep('DELETE FROM task_signals WHERE task_item_id = ? AND consumed_at IS NULL').run(itemId);
      let validation = {};
      try { validation = item.validation_json ? JSON.parse(item.validation_json) : {}; } catch { /* none */ }
      for (const key of Object.keys(validation)) {
        this.recordValidation({
          task_id: task.id, profile_id: profileId, task_item_id: itemId,
          criterion_id: criterionIdForItem(task, item, key), contract_revision: task.contract_revision || 1,
          validator: key, status: 'pass',
          evidence_json: JSON.stringify({ skipped: true, reason: reason.trim(), by }),
        });
      }
      this._bump(item.task_id);
      return this.getTaskItem(itemId);
    })();
  }

  /** profile_id is mandatory: every read/write is scoped to the owner profile. */
  getTask(id, profileId) {
    return this._prep('SELECT * FROM durable_tasks WHERE id = ? AND profile_id = ?')
      .get(id, profileId) || null;
  }

  listTasks(profileId, { status } = {}) {
    let sql = 'SELECT * FROM durable_tasks WHERE profile_id = ?';
    const args = [profileId];
    if (Array.isArray(status)) { sql += ` AND status IN (${status.map(() => '?').join(',')})`; args.push(...status); }
    else if (status) { sql += ' AND status = ?'; args.push(status); }
    sql += ' ORDER BY created_at DESC';
    return this._prep(sql).all(...args);
  }

  updateTask(id, profileId, patch) {
    const task = this.getTask(id, profileId);
    if (!task) return null;
    // P3d-2: a contract plan may only become 'done' through the finalization
    // gate — every declared (criterion, validator) needs a matching 'pass' row
    // at the current contract revision. This is the ONE write path: the executor
    // calls finalizePlan, which enforces the same gate, so there is no raw-SQL
    // bypass left.
    if (task.acceptance_criteria_json && patch.status === 'done') {
      const missing = this._finalizationMissing(task);
      if (missing.length) {
        throw new Error(`Plan finalization blocked: unmet validations — ${describeMissing(missing)}`);
      }
    }
    const allowed = ['goal', 'status', 'project_id'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in patch) {
        if (k === 'status' && !TASK_STATUSES.includes(patch.status)) {
          throw new Error(`invalid task status: ${patch.status}`);
        }
        sets.push(`${k} = ?`); args.push(patch[k]);
      }
    }
    if (!sets.length) return this.getTask(id, profileId);
    sets.push('updated_at = ?', 'revision = revision + 1');
    args.push(nowMs(), id, profileId);
    const changedStatus = 'status' in patch && patch.status !== task.status;
    const from = task.status;
    const res = this.db.transaction(() => {
      const r = this._prep(`UPDATE durable_tasks SET ${sets.join(', ')}
        WHERE id = ? AND profile_id = ?`).run(...args);
      if (r.changes === 0) return null;
      if (changedStatus) {
        this.recordEvent({ task_id: id, type: 'task_status', payload: { from, to: patch.status, by: 'api' } });
      }
      return r;
    })();
    if (res == null) return null;
    // A status set through the API must land in the right await state too
    // (unpausing a plan whose step is still parked on the owner).
    if (changedStatus && TASK_STATUSES_ALIVE.includes(patch.status)) this._refreshAwaitState(id);
    return this.getTask(id, profileId);
  }

  /** Close a task terminal-side and settle its non-done items. */
  completeTask(id, profileId, finalStatus = 'done') {
    return this.db.transaction(() => {
      const task = this.getTask(id, profileId);
      if (!task) return null;
      this._prep(`UPDATE task_items SET status = 'skipped', updated_at = ?
        WHERE task_id = ? AND status IN ('pending','waiting','running')`)
        .run(nowMs(), id);
      // A closed plan has no step left to deliver a signal to (#87 B1.2).
      this._prep('DELETE FROM task_signals WHERE task_id = ? AND consumed_at IS NULL').run(id);
      const updated = this.updateTask(id, profileId, { status: finalStatus });
      return updated;
    })();
  }

  /**
   * Which declared (criterion, validator) pairs lack a current 'pass' row. Only
   * rows at the task's current contract_revision count; the latest row per pair
   * wins (a retry that later passes overrides an earlier fail). `got` is the
   * latest status, or null when no row exists at all.
   */
  _finalizationMissing(task) {
    const revision = task.contract_revision || 1;
    const latest = new Map();
    for (const row of this.listValidations(task.id, task.profile_id)) {
      if ((row.contract_revision || 1) !== revision) continue;
      latest.set(`${row.criterion_id}\u0000${row.validator}`, row);
    }
    const missing = [];
    for (const declared of declaredValidations(task)) {
      const row = latest.get(`${declared.criterion_id}\u0000${declared.validator}`);
      if (!row || row.status !== 'pass') {
        missing.push({ criterion_id: declared.criterion_id, validator: declared.validator, got: row ? row.status : null });
      }
    }
    return missing;
  }

  /**
   * P3d-2 finalization gate. A contract plan becomes 'done' only when every
   * declared validation has a matching 'pass' row at the current
   * contract_revision; otherwise nothing changes and the unmet pairs are
   * returned. Mode-awareness (deterministic vs LLM vs explicit fast-pass skip)
   * is already encoded at record time — a fast-pass skip is stored as 'pass'
   * with evidence {skipped:true}, so it satisfies the gate while staying visible.
   */
  // `blocking(validatorKey)` (soft finalization): only the keys it returns true for
  // block 'done'; the rest come back as `unconfirmed`. Default: every key blocks.
  finalizePlan(taskId, profileId, { blocking = null } = {}) {
    const task = this.getTask(taskId, profileId);
    if (!task) return { finalized: false, missing: [], reason: 'task-not-found' };
    if (task.status === 'done') return { finalized: true };
    const all = this._finalizationMissing(task);
    const isBlocking = typeof blocking === 'function' ? blocking : () => true;
    const missing = all.filter(m => isBlocking(m.validator));
    const unconfirmed = all.filter(m => !isBlocking(m.validator));
    if (missing.length) return { finalized: false, missing, unconfirmed };
    this.db.transaction(() => {
      this._prep(`UPDATE durable_tasks SET status = 'done', updated_at = ?, revision = revision + 1
        WHERE id = ? AND profile_id = ?`).run(nowMs(), taskId, profileId);
      // the one write path that bypasses updateTask — journal it like any other
      // status change (#87 B1.4)
      this.recordEvent({ task_id: taskId, type: 'task_status', payload: { from: task.status, to: 'done', by: 'finalize' } });
    })();
    return unconfirmed.length ? { finalized: true, unconfirmed } : { finalized: true };
  }

  /**
   * The agent closes its CURRENT (running) step as an exception — done differently
   * or not applicable — with a reason. Stored on the step; when the run then
   * answers DURABLE: done, its validations are recorded as 'pass' with evidence
   * {exception:true, reason} instead of asking the judge. Always logged as a defect.
   */
  markItemException(itemId, profileId, { reason, by = 'agent' }) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason required');
    const item = this._itemOwnedBy(itemId, profileId);
    if (!item) throw new Error('item not found (or not owned by this profile)');
    if (item.status !== 'running') throw new Error(`only the step that is running now can be closed as an exception (status=${item.status})`);
    this._prep('UPDATE task_items SET exception_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ reason: reason.trim(), by, at: nowMs() }), nowMs(), itemId);
    return this.getTaskItem(itemId);
  }

  // ── Items ──────────────────────────────────────────────────────────────
  createTaskItem({ id, task_id, position = 0, title, execution_tier = 'free',
                   delay_after_sec = 0, due_at = null }) {
    if (!TIERS.includes(execution_tier)) throw new Error(`invalid tier: ${execution_tier}`);
    const task = this.db.prepare('SELECT id FROM durable_tasks WHERE id = ?').get(task_id);
    if (!task) throw new Error(`task not found: ${task_id}`);
    const ts = nowMs();
    this._prep(`INSERT INTO task_items
        (id, task_id, position, title, status, execution_tier, current_tier,
         escalation_count, delay_after_sec, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)`)
      .run(id, task_id, position, title, execution_tier, execution_tier,
           delay_after_sec, due_at, ts, ts);
    this._bump(task_id);
    return this.getTaskItem(id);
  }

  getTaskItem(id) {
    return this._prep('SELECT * FROM task_items WHERE id = ?').get(id) || null;
  }

  listTaskItems(taskId, profileId) {
    // join guards profile ownership of the parent task
    return this._prep(`SELECT i.* FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE i.task_id = ? AND t.profile_id = ?
      ORDER BY i.position`).all(taskId, profileId);
  }

  updateTaskItem(id, patch, profileId, { releaseClaim = false } = {}) {
    if (!this._itemOwnedBy(id, profileId)) return null;
    const allowed = ['title', 'status', 'current_tier', 'delay_after_sec', 'due_at',
                     'wait_deadline_at', 'last_execution_id', 'last_error',
                     // P3d-1c: per-step validation_mode override (nullable; DB CHECK enforces the enum)
                     'validation_mode',
                     // P3c: recovery observability (set by durable-recovery.js)
                     'last_failure_class', 'last_recovery_action',
                     // quality escalation (durable-recovery): the level the next attempt runs at
                     'current_model_level'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in patch) {
        if (k === 'status' && !ITEM_STATUSES.includes(patch.status)) {
          throw new Error(`invalid item status: ${patch.status}`);
        }
        if (k === 'current_model_level' && !['bachelor', 'master', 'doctor'].includes(patch.current_model_level)) {
          throw new Error(`invalid model level: ${patch.current_model_level}`);
        }
        if (k === 'current_tier' && !TIERS.includes(patch.current_tier)) {
          throw new Error(`invalid tier: ${patch.current_tier}`);
        }
        sets.push(`${k} = ?`); args.push(patch[k]);
      }
    }
    if (!sets.length) return this.getTaskItem(id);
    sets.push('updated_at = ?');
    args.push(nowMs(), id);
    const res = this.db.transaction(() => {
      const r = this._prep(`UPDATE task_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      if (r.changes === 0) return null;
      // `releaseClaim` (#87 B1.1): the scheduler is putting back a claim it never
      // turned into an attempt (busy session, slot limit, fanout/stage hold, a
      // re-claim of the item this same pass already fired). Give the generation
      // back — otherwise a bookkeeping release would fence off the settle of the
      // attempt that IS running, and its result would be thrown away.
      if (releaseClaim) {
        this._prep('UPDATE task_items SET claim_generation = MAX(0, claim_generation - 1) WHERE id = ?').run(id);
      }
      const item = this.getTaskItem(id);
      // Defense in depth: ownership was checked before UPDATE.
      const owner = this._prep('SELECT profile_id FROM durable_tasks WHERE id = ?')
        .get(item.task_id);
      if (!owner || owner.profile_id !== profileId) return null;
      this._bump(item.task_id);
      return item;
    })();
    return res;
  }

  /** Escalate current tier one step up (free→standard→strong). Idempotent at ceiling. */
  escalateItem(id, profileId) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const rank = TIER_RANK[item.current_tier];
      const next = Object.entries(TIER_RANK).find(([, r]) => r === rank + 1);
      if (!next) return item; // already at ceiling tier
      const ts = nowMs();
      this._prep(`UPDATE task_items SET current_tier = ?, escalation_count =
          escalation_count + 1, status = 'pending', updated_at = ? WHERE id = ?`)
        .run(next[0], ts, id);
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /**
   * Bump a contract item's current_model_level one rung up (bachelor→master→
   * doctor) — the P3c recovery move for a model/quota/context failure. Idempotent
   * at the ceiling. A legacy item with no contract level (NULL) is left untouched;
   * recovery falls back to a plain bounded re-pend for it. Does NOT change status:
   * the caller decides complete vs re-pend through the usual transition.
   */
  bumpModelLevel(id, profileId) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const idx = MODEL_LEVELS.indexOf(item.current_model_level);
      if (idx < 0 || idx >= MODEL_LEVELS.length - 1) return item; // unknown or at ceiling
      this._prep(`UPDATE task_items SET current_model_level = ?, updated_at = ? WHERE id = ?`)
        .run(MODEL_LEVELS[idx + 1], nowMs(), id);
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /**
   * Claim the next runnable item atomically (scheduler tick). Never returns the
   * same item to two concurrent callers — status flips to 'running' inside the
   * same transaction that selects it.
   *
   * Strict positional ordering: an item is runnable only when every
   * earlier-position item of the same task is terminal (`done`/`skipped`). A
   * `pending`/`waiting`/`running`/`failed` predecessor blocks it, so a
   * delay-gated step (waiting out its `delay_after_sec`) or a failed step stops
   * the plan from skipping ahead out of order — P3c owns what happens once a
   * predecessor is genuinely stuck.
   *
   * We gate here in the claim query rather than by creating items non-claimable
   * until `completeItem` arms them: the gate is one SELECT predicate, so it
   * leaves `createPlan`'s transaction, `completeItem`'s next-sibling arming,
   * `reconcileOrphanedRunning`/`expireWaitingDeadlines`, and every status
   * semantic untouched — only "which item may the scheduler hand out" changes.
   * The arm-based alternative would add a claimable/armed concept that must be
   * threaded through all of those paths for the same guarantee.
   *
   * `now` is injectable so the tick and tests drive `due_at` selection
   * deterministically (defaults to the wall clock).
   *
   * `waitsOnly` (durable-wait-latency design §2.1) narrows the claim to items
   * carrying an UNRESOLVED wait (`wait_json` without `$.resolved`) — that is the
   * dedicated 30s wait tick: it polls waiting steps and must not claim a plain
   * due step that belongs to the 5-min GTD tick. Everything else (positional
   * gate, due filter, statuses) is shared, so one claim = one pass either way.
   */
  claimNextRunnable(now = nowMs(), { waitsOnly = false } = {}) {
    const waitFilter = waitsOnly
      ? `AND i.wait_json IS NOT NULL AND json_extract(i.wait_json, '$.resolved') IS NULL`
      : '';
    return this.db.transaction(() => {
      const row = this._prep(`SELECT i.* FROM task_items i
        JOIN durable_tasks t ON t.id = i.task_id
        WHERE i.status IN ('pending','waiting') AND t.status IN ('active','awaiting_input')
          AND (i.due_at IS NULL OR i.due_at <= ?)
          ${waitFilter}
          AND NOT EXISTS (
            SELECT 1 FROM task_items p
            WHERE p.task_id = i.task_id AND p.position < i.position
              AND p.status NOT IN ('done','skipped')
          )
        ORDER BY (i.due_at IS NULL) DESC, i.due_at ASC, i.position ASC
        LIMIT 1`).get(now);
      if (!row) return null;
      // Attempt fencing (epic #87 B1.1, prod-plans T6): every claim opens a new
      // generation, and the attempt that carries it may only settle while the row still
      // holds that number — see completeItem/failItem/parkItem's `claimGeneration`.
      this._prep(`UPDATE task_items SET status = 'running', claim_generation = claim_generation + 1,
          result_json = NULL, updated_at = ? WHERE id = ?`)
        .run(now, row.id);
      return this.getTaskItem(row.id);
    })();
  }

  /**
   * How many active plans currently carry an unresolved wait — the wait tick's
   * fast no-op exit (0 → not a single SQL statement). Excludes terminal items
   * (a completed declared wait keeps its wait_json), so a quiet profile costs
   * one COUNT per 30s, nothing more.
   */
  countActiveWaits() {
    const row = this._prep(`SELECT COUNT(*) AS n FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE t.status IN ('active','awaiting_input') AND i.status IN ('pending','waiting')
        AND i.wait_json IS NOT NULL
        AND json_extract(i.wait_json, '$.resolved') IS NULL`).get();
    return row ? row.n : 0;
  }

  /**
   * Mark an item done. If the next sibling exists, arm it: delay_after_sec <= 300
   * keeps it immediately runnable (due_at = now); longer delays set waiting+due_at.
   * A waiting sibling also gets a `wait_deadline_at` — one full delay window past
   * its due time. If it is still waiting beyond that (the run that should have
   * claimed it never did), `expireWaitingDeadlines` fails it instead of letting a
   * stuck waiter defer forever.
   *
   * Attempt fencing (#87 B1.1): pass the `claimGeneration` this write's attempt
   * claimed. The UPDATE then carries `AND claim_generation = ?` and a superseded
   * attempt gets `null` instead of silently overwriting the newer attempt's step —
   * and never arms the next sibling.
   */
  completeItem(id, profileId, { executionId = null, claimGeneration = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const fence = this._claimFence(claimGeneration);
      const now = nowMs();
      const upd = this._prep(`UPDATE task_items SET status = 'done', last_execution_id = ?,
          updated_at = ? WHERE id = ?${fence.clause}`).run(executionId, now, id, ...fence.args);
      if (upd.changes === 0) return null;
      this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_done', payload: { execution_id: executionId } });
      // The step is over: a signal nobody parked for can never be consumed (#87 B1.2).
      this._prep('DELETE FROM task_signals WHERE task_item_id = ? AND consumed_at IS NULL').run(id);
      const next = this._prep(`SELECT * FROM task_items WHERE task_id = ? AND status = 'pending'
        ORDER BY position LIMIT 1`).get(item.task_id);
      if (next) {
        const waiting = next.delay_after_sec > 300;
        const due = waiting ? now + next.delay_after_sec * 1000
          : (next.delay_after_sec > 0 ? now : null);
        const waitDeadline = waiting ? due + next.delay_after_sec * 1000 : null;
        this._prep(`UPDATE task_items SET status = ?, due_at = ?, wait_deadline_at = ?,
            updated_at = ? WHERE id = ?`)
          .run(waiting ? 'waiting' : 'pending', due, waitDeadline, now, next.id);
      }
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /**
   * Fail `waiting` items whose declared wait deadline has passed (P3a). Chosen
   * outcome is `failed`, not `pending`: `wait_deadline_at` is an upper bound on
   * an external wait (CI/deploy/re-entrancy backoff) — re-pending it would defer
   * forever, which is exactly what the deadline exists to prevent. A failed item
   * is terminal for the item budget and visible to the recovery slice (P3c).
   * Returns the number of items expired.
   */
  /**
   * Durable wait (see src/durable-wait.js): park an item as `waiting` until
   * `dueAt` with its wait state in `wait_json`. A park is not a failure, so
   * `refundAttempt` gives back the attempt startExecution counted for the run
   * that asked to wait — waiting three times must not exhaust max_attempts.
   * wait_deadline_at is cleared: the wait's own deadline lives in wait_json and
   * is enforced by the poll, not by expireWaitingDeadlines.
   */
  parkItem(id, profileId, { wait, dueAt, refundAttempt = false, lastError = null, claimGeneration = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const fence = this._claimFence(claimGeneration);
      const now = nowMs();
      // A buffered early signal (#87 B1.2, prod-plans T4) is applied right here:
      // the step reaches its wait already woken, due NOW, so the next tick
      // resolves it as 'woken' — the answer that arrived while the step was still
      // running is no longer lost.
      const pending = this._prep(`SELECT * FROM task_signals
        WHERE task_id = ? AND task_item_id = ? AND consumed_at IS NULL`).get(item.task_id, id);
      let w = wait;
      let nextDue = dueAt;
      if (pending && wait && typeof wait === 'object') {
        w = {
          ...wait,
          woken_at: pending.created_at || now,
          woken_by: pending.source || 'user',
          wake_message: signalText(pending),
        };
        nextDue = now;
      }
      const upd = this._prep(`UPDATE task_items SET status = 'waiting', due_at = ?, wait_deadline_at = NULL,
          wait_json = ?, last_error = ?, updated_at = ?,
          attempt_count = CASE WHEN ? THEN MAX(0, attempt_count - 1) ELSE attempt_count END
          WHERE id = ?${fence.clause}`)
        .run(nextDue, w == null ? null : JSON.stringify(w), lastError, now, refundAttempt ? 1 : 0, id, ...fence.args);
      if (upd.changes === 0) return null;
      if (pending) {
        this._prep('UPDATE task_signals SET consumed_at = ? WHERE task_id = ? AND task_item_id = ?')
          .run(now, item.task_id, id);
      }
      // wait_json overwrites its own history (parked → woken → resolved), so the
      // journal is the only place the parked state survives (#87 B1.4).
      this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_parked',
        payload: { awaiting_user: !!(w && w.awaiting_user), reason: (w && w.reason) || null,
          due_at: nextDue, woken: !!(w && w.woken_at), by_signal: !!pending } });
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /** Replace an item's wait state without changing its status (e.g. clear it after a wake). */
  setItemWait(id, profileId, wait, { claimGeneration = null } = {}) {
    const owned = this._itemOwnedBy(id, profileId);
    if (!owned) return null;
    const fence = this._claimFence(claimGeneration);
    let hadResolved = null;
    try { const prev = owned.wait_json ? JSON.parse(owned.wait_json) : null; hadResolved = prev ? prev.resolved : null; } catch { hadResolved = null; }
    const res = this._prep(`UPDATE task_items SET wait_json = ?, updated_at = ? WHERE id = ?${fence.clause}`)
      .run(wait == null ? null : JSON.stringify(wait), nowMs(), id, ...fence.args);
    if (res.changes === 0) return null;
    // A resolution is exactly what wait_json used to erase without a trace (#87 B1.4).
    if (wait && wait.resolved && !hadResolved) {
      this.recordEvent({ task_id: owned.task_id, task_item_id: id, type: 'wait_resolved',
        payload: { resolved: wait.resolved, reason: wait.reason || null } });
    }
    this._refreshAwaitState(owned.task_id);
    return this.getTaskItem(id);
  }

  /**
   * Wake a waiting item now (a user answered, or someone knows the condition
   * holds). The next tick re-checks it; for an agent wait the message is handed
   * to the resumed run. Only a parked item (waiting + wait_json) can be woken —
   * a step that has not reached its wait yet does not error out any more: the
   * signal is BUFFERED for the park (see task_signals, #87 B1.2).
   *
   * Signal identity = (task, step): the first signal wins, a duplicate never
   * overwrites `wake_message` (prod-plans T5).
   */
  wakeItem(id, profileId, { message = null, by = 'user' } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return { error: 'item not found (or not owned by this profile)' };
      const now = nowMs();
      const payload = message == null ? null : String(message).slice(0, 4000);
      if (item.status !== 'waiting' || !item.wait_json) {
        // A finished step has nothing to wake (prod-plans T5: «wake после done»)
        // and gets no signal row.
        if (ITEM_STATUSES_TERMINAL.includes(item.status)) {
          return { error: `item is not waiting (status=${item.status})` };
        }
        // T4 — the answer arrived BEFORE the step parked (it is still pending or
        // running). Buffer it: parkItem applies it as soon as the step reaches its
        // wait, instead of dropping the event (prod-plans T4 FAIL).
        const { signal, duplicate } = this.postSignal({
          task_id: item.task_id, task_item_id: id, payload, source: by, now,
        });
        this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_woken',
          payload: { by, buffered: true, duplicate, message: payload } });
        return { ok: true, buffered: true, duplicate, item: this.getTaskItem(id) };
      }
      let wait;
      try { wait = JSON.parse(item.wait_json); } catch { wait = {}; }
      if (wait.woken_at) {
        // T5: the FIRST answer wins — a second wake must not overwrite it.
        this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_woken',
          payload: { by, already_woken: true, message: payload } });
        return { ok: true, already_woken: true, item: this.getTaskItem(id) };
      }
      const { signal, duplicate } = this.postSignal({
        task_id: item.task_id, task_item_id: id, payload, source: by, now,
      });
      const effective = duplicate ? signalText(signal) : payload;
      wait = { ...wait, woken_at: now, woken_by: by, wake_message: effective == null ? null : String(effective).slice(0, 4000) };
      this._prep('UPDATE task_items SET wait_json = ?, due_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(wait), now, now, id);
      this._prep('UPDATE task_signals SET consumed_at = ? WHERE task_id = ? AND task_item_id = ?')
        .run(now, item.task_id, id);
      this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_woken',
        payload: { by, buffered: false, duplicate, message: effective } });
      this._bump(item.task_id);
      return { item: this.getTaskItem(id), duplicate };
    })();
  }

  // ── Incoming signals (#87 B1.2, prod-plans T4/T5) ─────────────────────────
  /**
   * Record an incoming signal for a plan step. Identity = userTaskId + step, so
   * two wakes for the same step are ONE signal (a duplicate never overwrites the
   * first payload); a different step — a different signal.
   *
   * An UNCONSUMED row is a signal nobody has applied yet → duplicate.
   * A CONSUMED row is history of an earlier wait cycle → a new signal for a later
   * wait of the same step replaces it (that is a new event, not a duplicate).
   *
   * @returns {{signal: object, duplicate: boolean}}
   */
  postSignal({ task_id, task_item_id, event_type = 'wake', source = null, payload = null, now = null }) {
    if (!task_id || !task_item_id) throw new Error('task_id and task_item_id are required');
    const at = now == null ? nowMs() : now;
    const json = payload == null ? null : JSON.stringify(payload);
    const select = () => this._prep('SELECT * FROM task_signals WHERE task_id = ? AND task_item_id = ?')
      .get(task_id, task_item_id);
    return this.db.transaction(() => {
      const existing = select();
      if (existing && existing.consumed_at == null) return { signal: existing, duplicate: true };
      if (existing) {
        this._prep(`UPDATE task_signals SET event_type = ?, source = ?, payload_json = ?,
            created_at = ?, consumed_at = NULL WHERE task_id = ? AND task_item_id = ?`)
          .run(event_type, source, json, at, task_id, task_item_id);
        return { signal: select(), duplicate: false };
      }
      this._prep(`INSERT INTO task_signals
          (task_id, task_item_id, event_type, source, payload_json, created_at, consumed_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .run(task_id, task_item_id, event_type, source, json, at);
      return { signal: select(), duplicate: false };
    })();
  }

  getSignal(taskId, itemId) {
    return this._prep('SELECT * FROM task_signals WHERE task_id = ? AND task_item_id = ?')
      .get(taskId, itemId) || null;
  }

  /** Signals of a plan, profile-scoped, newest first. */
  listSignals(taskId, profileId) {
    return this._prep(`SELECT s.* FROM task_signals s
      JOIN durable_tasks t ON t.id = s.task_id
      WHERE s.task_id = ? AND t.profile_id = ?
      ORDER BY s.created_at DESC, s.rowid DESC`).all(taskId, profileId);
  }

  /** Items parked on a user answer, for the chat-context notice. Profile-scoped. */
  listItemsAwaitingUser(profileId) {
    return this._prep(`SELECT i.id, i.title, i.wait_json, t.goal, t.id AS task_id FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE t.profile_id = ? AND t.status IN ('active','awaiting_input') AND i.status = 'waiting' AND i.wait_json IS NOT NULL
      ORDER BY i.updated_at DESC LIMIT 20`).all(profileId)
      .filter(row => { try { const w = JSON.parse(row.wait_json); return w.awaiting_user === true && !w.woken_at; } catch { return false; } });
  }

  /**
   * Every unresolved wait of every active plan, with its owner profile (#1846).
   * The GitHub webhook is not profile-scoped: one delivery may satisfy a wait of
   * any profile, so the wake path scans them all. Bounded by active waits, which
   * is the same small set countActiveWaits() counts.
   */
  listActiveWaiters() {
    return this._prep(`SELECT i.id, i.task_id, t.profile_id, i.wait_json FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE t.status = 'active' AND i.status IN ('pending','waiting')
        AND i.wait_json IS NOT NULL
        AND json_extract(i.wait_json, '$.resolved') IS NULL`).all();
  }

  /**
   * Bring a waiting item's next poll forward to `now` because an external event
   * matched its condition (#1846). This is NOT a resolution — the verdict still
   * comes from the validator on the poll — so `resolved` is never written here.
   * Idempotent per GitHub delivery: a redelivery with the same `x-github-delivery`
   * id is recorded and ignored (GitHub retries), so `due_at` never moves backward
   * and no second wake is armed.
   * @returns {{item:object|null, changed:boolean, reason?:string}}
   */
  accelerateWaitByEvent(id, { deliveryId = null, event = null, key = null, subject = null, now = nowMs() } = {}) {
    return this.db.transaction(() => {
      const row = this._prep('SELECT id, task_id, wait_json, due_at FROM task_items WHERE id = ?').get(id);
      if (!row || !row.wait_json) return { item: null, changed: false, reason: 'no-wait' };
      let wait;
      try { wait = JSON.parse(row.wait_json); } catch { return { item: null, changed: false, reason: 'bad-wait' }; }
      if (wait.resolved) return { item: this.getTaskItem(id), changed: false, reason: 'resolved' };
      const seen = Array.isArray(wait.event_deliveries) ? wait.event_deliveries : [];
      if (deliveryId && seen.includes(deliveryId)) return { item: this.getTaskItem(id), changed: false, reason: 'duplicate' };
      const next = {
        ...wait,
        event_woken_at: now,
        event_woken_by: { event, key, subject },
        event_deliveries: deliveryId ? [...seen, deliveryId].slice(-20) : seen,
      };
      // Only pull the poll forward; never push it later.
      const dueAt = row.due_at != null && row.due_at < now ? row.due_at : now;
      this._prep('UPDATE task_items SET due_at = ?, wait_json = ?, updated_at = ? WHERE id = ?')
        .run(dueAt, JSON.stringify(next), now, id);
      this._bump(row.task_id);
      return { item: this.getTaskItem(id), changed: true };
    })();
  }

  expireWaitingDeadlines(now = nowMs()) {
    return this.db.transaction(() => {
      const rows = this._prep(`SELECT id, task_id FROM task_items
        WHERE status = 'waiting' AND wait_deadline_at IS NOT NULL AND wait_deadline_at <= ?`)
        .all(now);
      for (const row of rows) {
        this._prep(`UPDATE task_items SET status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ?`).run('wait deadline expired', now, row.id);
        this._bump(row.task_id);
      }
      return rows.length;
    })();
  }

  failItem(id, profileId, { executionId = null, error = null, claimGeneration = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const fence = this._claimFence(claimGeneration);
      const upd = this._prep(`UPDATE task_items SET status = 'failed', last_execution_id = ?,
          last_error = ?, updated_at = ? WHERE id = ?${fence.clause}`)
        .run(executionId, error, nowMs(), id, ...fence.args);
      if (upd.changes === 0) return null;
      this.recordEvent({ task_id: item.task_id, task_item_id: id, type: 'item_failed',
        payload: { execution_id: executionId, error: error == null ? null : String(error).slice(0, 300) } });
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /**
   * #1861 Fix C: restart a terminally `failed` step once its cause is fixed.
   * Re-pends the item with a FRESH attempt budget (attempt_count=0) and clears
   * the wait state; if the whole plan was parked on that failure (`blocked`, or
   * legacy `failed`), the task returns to `active` so the scheduler claims the
   * step again. `last_error` keeps the retry reason for the next run's context.
   * Profile-scoped: returns the updated item, or null when not owned.
   */
  retryItem(id, profileId, { reason = null, by = 'agent' } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const now = nowMs();
      this._prep(`UPDATE task_items SET status = 'pending', due_at = NULL, wait_json = NULL,
          wait_deadline_at = NULL, attempt_count = 0, last_error = ?,
          last_recovery_action = 'manual_retry', updated_at = ? WHERE id = ?`)
        .run(reason, now, id);
      const task = this._prep('SELECT status FROM durable_tasks WHERE id = ?').get(item.task_id);
      if (task && (task.status === 'blocked' || task.status === 'failed')) {
        this._prep(`UPDATE durable_tasks SET status = 'active', updated_at = ?,
            revision = revision + 1 WHERE id = ?`).run(now, item.task_id);
        this.recordEvent({ task_id: item.task_id, type: 'task_status',
          payload: { from: task.status, to: 'active', by: 'retry' } });
      }
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  // ── Structured step result (#87 B1.3, ARCHITECTURE §4.4) ──────────────────
  /**
   * The step reports its own verdict (task_item_result) instead of making the
   * server parse `DURABLE:` out of the reply text — 94% of OpenCode step failures
   * were «no terminal marker» although the work WAS done (#1907 audit).
   *
   * Only the attempt that is running on this step may post: `attempt` (the
   * generation from the prompt) must match `claim_generation`, and the row itself
   * must be `running`. The marker stays mandatory for the engines that do not call
   * the tool — this is an added channel, not a replacement.
   *
   * @returns {{ok: true, result: object} | {error: string}}
   */
  setStructuredResult(itemId, profileId, { status, result = null, note = null, attempt = null } = {}) {
    if (!['done', 'failed', 'waiting'].includes(status)) {
      return { error: `invalid status: ${status} (expected done | failed | waiting)` };
    }
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(itemId, profileId);
      if (!item) return { error: 'item not found (or not owned by this profile)' };
      if (item.status !== 'running') {
        return { error: `task_item_result posts the result of the step that is running now (status=${item.status})` };
      }
      const current = item.claim_generation ?? 0;
      if (attempt != null && Number(attempt) !== current) {
        return { error: `stale attempt: the result is for attempt ${attempt}, the step is on attempt ${current}` };
      }
      const payload = {
        status, result: result ?? null,
        note: note == null ? null : String(note).slice(0, 2000),
        at: nowMs(), attempt: current,
      };
      this._prep('UPDATE task_items SET result_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(payload), nowMs(), itemId);
      this.recordEvent({ task_id: item.task_id, task_item_id: itemId, type: 'step_result',
        payload: { status, note: payload.note, attempt: current } });
      return { ok: true, result: payload };
    })();
  }

  /** The step's structured result for its CURRENT attempt, or null. */
  getStructuredResult(itemId) {
    const row = this._prep('SELECT result_json FROM task_items WHERE id = ?').get(itemId);
    if (!row || !row.result_json) return null;
    try {
      const r = JSON.parse(row.result_json);
      return r && typeof r === 'object' && ['done', 'failed', 'waiting'].includes(r.status) ? r : null;
    } catch { return null; }
  }

  // ── Validation results + item evidence (P3d) ───────────────────────────
  /**
   * Append one machine-checked validation verdict (task_validation_results).
   * The write is anchored to the parent task's owner: `profile_id` is optional
   * for the caller but, when passed, must match — no cross-profile write.
   * `subject_json` / `evidence_json` are already-serialized JSON strings.
   */
  recordValidation({ task_id, profile_id = null, task_item_id = null, execution_id = null,
    criterion_id, contract_revision = 1, validator, status, subject_json = null, evidence_json = null }) {
    if (!task_id) throw new Error('task_id is required');
    if (!criterion_id) throw new Error('criterion_id is required');
    if (!validator) throw new Error('validator is required');
    if (!['pass', 'fail', 'inconclusive'].includes(status)) throw new Error(`invalid validation status: ${status}`);
    const task = this._prep('SELECT id, profile_id FROM durable_tasks WHERE id = ?').get(task_id);
    if (!task) throw new Error(`task not found: ${task_id}`);
    if (profile_id && task.profile_id !== profile_id) throw new Error('validation ownership mismatch');
    const id = crypto.randomUUID();
    this._prep(`INSERT INTO task_validation_results
        (id, task_id, task_item_id, execution_id, criterion_id, contract_revision, validator,
         status, subject_json, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, task_id, task_item_id, execution_id, criterion_id, contract_revision, validator,
        status, subject_json, evidence_json, nowMs());
    return this.getValidation(id);
  }

  getValidation(id) {
    return this._prep('SELECT * FROM task_validation_results WHERE id = ?').get(id) || null;
  }

  /** All validation rows for a task, profile-scoped, oldest first. */
  listValidations(taskId, profileId) {
    return this._prep(`SELECT v.* FROM task_validation_results v
      JOIN durable_tasks t ON t.id = v.task_id
      WHERE v.task_id = ? AND t.profile_id = ?
      ORDER BY v.rowid`).all(taskId, profileId);
  }

  /**
   * Attach step evidence (and a completion timestamp) to an item. Kept separate
   * from completeItem: `evidence_json` / `completed_at` are contract-plan fields,
   * while completeItem stays the legacy status transition.
   */
  setItemEvidence(itemId, profileId, { evidence_json = null, completed_at = null, claimGeneration = null } = {}) {
    if (!this._itemOwnedBy(itemId, profileId)) return null;
    const sets = ['updated_at = ?'];
    const args = [nowMs()];
    if (evidence_json !== null) { sets.push('evidence_json = ?'); args.push(evidence_json); }
    if (completed_at !== null) { sets.push('completed_at = ?'); args.push(completed_at); }
    const fence = this._claimFence(claimGeneration);
    args.push(itemId, ...fence.args);
    const changes = this.db.transaction(() => {
      const r = this._prep(`UPDATE task_items SET ${sets.join(', ')} WHERE id = ?${fence.clause}`).run(...args);
      if (r.changes === 0) return 0;
      const item = this.getTaskItem(itemId);
      this._bump(item.task_id);
      return r.changes;
    })();
    return changes ? this.getTaskItem(itemId) : null;
  }

  // ── Hook execution log (P4, #1459) ─────────────────────────────────────
  /**
   * Record one hook boundary outcome. `boundary_key` is unique, so a replay of
   * the same (task, item, event, index) is a no-op — a fired notification is
   * never re-delivered and a skip is not double-logged. Returns
   * `{recorded, row}` where `recorded:false` means the boundary already existed.
   */
  recordHookExecution({ task_id, task_item_id = null, event, hook_index, hook_type,
    status, detail = null, boundary_key }) {
    if (!task_id) throw new Error('task_id is required');
    if (!['fired', 'skipped', 'failed'].includes(status)) throw new Error(`invalid hook status: ${status}`);
    if (!boundary_key) throw new Error('boundary_key is required');
    return this.db.transaction(() => {
      const existing = this._prep('SELECT * FROM hook_executions WHERE boundary_key = ?').get(boundary_key);
      if (existing) return { recorded: false, row: existing };
      const id = crypto.randomUUID();
      this._prep(`INSERT INTO hook_executions
          (id, task_id, task_item_id, event, hook_index, hook_type, status, detail, boundary_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, task_id, task_item_id, event, hook_index, hook_type, status, detail, boundary_key, nowMs());
      return { recorded: true, row: this.getHookExecution(id) };
    })();
  }

  getHookExecution(id) {
    return this._prep('SELECT * FROM hook_executions WHERE id = ?').get(id) || null;
  }

  hasHookRun(boundaryKey) {
    return !!this._prep('SELECT 1 FROM hook_executions WHERE boundary_key = ?').get(boundaryKey);
  }

  /** All hook boundary rows for a task, profile-scoped, oldest first. */
  listHookExecutions(taskId, profileId) {
    return this._prep(`SELECT h.* FROM hook_executions h
      JOIN durable_tasks t ON t.id = h.task_id
      WHERE h.task_id = ? AND t.profile_id = ?
      ORDER BY h.rowid`).all(taskId, profileId);
  }

  progressSummary(taskId, profileId) {
    const row = this._prep(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN i.status IN ('done','skipped') THEN 1 ELSE 0 END) AS finished
      FROM task_items i JOIN durable_tasks t ON t.id = i.task_id
      WHERE i.task_id = ? AND t.profile_id = ?`).get(taskId, profileId);
    return { total: row?.total || 0, finished: row?.finished || 0 };
  }

  _itemOwnedBy(id, profileId) {
    return this._prep(`SELECT i.* FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE i.id = ? AND t.profile_id = ?`).get(id, profileId) || null;
  }

  /**
   * Attempt-fencing SQL fragment (#87 B1.1). `claimGeneration` is the generation the
   * writing attempt claimed from claimNextRunnable; null fences nothing (legacy/tick
   * callers that own the current claim outright). With a fence the UPDATE reports
   * `changes === 0` when a newer attempt has re-claimed the step — that is a refusal,
   * not a missing row.
   */
  _claimFence(claimGeneration) {
    return claimGeneration == null
      ? { clause: '', args: [] }
      : { clause: ' AND claim_generation = ?', args: [claimGeneration] };
  }

  _bump(taskId) {
    this._prep(`UPDATE durable_tasks SET revision = revision + 1, updated_at = ?
      WHERE id = ?`).run(nowMs(), taskId);
    this._refreshAwaitState(taskId);
  }

  /**
   * The task is `awaiting_input` while one of its steps is parked on the OWNER
   * (an unresolved `awaiting_user` wait that nobody has woken yet) and `active`
   * otherwise (#87 B1.4 — «статус должен стать явным состоянием»). Recomputed on
   * every item mutation through `_bump`, the single choke point every store write
   * already goes through, plus `setItemWait` (which does not bump).
   * Never touches a non-alive status (draft/paused/blocked/terminal).
   */
  _refreshAwaitState(taskId) {
    const t = this._prep('SELECT status FROM durable_tasks WHERE id = ?').get(taskId);
    if (!t || !TASK_STATUSES_ALIVE.includes(t.status)) return;
    const row = this._prep(`SELECT EXISTS(
        SELECT 1 FROM task_items
        WHERE task_id = ? AND status = 'waiting' AND wait_json IS NOT NULL
          AND json_extract(wait_json, '$.awaiting_user') = 1
          AND json_extract(wait_json, '$.resolved') IS NULL
          AND json_extract(wait_json, '$.woken_at') IS NULL) AS awaiting`).get(taskId);
    const want = row.awaiting ? 'awaiting_input' : 'active';
    if (want === t.status) return;
    this.db.transaction(() => {
      this._prep(`UPDATE durable_tasks SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status IN ('active','awaiting_input')`).run(want, nowMs(), taskId);
      this.recordEvent({ task_id: taskId, type: 'task_status', payload: { from: t.status, to: want } });
    })();
  }

  // ── Sessions (many-to-many) ────────────────────────────────────────────
  attachSession(taskId, sessionId, profileId) {
    return this.db.transaction(() => {
      const task = this.getTask(taskId, profileId);
      if (!task) return null;
      // one active task per session (unique partial index enforces too — surface nicely)
      const clash = this._prep(`SELECT task_id FROM task_sessions
        WHERE profile_id = ? AND session_id = ? AND active = 1 AND task_id != ?`)
        .get(profileId, sessionId, taskId);
      if (clash) throw new Error(`session ${sessionId} already has an active task ${clash.task_id}`);
      this._prep(`INSERT INTO task_sessions (task_id, session_id, profile_id, attached_at, active)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(task_id, session_id) DO UPDATE SET active = 1, attached_at = ?`)
        .run(taskId, sessionId, profileId, nowMs(), nowMs());
      return true;
    })();
  }

  detachSession(taskId, sessionId, profileId) {
    const res = this._prep(`UPDATE task_sessions SET active = 0
      WHERE task_id = ? AND session_id = ? AND profile_id = ?`)
      .run(taskId, sessionId, profileId);
    return res.changes > 0;
  }

  /** Active (status=active) task this session is attached to or started (#1886), or null. */
  activeTaskForSession(profileId, sessionId) {
    return this._prep(`SELECT t.* FROM task_sessions s
      JOIN durable_tasks t ON t.id = s.task_id
      WHERE s.profile_id = ? AND s.session_id = ? AND s.active = 1 AND t.status IN ('active','awaiting_input')
      LIMIT 1`).get(profileId, sessionId)
      || this._prep(`SELECT * FROM durable_tasks
      WHERE profile_id = ? AND origin_session_id = ? AND status IN ('active','awaiting_input')
      ORDER BY created_at DESC LIMIT 1`).get(profileId, sessionId)
      || null;
  }

  listSessions(taskId, profileId) {
    return this._prep(`SELECT s.* FROM task_sessions s
      JOIN durable_tasks t ON t.id = s.task_id
      WHERE s.task_id = ? AND s.profile_id = ?`).all(taskId, profileId);
  }

  // ── Executions (minimal history) ───────────────────────────────────────
  /**
   * Start an execution and count the attempt. attempt_count is bumped here (not
   * in claimNextRunnable) on purpose: a claim that only defers to a busy session
   * is not a real attempt — only a step that actually starts executing is. The
   * per-step budget reads attempt_count against `max_attempts`.
   */
  startExecution({ id, task_id, task_item_id = null, session_id = null,
                   engine = null, model = null, tier = null,
                   profile = null, model_level = null, executor_role = null, provider = null }) {
    return this.db.transaction(() => {
      if (task_item_id) {
        this._prep(`UPDATE task_items SET attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ?`).run(nowMs(), task_item_id);
      }
      // #1910: record WHICH attempt this execution is — without it a failure chain
      // can't be told apart from retries in any export.
      const attempt = task_item_id
        ? (this._prep('SELECT attempt_count FROM task_items WHERE id = ?').get(task_item_id)?.attempt_count || null)
        : null;
      this._prep(`INSERT INTO executions
          (id, task_id, task_item_id, session_id, engine, model, tier, status, started_at,
           profile, model_level, executor_role, provider, attempt_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
        .run(id, task_id, task_item_id, session_id, engine, model, tier, nowMs(),
          profile, model_level, executor_role, provider, attempt);
      return this.getExecution(id);
    })();
  }

  finishExecution(id, { status, error_class = null, error_text = null }) {
    this._prep(`UPDATE executions SET status = ?, finished_at = ?, error_class = ?,
        error_text = ? WHERE id = ?`)
      .run(status, nowMs(), error_class, error_text, id);
    return this.getExecution(id);
  }

  /**
   * #1910: patch attribution fields the runner learns only AFTER the engine answered
   * (the concrete model id, the token usage). Deliberately does NOT touch status /
   * error_* — the settle path owns those and the two writes must not clobber each
   * other when they race (runner patches first, settle finishes after).
   */
  patchExecution(id, { model = null, result_json = null } = {}) {
    const sets = []; const args = [];
    if (model != null) { sets.push('model = ?'); args.push(model); }
    if (result_json != null) { sets.push('result_json = ?'); args.push(result_json); }
    if (!sets.length) return this.getExecution(id);
    args.push(id);
    this._prep(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.getExecution(id);
  }

  getExecution(id) {
    return this._prep('SELECT * FROM executions WHERE id = ?').get(id) || null;
  }

  // ── Event journal (#87 B1.4) ──────────────────────────────────────────────
  /**
   * Append one journal row. Append-only — nothing ever rewrites a row (only the
   * plan's ON DELETE CASCADE removes one) — and always inside the SAME
   * transaction as the change it describes, so «status = колонка, history =
   * события» can never disagree.
   */
  recordEvent({ task_id, task_item_id = null, type, payload = null }) {
    if (!task_id) throw new Error('task_id is required');
    if (!type) throw new Error('type is required');
    this._prep(`INSERT INTO task_events (task_id, task_item_id, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)`)
      .run(task_id, task_item_id, type, payload == null ? null : JSON.stringify(payload), nowMs());
    return true;
  }

  /** Journal of one plan, profile-scoped, newest first. */
  listTaskEvents(taskId, profileId, { limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return this._prep(`SELECT e.* FROM task_events e
      JOIN durable_tasks t ON t.id = e.task_id
      WHERE e.task_id = ? AND t.profile_id = ?
      ORDER BY e.rowid DESC LIMIT ?`).all(taskId, profileId, n);
  }

  // ── File projection ────────────────────────────────────────────────────
  /**
   * checklist.md is generated FROM the DB. Deleting the file never deletes the
   * task; call this on startup and after every task/item mutation.
   */
  generateChecklistMd(taskId, profileId) {
    const task = this.getTask(taskId, profileId);
    if (!task) return null;
    const items = this.listTaskItems(taskId, profileId);
    const lines = [`# ${task.goal}`, '', `Task: ${task.id}`, `Revision: ${task.revision}`, ''];
    for (const it of items) {
      const box = (it.status === 'done' || it.status === 'skipped') ? 'x' : ' ';
      const skip = it.status === 'skipped' ? ' (skipped)' : '';
      const executor = task.acceptance_criteria_json
        ? (it.execution_kind === 'programmatic' ? 'programmatic' : `${it.executor_role}/${it.minimum_model_level}/${it.context_budget}`)
        : it.current_tier;
      lines.push(`- [${box}] [${executor}] ${it.title}${skip}`);
    }
    return lines.join('\n') + '\n';
  }

  writeProjection(taskId, profileId, projectDir) {
    const md = this.generateChecklistMd(taskId, profileId);
    if (!md) return null;
    const dir = path.join(projectDir, '.trained-assist', 'tasks', taskId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'checklist.md');
    atomicText(file, md);
    return file;
  }

  /** Rebuild projections for all active tasks (startup catch-up). */
  rebuildProjections(projectDir, profileId) {
    const out = [];
    for (const t of this.listTasks(profileId, { status: TASK_STATUSES_ALIVE })) {
      const f = this.writeProjection(t.id, profileId, projectDir);
      if (f) out.push(f);
    }
    return out;
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { DurableTaskStore, TASK_STATUSES, TASK_STATUSES_ALIVE, ITEM_STATUSES, TIERS, TIER_RANK, signalText };
