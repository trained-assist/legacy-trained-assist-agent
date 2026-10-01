'use strict';

// Additive plan-persistence migration. Legacy tier columns remain readable until
// the executor runtime is migrated; new plans use independent role/level/budget.
module.exports = function migratePlan(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='durable_tasks'").get().sql;
      if (!schema.includes("'draft'")) {
        db.exec(schema.replace('durable_tasks', 'durable_tasks_new').replace("'active','done','failed','cancelled'", "'draft','active','paused','blocked','done','failed','cancelled'"));
        db.exec('INSERT INTO durable_tasks_new SELECT * FROM durable_tasks; DROP TABLE durable_tasks; ALTER TABLE durable_tasks_new RENAME TO durable_tasks;');
      }
      const additions = {
        durable_tasks: {
          playbook_id: 'TEXT', playbook_version: 'INTEGER', user_value: 'TEXT',
          acceptance_criteria_json: 'TEXT', contract_revision: 'INTEGER NOT NULL DEFAULT 1',
          execution_policy_json: 'TEXT', execution_session_id: 'TEXT', request_id: 'TEXT', blocker_reason: 'TEXT',
          // P4 (#1459): resolved playbook hooks pinned at playbook_version — task_done/task_failed.
          hooks_json: 'TEXT',
          // Fanout (#1752): a child plan spawned by a parent's fanout step.
          parent_task_id: 'TEXT', parent_item_id: 'TEXT', batch_item_key: 'TEXT',
          // #1886: the plan's owner chat — the session it was started from plus a
          // snapshot {chatId,audience,threadId} of that session's chat at creation.
          // Separate from task_sessions («the session's active task», one per session).
          origin_session_id: 'TEXT', origin_chat_json: 'TEXT',
        },
        task_items: {
          // P4 (#1459): resolved per-item hooks — step on_complete/on_fail and the
          // stage boundaries carried on the stage's first/last item.
          hooks_json: 'TEXT',
          stage: 'TEXT', instructions: 'TEXT', execution_kind: "TEXT NOT NULL DEFAULT 'agent' CHECK(execution_kind IN ('agent','programmatic'))",
          executor_role: "TEXT CHECK(executor_role IN ('researcher','developer','reviewer','verifier'))",
          minimum_model_level: "TEXT CHECK(minimum_model_level IN ('bachelor','master','doctor'))",
          current_model_level: "TEXT CHECK(current_model_level IN ('bachelor','master','doctor'))",
          context_budget: "TEXT CHECK(context_budget IN ('small','medium','large'))", validation_json: 'TEXT',
          // P3d-1c: per-step validation_mode override (nullable). NULL → inherit
          // the plan's execution_policy_json.validation_mode; a set value beats it.
          validation_mode: "TEXT CHECK(validation_mode IN ('programmatic','programmatic+llm','programmatic+llm-fastpass'))",
          attempt_count: 'INTEGER NOT NULL DEFAULT 0', max_attempts: 'INTEGER NOT NULL DEFAULT 3',
          execution_timeout_seconds: 'INTEGER NOT NULL DEFAULT 600', wait_deadline_at: 'INTEGER', evidence_json: 'TEXT', completed_at: 'INTEGER',
          // P3c: observability of the last recovery decision (failure-classifier class
          // + recovery-policy action) so a stuck step can be diagnosed without replaying logs.
          last_failure_class: 'TEXT', last_recovery_action: 'TEXT',
          // agent-declared exception for this step {reason, by, at} (task_item_exception)
          exception_json: 'TEXT',
          // Durable wait (wait-until): {until, then, poll_every_sec, timeout_sec,
          // started_at, deadline_at, reason, awaiting_user, wake_message, ...}.
          // NULL = the step does not wait. See src/durable-wait.js.
          wait_json: 'TEXT',
          // already_done (#1959): deterministic pre-check evaluated when the step is
          // claimed, BEFORE any model run. All pass → the step is closed with an
          // audit row and the next step is taken; not pass → the normal run. NULL =
          // no pre-check. Keys are registry validators, same shape as validation_json.
          already_done_json: 'TEXT',
          // Fanout (#1752): batch config + durable state of a fanout step
          // (queue, child task per element, supervisor journal). See src/playbook-fanout.js.
          fanout_json: 'TEXT',
          // Structured step result (#87 B1.3, ARCHITECTURE §4.4): what the step
          // itself reports through task_item_result — {status, result, note, at,
          // attempt}. Settled on this instead of parsing `DURABLE:` out of the
          // reply text (94% of OpenCode step failures were a missing marker).
          // Cleared by claimNextRunnable: every attempt starts with a clean result.
          result_json: 'TEXT',
          // Attempt fencing (prod-plans T6 / red-team B3, epic #87 B1.1): bumped by
          // claimNextRunnable on every claim; every settle write of that attempt carries
          // the generation it claimed, so a stale attempt (45-min orphan grace re-queued a
          // run that was still alive) can no longer overwrite the step a newer attempt owns.
          claim_generation: 'INTEGER NOT NULL DEFAULT 0',
        },
        executions: { executor_role: 'TEXT', model_level: 'TEXT', context_budget: 'TEXT', profile: 'TEXT', provider: 'TEXT', attempt_number: 'INTEGER', result_json: 'TEXT' },
      };
      for (const [table, columns] of Object.entries(additions)) {
        const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        for (const [column, type] of Object.entries(columns)) {
          if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      }
      db.exec(`UPDATE task_items SET
        minimum_model_level = CASE execution_tier WHEN 'free' THEN 'bachelor' WHEN 'standard' THEN 'master' ELSE 'doctor' END,
        current_model_level = CASE current_tier WHEN 'free' THEN 'bachelor' WHEN 'standard' THEN 'master' ELSE 'doctor' END,
        executor_role = COALESCE(executor_role, 'developer'), context_budget = COALESCE(context_budget, 'small')
        WHERE execution_kind = 'agent' AND minimum_model_level IS NULL;
        CREATE TABLE IF NOT EXISTS task_validation_results (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          task_item_id TEXT REFERENCES task_items(id), execution_id TEXT REFERENCES executions(id),
          criterion_id TEXT NOT NULL, contract_revision INTEGER NOT NULL, validator TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pass','fail','inconclusive')),
          subject_json TEXT, evidence_json TEXT, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hook_executions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          task_item_id TEXT,
          event TEXT NOT NULL,
          hook_index INTEGER NOT NULL,
          hook_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('fired','skipped','failed')),
          detail TEXT,
          boundary_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_signals (
          -- Identity of an incoming signal = userTaskId + step (epic #87 B1.2):
          -- one signal per plan step, so a second wake for the same step can never
          -- overwrite the first (prod-plans T5: «второй wake перезаписывает
          -- wake_message»). Rows survive consumption as the audit trail.
          task_id      TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
          task_item_id TEXT NOT NULL REFERENCES task_items(id) ON DELETE CASCADE,
          event_type   TEXT NOT NULL DEFAULT 'wake',
          source       TEXT,
          payload_json TEXT,
          created_at   INTEGER NOT NULL,
          consumed_at  INTEGER,
          PRIMARY KEY (task_id, task_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_signals_pending
          ON task_signals(task_id, consumed_at);`);
      if (db.pragma('foreign_key_check').length) throw new Error('plan migration foreign key check failed');
    })();
  } finally { db.pragma('foreign_keys = ON'); }
};
