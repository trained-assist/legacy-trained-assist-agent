'use strict';
// S1b (#1851, issue #1878): POST /web/qa-bearer server-side handler.
// Covers auth, caller→qa-<caller> derivation (body username ignored), profile creation,
// rate limit, status (agent/gateway/expected-SHA/journal errors), trace scope + buttons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const REPO = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-live-handler-'));
process.env.HOME = tmp;
process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
process.env.USERS_DIR = path.join(tmp, 'users');
process.env.AGENT_GIT_DIR = REPO;
process.env.PORT = '1';
process.env.GATEWAY_HEALTH_URL = 'http://gateway.invalid/health';
process.env.WEB_CONVREF_CANARY = '*';
process.env.NODE_ENV = 'test';
delete process.env.WEB_VERIFY_SECRET;
const SECRET = 'qa-live-handler-secret';
process.env.AGENT_SECRET = SECRET;

// The slot user is not the repo owner → git refuses without safe.directory. HOME was
// redirected above, so a global config there applies to the real `git` calls below.
fs.writeFileSync(path.join(tmp, '.gitconfig'), '[safe]\n\tdirectory = *\n[user]\n\tname = qa-test\n\temail = qa@test\n');

const cp = require('child_process');
const HEAD = cp.execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();

// Fake journalctl only; every other exec (git) runs for real.
const origExecSync = cp.execSync;
const journalRef = { text: '' };
cp.execSync = function (cmd) {
  if (String(cmd).includes('journalctl')) return Buffer.from(journalRef.text);
  return origExecSync.apply(cp, arguments);
};

// Fake the two /health HTTP reads; everything else would be a bug in this test.
const origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/health') && u.includes('127.0.0.1')) {
    return { ok: true, status: 200, async json() { return { commit: HEAD, fullSha: HEAD, uptime: 3, vm: 'test' }; } };
  }
  if (u.includes('gateway.invalid')) {
    return { ok: true, status: 200, async json() { return { status: 'ok', buildSha: 'f'.repeat(40) }; } };
  }
  throw new Error(`unexpected fetch ${u}`);
};

const { handleQaLive, _internals } = require('../src/handlers/qa-live');
const { userWorkDir } = require('../src/data-paths');
const store = require('../src/session-store');

function makeReq(body, headers = {}) {
  const req = new Readable({ read() {} });
  req.headers = headers;
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}
function makeRes() {
  return {
    statusCode: null, headers: null, body: '', writableEnded: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    write(c) { this.body += String(c); return true; },
    end(c) { if (c) this.body += String(c); this.writableEnded = true; },
  };
}
async function call(body, { bearer = `Bearer ${SECRET}`, url = '/web/qa-bearer' } = {}) {
  const res = makeRes();
  const headers = bearer ? { authorization: bearer } : {};
  await handleQaLive(makeReq(body, headers), new URL(url, 'http://127.0.0.1'), res, { secrets: { AGENT_SECRET: SECRET } });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* SSE */ }
  return { res, json };
}

test('rejects a missing or wrong bearer with 401', async () => {
  assert.equal((await call({ op: 'status' }, { bearer: null })).res.statusCode, 401);
  assert.equal((await call({ op: 'status' }, { bearer: 'Bearer nope' })).res.statusCode, 401);
});

test('rejects an invalid caller and requires a caller for send/trace', async () => {
  assert.equal((await call({ op: 'status', caller: '../etc' })).res.statusCode, 400);
  assert.equal((await call({ op: 'send', text: 'hi' })).res.statusCode, 400);
  assert.equal((await call({ op: 'trace', sessionId: 's-1' })).res.statusCode, 400);
});

test('unknown op → 400', async () => {
  const r = await call({ op: 'nope', caller: 'alice' });
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.json.error, 'unknown op');
});

test('status reports agent/gateway/expected(merge-base)/journal errors', async () => {
  journalRef.text = '2026-09-29 vm assist-agent[1]: ERROR boom\nok line\nUnhandled rejection x\n';
  const r = await call({ op: 'status', caller: 'alice', expectSha: HEAD, sinceMinutes: 30 });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json.agent.commit, HEAD);
  assert.equal(r.json.gateway.buildSha, 'f'.repeat(40));
  assert.equal(r.json.expected.reached, true);
  assert.equal(r.json.errors.count, 2);
});

test('expected.reached is null (not false) when the expected SHA is unknown', async () => {
  const r = await call({ op: 'status', caller: 'alice', expectSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(r.json.expected.reached, null);
  assert.match(r.json.expected.reason, /неизвестен/);
});

test('send runs streamWebTask as qa-<caller> and ignores a body username; creates profile.json', async () => {
  const wr = require('../src/web-routes');
  const captured = [];
  wr.streamWebTask = async ({ res, username, task, sessionId, newSessionId }) => {
    captured.push({ username, task });
    const id = sessionId || newSessionId || 's-web-fixed';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: id })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', sessionId: id })}\n\n`);
    res.end();
  };
  const r = await call({ op: 'send', caller: 'alice', text: 'привет', username: 'real-client' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(captured.at(-1).username, 'qa-alice');
  assert.equal(captured.at(-1).task, 'привет');
  assert.ok(fs.existsSync(path.join(userWorkDir('qa-alice'), 'profile.json')), 'qa-alice profile.json created');
});

test('rate limit: 20 sends/hour then 429; a new window resets', async () => {
  const q = _internals.consumeSendQuota;
  const caller = 'ratelimited';
  const now = 1_800_000_000_000;
  for (let i = 0; i < 20; i++) assert.equal(q(caller, now).allowed, true, `send ${i + 1}`);
  const denied = q(caller, now);
  assert.equal(denied.allowed, false);
  assert.ok(denied.resetsIn > 0 && denied.resetsIn <= 3600);
  // next 1h window (windowStart changes) → allowed again
  assert.equal(q(caller, now + 3600 * 1000).allowed, true);
});

test('trace reads the qa-<caller> session, parses buttons, and 404s a foreign session', async () => {
  const caller = 'bob';
  const workDir = userWorkDir(`qa-${caller}`);
  const sid = store.createSession(workDir, { task: 'тест', id: 's-web-bob-1', chatId: null });
  store.appendReply(workDir, sid, 'готово');
  journalRef.text = `2026-09-29 [buttons] session=${sid} internalGtd=false reason=none textLen=6 attached=["Проверка"] callbacks=[{"t":"Проверка","c":"cb:1"}]\n`
    + '2026-09-29 unrelated line\n';
  const r = await call({ op: 'trace', caller, sessionId: sid });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.json.session.messageCount, 2);
  assert.equal(r.json.messages.length, 2);
  assert.deepEqual(r.json.buttons.labels, ['Проверка']);
  assert.deepEqual(r.json.buttons.callbacks, [{ t: 'Проверка', c: 'cb:1' }]);
  assert.equal(r.json.journal.length, 1);
  assert.ok(Array.isArray(r.json.executions));

  // A session owned by another profile is invisible to the qa-<caller> scope.
  const foreignDir = userWorkDir('realperson');
  const foreignId = store.createSession(foreignDir, { task: 'чужая', id: 's-web-foreign-1', chatId: null });
  const f = await call({ op: 'trace', caller, sessionId: foreignId });
  assert.equal(f.res.statusCode, 404);
});

test.after(() => { globalThis.fetch = origFetch; cp.execSync = origExecSync; fs.rmSync(tmp, { recursive: true, force: true }); });
