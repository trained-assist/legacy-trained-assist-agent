'use strict';
// Sandbox for issue #1893 / plan 1cb1e1f9 — scenarios DL-10…DL-14 end-to-end
// through the real blocks, no network, no human:
//   DL-14  GET /web/session/:id/trace answers 200 (route order vs generic /web/session/:id)
//   DL-12  runner stream → durable store (src/session-trace-store.js) → readTrace
//          falls back to it when the engine db is missing / was recreated
//   DL-13  resume appends to the same file, duplicate part ids collapse
//   DL-10  empty session → «Лог недоступен», zero LLM calls, nothing cached
//   DL-11  non-empty session → deterministic facts (files, URLs, repos, commands,
//          publications) without an LLM verdict about the session
// Run: scripts/sandbox/session-logs.sh  (~5 s)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.OPENCODE_DB_PATH;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-logs-sandbox-'));
process.env.HOME = ROOT;
process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
process.env.USERS_DIR = path.join(ROOT, 'users');

// web-routes pulls the whole runner in; the trace/digest routes never touch it.
const runnerPath = require.resolve('../src/runner');
require.cache[runnerPath] = {
  id: runnerPath, filename: runnerPath, loaded: true,
  exports: { isTaskRunning: () => false, isSessionRunning: () => false, isSessionQueuedFor: () => false, runTask: async () => {}, stopSessionTask: () => ({ ok: false }) },
};

const { userWorkDir } = require('../src/data-paths');
const T0 = Date.UTC(2026, 8, 29, 10, 0, 0);
const MIN = 60 * 1000;

function writeSession(user, id, sess) {
  const wd = userWorkDir(user);
  fs.mkdirSync(path.join(wd, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(wd, 'sessions', `${id}.json`), JSON.stringify({ id, ...sess }));
  return wd;
}

function traceStore() {
  try { return require('../src/session-trace-store'); }
  catch (e) { assert.fail(`durable trace store missing: ${e.message}`); }
}

// opencode stream parts as the runner receives them (event.part)
const ocTool = (id, tool, input, output, at) => ({ id, type: 'tool', tool, state: { status: 'completed', input, output, time: { start: at, end: at + 1000 } } });
const PARTS = [
  { id: 'p1', type: 'step-start', time: { created: T0 } },
  ocTool('p2', 'read', { filePath: '/home/u/projects/x/brief.md' }, 'brief', T0 + MIN),
  ocTool('p3', 'webfetch', { url: 'https://checko.ru/company/romashka' }, 'ИНН 7701234567', T0 + 5 * MIN),
  ocTool('p4', 'bash', { command: 'git push origin eng/x && gh pr create --repo trained-assist/trained-assist-agent' }, 'https://github.com/trained-assist/trained-assist-agent/pull/1900', T0 + 10 * MIN),
  ocTool('p5', 'trained-skills_publish_page', { slug: 'report-x', title: 'Отчёт' }, '{"url":"https://pages.trainedassist.store/report-x"}', T0 + 15 * MIN),
  { id: 'p6', type: 'text', text: 'Готово: отчёт опубликован.', time: { created: T0 + 16 * MIN } },
  { id: 'p7', type: 'step-finish', reason: 'stop', time: { created: T0 + 16 * MIN } },
];

// ── DL-14 ───────────────────────────────────────────────────────────────────
test('DL-14: GET /web/session/:id/trace is routed to the trace handler (200, not 400)', async () => {
  process.env.WEB_JWT_SECRET = 'sandbox-secret';
  const { signJwt } = require('../src/web-auth');
  const { handleWebRoute } = require('../src/web-routes');
  writeSession('carol', 's_route', { engineSessions: { opencode: 'ses_none' }, messages: [] });
  const token = signJwt('carol', 'sandbox-secret');
  const req = { method: 'GET', headers: { cookie: `web_token=${token}` } };
  let status = null, body = null;
  const res = {
    writeHead(s) { status = s; return this; }, setHeader() {},
    end(b) { body = b; },
  };
  const url = new URL('http://x/web/session/s_route/trace');
  await handleWebRoute(req, url, res, { WEB_JWT_SECRET: 'sandbox-secret' });
  assert.equal(status, 200, `trace route answered ${status}: ${body}`);
});

// ── DL-12 / DL-13: durable store + readTrace fallback ───────────────────────
test('DL-12: runner persists stream parts; readTrace falls back to the store when the engine db is gone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'claude-runner.js'), 'utf8');
  assert.match(src, /session-trace-store/, 'runner writes streamed opencode parts into the durable store');

  const store = traceStore();
  const wd = writeSession('dave', 's_store', { engineSessions: { opencode: 'ses_store' }, messages: [
    { role: 'user', content: 'Разбери клиента Ромашка и опубликуй отчёт', at: T0 - MIN },
    { role: 'assistant', content: 'Готово: отчёт опубликован.', at: T0 + 17 * MIN },
  ] });
  for (const p of PARTS) assert.equal(store.appendEvent(wd, 'opencode', 'ses_store', p, { taskId: 't1' }), true);

  process.env.OPENCODE_DB_PATH = path.join(ROOT, 'no-such', 'opencode.db'); // engine db rotated away
  try {
    const { readTrace } = require('../src/session-trace');
    const { getSession } = require('../src/session-store');
    const r = readTrace(wd, getSession(wd, 's_store'));
    assert.equal(r.ok, true, `readTrace: ${r.error}`);
    assert.equal(r.source, 'store');
    assert.equal(r.events.filter(e => e.kind === 'tool').length, 4);
  } finally { delete process.env.OPENCODE_DB_PATH; }
});

test('DL-13: a resumed run appends to the same file; duplicate part ids collapse', () => {
  const store = traceStore();
  const wd = userWorkDir('erin');
  for (const p of PARTS.slice(0, 4)) store.appendEvent(wd, 'opencode', 'ses_r', p, { taskId: 't1' });
  for (const p of PARTS.slice(3)) store.appendEvent(wd, 'opencode', 'ses_r', p, { taskId: 't2' }); // p4 re-sent
  const r = store.readEvents(wd, 'opencode', 'ses_r');
  assert.equal(r.found, true);
  assert.equal(r.events.length, PARTS.length, 'one event per part id');
  const files = fs.readdirSync(path.join(wd, '.session-traces'));
  assert.equal(files.length, 1, 'one file per engine session');
});

// ── DL-10 / DL-11: honest digest ────────────────────────────────────────────
test('DL-10: empty session → «Лог недоступен», zero LLM calls, no cache', async () => {
  const { getDigestFor } = require('../src/session-digest');
  const wd = writeSession('frank', 's_empty', { engineSessions: { opencode: 'ses_empty' }, messages: [
    { role: 'user', content: 'привет', at: T0 },
  ] });
  let calls = 0;
  const llm = async () => { calls++; return '{"activities":[],"summary":"Сессия фактически не состоялась."}'; };
  const r = await getDigestFor('frank', 's_empty', { llm });
  assert.equal(r.ok, true);
  assert.equal(calls, 0, 'no LLM call on empty data');
  assert.equal(r.empty, true);
  assert.equal(r.message, 'Лог недоступен');
  assert.equal(r.summary, null, 'no invented verdict');
  assert.ok(!fs.existsSync(path.join(wd, 'sessions', 's_empty.digest.json')), 'empty digest is not cached');
});

test('DL-11: non-empty session → deterministic facts: files, URLs, repos, commands, publications', async () => {
  const store = traceStore();
  const { getDigestFor } = require('../src/session-digest');
  const wd = writeSession('gina', 's_facts', { engineSessions: { opencode: 'ses_facts' }, messages: [
    { role: 'user', content: 'Разбери клиента Ромашка и опубликуй отчёт', at: T0 - MIN },
    { role: 'assistant', content: 'Готово: отчёт опубликован.', at: T0 + 17 * MIN },
  ] });
  for (const p of PARTS) store.appendEvent(wd, 'opencode', 'ses_facts', p, {});
  process.env.OPENCODE_DB_PATH = path.join(ROOT, 'no-such', 'opencode.db');
  try {
    const r = await getDigestFor('gina', 's_facts', { llm: async () => { throw new Error('llm down'); } });
    assert.equal(r.ok, true);
    assert.notEqual(r.empty, true);
    assert.ok(Array.isArray(r.facts) && r.facts.length, 'facts present even when the LLM is down');
    const flat = JSON.stringify(r.facts);
    for (const needle of [
      '/home/u/projects/x/brief.md',
      'https://checko.ru/company/romashka',
      'trained-assist/trained-assist-agent',
      'git push',
      'https://pages.trainedassist.store/report-x',
    ]) assert.ok(flat.includes(needle), `facts mention ${needle}`);
    assert.doesNotMatch(flat, /не состоял/i, 'no evaluative verdicts in facts');
  } finally { delete process.env.OPENCODE_DB_PATH; }
});
