// Quiet-mode group history (tg-bot src/group-history.js) reaches the agent once per
// message; the next run doesn't repeat it. The agent keeps what was delivered so the
// get_group_history MCP tool still shows earlier messages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-hist-'));
process.env.USERS_DIR = root;
const store = require('../src/group-history-store.js');
const chatTools = require('../src/mcp-skills/tools/02-chat-history.js');
const tool = chatTools.tools.get_group_history;
const fileTool = chatTools.tools.get_group_file;

const NOW = Date.now();
const CHAT = -100500;
const e = (id, seq, text, agoMin = 1) => ({ id, seq, ts: NOW - agoMin * 60_000, from: 'Петя (@petya)', text });

function sessionFile(chat, threadId) {
  const fp = path.join(root, `sess-${chat}-${threadId ?? 'x'}.json`);
  fs.writeFileSync(fp, JSON.stringify({ id: 's1', liveChatId: String(chat), ...(threadId != null ? { messageThreadId: threadId } : {}), messages: [] }));
  return fp;
}

test('batches delivered by consecutive runs accumulate; replays dedup', () => {
  assert.strictEqual(store.appendGroupHistory('u1', CHAT, null, [e(1, 1, 'первое'), e(2, 2, 'второе')], NOW), 2);
  assert.strictEqual(store.appendGroupHistory('u1', CHAT, null, [e(2, 2, 'второе')], NOW), 0); // outbox retry
  assert.strictEqual(store.appendGroupHistory('u1', CHAT, null, [e(3, 3, 'третье')], NOW), 1);
  assert.deepStrictEqual(store.readGroupHistory('u1', CHAT, null, { now: NOW }).map(x => x.text), ['первое', 'второе', 'третье']);
});

test('private chats, junk and old entries are not kept', () => {
  assert.strictEqual(store.appendGroupHistory('u1', 777, null, [e(1, 1, 'x')], NOW), 0);
  assert.strictEqual(store.appendGroupHistory('u1', CHAT, 9, [{ text: '' }, null, { ts: 'x', text: 'y' }], NOW), 0);
  store.appendGroupHistory('u1', CHAT, 9, [e(5, 1, 'старьё', 8 * 24 * 60), e(6, 2, 'свежее')], NOW);
  assert.deepStrictEqual(store.readGroupHistory('u1', CHAT, 9, { now: NOW }).map(x => x.text), ['свежее']);
});

test('get_group_history returns the current chat/topic, filters by since_hours', async () => {
  store.appendGroupHistory('u2', CHAT, null, [e(9, 0, 'вчера', 20 * 60), e(10, 1, 'утром', 300), e(11, 2, 'только что')], NOW);
  store.appendGroupHistory('u2', CHAT, 7, [e(12, 1, 'в теме 7')], NOW);
  process.env.AGENT_USER_ID = 'u2';

  process.env.AGENT_SESSION_FILE = sessionFile(CHAT, null);
  let r = await tool.handler({}); // default window = last 6 hours
  assert.deepStrictEqual(r.messages.map(m => m.text), ['утром', 'только что']);
  assert.strictEqual(r.since_hours, 6);
  r = await tool.handler({ since_hours: 24 });
  assert.deepStrictEqual(r.messages.map(m => m.text), ['вчера', 'утром', 'только что']);
  r = await tool.handler({ since_hours: 1 });
  assert.deepStrictEqual(r.messages.map(m => m.text), ['только что']);

  process.env.AGENT_SESSION_FILE = sessionFile(CHAT, 7);
  r = await tool.handler({});
  assert.deepStrictEqual(r.messages.map(m => m.text), ['в теме 7']);

  process.env.AGENT_SESSION_FILE = sessionFile(555, null);
  r = await tool.handler({});
  assert.strictEqual(r.total, 0);
});

test('ambient file handle is kept and get_group_file downloads it with the run bot token', async () => {
  const doc = { ...e(5095, 4, '[файл pool.xlsx] пул'), file: { kind: 'document', fileId: 'BQAC-1', name: 'pool.xlsx', mime: 'application/xlsx', size: 5 } };
  store.appendGroupHistory('u3', CHAT, 4668, [e(5087, 1, '[файл old.xlsx] старый'), doc], NOW);
  process.env.AGENT_USER_ID = 'u3';
  process.env.AGENT_SESSION_FILE = sessionFile(CHAT, 4668);

  const listed = await tool.handler({});
  const m = listed.messages.find(x => x.message_id === 5095);
  assert.strictEqual(m.file.download, 'get_group_file(message_id=5095)');

  // Old entry (recorded before handles were kept) → clear «re-send» answer, not a crash.
  const old = await fileTool.handler({ message_id: 5087 });
  assert.match(old.error, /no downloadable file handle/);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'documents/file_1.xlsx' } }) };
    return { ok: true, arrayBuffer: async () => Buffer.from('hello') };
  };
  const out = await chatTools._test.downloadTelegramFile({ username: 'u3', file: doc.file, token: 'freelance-bot', fetchImpl });
  assert.ok(out.ok, JSON.stringify(out));
  assert.strictEqual(fs.readFileSync(out.file_path, 'utf8'), 'hello');
  assert.ok(out.file_path.startsWith(path.join(root, 'u3', 'media', 'intake') + path.sep));
  assert.ok(calls[0].includes('/botfreelance-bot/getFile?file_id=BQAC-1'));
  assert.ok(calls[1].endsWith('/file/botfreelance-bot/documents/file_1.xlsx'));

  const big = await chatTools._test.downloadTelegramFile({ username: 'u3', file: { ...doc.file, size: 30 * 1048576 }, token: 't', fetchImpl });
  assert.match(big.error, /20 МБ/);
  const noTok = await chatTools._test.downloadTelegramFile({ username: 'u3', file: doc.file, token: '', fetchImpl });
  assert.match(noTok.error, /AGENT_BOT_TOKEN/);
});
