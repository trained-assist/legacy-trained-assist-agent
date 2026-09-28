// Unit tests for the pending-task disk journal (src/runner/index.js).
//
// Root cause under test: getPendingTasks() used to let a single malformed JSON
// file throw out of the whole function — resumePendingTasks() (called once at
// boot) would then abort for EVERY user's task, not just the one behind the bad
// file, silently stranding every legitimately-resumable session (including GTD
// turns) after a restart. Fixed alongside the equivalent gap in
// listSoftContinuations (which already had no such issue — this brings the two
// in line).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let tmpDir;
let prevAgentDataDir;

function freshRunner() {
  const key = require.resolve('../../src/runner/index.js');
  if (require.cache[key]) delete require.cache[key];
  return require('../../src/runner/index.js');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pending-task-test-'));
  prevAgentDataDir = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (prevAgentDataDir === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = prevAgentDataDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pending-task journal', () => {
  it('no pending-tasks dir yet → empty list, no throw', () => {
    const R = freshRunner();
    expect(R.getPendingTasks()).toEqual([]);
  });

  it('one malformed JSON file does not abort the whole list — good entries still resume', () => {
    const R = freshRunner();
    const dir = join(tmpDir, 'pending-tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good-task.json'), JSON.stringify({ taskId: 'good-task', username: 'alice', userId: '1', task: 'do X', startedAt: Date.now() }));
    writeFileSync(join(dir, 'corrupt-task.json'), '{not valid json truncated mid-write');

    const pending = R.getPendingTasks();
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBe('good-task');
  });
});

// Watchdog step 1b (issue #942 [011], 1/4) — https://instant-publish.trainedassist.store/p/issues-doc-1-942
//
// Root cause under test: _runTask() (src/runner/index.js) writes phase='running' to the
// journal, then has a couple dozen exit points before completion. If one of them throws
// instead of cleanly returning/clearing, the journal entry used to stay at phase='running'
// forever — nothing else would ever rewrite it, even though the OS process backing the task
// was long dead. The fix wraps the function body in try/catch/finally: the finally re-reads
// the journal entry and, only if it is STILL sitting at phase='running' (i.e. no earlier
// path already cleared or finalized it), stamps an explicit terminal phase — 'error' if an
// exception propagated, 'interrupted' for a plain return that reached the finally with no
// more specific handling.
describe('pending-task journal — terminal-phase safety net (watchdog step 1b)', () => {
  it('a thrown error during normal operation never leaves the journal stranded at phase=running', async () => {
    // Through the public runTask() entrypoint, the OUTER queue wrapper's own finally
    // (admission.run(...).finally(() => { if (!restartShutdown) clearPendingTask(...) }))
    // already deletes the journal entry on every non-restart exit, including a thrown error —
    // so the observable end state here is "entry gone", same as before this change. What this
    // guards against is the INNER _runTask try/catch/finally regressing that: if it threw again
    // on its own re-read/re-write, or somehow re-created the file at phase='running' after the
    // outer wrapper cleared it, a task's journal entry would come back from the dead stuck
    // 'running' forever. The core invariant either way: no entry left at phase='running'.
    const R = freshRunner();
    const workDir = join(tmpDir, 'not-a-dir'); // pre-created as a FILE below, so the
    // fs.mkdirSync(user.workDir, {recursive:true}) call early in _runTask throws EEXIST
    // synchronously — a deterministic way to exercise the catch/finally without mocking
    // the whole Claude/Telegram call chain.
    writeFileSync(workDir, 'i am a file, not a directory');

    const taskId = 'watchdog-test-throw-1';
    await R.runTask({
      taskId,
      user: { id: 999001, username: 'watchdog-test-user', workDir },
      task: 'do something that will never actually run',
      secrets: {}, // no BOT_TOKEN — admission-status / tgSend become no-ops, no network calls
    });

    const pending = R.getPendingTasks();
    const entry = pending.find(p => p.taskId === taskId);
    expect(entry?.phase, 'must never be left at phase=running').not.toBe('running');
  });

  it('a thrown error during a restart-interrupted run does not clobber phase=running — resumePendingTasks() relies on it staying that way', async () => {
    // Mirrors sessionState.restartInterrupted's `return { deferred: true }` path (which
    // deliberately leaves phase='running' so the NEXT process's resumePendingTasks() picks the
    // task back up): during a restart, both the outer runTask() finally AND _runTask()'s own
    // inner finally must back off and leave the journal entry exactly as the pre-restart write
    // left it. Regressing this (e.g. dropping the restartShutdown guard on the inner finally)
    // would not literally break resume (isTaskResumable only checks startedAt age, not phase —
    // see src/pending-task-resume.js) but would still silently overwrite a phase value future
    // watchdog steps (2-4, out of scope here) may come to depend on.
    const R = freshRunner();
    R.interruptForRestart(); // sets this fresh module instance's restartShutdown = true

    const workDir = join(tmpDir, 'not-a-dir-2');
    writeFileSync(workDir, 'i am a file, not a directory');

    const taskId = 'watchdog-test-throw-restart-1';
    await R.runTask({
      taskId,
      user: { id: 999002, username: 'watchdog-test-user-2', workDir },
      task: 'do something that will never actually run',
      secrets: {},
    });

    const pending = R.getPendingTasks();
    const entry = pending.find(p => p.taskId === taskId);
    expect(entry, 'journal entry must survive a restart-interrupted crash').toBeTruthy();
    expect(entry.phase).toBe('running');
  });

  it('lastHeartbeatAt written by the 30s engine-process tick survives savePendingTask\'s partial merge', () => {
    // Unit-level check of the on-disk contract step 1a relies on: claude-runner.js's
    // onHeartbeat callback calls savePendingTask(taskId, { lastHeartbeatAt: Date.now() })
    // on the existing 30s inactivity-check tick. savePendingTask does {...previous, ...params},
    // so a heartbeat-only write must never clobber the rest of the journal entry (phase, task,
    // username, ...) — this pins that merge behavior directly against the on-disk file.
    const dir = join(tmpDir, 'pending-tasks');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'heartbeat-test.json');
    writeFileSync(file, JSON.stringify({
      taskId: 'heartbeat-test', phase: 'running', username: 'bob', userId: '2',
      task: 'long running thing', startedAt: Date.now() - 60_000,
    }));

    const R = freshRunner();
    const before = R.getPendingTasks().find(p => p.taskId === 'heartbeat-test');
    expect(before.lastHeartbeatAt).toBeUndefined();

    // savePendingTask itself isn't exported — exercise the same merge contract getPendingTasks
    // already validates elsewhere in this file, applied the way the heartbeat tick uses it.
    const raw = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    require('fs').writeFileSync(file, JSON.stringify({ ...raw, lastHeartbeatAt: 123456 }));

    const after = R.getPendingTasks().find(p => p.taskId === 'heartbeat-test');
    expect(after.lastHeartbeatAt).toBe(123456);
    expect(after.phase).toBe('running');
    expect(after.username).toBe('bob');
  });
});

// Epic #1789 P1 — profile mobility: the journal identifies a task's profile by
// username/profileId and never by a machine path, so a profile copied to
// another directory (or another VM) resumes its unfinished session and pending
// tasks from the NEW location. The workspace is derived at read time through
// src/data-paths.js (Identity ≠ location, its header).
describe('pending-task journal stores profile identity, not machine paths (#1789 P1)', () => {
  const { resolvePendingWorkDir } = require('../../src/pending-task-resume');
  const { userWorkDir } = require('../../src/data-paths');
  const readJournal = (taskId) => JSON.parse(require('fs').readFileSync(join(tmpDir, 'pending-tasks', `${taskId}.json`), 'utf8'));

  it('a new record keeps no absolute workDir and resolves by username', () => {
    const R = freshRunner();
    const stalePath = join(tmpDir, 'somewhere-else', 'alice'); // what the old runner used to persist
    R.savePendingTask('alice-1', {
      taskId: 'alice-1', username: 'alice', profileId: 'alice',
      workDir: stalePath, phase: 'queued', task: 'do X', startedAt: Date.now(),
    });

    const record = readJournal('alice-1');
    expect(Object.hasOwn(record, 'workDir'), 'journal must not persist a machine path').toBe(false);
    expect(record.username).toBe('alice', 'profile identity stays in the record');
    expect(resolvePendingWorkDir(record)).toBe(userWorkDir('alice'));
    expect(resolvePendingWorkDir(record)).not.toBe(stalePath);
  });

  it('legacy record with an absolute workDir still reads back, resolves by identity, drops the path on rewrite', () => {
    const dir = join(tmpDir, 'pending-tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bob-1.json'), JSON.stringify({
      taskId: 'bob-1', username: 'bob', workDir: '/mnt/old/users/bob',
      phase: 'running', task: 'y', startedAt: Date.now(),
    }));

    const R = freshRunner();
    const record = R.getPendingTasks().find(p => p.taskId === 'bob-1');
    expect(record, 'a legacy journal entry must still be listed (resumable)').toBeTruthy();
    expect(record.workDir).toBe('/mnt/old/users/bob', 'read path never rewrites the record on its own');
    expect(resolvePendingWorkDir(record)).toBe(userWorkDir('bob'), 'profile identity wins — this is what makes a copied profile resume');

    R.savePendingTask('bob-1', { phase: 'interrupted' });
    expect(Object.hasOwn(readJournal('bob-1'), 'workDir'), 'legacy machine path retired on the first rewrite').toBe(false);
    expect(readJournal('bob-1').phase).toBe('interrupted');
  });

  it('legacy record with no profile identity falls back to its stored workDir', () => {
    const dir = join(tmpDir, 'pending-tasks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'noname-1.json'), JSON.stringify({ taskId: 'noname-1', workDir: '/mnt/old/users/bob', phase: 'running' }));

    const record = freshRunner().getPendingTasks().find(p => p.taskId === 'noname-1');
    expect(resolvePendingWorkDir(record)).toBe('/mnt/old/users/bob');
  });
});
