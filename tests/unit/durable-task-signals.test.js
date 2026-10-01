// Incoming signal table + dedup (#87 B1.2, prod-plans T4/T5).
//
// T4 (FAIL): task_item_wake before the step parked → «item is not waiting», the
// event was lost and the step stayed parked until the sender repeated it.
// T5 (PASS with оговорка): a second wake overwrites wake_message/woken_at — the
// last writer wins, there is no dedup by signal id.
//
// The fix: a signal row per (userTaskId, step) — that IS the identity. An
// unconsumed row is a signal nobody applied yet (duplicate → no overwrite); it is
// applied by parkItem as soon as the step reaches its wait.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DurableTaskStore, signalText } = require('../../src/durable-task-store');

function seeded(s, { items = 2 } = {}) {
  s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  for (let i = 0; i < items; i++) s.createTaskItem({ id: `i${i}`, task_id: 't', title: `step ${i}` });
  return s;
}
const store = () => seeded(new DurableTaskStore(':memory:'));
const waitingItem = (s, id) => {
  s.updateTaskItem(id, { status: 'waiting' }, 'p');
  s.setItemWait(id, 'p', { then: 'rerun', awaiting_user: true, reason: 'ответ' });
  return s.getTaskItem(id);
};

describe('task_signals — identity = userTaskId + step', () => {
  it('the table exists in the schema (fresh store)', () => {
    const s = store();
    const cols = s.db.prepare('PRAGMA table_info(task_signals)').all().map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(
      ['task_id', 'task_item_id', 'event_type', 'source', 'payload_json', 'created_at', 'consumed_at']));
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_signals_pending'").get()).toBeTruthy();
  });

  it('a second signal for the same step is a duplicate — the first payload wins', () => {
    const s = store();
    const first = s.postSignal({ task_id: 't', task_item_id: 'i0', payload: 'первый ответ' });
    expect(first.duplicate).toBe(false);
    const second = s.postSignal({ task_id: 't', task_item_id: 'i0', payload: 'второй ответ' });
    expect(second.duplicate).toBe(true);
    expect(signalText(second.signal)).toBe('первый ответ');
    expect(s.listSignals('t', 'p')).toHaveLength(1);
  });

  it('a different step of the same plan is a different signal', () => {
    const s = store();
    s.postSignal({ task_id: 't', task_item_id: 'i0', payload: 'a' });
    const other = s.postSignal({ task_id: 't', task_item_id: 'i1', payload: 'b' });
    expect(other.duplicate).toBe(false);
    expect(s.listSignals('t', 'p')).toHaveLength(2);
  });

  it('wake before the step waits (T4) is buffered, not refused', () => {
    const s = store();
    const out = s.wakeItem('i0', 'p', { message: 'вот ключ: dg_123' });
    expect(out.error).toBeUndefined();
    expect(out.buffered).toBe(true);
    const sig = s.getSignal('t', 'i0');
    expect(sig).toBeTruthy();
    expect(sig.consumed_at).toBeNull();
    expect(signalText(sig)).toBe('вот ключ: dg_123');
    // the step itself is untouched — it has not reached its wait yet
    expect(s.getTaskItem('i0').status).toBe('pending');
    expect(s.getTaskItem('i0').wait_json).toBeNull();

    // a duplicate while buffered does not overwrite the first payload
    const again = s.wakeItem('i0', 'p', { message: 'другой текст' });
    expect(again.duplicate).toBe(true);
    expect(signalText(s.getSignal('t', 'i0'))).toBe('вот ключ: dg_123');
  });

  it('parking applies the buffered signal (T4) and marks it consumed', () => {
    const s = store();
    s.wakeItem('i0', 'p', { message: 'да, делай вариант B' });
    const parked = s.parkItem('i0', 'p', {
      wait: { then: 'rerun', awaiting_user: true, reason: 'ответ', started_at: Date.now() - 5000, deadline_at: Date.now() + 3600_000 },
      dueAt: Date.now() + 3600_000,
    });
    expect(parked.status).toBe('waiting');
    const w = JSON.parse(parked.wait_json);
    expect(w.woken_at).toBeTruthy();              // the step starts its wait already woken
    expect(w.wake_message).toBe('да, делай вариант B');
    expect(w.woken_by).toBe('user');
    expect(parked.due_at).toBeLessThanOrEqual(Date.now() + 5); // resolved on the next tick, not at the deadline
    const sig = s.getSignal('t', 'i0');
    expect(sig.consumed_at).toBeTruthy();
  });

  it('a wake on a waiting step applies immediately; the second one does not overwrite (T5)', () => {
    const s = store();
    waitingItem(s, 'i0');
    const first = s.wakeItem('i0', 'p', { message: 'ответ первый' });
    expect(first.error).toBeUndefined();
    expect(JSON.parse(s.getTaskItem('i0').wait_json).wake_message).toBe('ответ первый');

    const second = s.wakeItem('i0', 'p', { message: 'ответ второй' });
    expect(second.error).toBeUndefined();
    expect(second.already_woken).toBe(true);       // first writer wins
    expect(JSON.parse(s.getTaskItem('i0').wait_json).wake_message).toBe('ответ первый');
    expect(s.listSignals('t', 'p')).toHaveLength(1);
  });

  it('a finished step is still refused and gets no signal row (T5)', () => {
    const s = store();
    s.updateTaskItem('i0', { status: 'done' }, 'p');
    const out = s.wakeItem('i0', 'p', { message: 'x' });
    expect(out.error).toMatch(/item is not waiting \(status=done\)/);
    expect(s.getSignal('t', 'i0')).toBeNull();

    s.updateTaskItem('i1', { status: 'failed' }, 'p');
    expect(s.wakeItem('i1', 'p', { message: 'x' }).error).toMatch(/status=failed/);
    expect(s.getSignal('t', 'i1')).toBeNull();
  });

  it('a consumed signal does not block a LATER wait cycle of the same step', () => {
    const s = store();
    waitingItem(s, 'i0');
    s.wakeItem('i0', 'p', { message: 'первый цикл' });
    // the step re-runs and waits again
    s.updateTaskItem('i0', { status: 'pending' }, 'p');
    s.updateTaskItem('i0', { status: 'waiting' }, 'p');
    s.setItemWait('i0', 'p', { then: 'rerun', awaiting_user: true, reason: 'ответ 2' });
    const next = s.wakeItem('i0', 'p', { message: 'второй цикл' });
    expect(next.duplicate).toBe(false);
    expect(JSON.parse(s.getTaskItem('i0').wait_json).wake_message).toBe('второй цикл');
  });

  it('cross-profile: a foreign profile can neither wake nor read the signals', () => {
    const s = store();
    waitingItem(s, 'i0');
    expect(s.wakeItem('i0', 'intruder', { message: 'x' }).error).toMatch(/not found/);
    expect(s.getSignal('t', 'i0')).toBeNull();     // the refused wake wrote nothing
    // a signal recorded for the owner's step (unconsumed → the next wake is a duplicate
    // and the FIRST payload is what the step will receive)
    s.postSignal({ task_id: 't', task_item_id: 'i0', payload: 'x' });
    const out = s.wakeItem('i0', 'p', { message: 'y' });
    expect(out.item.status).toBe('waiting');
    expect(out.duplicate).toBe(true);
    expect(JSON.parse(s.getTaskItem('i0').wait_json).wake_message).toBe('x');
    expect(s.listSignals('t', 'p')).toHaveLength(1);
    expect(s.listSignals('t', 'intruder')).toHaveLength(0);
  });

  it('an unfinished signal dies with the step, the consumed one stays as history', () => {
    const s = store();
    waitingItem(s, 'i0');
    s.wakeItem('i0', 'p', { message: 'применён' });            // consumed (history)
    s.postSignal({ task_id: 't', task_item_id: 'i1', payload: 'не применён' }); // still buffered
    s.completeItem('i0', 'p', {});
    s.completeItem('i1', 'p', {});
    expect(s.getSignal('t', 'i0')).toBeTruthy();               // history kept
    expect(s.getSignal('t', 'i1')).toBeNull();                 // undeliverable → removed
  });
});
