'use strict';
// Epic #1365 PR3 — Web ConversationRef canary: a Web run names its EXACT
// session (no chatId=0 "current session" pointer, no read-back after the run).
// Covers US-WEB-01/02 (tg-bot docs/user-stories) and CH-05 on the new path:
//   - two NEW Web tasks of one profile get distinct sessions and run in parallel;
//   - two tabs of ONE session serialize (session writer guard);
//   - a Web reply into a Telegram-born session writes that exact session, does
//     not move the Telegram chat's pointer/liveChatId, and waits for a TG run
//     already writing it;
//   - canary off → legacy behaviour byte-for-byte (pointer fallback kept).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { webConversationRef, newWebSessionId, webCanaryEnabled } = require('../src/core/web-conversation');
const { conversationKey } = require('../src/core/conversation-ref');
const { createAdmission } = require('../src/core/admission');
const { legacyAdmissionScopes } = require('../src/core/execution-context');
const { resolveRunSession } = require('../src/runner');
const sessions = require('../src/session-store');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/; // same as web-routes / handlers/web
const tick = () => new Promise(r => setImmediate(r));

test('web ConversationRef is keyed by the exact session, never a fake chat', () => {
  const ref = webConversationRef('s-web-1-abcd');
  assert.deepEqual({ ...ref }, { channel: 'web', endpointId: 'web-app', conversationId: 's-web-1-abcd' });
  assert.notEqual(conversationKey(ref), conversationKey(webConversationRef('s-web-2-abcd')));
  assert.throws(() => webConversationRef(''), TypeError);
});

test('minted Web session ids are unique and pass the route validator', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newWebSessionId(1790000000000)));
  assert.equal(ids.size, 200, 'same-millisecond mints must not collide');
  for (const id of ids) assert.match(id, SESSION_ID_RE);
});

test('canary flag: unset=repo default (all profiles, #1524), empty=off, * = all, list = exact usernames', () => {
  assert.equal(webCanaryEnabled('alice', {}), true, 'live profiles get exact Web sessions by default (#1524)');
  assert.equal(webCanaryEnabled('web-canary', {}), true, 'test profile stays on by default — survives deploys');
  assert.equal(webCanaryEnabled('alice', { WEB_CONVREF_CANARY: '' }), false, 'empty env = kill switch for live profiles too');
  assert.equal(webCanaryEnabled('web-canary', { WEB_CONVREF_CANARY: '' }), false, 'empty env = kill switch');
  assert.equal(webCanaryEnabled('alice', { WEB_CONVREF_CANARY: ' ' }), false);
  assert.equal(webCanaryEnabled('alice', { WEB_CONVREF_CANARY: '*' }), true);
  assert.equal(webCanaryEnabled('alice', { WEB_CONVREF_CANARY: 'bob, alice' }), true);
  assert.equal(webCanaryEnabled('ali', { WEB_CONVREF_CANARY: 'alice' }), false);
  assert.equal(webCanaryEnabled('', { WEB_CONVREF_CANARY: '*' }), false);
});

// ── resolveRunSession on a real session store ─────────────────────────────
function profileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'web-exact-'));
}

test('Web reply into a Telegram-born session: exact target, TG pointer + liveChatId untouched', () => {
  const workDir = profileDir();
  const tgSid = sessions.createSession(workDir, { task: 'tg task', id: 's-tg-1', chatId: 111 });
  sessions.setCurrentSessionId(workDir, tgSid, 111);
  const webOther = sessions.createSession(workDir, { task: 'older web', id: 's-web-old', chatId: 0 });
  sessions.setCurrentSessionId(workDir, webOther, 0);

  const picked = resolveRunSession(sessions, sessions.getCurrentSessionId,
    { workDir, sessionId: tgSid, chatId: 0, webExactSession: true });
  assert.deepEqual(picked, { activeSessionId: tgSid, contextSessionId: tgSid });
  assert.equal(sessions.getSession(workDir, tgSid).liveChatId, 111, 'Telegram chat keeps its session');
  assert.equal(sessions.getCurrentSessionId(workDir, 111), tgSid, 'Telegram pointer not moved');
});

test('legacy Web path (canary off) keeps old behaviour: foreign TG session dropped → chat-0 pointer', () => {
  const workDir = profileDir();
  sessions.createSession(workDir, { task: 'tg task', id: 's-tg-1', chatId: 111 });
  const webOther = sessions.createSession(workDir, { task: 'older web', id: 's-web-old', chatId: 0 });
  sessions.setCurrentSessionId(workDir, webOther, 0);
  const picked = resolveRunSession(sessions, sessions.getCurrentSessionId,
    { workDir, sessionId: 's-tg-1', chatId: 0 });
  assert.equal(picked.activeSessionId, webOther);
});

test('new Web task with a minted id never attaches to the chat-0 "current session"', () => {
  const workDir = profileDir();
  const webOther = sessions.createSession(workDir, { task: 'recent web', id: 's-web-recent', chatId: 0 });
  sessions.setCurrentSessionId(workDir, webOther, 0);
  const minted = newWebSessionId();
  const picked = resolveRunSession(sessions, sessions.getCurrentSessionId,
    { workDir, sessionId: minted, chatId: 0, forceNew: true, webExactSession: true });
  assert.deepEqual(picked, { activeSessionId: minted, contextSessionId: null });

  // Legacy: a new Web task (no id) silently continued the recent one.
  const legacy = resolveRunSession(sessions, sessions.getCurrentSessionId, { workDir, sessionId: null, chatId: 0 });
  assert.equal(legacy.activeSessionId, webOther);
});

test('restart-resume of a Web run whose session file was not written yet keeps the minted id', () => {
  const workDir = profileDir();
  sessions.setCurrentSessionId(workDir, sessions.createSession(workDir, { task: 'x', id: 's-web-recent', chatId: 0 }), 0);
  // resume passes the journaled sessionId + webExactSession, but NOT forceNew
  const picked = resolveRunSession(sessions, sessions.getCurrentSessionId,
    { workDir, sessionId: 's-web-9-deadbeef', chatId: 0, webExactSession: true });
  assert.deepEqual(picked, { activeSessionId: 's-web-9-deadbeef', contextSessionId: null });
});

// ── admission with exact Web sessions (fake engine) ───────────────────────
function fakeEngine(admission) {
  const running = new Set();
  let maxOverlap = 0;
  function start(name, scopes) {
    let finish;
    const gate = new Promise(r => { finish = r; });
    const done = admission.run(scopes, async () => {
      running.add(name); maxOverlap = Math.max(maxOverlap, running.size);
      await gate; running.delete(name);
    });
    return { finish, done };
  }
  return { start, running, get maxOverlap() { return maxOverlap; } };
}
const web = sessionId => legacyAdmissionScopes({ chatId: 0, profileId: 'alice', sessionId });
const tg = (chatId, sessionId) => legacyAdmissionScopes({ chatId, audience: 'default', profileId: 'alice', sessionId });

test('US-WEB-01: ten new Web tasks of one profile run in parallel (distinct minted sessions)', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const runs = Array.from({ length: 10 }, (_, i) => e.start(`w${i}`, web(newWebSessionId())));
  await tick();
  assert.equal(e.running.size, 10);
  runs.forEach(r => r.finish()); await Promise.all(runs.map(r => r.done));
});

test('US-WEB-02: two tabs replying into ONE session serialize', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const A = e.start('tab1', web('s-web-1-aaaa'));
  const B = e.start('tab2', web('s-web-1-aaaa'));
  await tick();
  assert.deepEqual([...e.running], ['tab1']);
  A.finish(); await A.done; await tick();
  assert.deepEqual([...e.running], ['tab2']);
  B.finish(); await B.done;
  assert.equal(e.maxOverlap, 1);
});

test('Web reply into a TG session waits for the TG writer; other TG chats unaffected', async () => {
  const a = createAdmission(), e = fakeEngine(a);
  const T = e.start('tg', tg(111, 's-tg-1'));
  const W = e.start('web', web('s-tg-1'));
  const O = e.start('tg-other', tg(222, 's-tg-2'));
  await tick();
  assert.deepEqual([...e.running].sort(), ['tg', 'tg-other']);
  T.finish(); await T.done; await tick();
  assert.ok(e.running.has('web'));
  W.finish(); O.finish(); await Promise.all([W.done, O.done]);
});

// ── streamWebTask wiring (runner stubbed) ─────────────────────────────────
function loadWebRoutesWithStub(calls, env) {
  const runnerPath = require.resolve('../src/runner');
  const routesPath = require.resolve('../src/web-routes');
  const saved = require.cache[runnerPath];
  delete require.cache[routesPath];
  require.cache[runnerPath] = {
    id: runnerPath, filename: runnerPath, loaded: true,
    exports: {
      runTask: opts => { calls.push(opts); return Promise.resolve('ok'); },
      isSessionRunning: () => false, stopSessionTask: () => false,
    },
  };
  const prev = process.env.WEB_CONVREF_CANARY;
  if (env == null) delete process.env.WEB_CONVREF_CANARY; else process.env.WEB_CONVREF_CANARY = env;
  const mod = require('../src/web-routes');
  return {
    mod,
    restore() {
      if (saved) require.cache[runnerPath] = saved; else delete require.cache[runnerPath];
      delete require.cache[routesPath];
      if (prev == null) delete process.env.WEB_CONVREF_CANARY; else process.env.WEB_CONVREF_CANARY = prev;
    },
  };
}

function fakeReqRes() {
  const req = new EventEmitter();
  const out = [];
  let ended;
  const ended$ = new Promise(r => { ended = r; });
  const res = { writeHead() {}, write: c => out.push(c), end: () => ended() };
  const events = () => out.filter(c => c.startsWith('data: ')).map(c => JSON.parse(c.slice(6)));
  return { req, res, events, ended$ };
}

test('streamWebTask (canary on): mints the session up front, announces it, never reads a pointer back', async () => {
  const calls = [];
  const { mod, restore } = loadWebRoutesWithStub(calls, 'alice');
  try {
    const a = fakeReqRes();
    mod.streamWebTask({ req: a.req, res: a.res, secrets: {}, username: 'alice', task: 'one', sessionId: null });
    const b = fakeReqRes();
    mod.streamWebTask({ req: b.req, res: b.res, secrets: {}, username: 'alice', task: 'two', sessionId: null });
    await Promise.all([a.ended$, b.ended$]);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.webExactSession, true);
      assert.equal(c.forceNew, true);
      assert.match(c.sessionId, /^s-web-\d+-[0-9a-f]{8}$/);
      assert.equal(c.user.id, 0, 'no Telegram chat → nothing is ever sent to Telegram');
    }
    assert.notEqual(calls[0].sessionId, calls[1].sessionId, 'parallel new Web tasks get distinct sessions');
    const evA = a.events();
    assert.deepEqual(evA[0], { type: 'session', sessionId: calls[0].sessionId });
    assert.deepEqual(evA.at(-1), { type: 'done', sessionId: calls[0].sessionId });

    const r = fakeReqRes();
    mod.streamWebTask({ req: r.req, res: r.res, secrets: {}, username: 'alice', task: 'reply', sessionId: 's-tg-1' });
    await r.ended$;
    assert.equal(calls[2].sessionId, 's-tg-1');
    assert.equal(calls[2].forceNew, false, 'a reply continues the named session');
    assert.equal(calls[2].webExactSession, true);
  } finally { restore(); }
});

test('streamWebTask (canary off / other profile): legacy call shape unchanged', async () => {
  const calls = [];
  const { mod, restore } = loadWebRoutesWithStub(calls, 'bob');
  try {
    const a = fakeReqRes();
    mod.streamWebTask({ req: a.req, res: a.res, secrets: {}, username: 'alice', task: 'one', sessionId: null });
    await a.ended$;
    assert.equal(calls[0].sessionId, undefined);
    assert.equal('webExactSession' in calls[0], false);
    assert.equal('forceNew' in calls[0], false);
    assert.equal(a.events().some(e => e.type === 'session'), false);
  } finally { restore(); }
});

// #1524: owner's report — a second, unrelated question asked via «Новая сессия»
// in the same project landed as a reply in the previous session. With the
// repo default (no env override) a live profile's new Web tasks must each get
// their own fresh session and never inherit the chat-0 "current session".
test('#1524 default env: two new Web tasks of a live profile in one project → two fresh sessions', async () => {
  const calls = [];
  const { mod, restore } = loadWebRoutesWithStub(calls, null);
  try {
    const a = fakeReqRes();
    mod.streamWebTask({ req: a.req, res: a.res, secrets: {}, username: 'trained-assist-product-owner', task: 'эпик GTD v2', sessionId: null, projectId: 'generic-x' });
    await a.ended$;
    const b = fakeReqRes();
    mod.streamWebTask({ req: b.req, res: b.res, secrets: {}, username: 'trained-assist-product-owner', task: 'в веб-сессии GTD включается?', sessionId: null, projectId: 'generic-x' });
    await b.ended$;
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.webExactSession, true, 'live profile is on the exact-session path by default');
      assert.equal(c.forceNew, true, 'a new Web task never resumes the current-session pointer');
      assert.equal(c.projectId, 'generic-x', 'same project = same folder, still separate sessions');
    }
    assert.notEqual(calls[0].sessionId, calls[1].sessionId, 'second question starts its own session');
  } finally { restore(); }
});
