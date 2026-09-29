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

const TASK_STATUSES = ['draft', 'paused', 'blocked', 'active', 'done', 'failed', 'cancelled'];
const ITEM_STATUSES = ['pending', 'running', 'waiting', 'done', 'failed', 'skipped'];
const TIERS = ['free', 'standard', 'strong'];
const TIER_RANK = { free: 0, standard: 1, strong: 2 };
// P3c: the contract model ladder a step may be escalated through (matches
// playbook-executor LEVELS — the executor resolver reads current_model_level).
const MODEL_LEVELS = ['bachelor', 'master', 'doctor'];

function nowMs() { return Date.now(); }

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
                    CHECK (status IN ('active','done','failed','cancelled')),
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
    this._prep(`INSERT INTO durable_tasks
        (id, profile_id, project_id, goal, status, created_at, updated_at, revision)
        VALUES (?, ?, ?, ?, 'active', ?, ?, 0)`)
      .run(id, profile_id, project_id, goal, ts, ts);
    return this.getTask(id, profile_id);
  }

  /** Persist the complete planner contract in one transaction. No execution. */
  createPlan({ id = crypto.randomUUID(), profile_id, project_id = null, goal,
    playbook_id = null, playbook_version = null, user_value, acceptance_criteria,
    items, session_id = null, execution_policy = null, request_id = null, hooks = null }) {
    if (typeof user_value !== 'string' || !user_value.trim()) throw new Error('user_value required');
    if (!Array.isArray(acceptance_criteria) || !acceptance_criteria.length || acceptance_criteria.some(c => !c || typeof c !== 'object' || Array.isArray(c) || !Object.keys(c).length)) throw new Error('acceptance_criteria required');
    if (!Array.isArray(items) || !items.length) throw new Error('items required');
    return this.db.transaction(() => {
      this.createTask({ id, profile_id, project_id, goal });
      this._prep(`UPDATE durable_tasks SET status='draft', playbook_id=?, playbook_version=?,
        user_value=?, acceptance_criteria_json=?, execution_policy_json=?, request_id=?, hooks_json=? WHERE id=?`)
        .run(playbook_id, playbook_version, user_value, JSON.stringify(acceptance_criteria),
          execution_policy == null ? null : JSON.stringify(execution_policy), request_id,
          hooks == null ? null : JSON.stringify(hooks), id);
      items.forEach((item, position) => {
        validateItem(item);
        const itemId = crypto.randomUUID();
        this.createTaskItem({ id: itemId, task_id: id, title: item.title, position,
          delay_after_sec: item.delay_after_sec ?? 0 });
        this._prep(`UPDATE task_items SET stage=?, instructions=?, execution_kind=?, executor_role=?,
          minimum_model_level=?, current_model_level=?, context_budget=?, validation_json=?,
          max_attempts=?, execution_timeout_seconds=?, hooks_json=?, wait_json=? WHERE id=?`)
          .run(item.stage ?? null, item.instructions ?? null, item.execution_kind,
            item.executor_role ?? null, item.minimum_model_level ?? null, item.minimum_model_level ?? null,
            item.context_budget ?? null, JSON.stringify(item.validation), item.max_attempts ?? 3,
            item.execution_timeout_seconds ?? 600,
            item.hooks == null ? null : JSON.stringify(item.hooks),
            item.wait == null ? null : JSON.stringify({ then: 'complete', ...item.wait }), itemId);
      });
      if (session_id) this.attachSession(id, session_id, profile_id);
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
        max_attempts=?, execution_timeout_seconds=? WHERE id=?`)
        .run(item.stage ?? null, item.instructions ?? null, item.execution_kind,
          item.executor_role ?? null, item.minimum_model_level ?? null, item.minimum_model_level ?? null,
          item.context_budget ?? null, JSON.stringify(item.validation), item.max_attempts ?? 3,
          item.execution_timeout_seconds ?? 600, itemId);
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
    if (status) { sql += ' AND status = ?'; args.push(status); }
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
    const res = this._prep(`UPDATE durable_tasks SET ${sets.join(', ')}
      WHERE id = ? AND profile_id = ?`).run(...args);
    if (res.changes === 0) return null;
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

  updateTaskItem(id, patch, profileId) {
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
        WHERE i.status IN ('pending','waiting') AND t.status = 'active'
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
      this._prep(`UPDATE task_items SET status = 'running', updated_at = ? WHERE id = ?`)
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
      WHERE t.status = 'active' AND i.status IN ('pending','waiting')
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
   */
  completeItem(id, profileId, { executionId = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const now = nowMs();
      this._prep(`UPDATE task_items SET status = 'done', last_execution_id = ?,
          updated_at = ? WHERE id = ?`).run(executionId, now, id);
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
  parkItem(id, profileId, { wait, dueAt, refundAttempt = false, lastError = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      const now = nowMs();
      this._prep(`UPDATE task_items SET status = 'waiting', due_at = ?, wait_deadline_at = NULL,
          wait_json = ?, last_error = ?, updated_at = ?,
          attempt_count = CASE WHEN ? THEN MAX(0, attempt_count - 1) ELSE attempt_count END
          WHERE id = ?`)
        .run(dueAt, wait == null ? null : JSON.stringify(wait), lastError, now, refundAttempt ? 1 : 0, id);
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
  }

  /** Replace an item's wait state without changing its status (e.g. clear it after a wake). */
  setItemWait(id, profileId, wait) {
    if (!this._itemOwnedBy(id, profileId)) return null;
    this._prep('UPDATE task_items SET wait_json = ?, updated_at = ? WHERE id = ?')
      .run(wait == null ? null : JSON.stringify(wait), nowMs(), id);
    return this.getTaskItem(id);
  }

  /**
   * Wake a waiting item now (a user answered, or someone knows the condition
   * holds). The next tick re-checks it; for an agent wait the message is handed
   * to the resumed run. Only a parked item (waiting + wait_json) can be woken.
   */
  wakeItem(id, profileId, { message = null, by = 'user' } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return { error: 'item not found (or not owned by this profile)' };
      if (item.status !== 'waiting' || !item.wait_json) return { error: `item is not waiting (status=${item.status})` };
      let wait;
      try { wait = JSON.parse(item.wait_json); } catch { wait = {}; }
      const now = nowMs();
      wait = { ...wait, woken_at: now, woken_by: by, wake_message: message == null ? null : String(message).slice(0, 4000) };
      this._prep('UPDATE task_items SET wait_json = ?, due_at = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(wait), now, now, id);
      this._bump(item.task_id);
      return { item: this.getTaskItem(id) };
    })();
  }

  /** Items parked on a user answer, for the chat-context notice. Profile-scoped. */
  listItemsAwaitingUser(profileId) {
    return this._prep(`SELECT i.id, i.title, i.wait_json, t.goal, t.id AS task_id FROM task_items i
      JOIN durable_tasks t ON t.id = i.task_id
      WHERE t.profile_id = ? AND t.status = 'active' AND i.status = 'waiting' AND i.wait_json IS NOT NULL
      ORDER BY i.updated_at DESC LIMIT 20`).all(profileId)
      .filter(row => { try { const w = JSON.parse(row.wait_json); return w.awaiting_user === true && !w.woken_at; } catch { return false; } });
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

  failItem(id, profileId, { executionId = null, error = null } = {}) {
    return this.db.transaction(() => {
      const item = this._itemOwnedBy(id, profileId);
      if (!item) return null;
      this._prep(`UPDATE task_items SET status = 'failed', last_execution_id = ?,
          last_error = ?, updated_at = ? WHERE id = ?`)
        .run(executionId, error, nowMs(), id);
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
      }
      this._bump(item.task_id);
      return this.getTaskItem(id);
    })();
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
  setItemEvidence(itemId, profileId, { evidence_json = null, completed_at = null } = {}) {
    if (!this._itemOwnedBy(itemId, profileId)) return null;
    const sets = ['updated_at = ?'];
    const args = [nowMs()];
    if (evidence_json !== null) { sets.push('evidence_json = ?'); args.push(evidence_json); }
    if (completed_at !== null) { sets.push('completed_at = ?'); args.push(completed_at); }
    args.push(itemId);
    this.db.transaction(() => {
      this._prep(`UPDATE task_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
      const item = this.getTaskItem(itemId);
      this._bump(item.task_id);
    })();
    return this.getTaskItem(itemId);
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

  _bump(taskId) {
    this._prep(`UPDATE durable_tasks SET revision = revision + 1, updated_at = ?
      WHERE id = ?`).run(nowMs(), taskId);
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

  /** Active (status=active) task this session is attached to, or null. */
  activeTaskForSession(profileId, sessionId) {
    return this._prep(`SELECT t.* FROM task_sessions s
      JOIN durable_tasks t ON t.id = s.task_id
      WHERE s.profile_id = ? AND s.session_id = ? AND s.active = 1 AND t.status = 'active'
      LIMIT 1`).get(profileId, sessionId) || null;
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
      this._prep(`INSERT INTO executions
          (id, task_id, task_item_id, session_id, engine, model, tier, status, started_at,
           profile, model_level, executor_role, provider)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(id, task_id, task_item_id, session_id, engine, model, tier, nowMs(),
          profile, model_level, executor_role, provider);
      return this.getExecution(id);
    })();
  }

  finishExecution(id, { status, error_class = null, error_text = null }) {
    this._prep(`UPDATE executions SET status = ?, finished_at = ?, error_class = ?,
        error_text = ? WHERE id = ?`)
      .run(status, nowMs(), error_class, error_text, id);
    return this.getExecution(id);
  }

  getExecution(id) {
    return this._prep('SELECT * FROM executions WHERE id = ?').get(id) || null;
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
    for (const t of this.listTasks(profileId, { status: 'active' })) {
      const f = this.writeProjection(t.id, profileId, projectDir);
      if (f) out.push(f);
    }
    return out;
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

module.exports = { DurableTaskStore, TASK_STATUSES, ITEM_STATUSES, TIERS, TIER_RANK };
