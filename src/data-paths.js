'use strict';
// Single source of truth for all on-disk paths used by the agent.
// Every module must import paths from here — never compute them inline.
//
// Three root directories exist by design:
//   USERS_ROOT  — Claude's cwd when spawned; MCP context_set writes here
//   SYSTEM_ROOT — server-side state: candidate history, cache, pending tasks
//   TOKENS_ROOT — per-profile credentials, one file per service
//
// They intentionally differ: USERS_ROOT is the "Claude workspace" (one dir per profile,
// used as cwd), SYSTEM_ROOT is the "agent database" (structured subdirs by feature).
// Confusing them causes silent misses — see issue #428.
//
// Identity ≠ location: durable state stores stable IDs (profileId, projectId,
// sessionId, executionId); filesystem paths are always derived here at read time.
// Do NOT persist an absolute path into a durable record — persist the ID and
// resolve it through one of the helpers below. The legacy workspace root
// `SYSTEM_ROOT/sessions/<profile>` is DEPRECATED (see migrate-workspaces.mjs);
// the workspace root is USERS_ROOT.

const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();

// Claude workspace root — process.cwd() when Claude subprocess runs = USERS_ROOT/{username}
const USERS_ROOT = process.env.USERS_DIR || path.join(HOME, 'users');

// Agent database root — structured storage for server-side state
const SYSTEM_ROOT = process.env.AGENT_DATA_DIR || path.join(HOME, 'agent-data');

// Token storage root — one dir per profile, one file per service.
// Accept BOTH env names: systemd sets AGENT_TOKENS_DIR, while the test harness
// (and user-tokens.js) use AGENT_TOKENS_ROOT. Honoring only one name meant tests
// that set AGENT_TOKENS_ROOT still wrote .chatid/credentials into the real
// ~/agent-tokens — the source of thousands of leaked test profiles (see issue).
const TOKENS_ROOT = process.env.AGENT_TOKENS_DIR || process.env.AGENT_TOKENS_ROOT || path.join(HOME, 'agent-tokens');

// ── Per-user Claude workspace (USERS_ROOT) ────────────────────────────────────

function userWorkDir(username) {
  return path.join(USERS_ROOT, String(username));
}

function contextFilePath(username, skill, key) {
  return path.join(USERS_ROOT, String(username), 'contexts', skill, `${key}.json`);
}

// Session store lives in the workspace (see session-store.js): index + per-session files.
function sessionsDirPath(username) {
  return path.join(userWorkDir(username), 'sessions');
}

// Projects live in the workspace; the project folder is the session's cwd.
function projectsRoot(username) {
  return path.join(userWorkDir(username), 'projects');
}

function projectDir(username, projectId) {
  return path.join(projectsRoot(username), String(projectId));
}

// ── Agent database (SYSTEM_ROOT) ──────────────────────────────────────────────

// Execution history / tracing — one JSON per execution, keyed by executionId.
function executionHistoryPath(executionId) {
  return path.join(SYSTEM_ROOT, 'execution-history', `${executionId}.json`);
}

// Operational flags (engine auth health, etc.) — server-side, not per-profile.
function systemFlagsDir() {
  return path.join(SYSTEM_ROOT, 'system-flags');
}

function candidateHistoryPath(username, negotiationId) {
  return path.join(SYSTEM_ROOT, 'hh', String(username), 'candidates', `${negotiationId}.json`);
}

function negotiationsCachePath(username) {
  return path.join(SYSTEM_ROOT, 'hh', String(username), 'negotiations-cache.json');
}

function pendingTaskPath(taskId) {
  return path.join(SYSTEM_ROOT, 'pending-tasks', `${taskId}.json`);
}

// One shared SQLite file for all profiles — DurableTaskStore scopes every
// query by profile_id, so a single DB is simpler than one-file-per-profile
// and matches durable-task-orchestrator-spec-2026-09-23.md (dedicated
// Persistent Disk path is a later infra step, not a blocker for this).
function durableTaskDbPath() {
  return path.join(SYSTEM_ROOT, 'durable-tasks', 'state.db');
}

// Engine health (claude|codex|opencode) — server-wide operational state, separate from
// credentials and failure history (see src/engine-health.js).
function engineHealthDbPath() {
  return path.join(SYSTEM_ROOT, 'engine-health', 'state.db');
}

// Outgoing Telegram TEXT message ids we may later delete (/clean_up_flood) — keyed by
// bot token prefix + chat. File artifacts (documents/photos) are deliberately never
// tracked here: cleanup keeps them.
function sentMessagesDir() {
  return path.join(SYSTEM_ROOT, 'sent-messages');
}

function sessionIndexPath(username) {
  return path.join(USERS_ROOT, String(username), 'sessions.json');
}

function sessionFilePath(username, sessionId) {
  return path.join(USERS_ROOT, String(username), 'sessions', `${sessionId}.json`);
}

// Quiet-mode group history the gateway delivered with /run (group-history-store.js):
// one file per (group chat, forum topic).
function groupHistoryPath(username, chatId, threadId = null) {
  const topic = threadId != null ? `_t${threadId}` : '';
  return path.join(USERS_ROOT, String(username), 'group-history', `${chatId}${topic}.json`);
}

// ── Token storage (TOKENS_ROOT) ───────────────────────────────────────────────

function tokenPath(username, service) {
  return path.join(TOKENS_ROOT, String(username), service);
}

module.exports = {
  USERS_ROOT,
  SYSTEM_ROOT,
  TOKENS_ROOT,
  userWorkDir,
  contextFilePath,
  sessionsDirPath,
  projectsRoot,
  projectDir,
  executionHistoryPath,
  systemFlagsDir,
  candidateHistoryPath,
  negotiationsCachePath,
  pendingTaskPath,
  sessionIndexPath,
  sessionFilePath,
  groupHistoryPath,
  tokenPath,
  durableTaskDbPath,
  engineHealthDbPath,
  sentMessagesDir,
};
