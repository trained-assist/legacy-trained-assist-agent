// Contract test for audience-scoped session/project resolution (AUDIENCE-SCOPE-SPEC).
//
// Bug: two Telegram bots (general-purpose + recruiter) share the same backend, same
// USERS KV (username), and — for a private chat — the same chatId (Telegram user id is
// identical regardless of which bot is messaged). Every session/project lookup keyed
// only by workDir+chatId therefore mixed the two bots' data: the recruiter bot could
// answer with the general bot's active session, and vice versa.
//
// Fix: an `audience` string (default 'default') scopes session/project creation,
// listing, and current-pointer resolution. Every session/project on disk before this
// feature existed has no `audience` field and must keep resolving under the implicit
// 'default' — zero migration, zero behavior change for the existing (general) bot.
const os = require('os');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

const sessions = require('../src/session-store');
const projects = require('../src/projects');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audience-scope-test-'));
}

// ── session-store: listSessions scoping ─────────────────────────────────────────
{
  const wd = tmpDir();
  const CHAT = 4242;
  const generalId = sessions.createSession(wd, { task: 'general bot task', id: 's-gen-1', chatId: CHAT, audience: 'default' });
  const recruiterId = sessions.createSession(wd, { task: 'recruiter bot task', id: 's-rec-1', chatId: CHAT, audience: 'recruiter' });

  const generalList = sessions.listSessions(wd, 10, 'default');
  ok(generalList.some(s => s.id === generalId), 'default audience sees its own session');
  ok(!generalList.some(s => s.id === recruiterId), 'default audience does NOT see the recruiter session (the reported bug)');

  const recruiterList = sessions.listSessions(wd, 10, 'recruiter');
  ok(recruiterList.some(s => s.id === recruiterId), 'recruiter audience sees its own session');
  ok(!recruiterList.some(s => s.id === generalId), 'recruiter audience does NOT see the default/general session');

  // Omitting audience in listSessions must default to 'default' (safe for HTTP paths).
  const omitted = sessions.listSessions(wd, 10);
  ok(!omitted.some(s => s.id === recruiterId), 'listSessions() with no audience arg still excludes the recruiter session');
}

// ── session-store: current-session pointer independence per chatId ─────────────
{
  const wd = tmpDir();
  const CHAT = 777;
  const generalId = sessions.createSession(wd, { task: 'general', id: 's-gen-2', chatId: CHAT, audience: 'default' });
  const recruiterId = sessions.createSession(wd, { task: 'recruiter', id: 's-rec-2', chatId: CHAT, audience: 'recruiter' });

  ok(sessions.getCurrentSessionId(wd, CHAT, 'default') === generalId, 'default pointer resolves to the general session');
  ok(sessions.getCurrentSessionId(wd, CHAT, 'recruiter') === recruiterId, 'recruiter pointer resolves to the recruiter session, independently of the same chatId');

  // resolveChatSession's pointer-fallback branch must also stay audience-scoped.
  ok(sessions.resolveChatSession(wd, 's-unknown', CHAT, 'default') === generalId, 'resolveChatSession falls back to the default-audience pointer');
  ok(sessions.resolveChatSession(wd, 's-unknown', CHAT, 'recruiter') === recruiterId, 'resolveChatSession falls back to the recruiter-audience pointer');

  // An EXPLICIT sessionId from another audience must not be continued either.
  // This is the cross-bot leak: the bot hands back the session it last saw, and
  // without this check a recruiter run would resume (and answer from) the
  // general bot's conversation.
  ok(sessions.resolveChatSession(wd, generalId, CHAT, 'recruiter') === recruiterId,
    'resolveChatSession refuses an explicit sessionId owned by another audience');
  ok(sessions.resolveChatSession(wd, generalId, CHAT, 'default') === generalId,
    'resolveChatSession still continues its own sessionId');
}

// ── session-store: legacy records (no audience field) resolve as 'default' ─────
{
  const wd = tmpDir();
  const CHAT = 999;
  const legacyId = sessions.createSession(wd, { task: 'pre-audience session', chatId: CHAT });
  // Strip the audience field to simulate a record written before this feature existed.
  const sessFile = path.join(wd, 'sessions', `${legacyId}.json`);
  const full = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  delete full.audience;
  fs.writeFileSync(sessFile, JSON.stringify(full, null, 2));
  const idxFile = path.join(wd, 'sessions.json');
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  delete idx.find(s => s.id === legacyId).audience;
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));

  ok(sessions.listSessions(wd, 10, 'default').some(s => s.id === legacyId), 'legacy session (no audience field) shows up under "default"');
  ok(!sessions.listSessions(wd, 10, 'recruiter').some(s => s.id === legacyId), 'legacy session does NOT leak into a non-default audience');
  // The pre-existing pointer file (current-session-<chatId>.json, no audience suffix)
  // must still resolve — this is the byte-for-byte backward-compat guarantee.
  ok(sessions.getCurrentSessionId(wd, CHAT, 'default') === legacyId, 'legacy current-session pointer (unsuffixed filename) still resolves under default audience');
  ok(sessions.getCurrentSessionId(wd, CHAT) === legacyId, 'getCurrentSessionId with audience omitted matches default-audience behavior (no filename change)');
}

// ── projects.js: listProjects / decideNewSessionProject scoping ────────────────
{
  const wd = tmpDir();
  const CHAT = 'chat-a';
  const generalProj = projects.createProject(wd, { type: 'generic', name: 'Основной' }, { audience: 'default' });
  const recruiterProj = projects.createProject(wd, { type: 'recruiting', name: 'Менеджер продаж' }, { audience: 'recruiter' });

  const generalList = projects.listProjects(wd, 'default');
  ok(generalList.some(p => p.id === generalProj.id), 'default audience sees its own project');
  ok(!generalList.some(p => p.id === recruiterProj.id), 'default audience does NOT see the recruiter project');

  const recruiterList = projects.listProjects(wd, 'recruiter');
  ok(recruiterList.some(p => p.id === recruiterProj.id), 'recruiter audience sees its own project');
  ok(!recruiterList.some(p => p.id === generalProj.id), 'recruiter audience does NOT see the default project');

  // A single project per audience -> decideNewSessionProject auto-binds within that scope only.
  const decision = projects.decideNewSessionProject(wd, CHAT, undefined, 'recruiter');
  ok(decision.action === 'auto' && decision.project.id === recruiterProj.id, 'decideNewSessionProject scopes to the given audience');
}

// ── projects.js: legacy projects (no audience field) resolve as 'default' ──────
{
  const wd = tmpDir();
  const legacy = projects.createProject(wd, { type: 'generic', name: 'Старый проект' });
  const metaFile = path.join(wd, 'projects', legacy.id, 'project.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  delete meta.audience;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  ok(projects.listProjects(wd, 'default').some(p => p.id === legacy.id), 'legacy project (no audience field) shows up under "default"');
  ok(!projects.listProjects(wd, 'recruiter').some(p => p.id === legacy.id), 'legacy project does NOT leak into a non-default audience');
  ok(projects.listProjects(wd).some(p => p.id === legacy.id), 'listProjects() with no audience arg matches default-audience behavior');
}

// ── runner: stop/running isolation across bots sharing one profile (#1302 §3.2) ─
// A private-chat chatId is the Telegram user's own id — identical no matter which
// bot they're messaging — so audience, not just chatId, must scope stop/running.
// Uses runner's real exported functions against the real (test-process) activeTimers
// map, same technique as runner-index-contract.test.cjs's _activeTimers pokes.
{
  const runner = require('../src/runner');
  const fakeProc = () => ({ killed: null, kill(sig) { this.killed = sig; } });
  const CHAT = 555; // deliberately identical across both audiences below

  const defaultProc = fakeProc();
  const recruiterProc = fakeProc();
  const freelanceProc = fakeProc();
  runner._activeTimers.set('alice-default-1', { username: 'alice', audience: 'default', chatId: CHAT, sessionId: 's-default', proc: defaultProc });
  runner._activeTimers.set('alice-recruiter-1', { username: 'alice', audience: 'recruiter', chatId: CHAT, sessionId: 's-recruiter', proc: recruiterProc });
  runner._activeTimers.set('alice-freelance-1', { username: 'alice', audience: 'freelance', chatId: CHAT, sessionId: 's-freelance', proc: freelanceProc });

  // isTaskRunning: omitted audience means 'default' only, never "any audience".
  ok(runner.isTaskRunning('alice') === true, 'isTaskRunning(no audience) sees the default-audience task');
  ok(runner.isTaskRunning('alice', 'recruiter') === true, 'isTaskRunning(recruiter) sees its own task');
  ok(runner.isTaskRunning('alice', 'freelance') === true, 'isTaskRunning(freelance) sees its own task (3rd bot, issue #1302)');
  ok(runner.isTaskRunning('bob', 'recruiter') === false, 'isTaskRunning does not match a different username');

  // stopUserTask: same chatId, different audience — stopping the recruiter bot's
  // task must NOT touch the default or freelance bot's task for the same profile.
  const stoppedRecruiter = runner.stopUserTask('alice', CHAT, 'recruiter');
  ok(stoppedRecruiter === true, 'stopUserTask(recruiter) reports it stopped something');
  ok(recruiterProc.killed === 'SIGTERM', 'stopUserTask(recruiter) kills only the recruiter process');
  ok(defaultProc.killed === null, 'stopUserTask(recruiter) does NOT touch the default-audience process (same chatId)');
  ok(freelanceProc.killed === null, 'stopUserTask(recruiter) does NOT touch the freelance-audience process (same chatId)');

  // stopUserTask with audience omitted scopes to 'default' only.
  const stoppedDefault = runner.stopUserTask('alice', CHAT);
  ok(stoppedDefault === true, 'stopUserTask(no audience) still finds and stops the default-audience task');
  ok(defaultProc.killed === 'SIGTERM', 'stopUserTask(no audience) kills the default process');
  ok(freelanceProc.killed === null, 'stopUserTask(no audience) still leaves freelance running — omitted audience is default-only, never "every audience"');

  runner._activeTimers.clear();
}

// ── runner: killTaskByUsername and stopSessionTask isolation (#1302 §3.2) ──────
{
  const runner = require('../src/runner');
  const fakeProc = () => ({ killed: null, kill(sig) { this.killed = sig; } });

  const recruiterProc = fakeProc();
  const freelanceProc = fakeProc();
  runner._activeTimers.set('carol-recruiter-1', { username: 'carol', audience: 'recruiter', chatId: 1, sessionId: 's-1', proc: recruiterProc });
  runner._activeTimers.set('carol-freelance-1', { username: 'carol', audience: 'freelance', chatId: 1, sessionId: 's-2', proc: freelanceProc });

  // /tasks/stop for one bot (B) must not kill another bot's (A) task for the same profile.
  const killedRecruiter = runner.killTaskByUsername('carol', 'recruiter');
  ok(killedRecruiter === 1, 'killTaskByUsername(recruiter) reports exactly one kill');
  ok(recruiterProc.killed === 'SIGTERM', 'killTaskByUsername(recruiter) kills the recruiter process');
  ok(freelanceProc.killed === null, 'killTaskByUsername(recruiter) does NOT kill the freelance process for the same profile');

  const killedDefault = runner.killTaskByUsername('carol'); // no audience -> default only
  ok(killedDefault === 0, 'killTaskByUsername(no audience) finds nothing — freelance is not "default"');
  ok(freelanceProc.killed === null, 'freelance process is still untouched');

  runner._activeTimers.clear();

  // stopSessionTask is exact-session already (sessionId disambiguates), but must also
  // use an exact username match rather than a taskId string-prefix check.
  const sessProc = fakeProc();
  runner._activeTimers.set('dave-1', { username: 'dave', chatId: 1, sessionId: 's-dave', proc: sessProc });
  ok(runner.stopSessionTask('dav', 's-dave') === false, 'stopSessionTask does not match on a username prefix');
  ok(sessProc.killed === null, 'no process killed by the prefix mismatch');
  ok(runner.stopSessionTask('dave', 's-dave') === true, 'stopSessionTask matches the exact username');
  ok(sessProc.killed === 'SIGTERM', 'stopSessionTask kills the right process on an exact match');
  runner._activeTimers.clear();
}

console.log(`\naudience-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
