// Contract test for issue #942 P1.5: src/runner/index.js is the orchestrator
// re-exporting the runner's public API. This guards against a "clean extraction"
// silently dropping an export that server.js/web-routes.js/misha-bot.js depend on.
const runner = require('../src/runner');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const REQUIRED_EXPORTS = [
  'interruptForRestart',
  'runTask',
  'getQuickAnswer',
  'runQuickAnswer',
  'generateConnectLink',
  'getPendingTasks',
  'clearPendingTask',
  'ensureSkillDir',
  'isTaskRunning',
  'isSessionRunning',
  'extendTaskTimeout',
  'stopTask',
  'stopUserTask',
  'killTaskByUsername',
  'reconcileSoftContinuations', // Startup migration retires legacy speculative timers.
];

for (const name of REQUIRED_EXPORTS) {
  ok(typeof runner[name] === 'function', `runner.${name} must be exported as a function`);
}

// Sanity: this file must actually resolve to src/runner/index.js (the moved file),
// not a stale src/runner.js left behind by an incomplete migration.
const path = require('path');
const resolved = require.resolve('../src/runner');
ok(resolved === path.join(__dirname, '..', 'src', 'runner', 'index.js'),
  `require('../src/runner') must resolve to src/runner/index.js, got ${resolved}`);

// isSessionRunning: real in-process activeTimers check used by gtd-controller's
// re-entrancy guard (replaced a pending-task-journal TTL heuristic that could age
// out — 30min TTL vs runs legitimately taking up to 40min+ — and double-fire a
// GTD session while it was still genuinely running).
ok(runner.isSessionRunning('s-not-running') === false, 'isSessionRunning: false when nothing active');
runner._activeTimers.set('someuser-gtd-s-active-123', { sessionId: 's-active', proc: {} });
ok(runner.isSessionRunning('s-active') === true, 'isSessionRunning: true once the session has an active timer entry');
ok(runner.isSessionRunning('s-other') === false, 'isSessionRunning: does not match a different sessionId');
runner._activeTimers.delete('someuser-gtd-s-active-123');
ok(runner.isSessionRunning('s-active') === false, 'isSessionRunning: false again after the entry is cleared');

// isSessionRunning: also true while QUEUED (accepted, waiting on the per-chat
// queue / RAM / global slot) — before activeTimers gets an entry. The session is
// added to queuedSessions synchronously at runTask() call time, well before the
// process spawns; without checking it, a GTD tick could see "not running" and
// double-fire a session that is simply waiting its turn under load.
ok(runner.isSessionRunning('s-queued') === false, 'isSessionRunning: false before anything is queued');
runner._queuedSessions.add('s-queued');
ok(runner.isSessionRunning('s-queued') === true, 'isSessionRunning: true while queued (queuedSessions entry, no activeTimers entry yet)');
ok(runner.isSessionRunning('s-other-queued') === false, 'isSessionRunning: queued check does not match a different sessionId');
runner._queuedSessions.delete('s-queued');
ok(runner.isSessionRunning('s-queued') === false, 'isSessionRunning: false again once the queued entry clears');

// Slice C of #1573: the runner must wire the audience-default playbook offer
// into the dev-task context, and it must stay out of durable playbook steps
// (internalGtd) — a step offering to run a playbook would be recursive.
const fs = require('fs');
const runnerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'index.js'), 'utf8');
ok(/require\('\.\.\/dev-task-playbook-suggestion'\)/.test(runnerSrc),
  'runner must import buildDevPlaybookSuggestion');
ok(/buildDevPlaybookSuggestion\(\{ task, profileId: user\.username/.test(runnerSrc),
  'runner must call buildDevPlaybookSuggestion with the profile + task');
ok(/\(!internalGtd && user\?\.username\)/.test(runnerSrc),
  'playbook suggestion must be gated off for durable steps (internalGtd)');
ok(/playbookSuggestionSection, artifactsSection\]/.test(runnerSrc),
  'playbook suggestion must be part of baseContext');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
