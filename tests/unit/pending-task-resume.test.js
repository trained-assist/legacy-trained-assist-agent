// Unit tests for isTaskResumable (src/pending-task-resume.js).
//
// Root cause under test: server.js used to abandon any task not resumed within
// 20 min of a restart ("Задача была прервана перезапуском и не возобновилась.
// Повтори запрос."). Live prod logs on 2026-09-21 showed 34 restarts in one day
// from routine CI/CD deploys, several with gaps well over 20 min (up to 2h21m) —
// so ordinary deep tasks kept getting silently abandoned even though the journal
// had everything needed to resume them. The window was widened to 2h; these tests
// pin that behavior so it can't silently regress back to 20 min.

import { describe, it, expect } from 'vitest';
import { isTaskResumable } from '../../src/pending-task-resume.js';

const HOUR = 60 * 60 * 1000;
const START = 1_000_000_000_000; // arbitrary fixed epoch ms, never falsy
const baseTask = { startedAt: START, username: 'u', userId: 1, task: 'do the thing' };

describe('isTaskResumable', () => {
  it('resumes a task interrupted moments ago', () => {
    expect(isTaskResumable(baseTask, START + 5_000, 2 * HOUR)).toBe(true);
  });

  it('resumes a task interrupted 90 minutes ago (old 20-min window would have dropped this)', () => {
    expect(isTaskResumable(baseTask, START + 90 * 60 * 1000, 2 * HOUR)).toBe(true);
  });

  it('gives up on a task older than the resume window', () => {
    expect(isTaskResumable(baseTask, START + 3 * HOUR, 2 * HOUR)).toBe(false);
  });

  it('treats the window boundary as exclusive', () => {
    expect(isTaskResumable(baseTask, START + 2 * HOUR, 2 * HOUR)).toBe(false);
  });

  for (const field of ['startedAt', 'username', 'userId', 'task']) {
    it(`refuses to resume when ${field} is missing`, () => {
      const p = { ...baseTask, [field]: undefined };
      expect(isTaskResumable(p, START + 5_000, 2 * HOUR)).toBe(false);
    });
  }

  // forceClaude callbacks (inline-button taps: «🔎 Разобраться подробнее» / plan / menu) carry
  // no task text — runner re-derives it from the session. They must still resume after a restart,
  // otherwise every such tap that a deploy interrupts gets a bogus "не возобновилась" notice.
  it('resumes a forceClaude callback with no task text when it is bound to a session', () => {
    const p = { startedAt: START, username: 'u', userId: 1, task: '', forceClaude: true, sessionId: 's1' };
    expect(isTaskResumable(p, START + 5_000, 2 * HOUR)).toBe(true);
  });

  it('refuses a no-task forceClaude request with no session to re-derive it from', () => {
    const p = { startedAt: START, username: 'u', userId: 1, task: '', forceClaude: true, sessionId: null };
    expect(isTaskResumable(p, START + 5_000, 2 * HOUR)).toBe(false);
  });

  it('refuses an empty task that is not a forceClaude callback', () => {
    const p = { startedAt: START, username: 'u', userId: 1, task: '' };
    expect(isTaskResumable(p, START + 5_000, 2 * HOUR)).toBe(false);
  });

  it('refuses a null/undefined entry', () => {
    expect(isTaskResumable(null, START + 5_000, 2 * HOUR)).toBe(false);
  });
});

// #1671: resume is not Telegram-only — the journal says where the result goes.
import { resumeSinkOf } from '../../src/pending-task-resume.js';

describe('resume sinks (#1671)', () => {
  const now = START + 5_000;
  it('telegram: a legacy chat entry (userId) resumes', () => {
    expect(resumeSinkOf(baseTask)).toEqual({ kind: 'telegram', chatId: 1 });
    expect(isTaskResumable(baseTask, now, 2 * HOUR)).toBe(true);
  });
  it('web: a web task (user.id = 0) resumes — explicit sink or legacy taskId pattern', () => {
    const explicit = { startedAt: START, username: 'ann', userId: 0, task: 't', resumeSink: { kind: 'web', username: 'ann', requestId: 'r1' } };
    expect(resumeSinkOf(explicit)).toEqual({ kind: 'web', username: 'ann', requestId: 'r1' });
    expect(isTaskResumable(explicit, now, 2 * HOUR)).toBe(true);
    const legacy = { startedAt: START, username: 'ann', userId: 0, task: 't', taskId: 'ann-web-abc123' };
    expect(resumeSinkOf(legacy)).toEqual({ kind: 'web', username: 'ann', requestId: 'abc123' });
    expect(isTaskResumable(legacy, now, 2 * HOUR)).toBe(true);
  });
  it('durable: a playbook plan step (no chat) resumes', () => {
    const d = { startedAt: START, username: 'p', userId: null, task: 'step', internalGtd: true,
      resumeSink: { kind: 'durable', taskId: 't1', itemId: 'i1', executionId: 'e1', profileId: 'p' } };
    expect(resumeSinkOf(d).kind).toBe('durable');
    expect(isTaskResumable(d, now, 2 * HOUR)).toBe(true);
  });
  it('no sink → not resumable (nowhere to deliver the result)', () => {
    const none = { startedAt: START, username: 'p', userId: null, task: 'x' };
    expect(resumeSinkOf(none)).toBe(null);
    expect(isTaskResumable(none, now, 2 * HOUR)).toBe(false);
  });
});
