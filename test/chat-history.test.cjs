// Cross-session chat history (get_chat_history + fresh-session prompt block).
// Regression 2026-09-25: get_chat_history applied its limit BEFORE sorting and
// sorted by a formatted ru-RU date string (NaN) → returned the OLDEST sessions of
// the chat and missed the one the user had just finished. Also: no time window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ch = require('../src/chat-history.js');

const H = 3600_000;
const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const CHAT = '-5578467476';

function mkUser() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hist-'));
  const dir = path.join(root, 'u1', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// Session ids embed creation ms → readdir order == oldest first, like prod.
function writeSession(dir, { id, chat = CHAT, lastAgoH, msgs }) {
  const lastAt = NOW - lastAgoH * H;
  const messages = msgs.map((text, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: text, at: lastAt - (msgs.length - 1 - i) * 60_000,
  }));
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, topic: id, createdAt: lastAt - H, lastAt, liveChatId: chat, messages,
  }));
}

function seed(dir) {
  writeSession(dir, { id: 's-5578467476-1000', lastAgoH: 72, msgs: ['old1', 'old1r'] });
  writeSession(dir, { id: 's-5578467476-2000', lastAgoH: 48, msgs: ['old2', 'old2r'] });
  writeSession(dir, { id: 's-5578467476-3000', lastAgoH: 30, msgs: ['old3', 'old3r'] });
  writeSession(dir, { id: 's-5578467476-4000', lastAgoH: 3.3, msgs: ['та задача', 'готово, PR смержен'] });
  writeSession(dir, { id: 's-5578467476-5000', lastAgoH: 0, msgs: ['новая тема'] }); // current
  writeSession(dir, { id: 's-999-4500', chat: '-999', lastAgoH: 1, msgs: ['чужой чат'] });
  // Pointer file, as in prod: must be ignored, not crash.
  fs.writeFileSync(path.join(dir, `current-session--5578467476.json`), JSON.stringify({ sessionId: 's-5578467476-5000' }));
  fs.writeFileSync(path.join(dir, `broken.json`), '{not json');
}

test('most-recent sessions first; limit applied after sort (the prod bug)', () => {
  const { dir } = mkUser(); seed(dir);
  const got = ch.chatSessions(dir, CHAT, { sessionsLimit: 3, excludeSessionId: 's-5578467476-5000', now: NOW });
  assert.deepStrictEqual(got.map(s => s.id), ['s-5578467476-4000', 's-5578467476-3000', 's-5578467476-2000']);
});

test('since_hours window: 6h → only the just-finished session', () => {
  const { dir } = mkUser(); seed(dir);
  const got = ch.chatSessions(dir, CHAT, { sinceHours: 6, excludeSessionId: 's-5578467476-5000', now: NOW });
  assert.deepStrictEqual(got.map(s => s.id), ['s-5578467476-4000']);
  const day = ch.chatSessions(dir, CHAT, { sinceHours: 24, excludeSessionId: 's-5578467476-5000', now: NOW });
  assert.deepStrictEqual(day.map(s => s.id), ['s-5578467476-4000']);
  const d2 = ch.chatSessions(dir, CHAT, { sinceHours: 36, excludeSessionId: 's-5578467476-5000', now: NOW });
  assert.deepStrictEqual(d2.map(s => s.id), ['s-5578467476-4000', 's-5578467476-3000']);
});

test('chat isolation + pointer/broken files ignored', () => {
  const { dir } = mkUser(); seed(dir);
  const all = ch.chatSessions(dir, CHAT, { sessionsLimit: 20, now: NOW });
  assert.strictEqual(all.length, 5);
  assert.ok(all.every(s => s.id.startsWith('s-5578467476-')));
  assert.deepStrictEqual(ch.chatSessions(dir, '-999', { now: NOW }).map(s => s.id), ['s-999-4500']);
});

test('recentChatMessages: chronological across sessions', () => {
  const { dir } = mkUser(); seed(dir);
  const msgs = ch.recentChatMessages(dir, CHAT, { sinceHours: 24, limit: 10, now: NOW });
  assert.deepStrictEqual(msgs.map(m => m.content), ['та задача', 'готово, PR смержен', 'новая тема']);
});

test('fresh-session prompt block carries the previous task, excludes current, empty when nothing recent', () => {
  const { dir } = mkUser(); seed(dir);
  const block = ch.buildRecentChatBlock(dir, CHAT, { excludeSessionId: 's-5578467476-5000', now: NOW });
  assert.match(block, /НЕДАВНЯЯ ИСТОРИЯ ЭТОГО ЧАТА/);
  assert.match(block, /та задача/);
  assert.match(block, /get_chat_history/);
  assert.doesNotMatch(block, /новая тема/);
  assert.doesNotMatch(block, /чужой чат|old1/);
  assert.strictEqual(ch.buildRecentChatBlock(dir, '-12345', { now: NOW }), '');
});

test('MCP get_chat_history handler: registered, recency order, since_hours', async () => {
  const { root, dir } = mkUser();
  // Real timestamps for the handler (it uses Date.now()).
  const realNow = Date.now();
  const w = (id, agoH, text) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, topic: id, createdAt: realNow - agoH * H, lastAt: realNow - agoH * H, liveChatId: CHAT,
    messages: [{ role: 'user', content: text, at: realNow - agoH * H }],
  }));
  w('s-5578467476-1000', 72, 'old1'); w('s-5578467476-2000', 48, 'old2'); w('s-5578467476-3000', 30, 'old3');
  w('s-5578467476-4000', 3, 'та задача'); w('s-5578467476-5000', 0, 'новая тема');

  const dp = require('../src/data-paths.js');
  const orig = dp.sessionsDirPath;
  dp.sessionsDirPath = () => dir; // tool reads through data-paths
  process.env.AGENT_USER_ID = 'u1';
  process.env.AGENT_SESSION_FILE = path.join(dir, 's-5578467476-5000.json');
  try {
    delete require.cache[require.resolve('../src/mcp-skills/tools/02-chat-history.js')];
    const mod = require('../src/mcp-skills/tools/02-chat-history.js');
    const tool = mod.tools.get_chat_history;
    assert.ok(tool.inputSchema.properties.since_hours, 'since_hours param exposed');
    const r = await tool.handler({ sessions_limit: 2 });
    assert.deepStrictEqual(r.sessions.map(s => s.session_id), ['s-5578467476-4000', 's-5578467476-3000']);
    const r6 = await tool.handler({ since_hours: 6 });
    assert.deepStrictEqual(r6.sessions.map(s => s.session_id), ['s-5578467476-4000']);
    const rc = await tool.handler({ since_hours: 6, include_current: true });
    assert.deepStrictEqual(rc.sessions.map(s => s.session_id), ['s-5578467476-5000', 's-5578467476-4000']);
  } finally {
    dp.sessionsDirPath = orig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new session can retrieve a prior persisted exchange through the MCP handler', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-e2e-'));
  const workDir = path.join(root, 'u1');
  const dir = path.join(workDir, 'sessions');
  const store = require('../src/session-store.js');
  const dataPaths = require('../src/data-paths.js');
  const originalSessionsDirPath = dataPaths.sessionsDirPath;
  const originalUserId = process.env.AGENT_USER_ID;
  const originalSessionFile = process.env.AGENT_SESSION_FILE;
  const previousSessionId = `s-${CHAT}-history-e2e-previous`;
  const currentSessionId = `s-${CHAT}-history-e2e-current`;
  const fact = `remember-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  fs.mkdirSync(dir, { recursive: true });
  dataPaths.sessionsDirPath = () => dir;
  process.env.AGENT_USER_ID = 'u1';
  try {
    store.createSession(workDir, {
      id: previousSessionId,
      task: `For this test, the code phrase is ${fact}`,
      chatId: CHAT,
    });
    store.appendReply(workDir, previousSessionId, `I will remember ${fact}.`);
    store.createSession(workDir, {
      id: currentSessionId,
      task: 'What code phrase did I mention earlier?',
      chatId: CHAT,
    });

    process.env.AGENT_SESSION_FILE = path.join(dir, `${currentSessionId}.json`);
    delete require.cache[require.resolve('../src/mcp-skills/tools/02-chat-history.js')];
    const tool = require('../src/mcp-skills/tools/02-chat-history.js').tools.get_chat_history;
    const result = await tool.handler({});

    assert.deepStrictEqual(result.sessions.map(session => session.session_id), [previousSessionId]);
    assert.deepStrictEqual(result.sessions[0].messages.map(message => message.text), [
      `For this test, the code phrase is ${fact}`,
      `I will remember ${fact}.`,
    ]);
    assert.ok(result.sessions[0].messages.every(message => message.at), 'messages include timestamps');
  } finally {
    dataPaths.sessionsDirPath = originalSessionsDirPath;
    if (originalUserId === undefined) delete process.env.AGENT_USER_ID;
    else process.env.AGENT_USER_ID = originalUserId;
    if (originalSessionFile === undefined) delete process.env.AGENT_SESSION_FILE;
    else process.env.AGENT_SESSION_FILE = originalSessionFile;
    delete require.cache[require.resolve('../src/mcp-skills/tools/02-chat-history.js')];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history tools are exposed by the MCP tool loader', () => {
  const names = new Set();
  const dir = path.join(__dirname, '..', 'src', 'mcp-skills', 'tools');
  for (const f of fs.readdirSync(dir).filter(f => /^(01|02|05)-.*\.js$/.test(f))) {
    Object.keys(require(path.join(dir, f)).tools || {}).forEach(n => names.add(n));
  }
  for (const n of ['get_chat_history', 'last_messages', 'load_full_context', 'session_search']) {
    assert.ok(names.has(n), `missing MCP tool ${n}`);
  }
});

test('runner wires the recent-chat block for fresh sessions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'index.js'), 'utf8');
  assert.match(src, /require\('\.\.\/chat-history'\)\.buildRecentChatBlock\(/);
  assert.match(src, /if \(!sessionExists && !contextFromSession && chatId && !webExactSession\)/);
});
