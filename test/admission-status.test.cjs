const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createAdmissionStatus } = require('../src/admission-status');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const opts = { taskId: 'task', user: { id: 42, username: 'test' }, secrets: { BOT_TOKEN: 'canonical-token' }, initialMsgId: 9, task: 'work', sessionId: 's1', mode: 'deep', projectId: 'p1' };

// Execute the real runTask admission function with isolated infrastructure.
// No server, subprocess, network or production journal is touched.
// The ONLY gates are core admission (Telegram dialog lane + session writer
// guard, src/core/admission.js) and the global OOM guard (RAM +
// MAX_CONCURRENT_TASKS). Per-profile cap waits were removed — a busy
// lane/session is the one case where the "waiting for previous work" message
// may appear.
function harness({ chatPending, run = async () => {}, taskOpts = opts, expectedToken = 'canonical-token', sessionsOnDisk = {}, scopeCalls = [], intents = {} } = {}) {
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  // Slice the real admission body. Epic #1527 PR1 renamed the public runTask
  // into a thin acceptedByChat/run-finished wrapper around _runTaskInner — the
  // harness exercises admission, so it pins the inner function (the wrapper's
  // helpers live outside this slice and would ReferenceError in the sandbox).
  const start = source.indexOf('function _runTaskInner(opts) {');
  const end = source.indexOf('// Returns context card string', start);
  const messages = [], journal = new Map();
  const gate = chatPending ? deferred() : null;
  const sandbox = {
    taskDelivery: require('../src/bot-delivery').taskDelivery,
    require: name => { assert.equal(name, '../admission-status'); return { createAdmissionStatus }; },
    recordTaskActivity: () => {}, fs: { existsSync: () => false }, path: require('node:path'), PENDING_DIR: '/isolated',
    restartShutdown: false,
    console, Promise, Set, Date,
    STOP_TASK_INTENT: /$^/, GTD_STOP_INTENT: /$^/, WAKEUP_INTENT: /$^/, SKIP_TASK_INTENT: /$^/, ACTIVE_CHECKLIST_INTENT: /$^/, FORGOTTEN_CHECKLISTS_INTENT: /$^/, CHECKLIST_EDIT_INTENT: /$^/,
    isPreQueueQuickIntent: () => false,
    ...intents,
    queuedSessions: new Set(),
    queuedByOwner: new Map(), pendingSessionStops: new Set(),
    ownerKey: (u, id) => `${u}\0${id}`, consumePendingStop: () => false,
    legacyAdmissionScopes: args => { scopeCalls.push(args); return ['lane:test']; },
    getCurrentSessionId: () => null,
    sessions: {
      getSession: (_wd, id) => sessionsOnDisk[id] || null,
      belongsToConversation: require('../src/session-store').belongsToConversation,
    },
    fromLegacyTelegram: () => null, sessionShadow: { shadowCompare: () => null },
    admission: {
      isBusy: () => !!gate,
      run: (_scopes, fn) => gate ? gate.promise.then(fn) : Promise.resolve().then(fn),
    },
    savePendingTask: (id, data) => journal.set(id, data), clearPendingTask: id => journal.delete(id),
    tgEdit: async (token, chat, id, text) => { assert.equal(token, expectedToken); messages.push(text); return { ok: true }; },
    tgSend: async () => { throw Error('unexpected fallback'); },
    _waitForRam: async () => {}, _acquireSlot: async () => {}, _releaseSlot: () => {},
    _runTask: run,
  };
  vm.createContext(sandbox);
  // The slice starts at _runTaskInner (see the start-marker comment above) —
  // alias it back to the name the harness calls: this test exercises the
  // admission body, not the acceptedByChat wrapper.
  vm.runInContext(source.slice(start, end) + '\nrunTask = _runTaskInner;', sandbox);
  return { start: () => sandbox.runTask(taskOpts), messages, journal, gate };
}

test('per-chat wait: a pending task in the same chat shows the waiting message and the new task follows it', async () => {
  let runs = 0;
  const h = harness({ chatPending: true, run: async () => { runs++; assert.match(h.messages.at(-1), /Начинаю работу/); } });
  const done = h.start();
  assert.equal(h.journal.get('task').mode, 'deep');
  assert.equal(h.journal.get('task').projectId, 'p1');
  await tick();
  assert.match(h.messages[0], /Ожидаю завершения предыдущей работы/);
  assert.equal(runs, 0);
  h.gate.resolve(); await done; await tick();
  assert.equal(runs, 1); assert.equal(h.journal.size, 0);
});

test('no predecessor: task starts immediately, no waiting message (session-lane and profile-cap waits removed)', async () => {
  let runs = 0;
  const h = harness({ run: async () => { runs++; assert.match(h.messages.at(-1), /Начинаю работу/); } });
  const done = h.start();
  await done; await tick();
  assert.equal(runs, 1); assert.equal(h.journal.size, 0);
  assert.ok(!h.messages.some(m => /Ожидаю/.test(m)), 'must never announce waiting when nothing is pending in the chat');
});

test('unexpected runner error replaces waiting/start with explicit failure', async () => {
  const h = harness({ run: async () => { throw Error('preparation broke'); } });
  await h.start();
  assert.match(h.messages.at(-1), /Не удалось/);
});

test('slow queue edit cannot overwrite running status; Telegram ok:false triggers fallback', async () => {
  const gate = deferred(); const messages = []; let calls = 0;
  const status = createAdmissionStatus(opts, { intervalMs: 999999,
    edit: async (_t, _c, _i, text) => { if (++calls === 1) await gate.promise; messages.push(text); return { ok: false, description: 'message not found' }; },
    send: async (_t, _c, text) => { messages.push(`fallback:${text}`); },
  });
  status.waiting('waiting');
  const done = status.finish('running');
  await tick(); assert.deepEqual(messages, []);
  gate.resolve(); await done;
  assert.deepEqual(messages, ['waiting', 'fallback:waiting', 'running', 'fallback:running']);
});

test('best-effort 429 drop (flooded) is skipped, not sent as a duplicate message', async () => {
  const messages = [];
  const status = createAdmissionStatus(opts, { intervalMs: 999999,
    edit: async (_t, _c, _i, text) => { messages.push(text); return { ok: false, flooded: true }; },
    send: async (_t, _c, text) => { messages.push(`fallback:${text}`); },
  });
  await status.finish('running');
  assert.deepEqual(messages, ['running']);
});

// Legacy unconditional resume assertion replaced by restart-execution.test.cjs
// and planned-restart-http.test.js: >=5m work is retained and requires confirmation.

test('recruiter admission, runner replies and restart journal keep the originating bot', async () => {
 const original={BOT_TOKEN:'classic',TELEGRAM_BOT_TOKEN:'classic',RECRUITER_BOT_TOKEN:'recruiter'};
 const h=harness({chatPending:true,expectedToken:'recruiter',taskOpts:{...opts,user:{...opts.user,audience:'recruiter'},secrets:original},run:async received=>{
  assert.equal(received.secrets.BOT_TOKEN,'recruiter');assert.equal(received.secrets.TELEGRAM_BOT_TOKEN,'recruiter');
 }});
 const done=h.start();assert.equal(h.journal.get('task').audience,'recruiter');
 await tick();h.gate.resolve();await done;
 assert.equal(original.BOT_TOKEN,'classic','concurrent classic tasks must retain their token');
 assert.ok(h.messages.some(m=>/Начинаю работу/.test(m)));
});

// 2026-09-26 incident: chat -5501536471 showed "Ожидаю завершения предыдущей работы"
// with nothing running in it. The gateway's session classifier had handed it the
// session of ANOTHER chat of the profile (s-1004371070440-…), whose live run held the
// session writer guard. A foreign session must never feed admission or activity.
test('foreign-chat session id is dropped before admission: no cross-chat queueing', async () => {
  const scopeCalls = []; let seen;
  const foreign = { id: 's-foreign', liveChatId: -1004371070440 };
  const h = harness({
    sessionsOnDisk: { 's-foreign': foreign }, scopeCalls,
    taskOpts: { ...opts, user: { id: -5501536471, username: 'test' }, sessionId: 's-foreign' },
    run: async o => { seen = o; },
  });
  await h.start(); await tick();
  assert.equal(scopeCalls[0].sessionId, null, 'admission must not lock the other chat session');
  assert.equal(seen.sessionId, null, 'run falls back to this chat own session');
  assert.notEqual(seen.activitySessionId, 's-foreign', 'activity must not leak into the other chat');
});

test('own-chat session id is kept for admission (same-dialog ordering intact)', async () => {
  const scopeCalls = [];
  const h = harness({
    sessionsOnDisk: { 's-own': { id: 's-own', liveChatId: 42 } }, scopeCalls,
    taskOpts: { ...opts, sessionId: 's-own' },
  });
  await h.start(); await tick();
  assert.equal(scopeCalls[0].sessionId, 's-own');
});

// Playbooks e2e (2026-09-28): a durable plan step's prompt mentioning «поправь … чек-лист»
// was hijacked by the chat intent CHECKLIST_EDIT_INTENT — the run returned the checklist
// autologin link instead of starting the engine (3 attempts in 2 s). Machine prompts
// (internalGtd) must never go through chat intents; a human message still does.
test('durable step prompt reaches the engine even when it matches a chat intent', async () => {
  const { CHECKLIST_EDIT_INTENT, WAKEUP_INTENT } = require('../src/runner/intent-engine');
  const prompt = '[DURABLE TASK — auto-execution]\nStep (6/13): Реализация\nInstructions: если по ходу нужно — поправь чек-лист в журнале; если агент завис — перезапусти шаг';
  assert.ok(CHECKLIST_EDIT_INTENT.test(prompt) && WAKEUP_INTENT.test(prompt), 'the prompt really matches the chat intents');
  let engineRuns = 0;
  const h = harness({ taskOpts: { ...opts, user: { id: null, username: 'test' }, initialMsgId: null, task: prompt, internalGtd: true },
    intents: { CHECKLIST_EDIT_INTENT, WAKEUP_INTENT, isPreQueueQuickIntent: () => true },
    run: async () => { engineRuns++; } });
  await h.start(); await tick();
  assert.equal(engineRuns, 1, 'engine ran — no chat-intent interception for a machine prompt');
});
