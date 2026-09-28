// Regression guard for the GTD scheduling hook (issue found 2026-09-25).
//
// The hook that schedules GTD tracking at the end of every completed run used to
// live inline inside _runTask, wrapped in a try/catch that swallowed the error.
// Commit #1347 (2026-09-25) wired the forum `threadId` through but referenced
// `runThreadId` — a const that only exists in runTask(), not _runTask(). Result:
// a ReferenceError on EVERY run, swallowed into a `[gtd] hook: runThreadId is not
// defined` warn → GTD scheduling silently died for every user, and no test failed.
//
// These tests call the extracted hook directly and assert a record is actually
// written, so any future wiring/scoping break fails CI instead of prod.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const runner = require('../src/runner');

let pass = 0, fail = 0;
async function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } }

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-hook-')); }
function withChecklist(projectDir) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'checklist.md'), 'Goal: ship it\n- [ ] CI green\n- [ ] merged\n');
}

(async () => {
  const hook = runner._gtd && runner._gtd.scheduleGtdAfterRun;
  await ok(typeof hook === 'function', 'runner._gtd.scheduleGtdAfterRun must be exported (hook must exist)');

  // 1. Non-deep reply with an unchecked checklist → a GTD record must appear.
  //    This is the exact path that was dead: the ReferenceError fired while
  //    building checklistArgs, before either branch ran.
  {
    const workDir = tmpRoot();
    const projectDir = path.join(workDir, 'proj');
    const runStartedAt = Date.now() - 1000; // the run wrote checklist.md (no owner line)
    withChecklist(projectDir);
    const p = hook({
      internalGtd: false, activeSessionId: 's-hook-1', explicitMode: 'reply',
      task: 'do the thing', secrets: {}, workDir, username: 'u',
      projectDir, audience: 'default', chatId: '123', threadId: null, runStartedAt,
    });
    await ok(p && typeof p.then === 'function', 'non-deep hook returns a promise (fire-and-forget)');
    await p;
    const rec = JSON.parse(fs.readFileSync(path.join(workDir, 'gtd', 's-hook-1.json'), 'utf8'));
    await ok(rec.status === 'open', 'non-deep: GTD record written with status=open');
    await ok(rec.sessionId === 's-hook-1', 'non-deep: record keyed to the session');
    await ok(rec.maxIterations >= 2, 'non-deep: maxIterations derived from the checklist');
    await ok(/Owner-session: s-hook-1/.test(fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8')),
      'BV-08: section written during the run is signed with the run session (claimFreshChecklist)');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // 2. Deep mode still schedules. task 'hi' is <8 chars and secrets lack an
  //    OPENROUTER key → detectIntent returns wanted:false without any network
  //    call, then scheduleFromChecklist is the fallback (checklist ⇒ intent).
  {
    const workDir = tmpRoot();
    const projectDir = path.join(workDir, 'proj');
    const runStartedAt = Date.now() - 1000;
    withChecklist(projectDir);
    const p = hook({
      internalGtd: false, activeSessionId: 's-hook-2', explicitMode: 'deep',
      task: 'hi', secrets: {}, workDir, username: 'u',
      projectDir, audience: 'default', chatId: '123', threadId: 42, runStartedAt,
    });
    await p;
    const rec = JSON.parse(fs.readFileSync(path.join(workDir, 'gtd', 's-hook-2.json'), 'utf8'));
    await ok(rec.status === 'open', 'deep: GTD record written with status=open');
    await ok(rec.threadId === 42, 'deep: forum threadId threaded into the record');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // 3. Internal GTD re-runs must never schedule (no self-loop).
  {
    const workDir = tmpRoot();
    const projectDir = path.join(workDir, 'proj');
    withChecklist(projectDir);
    const p = hook({
      internalGtd: true, activeSessionId: 's-hook-3', explicitMode: 'reply',
      task: 'do the thing', secrets: {}, workDir, username: 'u',
      projectDir, audience: 'default', chatId: '123', threadId: null,
    });
    await ok(p === null, 'internalGtd re-run: hook returns null (no self-loop)');
    await ok(!fs.existsSync(path.join(workDir, 'gtd', 's-hook-3.json')), 'internalGtd re-run: no record written');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // 3b. BV-08 (#1729): a legacy ownerless checklist that this run did NOT touch
  //     (mtime before run start) is not attached to the session and stays unsigned.
  {
    const workDir = tmpRoot();
    const projectDir = path.join(workDir, 'proj');
    withChecklist(projectDir);
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    fs.utimesSync(path.join(projectDir, 'checklist.md'), old, old);
    await hook({
      internalGtd: false, activeSessionId: 's-hook-legacy', explicitMode: 'reply',
      task: 'unrelated', secrets: {}, workDir, username: 'u',
      projectDir, audience: 'default', chatId: '123', threadId: null, runStartedAt: Date.now() - 1000,
    });
    await ok(!fs.existsSync(path.join(workDir, 'gtd', 's-hook-legacy.json')), 'legacy ownerless checklist: no GTD for the new session');
    await ok(!/Owner-session/.test(fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8')), 'legacy ownerless checklist: not claimed');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // 4. No active session → nothing to track.
  {
    const workDir = tmpRoot();
    const p = hook({
      internalGtd: false, activeSessionId: null, explicitMode: 'reply',
      task: 'x', secrets: {}, workDir, username: 'u',
      projectDir: null, audience: 'default', chatId: '123', threadId: null,
    });
    await ok(p === null, 'no activeSessionId: hook returns null');
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
