// ACD (§5 SESSION-CRASH-RETRY-SPEC.md): "убей сессию посреди работы, и несколько параллельно" —
// several pending tasks cut off by a restart must each resume independently with the correct
// backoff delay, and a restart that lands while an earlier resume is still waiting out its
// backoff must never fire that resume a second time (journal must not fork/duplicate).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const serverSrc = read('src/server.js');
const { isTaskResumable, resumeSinkOf } = require('../src/pending-task-resume');

const task = (over = {}) => ({ taskId: `t-${over.username || 'alice'}-1`, username: 'alice', userId: 42, task: 'work',
  initialMsgId: 7, startedAt: Date.now() - 30_000, sessionId: 's1', ...over });

// A harness whose setTimeout is DEFERRED (queued, not run) so tests can control exactly when a
// backoff delay "elapses" relative to a second simulated restart — the real bug this guards
// against only shows up when the delayed resume hasn't fired yet and another restart happens.
function deferredHarness({ pending, now = Date.now(), retryDelayMs = () => 50, startError = null }) {
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  const end = serverSrc.indexOf('async function main()', start);
  const calls = [], runs = [], cleared = [], timers = [];
  const journal = pending.slice(); // mutable — mirrors the on-disk pending-tasks file
  const sandbox = {
    taskDelivery: require('../src/bot-delivery').taskDelivery,
    path, console: { log() {}, error() {}, warn() {} }, Date: class extends Date { static now() { return now; } },
    BASE_USERS_DIR: '/users', AbortSignal, Promise,
    // server.js staggers loop iterations with a fixed 200ms `await new Promise(setTimeout(...))`
    // between resumes — that one must fire immediately so the loop doesn't hang the test; only
    // the backoff delay for an actual resume (a different value) is deferred/controllable.
    setTimeout: (fn, ms) => { if (ms === 200) { fn(); return 0; } const t = { fn, ms }; timers.push(t); return t; },
    process: { env: {} }, isTaskResumable, resumeSinkOf, MAX_RESUME_ATTEMPTS: 3,
    getRetryDelayMs: attempt => retryDelayMs(attempt),
    // A fresh snapshot per call, like the real fs-backed getPendingTasks() (server.js reads the
    // journal once per resumePendingTasks() run) — clearPendingTask() must not mutate the array
    // the current for-loop is iterating over, only what the *next* resumePendingTasks() call sees.
    getPendingTasks: () => journal.slice(),
    clearPendingTask: id => { cleared.push(id); const i = journal.findIndex(p => p.taskId === id); if (i >= 0) journal.splice(i, 1); },
    // Native-resume lookup (#1234): none on disk here → the pre-#1234 fallback path these
    // tests assert on. (Native resume itself is covered in instant-restart.test.cjs.)
    getEngineSessionId: () => null,
    isNonTaskMessage: require('../src/resume-hygiene').isNonTaskMessage,
    recordResume: () => {},
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return {}; },
    runTask: opts => { if (startError) throw startError; runs.push(opts); return Promise.resolve(); },
  };
  // resumePendingTasks() calls require('./gateway-callback') to release the chat
  // for tasks that end without a run; the slice runs in a VM with no require.
  sandbox.require = () => ({ notifyRunFinished: async () => true });
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, end)}; this.resume = resumePendingTasks;`, sandbox);
  return {
    resume: () => sandbox.resume({ BOT_TOKEN: 'tok' }),
    flushTimers: () => { const due = timers.splice(0); due.forEach(t => t.fn()); },
    calls, runs, cleared, journal,
  };
}

test('several sessions killed mid-run by the same restart each resume independently, own session/engine intact', async () => {
  const seenDelays = [];
  const h = deferredHarness({
    pending: [
      task({ taskId: 'a-1', username: 'alice', sessionId: 'sess-a', engine: 'claude', resumeAttempts: 1 }),
      task({ taskId: 'b-1', username: 'bob', sessionId: 'sess-b', engine: 'opencode', resumeAttempts: 2 }),
      task({ taskId: 'c-1', username: 'carol', sessionId: 'sess-c', engine: 'codex', resumeAttempts: 3 }),
    ],
    retryDelayMs: attempt => { seenDelays.push(attempt); return attempt * 1000; },
  });
  await h.resume();
  h.flushTimers();

  assert.equal(h.runs.length, 3, 'all three killed sessions get resumed');
  const byUser = Object.fromEntries(h.runs.map(r => [r.user.username, r]));
  assert.equal(byUser.alice.sessionId, 'sess-a');
  assert.equal(byUser.alice.engine, 'claude');
  assert.equal(byUser.bob.sessionId, 'sess-b');
  assert.equal(byUser.bob.engine, 'opencode');
  assert.equal(byUser.carol.sessionId, 'sess-c');
  assert.equal(byUser.carol.engine, 'codex');
  // Each session keeps its own attempt count — one session's crash history never bleeds into another's.
  assert.deepEqual(seenDelays, [1, 2, 3], 'per-task attempt = its own journaled resumeAttempts, in journal order');
  assert.equal(h.cleared.length, 3, 'each old journal entry is dropped exactly once');
  assert.deepEqual(new Set(h.cleared), new Set(['a-1', 'b-1', 'c-1']));
});

test('restart during backoff loses timers but retains the task for exactly one resumed run', async () => {
  let pending = [task({ taskId: 'a-1', resumeAttempts: 1, mode: 'deep', continuationCount: 2,
    initiatedAt: 123, threadId: 'thread-1' })];
  for (let restart = 0; restart < 3; restart++) {
    const killed = deferredHarness({ pending, retryDelayMs: () => 180_000 });
    await killed.resume();
    assert.equal(killed.runs.length, 0);
    assert.deepEqual(killed.cleared, [], 'cannot delete a task owned only by a volatile timer');
    pending = killed.journal.slice();
    // Simulate actual process death: discard this harness AND all its timers.
  }
  const alive = deferredHarness({ pending, retryDelayMs: () => 180_000 });
  await alive.resume();
  alive.flushTimers();
  assert.equal(alive.runs.length, 1);
  assert.deepEqual(alive.cleared, ['a-1']);
  assert.equal(alive.runs[0].resumeAttempts, 1, 'waiting/restarts never consume retry budget — the runner owns the counter');
  assert.equal(alive.runs[0].sessionId, 's1');
  assert.equal(alive.runs[0].mode, 'deep');
  assert.equal(alive.runs[0].continuationCount, 2);
  assert.equal(alive.runs[0].initiatedAt, 123);
  assert.equal(alive.runs[0].threadId, 'thread-1');
});

test('the backoff delay actually gates when a killed session comes back — nothing runs before flush', async () => {
  const h = deferredHarness({ pending: [task()], retryDelayMs: () => 30_000 });
  await h.resume();
  assert.equal(h.runs.length, 0, 'a killed session must not be resumed synchronously — the delay must be honored');
  h.flushTimers();
  assert.equal(h.runs.length, 1);
});

 test('a synchronous handoff failure retains the old journal and reports failure', async () => {
  const h = deferredHarness({ pending: [task()], startError: new Error('disk write failed') });
  await h.resume();
  h.flushTimers();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.runs.length, 0);
  assert.equal(h.journal.length, 1);
  assert.deepEqual(h.cleared, []);
  assert.equal(h.calls.length, 1);
});
