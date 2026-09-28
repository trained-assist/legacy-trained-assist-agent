// Unit tests for src/gtd-controller.js
// Covers: computeMaxIterations, readChecklist, checklistSummary,
//         scheduleFromChecklist, maybeSchedule, runDue progress-check.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function freshG() {
  const key = require.resolve('../../src/gtd-controller.js');
  if (require.cache[key]) delete require.cache[key];
  return require('../../src/gtd-controller.js');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mkTmp() { return mkdtempSync(join(tmpdir(), 'gtd-test-')); }

function makeChecklist(dir, content) {
  writeFileSync(join(dir, 'checklist.md'), content);
}

function makeUserDir(baseDir, username) {
  const d = join(baseDir, username);
  mkdirSync(d, { recursive: true });
  return d;
}

// ── computeMaxIterations ──────────────────────────────────────────────────────

describe('computeMaxIterations', () => {
  it('returns DEFAULT_MAX_ITERATIONS for null checklist', () => {
    const G = freshG();
    expect(G.computeMaxIterations(null)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS for empty items list', () => {
    const G = freshG();
    expect(G.computeMaxIterations({ goal: null, items: [] })).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS when all items are done', () => {
    const G = freshG();
    const checklist = { goal: null, items: [{ text: 'a', done: true }, { text: 'b', done: true }] };
    expect(G.computeMaxIterations(checklist)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('returns DEFAULT_MAX_ITERATIONS floor when unchecked items give a lower value', () => {
    // 1 unchecked → unchecked+2 = 3, which equals DEFAULT_MAX_ITERATIONS (3) — floor holds
    const G = freshG();
    const checklist = { goal: null, items: [{ text: 'a', done: false }, { text: 'b', done: true }] };
    expect(G.computeMaxIterations(checklist)).toBe(G.DEFAULT_MAX_ITERATIONS);
  });

  it('scales with unchecked items (3 unchecked → 5)', () => {
    const G = freshG();
    const items = Array.from({ length: 3 }, (_, i) => ({ text: String(i), done: false }));
    // 3 unchecked → min(25, 3+2) = 5; max(3, 5) = 5
    expect(G.computeMaxIterations({ goal: null, items })).toBe(5);
  });

  it('caps at CHECKLIST_MAX_ITERATIONS for huge checklists', () => {
    const G = freshG();
    const items = Array.from({ length: 100 }, (_, i) => ({ text: String(i), done: false }));
    expect(G.computeMaxIterations({ goal: null, items })).toBe(G.CHECKLIST_MAX_ITERATIONS);
  });
});

// ── readChecklist ─────────────────────────────────────────────────────────────

describe('readChecklist', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null for missing file', () => {
    const G = freshG();
    expect(G.readChecklist(join(dir, 'nonexistent'))).toBeNull();
  });

  it('returns null when projectDir is null/undefined', () => {
    const G = freshG();
    expect(G.readChecklist(null)).toBeNull();
    expect(G.readChecklist(undefined)).toBeNull();
  });

  it('returns null when checklist.md does not exist in the dir', () => {
    const G = freshG();
    expect(G.readChecklist(dir)).toBeNull();
  });

  it('parses Goal: line', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: ship the feature\n- [ ] write tests\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('ship the feature');
  });

  it('parses Goal: in mixed-case', () => {
    const G = freshG();
    makeChecklist(dir, 'GOAL: uppercase goal\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('uppercase goal');
  });

  it('parses unchecked [ ] items', () => {
    const G = freshG();
    makeChecklist(dir, '- [ ] do something\n- [ ] do another\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(2);
    expect(cl.items.every(i => !i.done)).toBe(true);
    expect(cl.items[0].text).toBe('do something');
  });

  it('parses checked [x] items', () => {
    const G = freshG();
    makeChecklist(dir, '- [x] already done\n- [X] also done\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(2);
    expect(cl.items.every(i => i.done)).toBe(true);
  });

  it('parses mixed done/undone items', () => {
    const G = freshG();
    makeChecklist(dir, '- [x] done\n- [ ] pending\n');
    const cl = G.readChecklist(dir);
    expect(cl.items[0].done).toBe(true);
    expect(cl.items[1].done).toBe(false);
  });

  it('returns empty items array when no checkbox lines', () => {
    const G = freshG();
    makeChecklist(dir, 'just some text\nno checkboxes here\n');
    const cl = G.readChecklist(dir);
    expect(cl.items).toHaveLength(0);
    expect(cl.goal).toBeNull();
  });
});

// ── checklistSummary ──────────────────────────────────────────────────────────

describe('checklistSummary', () => {
  it('returns null for null checklist', () => {
    const G = freshG();
    expect(G.checklistSummary(null)).toBeNull();
  });

  it('returns null for empty items', () => {
    const G = freshG();
    expect(G.checklistSummary({ goal: null, items: [] })).toBeNull();
  });

  it('lists unchecked items only', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [
        { text: 'done task', done: true },
        { text: 'pending task', done: false },
        { text: 'another pending', done: false },
      ],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('pending task');
    expect(s).toContain('another pending');
    expect(s).not.toContain('done task');
  });

  it('shows all-done message when all items are checked', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [{ text: 'done', done: true }],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('все пункты');
  });

  it('includes goal when present', () => {
    const G = freshG();
    const cl = {
      goal: 'deploy to prod',
      items: [{ text: 'run tests', done: false }],
    };
    const s = G.checklistSummary(cl);
    expect(s).toContain('deploy to prod');
  });

  it('omits goal line when goal is null', () => {
    const G = freshG();
    const cl = {
      goal: null,
      items: [{ text: 'run tests', done: false }],
    };
    const s = G.checklistSummary(cl);
    expect(s).not.toContain('Цель:');
  });
});

// ── scheduleFromChecklist ─────────────────────────────────────────────────────

describe('scheduleFromChecklist', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    makeChecklist(projDir, 'Goal: do the thing\n- [x] done step\n- [ ] pending step\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null when workDir is missing', async () => {
    const G = freshG();
    const r = await G.scheduleFromChecklist({ workDir: null, sessionId: 's-1', projectDir: projDir });
    expect(r).toBeNull();
  });

  it('returns null when sessionId is missing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: null, projectDir: projDir });
    expect(r).toBeNull();
  });

  it('returns null when projectDir is missing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: null });
    expect(r).toBeNull();
  });

  it('returns null when checklist has no unchecked items', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const allDone = mkTmp();
    makeChecklist(allDone, '- [x] done\n');
    try {
      const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: allDone });
      expect(r).toBeNull();
    } finally {
      try { rmSync(allDone, { recursive: true, force: true }); } catch {}
    }
  });

  it('returns null when no checklist.md exists', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const emptyDir = mkTmp();
    try {
      const r = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', projectDir: emptyDir });
      expect(r).toBeNull();
    } finally {
      try { rmSync(emptyDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('creates record with consecutiveNoProgress=0', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    expect(rec).not.toBeNull();
    expect(rec.consecutiveNoProgress).toBe(0);
  });

  it('creates open record with correct fields', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', chatId: '42', username: 'u1', projectDir: projDir });
    expect(rec.status).toBe('open');
    expect(rec.iterations).toBe(0);
    expect(rec.projectDir).toBe(projDir);
    expect(rec.chatId).toBe('42');
  });

  it('skips a second tracker when the session has an active durable plan (#1719)', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u-plan');
    const store = G.durableStore();
    const task = store.createTask({ id: `t-${Date.now()}`, profile_id: 'u-plan', goal: 'plan-driven' });
    store.attachSession(task.id, 's-plan', 'u-plan');
    expect(await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-plan', username: 'u-plan', projectDir: projDir })).toBeNull();

    // A draft (not yet active) plan does not suppress the checklist tracker.
    store.updateTask(task.id, 'u-plan', { status: 'draft' });
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-plan', username: 'u-plan', projectDir: projDir });
    expect(rec && rec.status).toBe('open');
  });

  it('dedup by sessionId: returns existing open record without resetting it', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const first = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    const second = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: projDir });
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('dedup by projectDir: same projectDir tracked by different session → returns existing', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const first = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-AAA', username: 'u1', projectDir: projDir });
    const second = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-BBB', username: 'u1', projectDir: projDir });
    // Should return the existing record for s-AAA, not create a new one
    expect(second.sessionId).toBe('s-AAA');
    expect(second.createdAt).toBe(first.createdAt);
    // Only one GTD record should exist
    const all = G.listGtd(wd);
    expect(all.filter(r => r.status === 'open')).toHaveLength(1);
  });

  it('scales maxIterations from unchecked count', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const bigProj = mkTmp();
    // 5 unchecked items → max(3, min(25, 7)) = 7
    makeChecklist(bigProj, Array.from({ length: 5 }, (_, i) => `- [ ] step ${i}`).join('\n'));
    try {
      const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-1', username: 'u1', projectDir: bigProj });
      expect(rec.maxIterations).toBe(7);
    } finally {
      try { rmSync(bigProj, { recursive: true, force: true }); } catch {}
    }
  });

  it('takes originalTask from the active (newest) section, not the first Goal', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    makeChecklist(projDir, 'Goal: old goal\n- [x] old done\n\nGoal: current goal\n- [ ] do it\n');
    const rec = await G.scheduleFromChecklist({ workDir: wd, sessionId: 's-act', username: 'u1', projectDir: projDir });
    expect(rec).not.toBeNull();
    expect(rec.originalTask).toBe('current goal');
    // maxIterations from the active section only: 1 unchecked → max(3, 3) = 3
    expect(rec.maxIterations).toBe(G.DEFAULT_MAX_ITERATIONS);
  });
});

// ── maybeSchedule ─────────────────────────────────────────────────────────────

describe('maybeSchedule', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    makeChecklist(projDir, '- [ ] deploy to prod\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null when workDir is null', async () => {
    const G = freshG();
    const r = await G.maybeSchedule({ workDir: null, sessionId: 's-1', task: 'доведи до конца' });
    expect(r).toBeNull();
  });

  it('returns null when sessionId is null', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const r = await G.maybeSchedule({ workDir: wd, sessionId: null, task: 'доведи до конца' });
    expect(r).toBeNull();
  });

  it('creates record with consecutiveNoProgress=0 when intent is wanted', async () => {
    const G = freshG();
    const wd = makeUserDir(baseDir, 'u1');
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ wanted: true, etaMinutes: 30 }) } }] }),
    });
    try {
      const rec = await G.maybeSchedule({
        workDir: wd, sessionId: 's-1', chatId: '99', username: 'u1',
        task: 'доведи до конца и проконтролируй деплой',
        apiKey: 'fake-key', projectDir: projDir,
      });
      expect(rec).not.toBeNull();
      expect(rec.consecutiveNoProgress).toBe(0);
      expect(rec.status).toBe('open');
    } finally {
      global.fetch = realFetch;
    }
  });
});

// ── runDue: progress-check (consecutive-no-progress) ──────────────────────────

describe('runDue — progress-check', () => {
  let baseDir, projDir;

  beforeEach(() => {
    baseDir = mkTmp();
    projDir = mkTmp();
    // Checklist with one unchecked item (will stay unchecked through iterations)
    makeChecklist(projDir, 'Goal: ship it\n- [ ] write tests\n- [ ] deploy\n');
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  function makeRec(userDir, overrides = {}) {
    const G = freshG();
    const rec = {
      sessionId: 's-prog', chatId: '7', username: 'u1',
      createdAt: 1, dueAt: 100,
      etaMinutes: 20, iterations: 0, maxIterations: 10, status: 'open',
      originalTask: 'ship it', projectDir: projDir,
      lastFiredAt: null, closedReason: null,
      consecutiveNoProgress: 0,
      ...overrides,
    };
    G.writeGtd(userDir, rec);
    return rec;
  }

  it('increments consecutiveNoProgress when GTD: continue and checklist unchanged', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir);

    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => { callCount++; return 'GTD: continue'; },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.consecutiveNoProgress).toBe(1);
    expect(after.status).toBe('open');
  });

  it('closes with no-progress after 2 consecutive stalled iterations', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    // Start with consecutiveNoProgress=1 already (first stall happened previously)
    makeRec(userDir, { consecutiveNoProgress: 1 });

    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => { callCount++; return 'GTD: continue'; },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('no-progress');
  });

  it('resets consecutiveNoProgress when checklist progresses', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir, { consecutiveNoProgress: 1 });

    // Simulate task checking off one item during its run
    let callCount = 0;
    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => {
        callCount++;
        // Check off first item to simulate progress
        makeChecklist(projDir, 'Goal: ship it\n- [x] write tests\n- [ ] deploy\n');
        return 'GTD: continue';
      },
    });

    expect(callCount).toBe(1);
    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('open');
    expect(after.consecutiveNoProgress).toBe(0);
  });

  it('does not apply progress-check when there is no projectDir', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    // Record without a projectDir
    const rec = {
      sessionId: 's-noproj', chatId: '7', username: 'u1',
      createdAt: 1, dueAt: 100, etaMinutes: 20, iterations: 0, maxIterations: 10,
      status: 'open', originalTask: 'do it', projectDir: null,
      lastFiredAt: null, closedReason: null, consecutiveNoProgress: 1,
    };
    G.writeGtd(userDir, rec);

    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => 'GTD: continue',
    });

    const after = G.readGtd(userDir, 's-noproj');
    // Without projectDir, no progress-check → stays open, consecutiveNoProgress unchanged
    expect(after.status).toBe('open');
  });

  it('closes with done when runTask returns GTD: done (not affected by progress-check)', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir, { consecutiveNoProgress: 1 });

    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => 'all done! GTD: done',
    });

    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('done');
  });

  it('closes with awaiting-human (not escalated) when the run reports blocked-on-human', async () => {
    const G = freshG();
    const userDir = makeUserDir(baseDir, 'u1');
    makeRec(userDir, { consecutiveNoProgress: 1 });

    await G.runDue({
      secrets: {}, baseUsersDir: baseDir, now: 200,
      isTaskRunning: () => false,
      getSession: () => ({ ownerChatId: '7', summary: {} }),
      runTask: async () => 'осталось только живое подтверждение\nGTD: blocked-on-human',
    });

    const after = G.readGtd(userDir, 's-prog');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('awaiting-human');
  });
});

// ── settleResumedGtd (GTD turn resumed after a restart) ───────────────────────

describe('settleResumedGtd', () => {
  let base, workDir, G;
  const rec = (over = {}) => ({
    sessionId: 's-1', chatId: 42, status: 'open', iterations: 1, maxIterations: 5,
    etaMinutes: 20, dueAt: 0, originalTask: 't', ...over,
  });
  beforeEach(() => { base = mkTmp(); workDir = makeUserDir(base, 'alice'); G = freshG(); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('closes the record when the resumed turn says GTD: done', () => {
    G.writeGtd(workDir, rec());
    G.settleResumedGtd(workDir, 's-1', 'Всё доехало.\n\nGTD: done');
    const after = G.readGtd(workDir, 's-1');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('done');
    expect(G.listGtd(workDir).filter(r => r.status === 'open')).toHaveLength(0);
  });

  it('closes on GTD: escalated', () => {
    G.writeGtd(workDir, rec());
    G.settleResumedGtd(workDir, 's-1', 'слишком сложно\nGTD: escalated');
    expect(G.readGtd(workDir, 's-1').closedReason).toBe('complexity-escalated');
  });

  it('closes with awaiting-human (not escalated) on GTD: blocked-on-human', () => {
    G.writeGtd(workDir, rec());
    G.settleResumedGtd(workDir, 's-1', 'дальше только живая проверка в чате\nGTD: blocked-on-human');
    const after = G.readGtd(workDir, 's-1');
    expect(after.status).toBe('closed');
    expect(after.closedReason).toBe('awaiting-human');
  });

  it('keeps the record open and pushes dueAt out when not done', () => {
    G.writeGtd(workDir, rec());
    G.settleResumedGtd(workDir, 's-1', 'ещё жду CI\nGTD: continue', { now: 1_000_000 });
    const after = G.readGtd(workDir, 's-1');
    expect(after.status).toBe('open');
    expect(after.dueAt).toBe(1_000_000 + 20 * 60 * 1000);
  });

  it('is a no-op for a missing or already-closed record', () => {
    expect(G.settleResumedGtd(workDir, 's-none', 'GTD: done')).toBeNull();
    G.writeGtd(workDir, rec({ status: 'closed', closedReason: 'no-progress' }));
    G.settleResumedGtd(workDir, 's-1', 'GTD: done');
    expect(G.readGtd(workDir, 's-1').closedReason).toBe('no-progress');
  });
});

// ── mirrorGtdChecklist ──────────────────────────────────────────────────────
// checklist.md stays authoritative for the tick loop; this only best-effort
// pushes a copy to checklist.trainedassist.store so the human sees GTD
// auto-tracking checklists in the same UI as their manual ones.

describe('mirrorGtdChecklist', () => {
  const realFetch = global.fetch;
  const realKey = process.env.CHECKLIST_API_KEY;

  afterEach(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.CHECKLIST_API_KEY;
    else process.env.CHECKLIST_API_KEY = realKey;
  });

  it('does nothing when CHECKLIST_API_KEY is not configured', async () => {
    const G = freshG();
    delete process.env.CHECKLIST_API_KEY;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    await G.mirrorGtdChecklist({ username: 'u1', sessionId: 's-1', checklist: { goal: null, items: [{ text: 'a', done: false }] }, rec: {} });
    expect(called).toBe(false);
  });

  it('does nothing when checklist has no items', async () => {
    const G = freshG();
    process.env.CHECKLIST_API_KEY = 'k';
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    await G.mirrorGtdChecklist({ username: 'u1', sessionId: 's-1', checklist: { goal: null, items: [] }, rec: {} });
    expect(called).toBe(false);
  });

  it('upserts by external_key then syncs items, using username+sessionId as the key', async () => {
    const G = freshG();
    process.env.CHECKLIST_API_KEY = 'k';
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
      if (url.endsWith('/api/checklists')) return { ok: true, json: async () => ({ id: 'cl-1' }) };
      return { ok: true, json: async () => ({}) };
    };
    await G.mirrorGtdChecklist({
      username: 'u1', sessionId: 's-1',
      checklist: { goal: 'Ship it', items: [{ text: 'CI green', done: true }, { text: 'Deploy', done: false }] },
      rec: { originalTask: 'unused when goal is set' },
    });
    expect(calls.length).toBe(2);
    expect(calls[0].url).toMatch(/\/api\/checklists$/);
    expect(calls[0].body).toEqual({ name: 'Ship it', external_key: 'gtd:u1:s-1', source: 'agent' });
    expect(calls[0].auth).toBe('Bearer k');
    expect(calls[1].url).toBe(`${G.CHECKLIST_API_BASE}/api/checklists/cl-1/sync-items`);
    expect(calls[1].body).toEqual({ items: [{ text: 'CI green', done: true }, { text: 'Deploy', done: false }] });
  });

  it('swallows fetch errors without throwing', async () => {
    const G = freshG();
    process.env.CHECKLIST_API_KEY = 'k';
    global.fetch = async () => { throw new Error('network down'); };
    await expect(G.mirrorGtdChecklist({
      username: 'u1', sessionId: 's-1', checklist: { goal: 'g', items: [{ text: 'a', done: false }] }, rec: {},
    })).resolves.toBeUndefined();
  });

  it('stops after a non-ok create response (no sync-items call)', async () => {
    const G = freshG();
    process.env.CHECKLIST_API_KEY = 'k';
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: false, json: async () => ({}) }; };
    await G.mirrorGtdChecklist({
      username: 'u1', sessionId: 's-1', checklist: { goal: 'g', items: [{ text: 'a', done: false }] }, rec: {},
    });
    expect(calls).toBe(1);
  });
});

// ── readChecklist: multi-Goal journal (active section only) ───────────────────
// Regression for the PR #1422 incident: a checklist.md accumulates one Goal
// section per task (append-only). readChecklist used to glue ALL sections'
// items and take the FIRST Goal, so GTD tracked a long-done goal and fed the
// whole project backlog into the reopen prompt → the agent refused three times
// and GTD closed complexity-escalated.

describe('readChecklist — multi-Goal active section', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const MULTI = [
    'Goal: old finished goal',      // 0
    '- [x] old done 1',             // 1
    '- [x] old done 2',             // 2
    '',                             // 3
    '## drift note',                // 4
    '- [x] drift done',             // 5
    '',                             // 6
    'Goal: current goal',           // 7
    '- [ ] current open 1',         // 8
    '- [ ] current open 2',         // 9
    '',                             // 10
    'Goal: newest finished goal',   // 11
    '- [x] newest done',            // 12
  ].join('\n');

  it('returns only the last section with items — not the first Goal, not glued', () => {
    const G = freshG();
    makeChecklist(dir, MULTI);
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('newest finished goal');
    expect(cl.items.map(i => i.text)).toEqual(['newest done']);
  });

  it('never mixes items from older sections into the active one', () => {
    const G = freshG();
    makeChecklist(dir, MULTI);
    const cl = G.readChecklist(dir);
    expect(cl.items.some(i => /old done|current open|drift/.test(i.text))).toBe(false);
  });

  it('records each item file line for exact write-back', () => {
    const G = freshG();
    makeChecklist(dir, MULTI);
    const cl = G.readChecklist(dir);
    expect(cl.items[0].line).toBe(12);
  });

  it('stays backward-compatible for a single-section checklist', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: only goal\n- [x] done\n- [ ] pending\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('only goal');
    expect(cl.items.map(i => i.text)).toEqual(['done', 'pending']);
  });

  it('treats a flat checklist without any Goal as a single section', () => {
    const G = freshG();
    makeChecklist(dir, '- [ ] a\n- [x] b\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBeNull();
    expect(cl.items.map(i => i.text)).toEqual(['a', 'b']);
  });

  it('falls back to the last declared goal when no checkbox exists', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: first\n\nGoal: second\n');
    const cl = G.readChecklist(dir);
    expect(cl.goal).toBe('second');
    expect(cl.items).toEqual([]);
  });
});

// ── writeChecklistDone: section isolation ─────────────────────────────────────
// Line-addressed write-back is what makes the scoping safe: flipping by
// sequential index would map the active section onto the first N checkboxes in
// the file, i.e. clobber an older section.

describe('writeChecklistDone — section isolation', () => {
  let dir;
  beforeEach(() => { dir = mkTmp(); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('flips only the active section lines, leaving older sections untouched', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: old\n- [ ] old open\n\nGoal: new\n- [ ] new open\n');
    const cl = G.readChecklist(dir); // active = 'new'
    expect(cl.goal).toBe('new');
    G.writeChecklistDone(dir, cl.items.map(i => ({ ...i, done: true })));
    const raw = readFileSync(join(dir, 'checklist.md'), 'utf8');
    expect(raw).toContain('- [ ] old open'); // older section not clobbered
    expect(raw).toContain('- [x] new open');
  });

  it('preserves non-checkbox text (headings, Goal lines, notes)', () => {
    const G = freshG();
    makeChecklist(dir, 'Goal: keep me\nnote line\n- [ ] item\n');
    const cl = G.readChecklist(dir);
    G.writeChecklistDone(dir, cl.items.map(i => ({ ...i, done: true })));
    const raw = readFileSync(join(dir, 'checklist.md'), 'utf8');
    expect(raw).toContain('Goal: keep me');
    expect(raw).toContain('note line');
    expect(raw).toContain('- [x] item');
  });

  it('falls back to sequential order for items without a recorded line', () => {
    const G = freshG();
    makeChecklist(dir, '- [ ] one\n- [ ] two\n');
    G.writeChecklistDone(dir, [{ text: 'one', done: true }, { text: 'two', done: false }]);
    const raw = readFileSync(join(dir, 'checklist.md'), 'utf8');
    expect(raw).toContain('- [x] one');
    expect(raw).toContain('- [ ] two');
  });
});

// ── buildReopenMessage: human-blocked terminal ────────────────────────────────

describe('buildReopenMessage — blocked-on-human signal', () => {
  it('tells the agent to signal blocked-on-human instead of escalating', () => {
    const G = freshG();
    const msg = G.buildReopenMessage({ iterations: 1, maxIterations: 4, originalTask: 'x', projectDir: null });
    expect(msg).toContain('GTD: blocked-on-human');
  });
});
