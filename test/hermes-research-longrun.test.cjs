'use strict';
// hermes_web_research hotfix (2026-09-27): research runs take 1–10 min, and died on
// engine limits — opencode's 60s MCP tool timeout (11/11 failures), and the
// runner's 5-min inactivity kill while a tool call is pending. Plus the result
// was lost if the calling session died. These tests pin the three fixes:
// (1) engines get a long MCP tool timeout, (2) a per-run keepalive file lets a
// slow tool prove liveness, (3) the result is saved to disk + sent to Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Hermetic keepalive dir (#1791): the default lives under the service data dir; a
// test must never touch a path shared with the service or other runs.
process.env.AGENT_KEEPALIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-keepalive-'));

const { writeOpencodeMcpConfig, codexMcpArgs, runEngineProcess, _const } = require('../src/runner/claude-runner');
const { keepaliveDir, keepaliveFilePath, lastKeepaliveAt, withKeepalive, sweepKeepalive } = require('../src/mcp-keepalive');
const { persistAndDeliver, researchDir } = require('../src/hermes-delivery');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-longrun-'));

function mcpFixture(dir) {
  const p = path.join(dir, '.mcp.json');
  fs.writeFileSync(p, JSON.stringify({ mcpServers: { 'trained-skills': { command: 'node', args: ['srv.js'] } } }));
  return p;
}

test('opencode config: MCP tool calls get the long timeout, profile experimental keys survive', () => {
  const dir = tmp();
  const cfg = JSON.parse(fs.readFileSync(writeOpencodeMcpConfig(dir, mcpFixture(dir), { model: 'm', experimental: { foo: 1 } }), 'utf8'));
  assert.equal(cfg.experimental.mcp_timeout, _const.MCP_TOOL_TIMEOUT_MS);
  assert.equal(cfg.experimental.foo, 1);
  assert.equal(cfg.mcp['trained-skills'].timeout, _const.MCP_TOOL_TIMEOUT_MS);
  assert.ok(_const.MCP_TOOL_TIMEOUT_MS >= 10 * 60 * 1000, 'ceiling covers a 10-min research run');
});

test('codex args: per-server tool_timeout_sec is set', () => {
  const dir = tmp();
  const args = codexMcpArgs(mcpFixture(dir));
  assert.ok(args.includes(`mcp_servers.trained-skills.tool_timeout_sec=${_const.MCP_TOOL_TIMEOUT_MS / 1000}`));
});

test('runner hands the engine AGENT_KEEPALIVE_FILE / AGENT_THREAD_ID / MCP_TOOL_TIMEOUT and cleans the file up', async () => {
  const dir = tmp();
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const e = process.env;
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'env.json'))}, JSON.stringify({ k: e.AGENT_KEEPALIVE_FILE, t: e.AGENT_THREAD_ID, m: e.MCP_TOOL_TIMEOUT }));
require('fs').mkdirSync(require('path').dirname(e.AGENT_KEEPALIVE_FILE), { recursive: true });
require('fs').writeFileSync(e.AGENT_KEEPALIVE_FILE, '');
console.log(JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  fs.chmodSync(bin, 0o755);
  const r = await runEngineProcess({
    engine: 'claude', taskId: 't-keepalive', chatId: '42', thinkingStart: Date.now(), threadId: 7,
    msgId: null, BOT_TOKEN: 'tok', secrets: {}, user: { username: 'u', workDir: dir, name: 'U' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: bin, engineArgs: [], cwd: dir,
  });
  assert.equal(r.terminalSuccess, true);
  const env = JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8'));
  assert.equal(env.k, keepaliveFilePath('t-keepalive'));
  assert.equal(env.t, '7');
  assert.equal(Number(env.m), _const.MCP_TOOL_TIMEOUT_MS);
  assert.equal(fs.existsSync(env.k), false, 'keepalive file removed after the run');
});

test('withKeepalive touches the file while the tool runs and is a no-op without the env', async () => {
  const file = path.join(tmp(), 'ka');
  assert.equal(lastKeepaliveAt(file), 0);
  const out = await withKeepalive(async () => { assert.ok(lastKeepaliveAt(file) > Date.now() - 5000); return 42; }, file);
  assert.equal(out, 42);
  assert.equal(await withKeepalive(async () => 'x', ''), 'x');
});

test('keepalive dir: service data dir by default (never the shared /tmp), private, swept of day-old files', async () => {
  const saved = { d: process.env.AGENT_KEEPALIVE_DIR, a: process.env.AGENT_DATA_DIR };
  try {
    delete process.env.AGENT_KEEPALIVE_DIR;
    process.env.AGENT_DATA_DIR = '/srv/agent-data';
    assert.equal(keepaliveDir(), '/srv/agent-data/agent-keepalive');
    assert.equal(keepaliveFilePath('a/b'), '/srv/agent-data/agent-keepalive/a_b');
  } finally {
    process.env.AGENT_KEEPALIVE_DIR = saved.d;
    if (saved.a === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = saved.a;
  }
  const dir = path.join(tmp(), 'ka');
  await withKeepalive(async () => {}, path.join(dir, 'fresh'));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(dir, 'old'), '');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(path.join(dir, 'old'), old, old);
  assert.equal(sweepKeepalive(dir), 1);
  assert.deepEqual(fs.readdirSync(dir), ['fresh']);
  assert.equal(sweepKeepalive(path.join(dir, 'missing')), 0);
});

test('keepalive: a touch that cannot write is logged once per file, never thrown', async () => {
  const blocker = path.join(tmp(), 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const file = path.join(blocker, 'ka');
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    await withKeepalive(async () => {}, file);
    await withKeepalive(async () => {}, file);
  } finally { console.warn = orig; }
  assert.equal(warns.filter(w => w.includes(file)).length, 1, warns.join('\n'));
});

function fakeFetch(calls, ok = true) {
  return async (url, init) => {
    const fields = {};
    for (const [k, v] of init.body.entries()) fields[k] = typeof v === 'string' ? v : `<blob ${v.size}>`;
    calls.push({ method: url.split('/').pop(), fields });
    return { status: ok ? 200 : 400, json: async () => (ok ? { ok: true, result: {} } : { ok: false, description: 'chat not found' }) };
  };
}

test('result is saved to disk and sent to the originating Telegram topic', async () => {
  const dir = tmp(); const calls = [];
  const target = { token: 'tok', chatId: '123', threadId: 9 };
  const r = await persistAndDeliver({ task: 'Найди X', result: { answer: 'да' }, target, fetchImpl: fakeFetch(calls), dir });
  assert.equal(r.delivered, true);
  assert.ok(fs.readFileSync(r.saved_to, 'utf8').includes('"answer": "да"'));
  assert.ok(fs.existsSync(r.saved_to.replace(/\.md$/, '.json')));
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].fields.chat_id, '123');
  assert.equal(calls[0].fields.message_thread_id, '9');
  assert.ok(calls[0].fields.text.includes('Найди X'));
});

test('long result goes as a document; Telegram failure never throws; web run is file-only', async () => {
  const dir = tmp(); const calls = [];
  const target = { token: 'tok', chatId: '123', threadId: null };
  const big = { text: 'я'.repeat(5000) };
  const r1 = await persistAndDeliver({ task: 't', result: big, target, fetchImpl: fakeFetch(calls), dir });
  assert.equal(r1.delivered, true);
  assert.equal(calls[0].method, 'sendDocument');
  assert.equal(calls[0].fields.message_thread_id, undefined);

  const r2 = await persistAndDeliver({ task: 't', result: { a: 1 }, target, fetchImpl: fakeFetch([], false), dir });
  assert.equal(r2.delivered, false);
  assert.match(r2.reason, /chat not found/);
  assert.ok(r2.saved_to, 'file still saved when Telegram fails');

  const r3 = await persistAndDeliver({ task: 't', result: { a: 1 }, target: null, fetchImpl: fakeFetch(calls), dir });
  assert.equal(r3.delivered, false, 'no chat target → file only');
  assert.ok(r3.saved_to);
});

test('chat target: web runs (chat id 0) and headless runs are never sent to Telegram', () => {
  const { spawnSync } = require('node:child_process');
  const probe = (env) => JSON.parse(spawnSync(process.execPath, ['-e',
    "console.log(JSON.stringify(require('./src/mcp-skills/tools/94-tg-send').chatTarget()))"],
    { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout);
  assert.equal(probe({ AGENT_BOT_TOKEN: 'tok', AGENT_CHAT_ID: '0' }), null);
  assert.equal(probe({ AGENT_BOT_TOKEN: '', AGENT_CHAT_ID: '5' }), null);
  assert.deepEqual(probe({ AGENT_BOT_TOKEN: 'tok', AGENT_CHAT_ID: '5', AGENT_THREAD_ID: '3' }), { token: 'tok', chatId: '5', threadId: 3 });
});

test('research never lands inside a git checkout', () => {
  const dir = tmp();
  assert.equal(researchDir({ cwd: dir, username: 'u' }), path.join(dir, 'research'));
  fs.mkdirSync(path.join(dir, '.git'));
  assert.equal(researchDir({ cwd: dir, username: 'u' }), path.join(os.homedir(), 'agent-tokens', 'u', 'hermes-research'));
});
