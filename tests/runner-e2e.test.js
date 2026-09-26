/**
 * E2E runner tests — real user dialogues, no mocking magic.
 *
 * Strategy:
 * - Local HTTP server captures Telegram API calls (sendMessage / editMessageText)
 * - Fake `claude` binary in temp dir (outputs canned stream-json), added to PATH
 * - Real runner.js + session-store runs against a temp workDir
 * - Tests assert on captured Telegram calls and session files on disk
 *
 * This approach avoids vi.mock/ESM/CJS hell — everything is real except:
 *   1. Telegram API endpoint → local capture server
 *   2. `claude` binary → shell script that outputs our reply JSON
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import * as http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Local Telegram capture server ─────────────────────────────────────────────

let tgServer;
let tgPort;
let tgRespond = null;
let tgLog = []; // captured { method, body } per request

async function startTgServer() {
  return new Promise((resolve) => {
    tgServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        tgLog.push({ url: req.url, body: parsed });
        if (tgRespond?.(req, res, parsed)) return;
        // Always reply with a valid Telegram-like response
        const msgId = Math.floor(Math.random() * 9000 + 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
      });
    });
    tgServer.listen(0, '127.0.0.1', () => {
      tgPort = tgServer.address().port;
      resolve();
    });
  });
}

function stopTgServer() {
  return new Promise(r => tgServer.close(r));
}

// ── Fake claude binary ────────────────────────────────────────────────────────

let fakeBinDir;
let claudeReplyFile;

function setupFakeClaude(reply = 'OK') {
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, reply);
}

// Writes the normal (always-succeeds) fake claude script to the current fakeBinDir/claude path.
function writeNormalClaudeScript() {
  const script = `#!/bin/bash
REPLY=$(cat "${claudeReplyFile}" 2>/dev/null || echo "OK")
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
echo '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":100,"output_tokens":50}}'
`;
  const scriptPath = join(fakeBinDir, 'claude');
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

// Crashes (non-zero exit, near-empty output) on the first `crashCount` invocations,
// then behaves like a normal successful run. Invocation count tracked on disk so it
// survives the fact that a retry spawns a brand-new process. Callers MUST call
// restoreNormalClaude() afterwards — this overwrites the shared claude binary in place.
// argsLogFile, if given, gets one base64-encoded line per invocation holding that
// invocation's last argv (the --print prompt) — lets a test assert what a retry actually saw
// without a raw prompt's embedded newlines corrupting the line-per-invocation format.
function setupCrashingClaude(crashCount = 1, exitCode = 1, { argsLogFile = null } = {}) {
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, 'OK after retry');
  const counterFile = join(fakeBinDir, 'crash-counter.txt');
  writeFileSync(counterFile, '0');
  const scriptPath = join(fakeBinDir, 'claude');
  const script = `#!/bin/bash
COUNT=$(cat "${counterFile}" 2>/dev/null || echo 0)
COUNT=$((COUNT+1))
echo $COUNT > "${counterFile}"
${argsLogFile ? `printf '%s' "\${@: -1}" | base64 -w0 >> "${argsLogFile}"; printf '\\n' >> "${argsLogFile}"` : ''}
if [ "$COUNT" -le ${crashCount} ]; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}'
  exit ${exitCode}
fi
REPLY=$(cat "${claudeReplyFile}" 2>/dev/null || echo "OK")
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
echo '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":100,"output_tokens":50}}'
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

function restoreNormalClaude() {
  writeNormalClaudeScript();
  setupFakeClaude('OK');
}

// Exits 0 with narration text but no `result`/completion event on the first `badCount`
// invocations (the "no confirmed final answer" dead-end — distinct from setupCrashingClaude's
// non-zero exit, which is the separate QUICK_CRASH_MS path), then behaves normally.
function setupIncompleteClaude(badCount = 1, { argsLogFile = null } = {}) {
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, 'Готово после ретраев');
  const counterFile = join(fakeBinDir, 'incomplete-counter.txt');
  writeFileSync(counterFile, '0');
  const scriptPath = join(fakeBinDir, 'claude');
  const script = `#!/bin/bash
COUNT=$(cat "${counterFile}" 2>/dev/null || echo 0)
COUNT=$((COUNT+1))
echo $COUNT > "${counterFile}"
${argsLogFile ? `printf '%s' "\${@: -1}" | base64 -w0 >> "${argsLogFile}"; printf '\\n' >> "${argsLogFile}"` : ''}
if [ "$COUNT" -le ${badCount} ]; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"работаю над задачей"}]}}'
  exit 0
fi
REPLY=$(cat "${claudeReplyFile}" 2>/dev/null || echo "OK")
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
echo '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":100,"output_tokens":50}}'
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o755);
}

function buildFakeClaudeBinary() {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'fake-claude-bin-'));
  claudeReplyFile = join(fakeBinDir, 'claude-reply.txt');
  writeFileSync(claudeReplyFile, 'default reply');
  writeNormalClaudeScript();
}

// ── Module loading ────────────────────────────────────────────────────────────

// Loaded once — we patch env vars before loading
let runTask;
let sessionStore;
let origTgUrl;

// Isolated tokens root — prevents loadUserTokens from scanning real ~/agent-tokens/
// and migrating real user data into the test run.
let testTokensRoot;
let testDataRoot;
let origDataRoot;
let origZerocredsUrl;
let origZerocredsAdmin;

beforeAll(async () => {
  await startTgServer();
  buildFakeClaudeBinary();
  testTokensRoot = mkdtempSync(join(tmpdir(), 'runner-e2e-tokens-'));
  testDataRoot = mkdtempSync(join(tmpdir(), 'runner-e2e-data-'));
  origDataRoot = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = testDataRoot; // never inherit the live maintenance journal

  // Patch env BEFORE loading runner.js (runner reads TG_API at module level)
  origTgUrl = process.env.TELEGRAM_API_URL;
  process.env.TELEGRAM_API_URL = `http://127.0.0.1:${tgPort}`;
  process.env.CLAUDE_BIN = join(fakeBinDir, 'claude'); // explicit path, no PATH manipulation
  process.env.AGENT_TOKENS_ROOT = testTokensRoot;     // isolate from real ~/agent-tokens/
  process.env.TEST_MODE = '1'; // retry-policy backoff → ms instead of 30s/3min/10min (see src/retry-policy.js)

  // Never let a "подключи X" quick answer create a REAL ZeroCreds session against
  // production. The ZeroCreds destination preflight would then POST the production
  // /tokens for this testuser — the duplicate-flood incident of 2026-09-24. Force the
  // legacy, fully-local connect-link path instead.
  origZerocredsUrl = process.env.ZEROCREDS_URL;
  origZerocredsAdmin = process.env.ZEROCREDS_ADMIN_TOKEN;
  process.env.ZEROCREDS_URL = '';
  process.env.ZEROCREDS_ADMIN_TOKEN = '';

  const mod = require('../src/runner');
  runTask = mod.runTask;
  sessionStore = require('../src/session-store.js');
});

afterAll(async () => {
  process.env.TELEGRAM_API_URL = origTgUrl;
  delete process.env.CLAUDE_BIN;
  delete process.env.AGENT_TOKENS_ROOT;
  delete process.env.TEST_MODE;
  if (origZerocredsUrl === undefined) delete process.env.ZEROCREDS_URL; else process.env.ZEROCREDS_URL = origZerocredsUrl;
  if (origZerocredsAdmin === undefined) delete process.env.ZEROCREDS_ADMIN_TOKEN; else process.env.ZEROCREDS_ADMIN_TOKEN = origZerocredsAdmin;
  if (origDataRoot === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = origDataRoot;
  rmSync(testDataRoot, { recursive: true, force: true });
  rmSync(testTokensRoot, { recursive: true, force: true });
  await stopTgServer();
  rmSync(fakeBinDir, { recursive: true, force: true });
});

// ── Per-test setup ────────────────────────────────────────────────────────────

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'runner-e2e-'));
  // These scenarios count answer-delivery messages one by one. Since 2026-09-26 every
  // profile with a project gets a pinned project card after a run — an extra send that is
  // covered by test/pin-context-card + test/chat-pinned-project, not here. Same switch as
  // the user's /context_off.
  writeFileSync(join(workDir, '.context_disabled'), '');
  tgLog = [];
  tgRespond = null;
  setupFakeClaude('OK');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

// Use a unique username per test so listConnectedServices() never picks up real
// tokens from ~/agent-tokens/testuser/ on the developer's machine.
// A random suffix ensures no accidental collision with real profiles.
let testUsername;
beforeEach(() => { testUsername = `testuser-${Math.random().toString(36).slice(2, 8)}`; });

function makeUser(userId = 111222333) {
  return { id: userId, name: 'Test', username: testUsername, workDir };
}

async function chat(task, { userId = 111222333, sessionId = null, forceNew = false, claudeReply = null } = {}) {
  if (claudeReply !== null) setupFakeClaude(claudeReply);
  await runTask({
    taskId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    user: makeUser(userId),
    task,
    context: null,
    sessionId,
    forceNew,
    contextFromSession: null,
    secrets: { BOT_TOKEN: 'fake:token' },
  });
}

function readCurrentSession(userId = 111222333) {
  // Try per-chat file first (current format), fall back to legacy
  const perChat = join(workDir, 'sessions', `current-session-${userId}.json`);
  if (existsSync(perChat)) return JSON.parse(readFileSync(perChat, 'utf8'));
  const legacy = join(workDir, 'sessions', 'current-session.json');
  return existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : null;
}

function readSession(id) {
  const fp = join(workDir, 'sessions', `${id}.json`);
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : null;
}

function listSessionIndex() {
  const fp = join(workDir, 'sessions.json');
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : [];
}

function tgSent() {
  return tgLog.filter(l => l.url.includes('sendMessage') || l.url.includes('editMessageText'));
}

function tgTexts() {
  return tgSent().map(l => l.body.text).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 1: quick answer creates session, Claude picks up the history
// ═══════════════════════════════════════════════════════════════════════════════

describe('Quick answer → Claude context injection', () => {

  it('capability question creates a session and logs both sides', { timeout: 15000 }, async () => {
    // "подключи github" always gives a quick answer regardless of config
    await chat('подключи github');

    const current = readCurrentSession();
    expect(current, 'current-session.json not created after quick answer').not.toBeNull();

    const sess = readSession(current.id);
    expect(sess).not.toBeNull();
    expect(sess.messages.length, 'should have user msg + bot reply = 2').toBe(2);
    expect(sess.messages[0].role).toBe('user');
    expect(sess.messages[1].role).toBe('assistant');
    expect(sess.messages[1].content).toMatch(/github\.com|token|токен|ссылке/i);
  });

  it('second quick answer appends to same session', { timeout: 15000 }, async () => {
    await chat('умеешь читать гугл таблицы?');
    const after1 = readCurrentSession();

    await chat('подключи github');  // no sessionId — should auto-continue
    const after2 = readCurrentSession();

    expect(after2.id, 'session ID changed — continuity broken').toBe(after1.id);
    const sess = readSession(after2.id);
    expect(sess.messages.length, 'expected 4 messages (2 exchanges)').toBe(4);
  });

  it('Claude invocation after quick answers receives session context', { timeout: 20000 }, async () => {
    await chat('умеешь читать гугл таблицы?');
    await chat('подключи github');

    // Save prompt that Claude was invoked with by checking its args
    // (we can't intercept spawn args directly, but we can verify session context via disk)
    const sess = readSession(readCurrentSession().id);
    const msgs = sess.messages;

    // The session has 4 messages from 2 quick-answer exchanges
    // Now Claude should get buildContext(last 6) — which includes these 4 messages
    await chat('прочитай файл sales.xlsx и дай итоги', { claudeReply: 'Q3: выручка 4.2M, отток снизился' });

    // After Claude run, session should have 6 messages (4 quick + user + claude)
    const sessAfter = readSession(readCurrentSession().id);
    expect(sessAfter.messages.length, 'expected 6 messages after Claude run').toBe(6);
    const claudeMsg = sessAfter.messages.find(m => m.content.includes('4.2M'));
    expect(claudeMsg, 'Claude reply not found in session history').not.toBeUndefined();
  });

  it('Claude Telegram output shows 🧠 prefix', { timeout: 20000 }, async () => {
    await chat('сделай анализ продаж', { claudeReply: 'Анализ выполнен: выручка 4.2M' });

    const texts = tgTexts();
    const finalMsg = texts[texts.length - 1];
    expect(finalMsg).toMatch(/🧠/);
    expect(finalMsg).toMatch(/Анализ выполнен/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2: utility commands don't pollute sessions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Utility commands do not pollute sessions', () => {

  it('/ping — no session created', { timeout: 10000 }, async () => {
    await chat('/ping');
    expect(readCurrentSession(), '/ping should not create a session').toBeNull();
    expect(listSessionIndex()).toHaveLength(0);
  });

  it('/help — no session created', { timeout: 10000 }, async () => {
    await chat('/help');
    expect(readCurrentSession()).toBeNull();
  });

  it('/usage — no session created', { timeout: 10000 }, async () => {
    await chat('/usage');
    expect(readCurrentSession()).toBeNull();
  });

  it('[BUG DETECTOR] utility on existing session — user message must NOT be orphaned', { timeout: 20000 }, async () => {
    // First: create a session with a real message
    await chat('умеешь работать с weeek?');
    const current = readCurrentSession();
    const beforeCount = readSession(current.id).messages.length;

    // Now: send utility command — should NOT append user msg without bot reply
    await chat('/ping');

    const afterCount = readSession(current.id).messages.length;
    // Bug: if utility check happens AFTER appendUserMessage, count is beforeCount+1 (orphan)
    // Correct: count stays at beforeCount (utility not logged at all)
    expect(afterCount, `orphan user message! was ${beforeCount}, now ${afterCount}`).toBe(beforeCount);
  });

  it('after utility commands, capability question starts clean session', { timeout: 15000 }, async () => {
    await chat('/ping');
    await chat('/help');

    await chat('умеешь weeek?');
    const current = readCurrentSession();
    expect(current).not.toBeNull();

    const sess = readSession(current.id);
    // Session should have ONLY the capability question, not /ping or /help
    const commandMsgs = sess.messages.filter(m => m.content.match(/^\/ping|^\/help/));
    expect(commandMsgs.length, 'utility commands leaked into session').toBe(0);
    expect(sess.messages.length).toBe(2); // user + bot
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 2b: pure-info quick answers bypass the per-chat admission queue
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pre-queue quick answers skip the chat queue', () => {

  function writeSlowClaudeScript(delayMs) {
    const script = `#!/bin/bash
sleep ${(delayMs / 1000).toFixed(2)}
REPLY=$(cat "${claudeReplyFile}" 2>/dev/null || echo "OK")
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"'"$REPLY"'"}]}}'
echo '{"type":"result","result":"'"$REPLY"'","usage":{"input_tokens":100,"output_tokens":50}}'
`;
    writeFileSync(join(fakeBinDir, 'claude'), script);
    chmodSync(join(fakeBinDir, 'claude'), 0o755);
  }

  it('/agent_info answers immediately while a real task is still running in the same chat', { timeout: 20000 }, async () => {
    const SLOW_MS = 4000;
    writeSlowClaudeScript(SLOW_MS);
    const userId = 555444333;
    try {
      // Kick off a slow task in this chat — deliberately NOT awaited, it occupies the
      // per-chat queue for SLOW_MS.
      const slowTask = runTask({
        taskId: `slow-${Date.now()}`,
        user: makeUser(userId),
        task: 'сделай что-нибудь долгое',
        context: null,
        sessionId: null,
        contextFromSession: null,
        // Real callers (server.js) pass both keys — TELEGRAM_BOT_TOKEN is an alias of
        // BOT_TOKEN that the pre-queue bypass blocks (/stop, /agent_info, ...) read.
        secrets: { BOT_TOKEN: 'fake:token', TELEGRAM_BOT_TOKEN: 'fake:token' },
      });

      // Give the slow task a moment to actually enter the queue/admission path.
      await new Promise(r => setTimeout(r, 300));

      const t0 = Date.now();
      await runTask({
        taskId: `info-${Date.now()}`,
        user: makeUser(userId),
        task: '/agent_info',
        context: null,
        sessionId: null,
        contextFromSession: null,
        secrets: { BOT_TOKEN: 'fake:token', TELEGRAM_BOT_TOKEN: 'fake:token' },
      });
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs, `/agent_info took ${elapsedMs}ms — looks like it waited behind the slow task instead of bypassing the queue`).toBeLessThan(SLOW_MS / 2);

      // The bypass sends its Telegram reply fire-and-forget (same style as /stop etc.,
      // see runTask()) — runTask() itself resolves before that HTTP call necessarily lands.
      // Poll briefly instead of asserting immediately.
      let texts = [];
      for (let i = 0; i < 20; i++) {
        texts = tgTexts();
        if (texts.some(t => /Модель:|Движок:|VM:/i.test(t))) break;
        await new Promise(r => setTimeout(r, 25));
      }
      expect(texts.some(t => /Модель:|Движок:|VM:/i.test(t)), 'expected an agent-info-shaped reply').toBe(true);

      await slowTask; // drain before the next test reuses fakeBinDir/claude
    } finally {
      restoreNormalClaude();
    }
  });

  // Regression for 2026-09-24 bug report: /switch2codex sat behind "Ожидаю завершения
  // предыдущей работы" instead of answering instantly, because ENGINE_SWITCH_INTENT was
  // missing from isPreQueueQuickIntent's whitelist even though its handler is a sync,
  // local profiles.json write with no Claude/network call — same shape as /agent_info above.
  it('/switch2codex answers immediately while a real task is still running in the same chat', { timeout: 20000 }, async () => {
    const SLOW_MS = 4000;
    writeSlowClaudeScript(SLOW_MS);
    const userId = 555444334;
    try {
      const slowTask = runTask({
        taskId: `slow-${Date.now()}`,
        user: makeUser(userId),
        task: 'сделай что-нибудь долгое',
        context: null,
        sessionId: null,
        contextFromSession: null,
        secrets: { BOT_TOKEN: 'fake:token', TELEGRAM_BOT_TOKEN: 'fake:token' },
      });

      await new Promise(r => setTimeout(r, 300));

      const t0 = Date.now();
      await runTask({
        taskId: `switch-${Date.now()}`,
        user: makeUser(userId),
        task: '/switch2codex',
        context: null,
        sessionId: null,
        contextFromSession: null,
        secrets: { BOT_TOKEN: 'fake:token', TELEGRAM_BOT_TOKEN: 'fake:token' },
      });
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs, `/switch2codex took ${elapsedMs}ms — looks like it waited behind the slow task instead of bypassing the queue`).toBeLessThan(SLOW_MS / 2);

      let texts = [];
      for (let i = 0; i < 20; i++) {
        texts = tgTexts();
        if (texts.some(t => /движок/i.test(t))) break;
        await new Promise(r => setTimeout(r, 25));
      }
      expect(texts.some(t => /движок/i.test(t)), 'expected an engine-switch-shaped reply').toBe(true);
      expect(texts.some(t => /Ожидаю завершения предыдущей работы/i.test(t)), 'must NOT get the queued-behind-previous-task message').toBe(false);

      await slowTask;
    } finally {
      restoreNormalClaude();
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3: session continuity — 4h TTL
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session continuity TTL', () => {

  it('continues same session within 4h', { timeout: 15000 }, async () => {
    await chat('подключи github');
    const id1 = readCurrentSession().id;

    // Next message without sessionId — should auto-continue
    await chat('создай issue', { claudeReply: 'Issue создан' });
    const id2 = readCurrentSession().id;

    expect(id2, 'session ID changed — expected continuation').toBe(id1);
  });

  it('starts new session after TTL expired', { timeout: 25000 }, async () => {
    await chat('подключи github');
    const current = readCurrentSession();
    // Use per-chat file path (userId=111222333 is the default in chat())
    const fp = join(workDir, 'sessions', 'current-session-111222333.json');

    // Expire the session
    writeFileSync(fp, JSON.stringify({ ...current, lastAt: Date.now() - 5 * 60 * 60 * 1000 }));

    await chat('совсем другая задача', { claudeReply: 'Выполнено' });

    const newCurrent = readCurrentSession();
    expect(newCurrent.id, 'expected NEW session after TTL').not.toBe(current.id);
  });

  it('explicit sessionId always wins over auto-continue (forceNew — gateway intent)', { timeout: 25000 }, async () => {
    await chat('умеешь github?');  // creates S-auto
    const autoId = readCurrentSession().id;

    // A brand-new, not-yet-on-disk id is only ever sent by the gateway with forceNew
    // intent (NEW_SESSION_SIGNALS or first message — see tg-bot resolveSessionRoute).
    // Without forceNew, resolveChatSession's sign-split heal would treat this the
    // same as a stale/diverged id and reattach to the chat's existing pointer instead.
    const explicitId = 's-explicit-123';
    await chat('работаю в явной сессии', { sessionId: explicitId, forceNew: true, claudeReply: 'OK' });

    const current = readCurrentSession();
    expect(current.id, 'expected explicit session to win').toBe(explicitId);
    expect(current.id).not.toBe(autoId);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 3b: cross-chat isolation is non-blocking
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-chat session isolation is non-blocking', () => {
  const CHAT_A = -5042012537;
  const CHAT_B = -5042012538;

  it('a foreign session id never blocks — the chat still gets an answer', { timeout: 30000 }, async () => {
    // CHAT_A owns a session.
    await chat('подключи github', { userId: CHAT_A });
    const sessA = readCurrentSession(CHAT_A);
    expect(sessA, 'CHAT_A session not created').not.toBeNull();

    // CHAT_B's gateway mistakenly hands back CHAT_A's session id.
    await chat('сделай отчёт', { userId: CHAT_B, sessionId: sessA.id, claudeReply: 'Отчёт готов' });

    // No rejection message.
    expect(tgTexts().some(t => /закреплена за другим чатом/.test(t))).toBe(false);

    // CHAT_B got its own current session + the answer.
    const sessB = readCurrentSession(CHAT_B);
    expect(sessB, 'CHAT_B session not created').not.toBeNull();
    expect(sessB.id).not.toBe(sessA.id);
    expect(readSession(sessB.id).messages.some(m => m.content.includes('Отчёт готов'))).toBe(true);

    // CHAT_A's session is untouched and still attached to CHAT_A.
    const a = readSession(sessA.id);
    expect(String(a.liveChatId)).toBe(String(CHAT_A));
    expect(a.messages.some(m => m.content.includes('сделай отчёт'))).toBe(false);
  });

  it("falls back to this chat's own session when it already has one", { timeout: 30000 }, async () => {
    await chat('подключи github', { userId: CHAT_B });        // CHAT_B owns S_B
    const sessB = readCurrentSession(CHAT_B);

    await chat('подключи github', { userId: CHAT_A });        // CHAT_A owns S_A
    const sessA = readCurrentSession(CHAT_A);
    expect(sessA.id).not.toBe(sessB.id);

    // CHAT_B receives CHAT_A's id — must continue S_B, not spawn a new session.
    await chat('прочитай файл sales.xlsx', { userId: CHAT_B, sessionId: sessA.id, claudeReply: 'Прочитал' });

    expect(readCurrentSession(CHAT_B).id, 'expected CHAT_B to continue its own session').toBe(sessB.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 4: full dialogue — setup → work
// ═══════════════════════════════════════════════════════════════════════════════

describe('Full dialogue: setup → work', () => {

  it('GitHub setup → issue: session has setup context before Claude runs', { timeout: 25000 }, async () => {
    await chat('подключи github');

    // Before Claude runs, session should have the setup exchange
    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length).toBe(2); // setup quick answer
    expect(sess.messages[1].content).toMatch(/github\.com|token|токен/i);

    // Now Claude runs — it will get buildContext which includes the setup exchange
    await chat('создай issue «/export команда»', { claudeReply: 'Issue #42 создан' });

    const sessAfter = readSession(current.id);
    // Should have 4 messages: setup user + setup bot + task user + claude reply
    expect(sessAfter.messages.length).toBe(4);
  });

  it('Weeek: 2 quick answers → Claude with full context', { timeout: 25000 }, async () => {
    await chat('умеешь работать с weeek?');
    await chat('подключи weeek');

    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length, 'expected 4 messages before Claude').toBe(4);

    await chat('покажи все воронки', { claudeReply: 'Воронки: Новые лиды, Квалификация, Закрытие' });

    const sessAfter = readSession(current.id);
    expect(sessAfter.messages.length, 'expected 6 messages after Claude').toBe(6);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 5: multi-turn Claude conversation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-turn Claude conversation', () => {

  it('second Claude turn history includes first Claude reply', { timeout: 30000 }, async () => {
    await chat('прочитай sales.xlsx', { claudeReply: 'Q3 выручка 4.2M, отток 8%' });
    const sessAfterFirst = readSession(readCurrentSession().id);
    expect(sessAfterFirst.messages.length).toBe(2);

    await chat('подробнее про отток', { claudeReply: 'Отток: было 12%, стало 8%' });

    const sessAfterSecond = readSession(readCurrentSession().id);
    expect(sessAfterSecond.messages.length, 'expected 4 messages after 2 Claude turns').toBe(4);
    // The second Claude reply should be in history
    const lastMsg = sessAfterSecond.messages[sessAfterSecond.messages.length - 1];
    expect(lastMsg.content).toMatch(/12%|8%/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 6: Telegram delivery
// ═══════════════════════════════════════════════════════════════════════════════

describe('Telegram delivery', () => {

  it('/ping sends exactly one message, no thinking step', { timeout: 10000 }, async () => {
    await chat('/ping');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    expect(sent[0].url).toMatch(/sendMessage/);
    expect(sent[0].body.text).toMatch(/онлайн|Онлайн/i);
  });

  it('quick answer sends exactly one message (no thinking step)', { timeout: 10000 }, async () => {
    await chat('подключи github');  // always quick answer
    const sent = tgSent();
    expect(sent.length, 'quick answer should send exactly 1 message').toBe(1);
    expect(sent[0].url).toMatch(/sendMessage/);
  });

  it('Claude answer: thinking → edit with 🧠', { timeout: 20000 }, async () => {
    await chat('сделай задачу', { claudeReply: 'Задача выполнена' });

    const sends = tgSent().filter(l => l.url.includes('sendMessage'));
    const edits = tgSent().filter(l => l.url.includes('editMessageText'));

    expect(sends.length, 'should send exactly 1 thinking message').toBe(1);
    expect(sends[0].body.text).toMatch(/Думаю/);
    expect(edits.length, 'should have at least 1 edit').toBeGreaterThanOrEqual(1);

    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.body.text).toMatch(/🧠/);
    expect(lastEdit.body.text).toMatch(/Задача выполнена/);
  });

  it('revoke command: quick answer with confirmation', { timeout: 10000 }, async () => {
    await chat('отзови доступ к github', { userId: 42 });
    const texts = tgTexts();
    expect(texts.length).toBe(1);
    // Either "revoked" or "not connected" — both are valid quick answers
    expect(texts[0]).toMatch(/github|GitHub/i);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 7: quick-answer button (expand to Claude)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Expand button — forceClaude escalation', () => {

  it('quick answer carries a qa_more escalate button (requirements-log [062])', { timeout: 10000 }, async () => {
    await chat('подключи github');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    const body = sent[0].body;
    // #530 §B + INTAKE-REFACTOR-SPEC §9.2 (owner reversal) killed the generic one-shot
    // action markup (answer-router.oneshotActionMarkup stays null — clarify| is gone for
    // good). But a template quick answer never runs detectPlanInAnswer, so it could never
    // earn a «▶️ Действуй дальше по плану» button either — leaving it a dead end whenever
    // it missed the point (requirements-log [062], 2026-09-15). Fix: a dedicated
    // qa_more|{sessionId} button (tg-bot callbacks.js) reruns the same session
    // forceClaude+deep, and runner.js's existing forceClaude-deep wrap (SCENARIO 7 below)
    // carries the quick reply along as context.
    const sessionId = readCurrentSession().id;
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🔎 Разобраться подробнее', callback_data: `qa_more|${sessionId}` }]],
    });
  });

  it('forceClaude=true skips quick answer and calls Claude', { timeout: 20000 }, async () => {
    // First: create session with a quick answer
    await chat('подключи github');
    const current = readCurrentSession();
    const sessionId = current.id;

    // Now user taps expand button — forceClaude=true, no task (agent reads lastUserMessage)
    tgLog = [];
    await runTask({
      taskId: `t-expand-${Date.now()}`,
      user: makeUser(),
      task: '',           // bot sends empty task on button tap
      context: null,
      sessionId,
      contextFromSession: null,
      forceClaude: true,
      secrets: { BOT_TOKEN: 'fake:token' },
    });

    // Should have sent thinking + final edit (Claude path, not quick-answer path)
    const sends = tgSent().filter(l => l.url.includes('sendMessage'));
    const edits = tgSent().filter(l => l.url.includes('editMessageText'));
    expect(sends.length, 'should send thinking message').toBe(1);
    expect(sends[0].body.text).toMatch(/Думаю/);
    expect(edits.length, 'should edit to 🧠').toBeGreaterThanOrEqual(1);
    expect(edits[edits.length - 1].body.text).toMatch(/🧠/);
  });

  it('forceClaude session history includes the original quick-answer exchange', { timeout: 20000 }, async () => {
    await chat('подключи weeek');
    const sessionId = readCurrentSession().id;

    await runTask({
      taskId: `t-expand2-${Date.now()}`,
      user: makeUser(),
      task: '',
      context: null,
      sessionId,
      contextFromSession: null,
      forceClaude: true,
      secrets: { BOT_TOKEN: 'fake:token' },
    });

    const sess = readSession(sessionId);
    // Session should have: quick-answer user + quick-answer bot + expand user(same) + claude reply = 4
    expect(sess.messages.length, 'expected 4 messages (quick exchange + Claude turn)').toBe(4);
    const claudeMsg = sess.messages[sess.messages.length - 1];
    expect(claudeMsg.role).toBe('assistant');
  });

  // Replaces «utility commands still have NO button (ping)»: owner requirement #1481 —
  // every ⚡ reply is escalatable. The button points at a side session that stays out of
  // the session index until tapped, then becomes a normal indexed dialog.
  it('utility commands get the escalate button from an unindexed side session (ping)', { timeout: 20000 }, async () => {
    await chat('/ping');
    const sent = tgSent();
    expect(sent.length).toBe(1);
    const btn = sent[0].body.reply_markup?.inline_keyboard?.flat().find(b => /^qa_more\|/.test(b.callback_data));
    expect(btn, 'every ⚡ reply carries «Разобраться подробнее»').toBeTruthy();
    const sideId = btn.callback_data.split('|')[1];
    expect(readSession(sideId)?.sideSession).toBe(true);
    expect(listSessionIndex().some(s => s.id === sideId), 'side session must not enter the index').toBe(false);

    await runTask({
      taskId: `t-expand-ping-${Date.now()}`, user: makeUser(), task: '', context: null,
      sessionId: sideId, contextFromSession: null, forceClaude: true, mode: 'deep',
      secrets: { BOT_TOKEN: 'fake:token' },
    });
    expect(readSession(sideId)?.sideSession).toBeUndefined();
    expect(listSessionIndex().some(s => s.id === sideId), 'escalated side session is a real dialog').toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO 8: real dialogue pattern — выставки/gdrive style
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dialogue: Google Drive file research (like выставки)', () => {

  it('gdrive share prompt → Claude data request: session carries SA email', { timeout: 25000 }, async () => {
    // Simulate: user asks to share a file (quick answer with SA email)
    // then asks Claude to read it
    // Without gdrive token set up, gdrive_share goes to null (no email)
    // So we test the pattern where user sends Claude a real work message first

    await chat('это каталог выставок, хочу собрать данные по участникам', {
      claudeReply: 'Понял задачу. Покажи список выставок — или пришли ссылку на файл.',
    });

    const current = readCurrentSession();
    const sess = readSession(current.id);
    expect(sess.messages.length).toBe(2);
    expect(sess.messages[0].content).toMatch(/выставок/i);

    // User continues — Claude gets prior context
    tgLog = [];
    await chat('вот файл выставки-2026.xlsx, первые 3 — ExpoMos, BuildEx, AgriRu', {
      claudeReply: 'Понял, буду собирать данные: ИНН, ОГРН, директор, выручка, сайт. Начинаю с ExpoMos.',
    });

    const sessAfter = readSession(current.id);
    expect(sessAfter.messages.length, 'expected 4 messages after 2 Claude turns').toBe(4);

    const texts = tgTexts();
    expect(texts[texts.length - 1]).toMatch(/🧠/);
    expect(texts[texts.length - 1]).toMatch(/ExpoMos/);
  });

  it('long dialogue (4 turns) — session accumulates correctly', { timeout: 60000 }, async () => {
    const turns = [
      { msg: 'подключи github', reply: null },   // quick answer
      { msg: 'создай репо train-data', reply: 'Репозиторий train-data создан' },
      { msg: 'добавь README с описанием', reply: 'README.md добавлен в main' },
      { msg: 'создай .gitignore для node', reply: '.gitignore создан' },
    ];

    for (const t of turns) {
      await chat(t.msg, { claudeReply: t.reply });
    }

    const sess = readSession(readCurrentSession().id);
    // quick answer: 2 msgs + 3 Claude turns × 2 = 8 total
    expect(sess.messages.length, 'expected 8 messages across 4 turns').toBe(8);

    const sessionId = readCurrentSession().id;
    expect(sessionId, 'session should stay the same throughout').toBe(readCurrentSession().id);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO: quick-crash self-healing — a crash within QUICK_CRASH_MS of launch
// gets one silent auto-retry before bothering the user; a crash that keeps
// happening surfaces as a real error instead of looping forever.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Quick-crash auto-retry', () => {

  it('crash on first launch auto-retries once and delivers the eventual success', { timeout: 20000 }, async () => {
    setupCrashingClaude(1); // crashes on invocation #1, succeeds from #2 on
    try {
      await chat('сделай штуку', { claudeReply: 'Готово, сделал штуку' });
    } finally {
      restoreNormalClaude();
    }

    const texts = tgTexts();
    expect(texts.some(t => /⚡ Быстрый сбой/.test(t)), 'should show the silent-retry status line').toBe(true);
    expect(texts[texts.length - 1]).toMatch(/Готово, сделал штуку/);
    // Only one retry happened — the crash+retry pair, not a loop.
    expect(readFileSync(join(fakeBinDir, 'crash-counter.txt'), 'utf8').trim()).toBe('2');
  });

  it('crash that keeps happening surfaces as a real error, capped at one retry', { timeout: 20000 }, async () => {
    setupCrashingClaude(5); // would crash 5 times in a row if allowed to keep retrying
    try {
      await chat('сделай штуку');
    } finally {
      restoreNormalClaude();
    }

    const texts = tgTexts();
    expect(texts.some(t => /⚡ Быстрый сбой/.test(t)), 'exactly one retry attempt should show').toBe(true);
    expect(texts[texts.length - 1]).toMatch(/реальный сбой/);
    // Original launch + exactly 1 retry = 2 invocations, no infinite loop.
    expect(readFileSync(join(fakeBinDir, 'crash-counter.txt'), 'utf8').trim()).toBe('2');
  });

  // Voice 2026-09-23 (simplest version, in-memory only — see lastAttemptError in runner/index.js):
  // the retried invocation must tell the agent it's re-running the same task after a crash,
  // not silently repeat the identical prompt as if nothing happened.
  it('retried invocation prompt tells the agent about the previous crash', { timeout: 20000 }, async () => {
    const argsLogFile = join(fakeBinDir, 'crash-args.log');
    setupCrashingClaude(1, 1, { argsLogFile });
    try {
      await chat('сделай штуку', { claudeReply: 'Готово, сделал штуку' });
    } finally {
      restoreNormalClaude();
    }

    const prompts = readFileSync(argsLogFile, 'utf8').split('\n').filter(Boolean)
      .map(line => Buffer.from(line, 'base64').toString('utf8'));
    expect(prompts.length).toBe(2);
    expect(prompts[0]).not.toMatch(/ПРОШЛАЯ ПОПЫТКА/);
    expect(prompts[1]).toMatch(/ПРОШЛАЯ ПОПЫТКА ЭТОЙ ЖЕ ЗАДАЧИ УПАЛА/);
    expect(prompts[1]).toMatch(/быстрый сбой при запуске/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO: general mid-task dead-end (no confirmed final answer, not a crash, not a
// restart) auto-retries with the shared backoff schedule instead of dead-ending
// immediately on "напиши продолжай" — this is the "OpenCode не смог перезапуститься"
// class of complaint: a transient hiccup shouldn't need a human in the loop.
// ═══════════════════════════════════════════════════════════════════════════════

describe('General incomplete auto-retry', () => {

  it('incomplete run auto-retries and delivers the eventual success', { timeout: 20000 }, async () => {
    setupIncompleteClaude(2); // incomplete on invocations #1 and #2, succeeds from #3 on
    try {
      await chat('сделай штуку');
    } finally {
      restoreNormalClaude();
    }

    const texts = tgTexts();
    const retryLines = texts.filter(t => /🔄 Работа прервана.*пробую ещё раз/.test(t));
    expect(retryLines.length, 'two silent retries before success').toBe(2);
    expect(retryLines[0]).toContain('1/3');
    expect(retryLines[1]).toContain('2/3');
    expect(texts[texts.length - 1]).toContain('Готово после ретраев');
    // Original launch + 2 retries = 3 invocations, no give-up message anywhere.
    expect(readFileSync(join(fakeBinDir, 'incomplete-counter.txt'), 'utf8').trim()).toBe('3');
    expect(texts.some(t => t.includes('не помогло'))).toBe(false);
  });

  it('incomplete run that keeps happening gives up after MAX_INCOMPLETE_RETRIES, capped', { timeout: 20000 }, async () => {
    setupIncompleteClaude(99); // would stay incomplete forever if retries weren't bounded
    try {
      await chat('сделай штуку');
    } finally {
      restoreNormalClaude();
    }

    const texts = tgTexts();
    const retryLines = texts.filter(t => /🔄 Работа прервана.*пробую ещё раз/.test(t));
    expect(retryLines.length, 'exactly 3 retries, not a loop').toBe(3);
    expect(texts[texts.length - 1]).toContain('не помогло и после 3 автоматических попыток');
    expect(texts[texts.length - 1]).toContain('продолжай');
    // Original launch + exactly 3 retries = 4 invocations, no infinite loop.
    expect(readFileSync(join(fakeBinDir, 'incomplete-counter.txt'), 'utf8').trim()).toBe('4');
  });

  it('retried invocation prompt tells the agent about the previous incomplete run', { timeout: 20000 }, async () => {
    const argsLogFile = join(fakeBinDir, 'incomplete-args.log');
    setupIncompleteClaude(1, { argsLogFile });
    try {
      await chat('сделай штуку');
    } finally {
      restoreNormalClaude();
    }

    const prompts = readFileSync(argsLogFile, 'utf8').split('\n').filter(Boolean)
      .map(line => Buffer.from(line, 'base64').toString('utf8'));
    expect(prompts.length).toBe(2);
    expect(prompts[0]).not.toMatch(/ПРОШЛАЯ ПОПЫТКА/);
    expect(prompts[1]).toMatch(/ПРОШЛАЯ ПОПЫТКА ЭТОЙ ЖЕ ЗАДАЧИ УПАЛА/);
    expect(prompts[1]).toMatch(/работа прервана/);
  });

});

// Regression: separate text/tool events + deployment SIGTERM used to publish narration as final.
describe('terminal answer delivery', () => {
  function streamScript(events, ending = 'exit 0', trailingNewline = true) {
    const payload = events.map(e => JSON.stringify(e)).join('\n') + (trailingNewline ? '\n' : '');
    writeFileSync(join(fakeBinDir, 'claude'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(payload)}, () => { ${ending === 'signal' ? "process.kill(process.pid, 'SIGTERM')" : `process.exit(${ending === 'exit 143' ? 143 : 0})`}; });\n`);
    chmodSync(join(fakeBinDir, 'claude'), 0o755);
  }
  const narration = 'Секунду, подниму факты о том, что реально было сделано и задеплоено — отвечу по диску, а не по памяти.';
  const text = { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: narration }] } };
  const tool = { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } };
  for (const ending of ['exit 143', 'signal', 'exit 0']) {
    it(`does not report split tool narration as completed after ${ending}`, async () => {
      try {
        streamScript([text, tool], ending);
        await chat('Проверь проект и исправь найденные дефекты');
        const final = tgTexts().at(-1);
        expect(final).toContain('Работа прервана');
        expect(final).not.toContain(narration);
        expect(readSession(readCurrentSession().id).messages.at(-1).content).toContain('Работа прервана');
      } finally { writeNormalClaudeScript(); }
    });
  }
  it('reads the final result even without a trailing newline', async () => {
    try {
      streamScript([text, tool, { type: 'result', subtype: 'success', result: 'Готово: исправление проверено.' }], 'exit 0', false);
      await chat('Проверь проект и исправь найденные дефекты');
      expect(tgTexts().at(-1)).toContain('Готово: исправление проверено.');
      expect(tgTexts().at(-1)).not.toContain(narration);
    } finally { writeNormalClaudeScript(); }
  });
  it('does not treat an error result as successful completion', async () => {
    try {
      streamScript([text, { type: 'result', subtype: 'error_max_turns', is_error: true, result: narration }]);
      await chat('Проверь проект и исправь найденные дефекты');
      expect(tgTexts().at(-1)).toContain('Работа прервана');
      expect(tgTexts().at(-1)).not.toContain(narration);
    } finally { writeNormalClaudeScript(); }
  });
  it('sends a new final message when Telegram rejects editing the old one', async () => {
    tgRespond = (req, res) => {
      if (!req.url.includes('editMessageText')) return false;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 400, description: 'message to edit not found' }));
      return true;
    };
    await chat('Проверь проект и исправь найденные дефекты', { claudeReply: 'Финальный отчёт доставлен' });
    expect(tgSent().at(-1).url).toContain('sendMessage');
    expect(tgTexts().at(-1)).toContain('Финальный отчёт доставлен');
  });
  it('waits for a delayed progress edit before sending the final answer', async () => {
    let progressFinished = false;
    tgRespond = (req, res, body) => {
      if (!req.url.includes('editMessageText')) return false;
      if (body.text.includes('Финальный отчёт')) {
        expect(progressFinished).toBe(true);
        return false;
      }
      setTimeout(() => {
        progressFinished = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 123 } }));
      }, 80);
      return true;
    };
    try {
      streamScript([tool, { type: 'result', subtype: 'success', result: 'Финальный отчёт' }]);
      // Fresh chat id: progress edits coalesce per chat — an edit is skipped if one
      // already landed for that chat <1.2s ago (tg-stream `lastEditAt`). The default
      // test chat id is reused across tests, so its coalesce window can already be
      // open and the event-driven progress edit below would be skipped, leaving
      // nothing in flight to wait for. A unique id guarantees the edit is sent.
      await chat('Проверь проект и исправь найденные дефекты', { userId: 555000123 });
      expect(progressFinished).toBe(true);
      expect(tgTexts().at(-1)).toContain('Финальный отчёт');
    } finally { writeNormalClaudeScript(); }
  });

  for (const completed of [true, false]) {
    it(`requires Codex turn completion (completed=${completed})`, async () => {
      const profiles = require('../src/profiles');
      profiles.setEngine(workDir, 'codex', 111222333);
      process.env.CODEX_BIN = join(fakeBinDir, 'claude');
      try {
        const events = [{ type: 'item.completed', item: { type: 'agent_message', text: 'Ответ Codex' } }];
        if (completed) events.push({ type: 'turn.completed' });
        streamScript(events);
        await chat('Проверь проект и исправь найденные дефекты');
        expect(tgTexts().at(-1)).toContain(completed ? 'Ответ Codex' : 'Работа прервана');
      } finally { delete process.env.CODEX_BIN; writeNormalClaudeScript(); }
    });
  }

});


describe('Completed answers do not authorize speculative continuation', () => {
  it('does not ask an optimistic LLM to schedule more paid work', { timeout: 15000 }, async () => {
    setupFakeClaude('Задеплоил и проверил. Ложная кнопка продолжения пока остаётся отдельной неисправленной проблемой.');
    const requests = [];
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).startsWith('https://openrouter.ai/')) return originalFetch(url, options);
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        plan: false, menu: false, incomplete: true, auto_continue: true, reason: 'still_working',
      }) } }] }) };
    });
    try {
      await runTask({ taskId: `terminal-${Date.now()}`, user: makeUser(), task: 'Исправь обещание запуска',
        forceClaude: true, mode: 'deep', secrets: { BOT_TOKEN: 'fake:token', OPENROUTER_API_KEY: 'fake' } });
      await new Promise(resolve => setImmediate(resolve));
      expect(tgTexts().join(' ')).toContain('Задеплоил и проверил');
      expect(tgTexts().join(' ')).not.toContain('Продолжу через');
      expect(requests.some(r => JSON.stringify(r).includes('auto_continue'))).toBe(false);
      expect(existsSync(join(testDataRoot, 'soft-continuations', `${testUsername}.json`))).toBe(false);
    } finally { spy.mockRestore(); }
  });
});

describe('Originating bot delivery isolation', () => {
  it('routes status, quick and final replies through recruiter credentials, preserving classic replies', { timeout: 20000 }, async () => {
    const secrets = { BOT_TOKEN: 'classic:token', RECRUITER_BOT_TOKEN: 'recruiter:token' };
    for (const [audience, task, token] of [
      ['recruiter', 'сделай задачу', 'recruiter:token'],
      ['recruiter', '/ping', 'recruiter:token'],
      ['default', '/ping', 'classic:token'],
    ]) {
      tgLog = [];
      setupFakeClaude('Ответ 453918');
      await runTask({ taskId: `route-${audience}-${Date.now()}`, user: { ...makeUser(928311457), audience },
        task, forceNew: true, mode: 'deep', initialMsgId: 25, secrets });
      const sent = tgSent();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every(call => call.url.startsWith(`/bot${token}/`))).toBe(true);
      if (task !== '/ping') {
        expect(sent.some(call => call.body.text.includes('Начинаю работу'))).toBe(true);
        expect(sent.some(call => call.body.text.includes('453918'))).toBe(true);
      }
    }
    expect(secrets.BOT_TOKEN).toBe('classic:token');
  });
});


describe('GTD footer is not an assistant menu', () => {
  it('keeps service controls out of both classifiers and produces no recursive menu', { timeout: 15000 }, async () => {
    const user = makeUser();
    const gtd = require('../src/gtd-controller');
    gtd.writeGtd(user.workDir, { sessionId: 'other-open-checklist', status: 'open' });
    const answer = 'Исправил и проверил: уведомления выключены, автопоиск продолжает работать. Все обязательные проверки успешно завершились.';
    setupFakeClaude(answer);
    const inputs = [];
    const originalFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (!String(url).startsWith('https://openrouter.ai/')) return originalFetch(url, options);
      const input = JSON.parse(options.body).messages.find(m => m.role === 'user').content;
      inputs.push(input);
      const footer = input.includes('/checklist_turn_off');
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        plan: false, menu: footer, labels: ['Чеклист активен', 'Отключить чеклист'],
      }) } }] }) };
    });
    try {
      await runTask({ taskId: `footer-${Date.now()}`, user, task: 'Исправь уведомления',
        forceClaude: true, mode: 'deep', secrets: { BOT_TOKEN: 'fake:token', OPENROUTER_API_KEY: 'fake' } });
      expect(inputs.filter(t => t === answer).length).toBe(2);
      expect(inputs.every(t => !t.includes('/checklist_turn_off'))).toBe(true);
      expect(tgTexts().at(-1)).toContain('/checklist_turn_off');
      expect(tgSent().at(-1).body.reply_markup).toEqual({ inline_keyboard: [] });
    } finally { spy.mockRestore(); gtd.clearGtd(user.workDir, 'other-open-checklist'); }
  });
});
