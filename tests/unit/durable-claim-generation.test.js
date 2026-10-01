// Attempt fencing (#87 B1.1, prod-plans T6): claim_generation on task_items.
//
// The pilot that replays prod's own plan code (trained-agent-architecture
// pilots/p-db/prod-plans, T6) showed the hole: attempt A claims a step, the
// 45-min orphan grace re-queues it while A is still alive, attempt B claims it,
// and then A's stale `DURABLE: done` is ACCEPTED — the step is closed with the
// dead attempt's execution id while B is still running. Every claim now opens a
// new generation and every settle write carries the generation it claimed: a
// mismatch is a refusal (null), never a silent overwrite.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DurableTaskStore } = require('../../src/durable-task-store');

function tmpStore() {
  return new DurableTaskStore(':memory:');
}

function seeded(s, { items = 1 } = {}) {
  s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  for (let i = 0; i < items; i++) s.createTaskItem({ id: `i${i}`, task_id: 't', title: `step ${i}` });
}

describe('task_items.claim_generation (attempt fencing)', () => {
  it('is part of the schema with default 0, and every claim bumps it', () => {
    const s = tmpStore();
    seeded(s);
    const first = s.claimNextRunnable();
    expect(first.id).toBe('i0');
    expect(first.claim_generation).toBe(1);
    // A re-claim after a re-queue opens the NEXT generation — that is the token
    // the stale attempt no longer matches.
    s.updateTaskItem('i0', { status: 'pending', due_at: Date.now() - 1 }, 'p');
    const second = s.claimNextRunnable();
    expect(second.id).toBe('i0');
    expect(second.claim_generation).toBe(2);
    expect(first.claim_generation).toBe(1);
  });

  it('completeItem: a stale generation is refused, the current one lands', () => {
    const s = tmpStore();
    seeded(s, { items: 2 });
    const a = s.claimNextRunnable();          // gen 1
    s.updateTaskItem(a.id, { status: 'pending' }, 'p');
    const b = s.claimNextRunnable();          // gen 2 (B owns the step now)

    expect(s.completeItem(a.id, 'p', { executionId: 'exec-A', claimGeneration: 1 })).toBeNull();
    let row = s.getTaskItem(a.id);
    expect(row.status).toBe('running');       // B's claim untouched
    expect(row.last_execution_id).toBeNull();

    expect(s.completeItem(b.id, 'p', { executionId: 'exec-B', claimGeneration: 2 })).not.toBeNull();
    row = s.getTaskItem(b.id);
    expect(row.status).toBe('done');
    expect(row.last_execution_id).toBe('exec-B');
    // arming the next sibling happened only for the accepted write
    expect(s.getTaskItem('i1').status).toBe('pending');
  });

  it('failItem and parkItem refuse a superseded generation too', () => {
    const s = tmpStore();
    seeded(s);
    const a = s.claimNextRunnable();          // gen 1
    s.updateTaskItem(a.id, { status: 'pending' }, 'p');
    const b = s.claimNextRunnable();          // gen 2

    expect(s.failItem(a.id, 'p', { executionId: 'exec-A', error: 'stale boom', claimGeneration: 1 })).toBeNull();
    expect(s.getTaskItem(b.id).status).toBe('running');

    expect(s.parkItem(b.id, 'p', { wait: { then: 'rerun' }, dueAt: Date.now(), claimGeneration: 2 })).not.toBeNull();
    expect(s.getTaskItem(b.id).status).toBe('waiting');
    // the stale attempt can neither fail nor park what B now owns
    expect(s.failItem(b.id, 'p', { executionId: 'exec-A', error: 'late', claimGeneration: 1 })).toBeNull();
    expect(s.getTaskItem(b.id).status).toBe('waiting');
  });

  it('setItemEvidence / setItemWait are fenced the same way', () => {
    const s = tmpStore();
    seeded(s);
    const a = s.claimNextRunnable();          // gen 1
    s.updateTaskItem(a.id, { status: 'pending' }, 'p');
    const b = s.claimNextRunnable();          // gen 2

    expect(s.setItemEvidence(a.id, 'p', { evidence_json: '{"stale":1}', claimGeneration: 1 })).toBeNull();
    expect(s.getTaskItem(b.id).evidence_json).toBeNull();

    expect(s.setItemWait(a.id, 'p', { then: 'rerun' }, { claimGeneration: 1 })).toBeNull();
    expect(s.getTaskItem(b.id).wait_json).toBeNull();

    expect(s.setItemEvidence(b.id, 'p', { evidence_json: '{"ok":1}', claimGeneration: 2 })).not.toBeNull();
    expect(s.getTaskItem(b.id).evidence_json).toBe('{"ok":1}');
  });

  it('no claimGeneration passed = unfenced (legacy callers keep working)', () => {
    const s = tmpStore();
    seeded(s, { items: 2 });
    const a = s.claimNextRunnable();
    expect(s.completeItem(a.id, 'p', { executionId: 'e' })).not.toBeNull();
    expect(s.getTaskItem(a.id).status).toBe('done');
    const b = s.claimNextRunnable();          // the armed sibling
    expect(b && b.id).toBe('i1');
    expect(s.failItem(b.id, 'p', { error: 'x' })).not.toBeNull();
    expect(s.getTaskItem(b.id).status).toBe('failed');
  });

  it('additive migration: an old DB without the column gets it on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fence-mig-'));
    try {
      const file = join(dir, 'state.db');
      const s = new DurableTaskStore(file);
      seeded(s);
      // simulate a pre-upgrade database (the column did not exist yet)
      s.db.exec('ALTER TABLE task_items DROP COLUMN claim_generation');
      expect(() => s.db.prepare('SELECT claim_generation FROM task_items').get()).toThrow();
      s.close();

      const reopened = new DurableTaskStore(file); // the constructor runs the migrations
      expect(reopened.db.prepare('SELECT claim_generation FROM task_items').get().claim_generation).toBe(0);
      expect(reopened.getTaskItem('i0').title).toBe('step 0'); // existing rows survived
      expect(reopened.claimNextRunnable().claim_generation).toBe(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
