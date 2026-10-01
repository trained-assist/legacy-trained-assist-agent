// awaiting_input status + the event journal (#87 B1.4).
//
// Before this the plan stayed `active` while a step parked on the owner — the
// wait was visible only in task_items.wait_json, which every transition
// overwrites (pilot T8: «переходы ожидания хранятся в wait_json и затираются»,
// gap 5 «нет статуса задачи ждёт ввода», gap 6 «нет журнала событий»).
//
// Now: status is a column with an explicit `awaiting_input` value, and the
// history that the columns erase lives in append-only task_events, written in
// the same transaction as the change it describes.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DurableTaskStore, TASK_STATUSES } = require('../../src/durable-task-store');
const Database = require('better-sqlite3');

function seeded(s, { items = 1 } = {}) {
  s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  for (let i = 0; i < items; i++) s.createTaskItem({ id: `i${i}`, task_id: 't', position: i, title: `step ${i}` });
  return s;
}
const store = () => seeded(new DurableTaskStore(':memory:'));
// the real park path (the one the settle takes), so the journal and the await
// state see exactly what production writes
const parkOnOwner = (s, id = 'i0') => {
  const parked = s.parkItem(id, 'p', {
    wait: { then: 'rerun', awaiting_user: true, reason: 'нужен ответ', started_at: Date.now(), deadline_at: Date.now() + 3600_000 },
    dueAt: Date.now() + 3600_000,
  });
  if (!parked) throw new Error('parkItem refused');
  return parked;
};

describe('task status awaiting_input (#87 B1.4)', () => {
  it('is a legal status in the schema and in the app enum', () => {
    expect(TASK_STATUSES).toContain('awaiting_input');
    const s = store();
    expect(() => s.updateTask('t', 'p', { status: 'nope' })).toThrow(/invalid task status/);
    // The value is legal for the CHECK (and filterable through task_list), but the
    // state is DERIVED from the steps: with nobody parked on the owner it self-heals
    // back to `active` on the next recompute.
    s.updateTask('t', 'p', { status: 'awaiting_input' });
    expect(s.getTask('t', 'p').status).toBe('active');
    parkOnOwner(s);
    expect(s.updateTask('t', 'p', { status: 'awaiting_input' }).status).toBe('awaiting_input');
  });

  it('an old database is rebuilt to carry the new value (row survives)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'await-mig-'));
    try {
      const file = join(dir, 'state.db');
      const db = new Database(file);
      // the schema as it was BEFORE this change (no draft, no awaiting_input)
      db.exec(`CREATE TABLE durable_tasks (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, project_id TEXT, goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','failed','cancelled')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE task_items (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES durable_tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        execution_tier TEXT NOT NULL DEFAULT 'free', current_tier TEXT NOT NULL DEFAULT 'free',
        escalation_count INTEGER NOT NULL DEFAULT 0, delay_after_sec INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER, last_execution_id TEXT, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE executions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_item_id TEXT,
        session_id TEXT, engine TEXT, model TEXT, tier TEXT, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, error_class TEXT, error_text TEXT);
      CREATE TABLE task_sessions (task_id TEXT NOT NULL, session_id TEXT NOT NULL,
        profile_id TEXT NOT NULL, attached_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (task_id, session_id));`);
      db.prepare('INSERT INTO durable_tasks VALUES (?,?,?,?,?,?,?,?)').run('t', 'p', null, 'старый план', 'active', 1, 1, 0);
      db.prepare(`INSERT INTO task_items (id, task_id, position, title, created_at, updated_at)
        VALUES (?,?,?,?,?,?)`).run('i0', 't', 0, 'шаг', 1, 1);
      db.close();

      const s = new DurableTaskStore(file); // runs the migrations
      expect(s.getTask('t', 'p').status).toBe('active');
      // direct write: the CHECK is what the rebuild had to widen (an app-level set
      // would self-heal back to `active` — nothing is parked on the owner here)
      expect(() => s.db.prepare('UPDATE durable_tasks SET status = ? WHERE id = ?').run('awaiting_input', 't')).not.toThrow();
      expect(s.getTask('t', 'p').status).toBe('awaiting_input');
      expect(s.getTaskItem('i0').title).toBe('шаг'); // existing rows intact
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flips to awaiting_input while a step is parked on the owner, back to active when it is not', () => {
    const s = store();
    expect(s.getTask('t', 'p').status).toBe('active');
    parkOnOwner(s);
    expect(s.getTask('t', 'p').status).toBe('awaiting_input');

    // the owner answers → the wait is woken → the plan runs again
    s.wakeItem('i0', 'p', { message: 'да' });
    expect(s.getTask('t', 'p').status).toBe('active');

    // parked again, then the wait resolves (condition/timer) → active
    s.updateTaskItem('i0', { status: 'running' }, 'p');
    parkOnOwner(s);
    expect(s.getTask('t', 'p').status).toBe('awaiting_input');
    s.setItemWait('i0', 'p', { then: 'rerun', awaiting_user: true, resolved: 'timeout', resolved_at: Date.now() });
    expect(s.getTask('t', 'p').status).toBe('active');
  });

  it('a CONDITION wait does not put the plan in awaiting_input (that is for input)', () => {
    const s = store();
    s.updateTaskItem('i0', { status: 'waiting' }, 'p');
    s.setItemWait('i0', 'p', { then: 'rerun', until: { ci_green: 'url' }, started_at: Date.now(), deadline_at: Date.now() + 3600_000 });
    expect(s.getTask('t', 'p').status).toBe('active');
  });

  it('an awaiting_input plan still claims, is still listed for the notice, still owns its session', () => {
    const s = seeded(new DurableTaskStore(':memory:'), { items: 2 });
    s.attachSession('t', 's1', 'p');
    parkOnOwner(s, 'i0');
    expect(s.getTask('t', 'p').status).toBe('awaiting_input');
    expect(s.listItemsAwaitingUser('p').map(r => r.id)).toEqual(['i0']);
    expect(s.countActiveWaits()).toBe(1);
    expect(s.activeTaskForSession('p', 's1').id).toBe('t'); // the plan is still the session's task
    // the parked step blocks its successor, but a plan-wide projection still sees it
    expect(s.listTasks('p', { status: ['active', 'awaiting_input'] }).map(t => t.id)).toEqual(['t']);
    // the owner answers → the step is woken (and due NOW) → the next claim takes
    // exactly that step; the plan runs again
    s.wakeItem('i0', 'p', { message: 'давай' });
    const claimed = s.claimNextRunnable();
    expect(claimed && claimed.id).toBe('i0');
    expect(claimed.status).toBe('running');
    expect(s.getTask('t', 'p').status).toBe('active');
  });

  it('never clobbers a terminal or explicit status', () => {
    const s = store();
    parkOnOwner(s);
    s.updateTask('t', 'p', { status: 'paused' });
    // an item mutation while paused must not silently un-pause it
    s.updateTaskItem('i0', { status: 'waiting' }, 'p');
    expect(s.getTask('t', 'p').status).toBe('paused');
    s.updateTask('t', 'p', { status: 'cancelled' });
    s.updateTaskItem('i0', { status: 'pending' }, 'p');
    expect(s.getTask('t', 'p').status).toBe('cancelled');
    s.updateTask('t', 'p', { status: 'done' });
    s.updateTaskItem('i0', { status: 'done' }, 'p');
    expect(s.getTask('t', 'p').status).toBe('done');
  });

  it('unpausing a plan whose step is still parked lands in awaiting_input', () => {
    const s = store();
    parkOnOwner(s);
    s.updateTask('t', 'p', { status: 'paused' });
    expect(s.getTask('t', 'p').status).toBe('paused');
    s.updateTask('t', 'p', { status: 'active' });
    expect(s.getTask('t', 'p').status).toBe('awaiting_input');
  });
});

describe('task_events journal (#87 B1.4)', () => {
  it('records creation, status transitions and the wait lifecycle, append-only', () => {
    const s = store();
    const typesOf = () => s.listTaskEvents('t', 'p').map(e => e.type);
    expect(typesOf()).toContain('task_created');

    parkOnOwner(s);
    expect(typesOf()).toContain('task_status');   // active → awaiting_input
    expect(typesOf()).toContain('item_parked');

    s.wakeItem('i0', 'p', { message: 'ответ' });
    expect(typesOf()).toContain('item_woken');

    s.updateTaskItem('i0', { status: 'running' }, 'p');
    s.setItemWait('i0', 'p', { then: 'rerun', awaiting_user: true, reason: 'x' });
    s.setItemWait('i0', 'p', { then: 'rerun', awaiting_user: true, resolved: 'woken', resolved_at: Date.now() });
    expect(typesOf()).toContain('wait_resolved');

    s.completeItem('i0', 'p', {});
    expect(typesOf()).toContain('item_done');
    expect(typesOf()).toContain('task_status');   // → active / → done

    const rows = s.listTaskEvents('t', 'p');
    expect(rows.length).toBe(typesOf().length);
    // append-only: older rows are never rewritten
    const first = rows[rows.length - 1];
    expect(first.type).toBe('task_created');
    expect(first.created_at).toBeGreaterThan(0);
  });

  it('payloads are parsed back and the read is profile-scoped', () => {
    const s = store();
    parkOnOwner(s);
    const [status] = s.listTaskEvents('t', 'p').filter(e => e.type === 'task_status');
    expect(JSON.parse(status.payload_json)).toMatchObject({ from: 'active', to: 'awaiting_input' });
    const [parked] = s.listTaskEvents('t', 'p').filter(e => e.type === 'item_parked');
    expect(JSON.parse(parked.payload_json)).toMatchObject({ awaiting_user: true, reason: 'нужен ответ' });
    expect(parked.task_item_id).toBe('i0');
    expect(s.listTaskEvents('t', 'intruder')).toEqual([]);
    expect(s.listTaskEvents('t', 'p', { limit: 1 })).toHaveLength(1);
  });

  it('terminal item transitions and a posted step result are journaled too', () => {
    const s = seeded(new DurableTaskStore(':memory:'), { items: 2 });
    s.claimNextRunnable();
    s.setStructuredResult('i0', 'p', { status: 'done', note: 'ок' });
    s.failItem('i0', 'p', { error: 'упало' });
    const types = s.listTaskEvents('t', 'p').map(e => e.type);
    expect(types).toContain('step_result');
    expect(types).toContain('item_failed');
    const failed = s.listTaskEvents('t', 'p').find(e => e.type === 'item_failed');
    expect(JSON.parse(failed.payload_json).error).toBe('упало');
    s.skipItem('i1', 'p', { reason: 'не применяется' }).id;
    expect(s.listTaskEvents('t', 'p').map(e => e.type)).toContain('item_skipped');
  });

  it('recordEvent refuses a malformed row', () => {
    const s = store();
    expect(() => s.recordEvent({ type: 'x' })).toThrow(/task_id/);
    expect(() => s.recordEvent({ task_id: 't' })).toThrow(/type/);
  });
});
