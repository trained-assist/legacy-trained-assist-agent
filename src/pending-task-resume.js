// Whether a journaled pending task is still worth auto-resuming after a restart.
// Pulled out of server.js so the age-window decision is unit-testable without
// booting the whole server (see tests/unit/pending-task-resume.test.js).
// Where a journaled task's result goes (#1671). Resume must not be Telegram-only:
//   durable  — a playbook plan step; its reply settles the step (gtd-controller)
//   web      — a web-UI task; the runner persists the answer in the web session and
//              the resume closes the web mutation receipt
//   telegram — a chat task (legacy entries: identified by userId)
// null → nowhere to deliver the result, not resumable.
const { userWorkDir } = require('./data-paths');

const WEB_TASK_RE = /^(.+)-web-([A-Za-z0-9_-]+)$/;
function resumeSinkOf(p) {
  if (!p) return null;
  const s = p.resumeSink;
  if (s && s.kind === 'durable' && s.taskId && s.itemId) return { ...s };
  if (s && s.kind === 'web' && s.requestId) return { ...s, username: s.username || p.username };
  const web = WEB_TASK_RE.exec(p.taskId || '');
  if (web && web[1] === p.username) return { kind: 'web', username: p.username, requestId: web[2] };
  if (p.userId) return { kind: 'telegram', chatId: p.userId };
  return null;
}

function isTaskResumable(p, now, windowMs) {
  if (!p || !p.startedAt || !p.username || !resumeSinkOf(p)) return false;
  // A task needs recoverable work. Usually that is its text — but a forceClaude request
  // (inline-button callbacks: «🔎 Разобраться подробнее» / plan / menu) intentionally carries
  // NO task text: runner/index.js re-derives it from the session's last user message
  // (`if (forceClaude && activeSessionId && sessionExists)`). Requiring `task` here misclassified
  // every such callback as abandoned, so after a restart the user got a bogus
  // "Задача была прервана перезапуском и не возобновилась. Повтори запрос." instead of the
  // work continuing. Accept them when they are bound to a session.
  const hasRecoverableWork = !!p.task || (p.forceClaude === true && !!p.sessionId);
  if (!hasRecoverableWork) return false;
  return (now - p.startedAt) < windowMs;
}

// Read-time workspace resolution for a journaled task (epic #1789 P1).
//
// Identity ≠ location (see the header of src/data-paths.js): the journal
// identifies the task's profile by username/profileId and NEVER by a machine
// path, so a profile copied to another directory — or another VM — still
// resumes in its new home. The workspace path is derived here, never trusted
// from the record.
//
// Legacy (pre-P1) records carry an absolute `workDir` written by the old
// runner. It is only consulted when the record has no profile identity, so
// those journals keep resuming; anything with a username resolves by identity.
function resolvePendingWorkDir(p) {
  if (p && p.username) return userWorkDir(p.username);
  return (p && p.workDir) || null;
}

module.exports = { isTaskResumable, resumeSinkOf, resolvePendingWorkDir, WEB_TASK_RE };
