'use strict';
// Owner rule 2026-09-26: no quick answer is ever empty, every ⚡ reply can be escalated to
// the agent, and no MCP tool call hands the model an empty result.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Never touch the VM-wide OpenCode toggle from a test.
process.env.OPENCODE_GO_MODE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-go-')), 'go-mode.json');

const { isEmptyQuickReply, nonEmptyQuickReply, recordQuickExchange, quickExchangeSessionId, escalateRows } = require('../src/quick-reply');
const { isEmptyToolResult, toolResultText } = require('../src/mcp-tool-result');
const sessions = require('../src/session-store');
const ROOT = path.join(__dirname, '..');

test('empty quick replies are suppressed, real ones pass through', () => {
  for (const r of ['', '   ', '\n', { __connectLink: true, hint: '' }]) {
    assert.equal(isEmptyQuickReply(r), true, JSON.stringify(r));
    assert.equal(nonEmptyQuickReply(r, '/x'), null, JSON.stringify(r));
  }
  assert.equal(nonEmptyQuickReply(null, '/x'), null);
  assert.equal(nonEmptyQuickReply('🟢 Онлайн', '/ping'), '🟢 Онлайн');
  const link = { __connectLink: true, service: 'github', hint: 'нужен GitHub' };
  assert.equal(nonEmptyQuickReply(link, 'dev'), link);
});

test('exported quick-answer entry points are the guarded wrappers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/runner/intent-engine.js'), 'utf8');
  const exportsBlock = src.slice(src.lastIndexOf('module.exports = {'));
  assert.doesNotMatch(exportsBlock, /Unchecked/, 'raw quick-answer functions must not be exported');
  assert.match(src, /function getQuickAnswer\(task, \.\.\.rest\) \{\n\s+return nonEmptyQuickReply\(/);
  assert.match(src, /async function runQuickAnswer\(task, \.\.\.rest\) \{\n\s+return nonEmptyQuickReply\(/);
});

test('built-in quick commands all answer with real text', () => {
  const { getQuickAnswer } = require('../src/runner/intent-engine');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cmds-'));
  for (const cmd of ['/ping', '/help', '/agent_info', '/settings', '/secrets_list', '/secrets_log', '/usage', '/sessions', '/project']) {
    const r = getQuickAnswer(cmd, 'qatest', workDir, false, 1, null, 'default', null);
    assert.equal(typeof r, 'string', cmd);
    assert.ok(r.trim().length > 0, `${cmd} returned an empty quick answer`);
  }
});

test('utility quick replies get an escalation side session, chat session untouched', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-esc-'));
  const opts = { username: 'u', chatId: 42, threadId: null, audience: 'default', task: '/help', reply: '🤖 Что я умею' };
  const id = recordQuickExchange(workDir, opts);
  assert.equal(id, quickExchangeSessionId('u', 42, null, '/help'));
  assert.equal(recordQuickExchange(workDir, { ...opts, reply: 'ещё раз' }), id, 'repeat reuses the side session');
  const s = sessions.getSession(workDir, id);
  assert.equal(s.messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(sessions.getCurrentSessionId(workDir, 42, 'default', null), null, 'must not hijack the chat session');
  assert.deepEqual(escalateRows(id), [[{ text: '🔎 Разобраться подробнее', callback_data: `qa_more|${id}` }]]);
  assert.ok(Buffer.byteLength(`qa_more|${id}`) <= 64, 'Telegram callback_data limit');
  assert.equal(recordQuickExchange(workDir, { ...opts, reply: '  ' }), null);
});

test('both ⚡ delivery paths attach the escalation button', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/runner/index.js'), 'utf8');
  const pre = src.slice(src.indexOf('pre-queue quick-answer len='), src.indexOf("if (!Object.hasOwn(opts, 'activitySessionId'))"));
  assert.match(pre, /escalateRows\(qaSessionId\)/);
  assert.doesNotMatch(pre, /tgEdit\([^)]*msg, \{\}\)/, 'pre-queue reply must not be sent without markup');
  const normal = src.slice(src.indexOf("quick-answer len=%d', taskId"), src.indexOf('// Claude path — finalize session'));
  assert.match(normal, /escalateRows\(escalateSessionId\)/);
});

test('empty MCP tool results become an explicit notice', () => {
  for (const r of [undefined, null, '', '  ', [], {}]) {
    assert.equal(isEmptyToolResult(r), true, JSON.stringify(r));
    assert.match(toolResultText('t', r), /вернул пустой результат/);
  }
  assert.equal(toolResultText('t', 'ok'), 'ok');
  assert.equal(toolResultText('t', { a: 1 }, { pretty: false }), '{"a":1}');
  for (const f of ['src/mcp-skills/index.js', 'scripts/mcp-provider-adapter.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /toolResultText\(/, `${f} must route tools/call through toolResultText`);
  }
});

test('trained-skills MCP server never answers tools/call with empty text', async () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tools-'));
  fs.writeFileSync(path.join(toolsDir, 'empty.js'), "module.exports = { tools: { empty_tool: { description: 'x', handler: async () => undefined } } };");
  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp-skills/index.js')], { env: { ...process.env, TOOLS_DIR: toolsDir }, stdio: ['pipe', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; if (buf.includes('\n')) resolve(buf.split('\n')[0]); });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'empty_tool', arguments: {} } }) + '\n');
  });
  child.kill();
  const text = JSON.parse(line).result.content[0].text;
  assert.match(text, /empty_tool вернул пустой результат/);
});
