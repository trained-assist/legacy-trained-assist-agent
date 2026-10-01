// Structured step result (#87 B1.3, ARCHITECTURE §4.4).
//
// 94% of OpenCode step failures (#1907 audit) were «no terminal DURABLE marker»:
// the agent DID the work but never printed the final line, so the attempt was
// burned, retried and often escalated to doctor. The step now reports its verdict
// STRUCTURED through `task_item_result` (task_items.result_json) and the settle
// reads that instead of parsing the text — the marker itself stays untouched for
// the engines that do not call the tool.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DurableTaskStore } = require('../../src/durable-task-store');

function seeded(s) {
  s.createTask({ id: 't', profile_id: 'p', goal: 'g' });
  s.createTaskItem({ id: 'i0', task_id: 't', title: 'step' });
  return s;
}
const store = () => seeded(new DurableTaskStore(':memory:'));

describe('task_items.result_json — structured step result', () => {
  it('is part of the schema', () => {
    const s = store();
    const cols = s.db.prepare('PRAGMA table_info(task_items)').all().map(c => c.name);
    expect(cols).toContain('result_json');
  });

  it('the running step posts a result and it reads back', () => {
    const s = store();
    s.claimNextRunnable();
    const out = s.setStructuredResult('i0', 'p', {
      status: 'done', result: { pr_url: 'https://github.com/o/r/pull/7' }, note: 'PR открыт', attempt: 1,
    });
    expect(out.error).toBeUndefined();
    expect(out.result.status).toBe('done');
    expect(out.result.attempt).toBe(1);
    const read = s.getStructuredResult('i0');
    expect(read.result.pr_url).toBe('https://github.com/o/r/pull/7');
    expect(read.note).toBe('PR открыт');
  });

  it('only the running step can post, and only with a valid status', () => {
    const s = store();
    expect(s.setStructuredResult('i0', 'p', { status: 'done' }).error).toMatch(/running now \(status=pending\)/);
    expect(s.setStructuredResult('i0', 'p', { status: 'ok' }).error).toMatch(/invalid status/);
    expect(s.setStructuredResult('i0', 'intruder', { status: 'done' }).error).toMatch(/not found/);

    s.claimNextRunnable();
    expect(s.setStructuredResult('i0', 'p', { status: 'meh' }).error).toMatch(/invalid status/);
    expect(s.setStructuredResult('i0', 'p', { status: 'done' }).ok).toBe(true);
  });

  it('a stale attempt cannot post over the current one', () => {
    const s = store();
    s.claimNextRunnable();                       // attempt 1
    s.updateTaskItem('i0', { status: 'pending' }, 'p');
    s.claimNextRunnable();                       // attempt 2 (gen 2)
    const stale = s.setStructuredResult('i0', 'p', { status: 'done', attempt: 1 });
    expect(stale.error).toMatch(/stale attempt: .*attempt 1, the step is on attempt 2/);
    expect(s.getStructuredResult('i0')).toBeNull();
    expect(s.setStructuredResult('i0', 'p', { status: 'done', attempt: 2 }).ok).toBe(true);
  });

  it('every claim starts with a clean result — an earlier attempt never leaks', () => {
    const s = store();
    s.claimNextRunnable();
    s.setStructuredResult('i0', 'p', { status: 'failed', note: 'старая попытка' });
    expect(s.getStructuredResult('i0').status).toBe('failed');
    s.updateTaskItem('i0', { status: 'pending' }, 'p');
    s.claimNextRunnable();
    expect(s.getStructuredResult('i0')).toBeNull();
  });

  it('a malformed row is read as no result (never a fake verdict)', () => {
    const s = store();
    s.claimNextRunnable();
    s.db.prepare('UPDATE task_items SET result_json = ? WHERE id = ?').run('{oops', 'i0');
    expect(s.getStructuredResult('i0')).toBeNull();
    s.db.prepare('UPDATE task_items SET result_json = ? WHERE id = ?').run('{"status":"maybe"}', 'i0');
    expect(s.getStructuredResult('i0')).toBeNull();
  });
});
