'use strict';
// Owner 29.09: a plan belongs to the chat it was started from.
// R5 reproduce — all 5 checks from the issue "Проверка (исполняемая)".
// On the current release (3b14487) every test FAILS (red), proving the bug.
// After the fix all 5 pass green.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-chat-scope-'));
process.env.AGENT_DATA_DIR = path.join(tmp, 'data');
process.env.USERS_DIR = path.join(tmp, 'users');
process.env.AGENT_TOKENS_ROOT = path.join(tmp, 'tokens');
process.env.HOME = tmp;

const runner = require('../src/runner');
const G = require('../src/gtd-controller');
const { writeBgNotify, readBgNotify, isBgNotifyEnabled } = require('../src/bg-notify');
const { DurableTaskStore } = require('../src/durable-task-store');
const { durableTaskDbPath } = require('../src/data-paths');
const { buildAwaitingUserNotice } = require('../src/durable-wait');

const P = 'pz';

function writeSession(id, liveChatId) {
  const dir = path.join(process.env.USERS_DIR, P, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, liveChatId, audience: 'default', messages: [] }));
}

function freshStore() {
  return new DurableTaskStore(durableTaskDbPath());
}

function activePlan(store, extra = {}) {
  const r = store.createPlan({
    profile_id: P, goal: 'g', user_value: 'v', acceptance_criteria: [{ id: 'c' }],
    items: [{ title: 'step', execution_kind: 'programmatic', validation: { ok: true } }], ...extra,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task;
}

// ── 5. stopUserTask(chat B) must not kill a plan step (chatId=null),
//    but stopUserTask(chat A) must kill its own chat run ──────────────
test('stopUserTask(chat B) does not kill chat-less plan step; stopUserTask(chat A) kills its own chat run', () => {
  runner._activeTimers.clear();
  const chatRun = { killed: null, kill(s) { this.killed = s; } };
  const planStep = { killed: null, kill(s) { this.killed = s; } };
  // Chat run lives in chat A (-100); durable step has chatId=null (no owner chat yet).
  runner._activeTimers.set(`${P}-tg-a`, { username: P, audience: 'default', chatId: -100, sessionId: 's-a', proc: chatRun });
  runner._activeTimers.set(`durable-${P}-x`, { username: P, audience: 'default', chatId: null, sessionId: 's-plan-x', proc: planStep });

  // Stop in chat B (-200) must not kill the plan step (chatId=null matches any chat today — that's the bug).
  // Chat B has no runs of its own → nothing stopped (the red repro expected true — a test bug).
  assert.equal(runner.stopUserTask(P, -200, 'default'), false, 'stop in chat B stops nothing');
  assert.equal(planStep.killed, null, 'a plan step must not be killed by a stop in another chat');
  assert.equal(chatRun.killed, null, 'chat run in chat A must not be killed by stop in chat B');

  // Stop in chat A (-100) must kill its own chat run.
  runner._activeTimers.set(`${P}-tg-a`, { username: P, audience: 'default', chatId: -100, sessionId: 's-a', proc: chatRun });
  assert.equal(runner.stopUserTask(P, -100, 'default'), true, 'stop in chat A returned true');
  assert.ok(chatRun.killed, 'chat run in chat A is stopped by stop in chat A');

  // A plan step carrying its owner chat (A) is stopped from chat A, not from chat B.
  const ownedStep = { killed: null, kill(s) { this.killed = s; } };
  runner._activeTimers.clear();
  runner._activeTimers.set(`durable-${P}-y`, { username: P, audience: 'default', chatId: -100, sessionId: 's-plan-y', proc: ownedStep });
  runner.stopUserTask(P, -200, 'default');
  assert.equal(ownedStep.killed, null, 'owned plan step survives a stop in another chat');
  runner.stopUserTask(P, -100, 'default');
  assert.ok(ownedStep.killed, 'owned plan step is stopped from its owner chat');
  runner._activeTimers.clear();
});

// ── 1. createPlan records origin_session_id ──────────────────────────
test('createPlan records origin_session_id from session_id', () => {
  const store = freshStore();
  const r = store.createPlan({
    profile_id: P, goal: 'g', user_value: 'v', acceptance_criteria: [{ id: 'c' }],
    items: [{ title: 'step', execution_kind: 'programmatic', validation: { ok: true } }],
    session_id: 's-origin',
  });
  assert.equal(r.task.origin_session_id, 's-origin', 'origin_session_id must be recorded');
});

// ── 2. 3 plans from the same session must all be created without error ──
test('3 plans from one session are created without error', () => {
  const store = freshStore();
  writeSession('s-shared', -333);
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      store.createPlan({
        profile_id: P, goal: `g${i}`, user_value: 'v', acceptance_criteria: [{ id: `c${i}` }],
        items: [{ title: `step${i}`, execution_kind: 'programmatic', validation: { ok: true } }],
        session_id: 's-shared',
      });
    } catch (e) {
      lastErr = e;
    }
  }
  assert.equal(lastErr, undefined, '3 plans from one session must not throw (origin_session_id, not task_sessions clash)');
});

// ── 4. awaiting-notice in session B must not show plan A ─────────────
test('buildAwaitingUserNotice in session B does not show plan A', () => {
  const store = freshStore();
  writeSession('s-a', -1000);
  writeSession('s-b', -2000);

  // plan A originated from s-a (chat -1000)
  const planA = activePlan(store, { session_id: 's-a' });
  const itemA = store.listTaskItems(planA.id, P)[0];
  store.db.prepare("UPDATE task_items SET status='waiting', wait_json=? WHERE id=?")
    .run(JSON.stringify({ awaiting_user: true, reason: 'ключ из сессии A', timeout_sec: 86400 }), itemA.id);

  // plan B originated from s-b (chat -2000)
  const planB = activePlan(store, { session_id: 's-b' });
  const itemB = store.listTaskItems(planB.id, P)[0];
  store.db.prepare("UPDATE task_items SET status='waiting', wait_json=? WHERE id=?")
    .run(JSON.stringify({ awaiting_user: true, reason: 'ключ из сессии B', timeout_sec: 86400 }), itemB.id);

  // buildAwaitingUserNotice scoped to session B must not contain plan A
  const notice = buildAwaitingUserNotice(P, { store, sessionId: 's-b' });
  // The notice lists steps by item_id.
  assert.ok(notice.includes(itemB.id), 'session B notice must contain plan B step');
  assert.ok(!notice.includes(itemA.id), 'session B notice must not contain plan A step');
});

// ── 3. bgNotice with a flag on a different chat sends to the plan owner ──
test('bgNotice sends to the plan owner chat, not to the bg-notify flag chat', async () => {
  const store = freshStore();
  writeSession('s-owner', -777);
  writeBgNotify(P, { enabled: true, chatId: -555, audience: 'default' });
  const sent = [];
  global.fetch = async (_url, opts) => {
    sent.push(JSON.parse(opts.body).chat_id);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const secrets = { TELEGRAM_BOT_TOKEN: 'T' };

  const own = activePlan(store, { session_id: 's-owner' });
  assert.equal((await G._bgNotice(secrets, own, 'step started')).sent, true);
  assert.deepEqual(sent, [-777], 'plan owner chat (-777) wins over bg-notify flag chat (-555)');

  // A fanout child inherits its parent's chat.
  const child = store.createPlan({
    profile_id: P, goal: 'child', user_value: 'v', acceptance_criteria: [{ id: 'c' }],
    items: [{ title: 'step', execution_kind: 'programmatic', validation: { ok: true } }],
  });
  store.db.prepare('UPDATE durable_tasks SET parent_task_id=? WHERE id=?').run(own.id, child.id);
  await G._bgNotice(secrets, store.getTask(child.id, P), 'step started');
  assert.equal(sent.at(-1), -777, 'child plan inherits parent origin chat');

  // A plan with no origin (legacy row / deleted dialog) → bg-notify flag chat.
  const orphan = activePlan(store);
  await G._bgNotice(secrets, orphan, 'step started');
  assert.equal(sent.at(-1), -555, 'orphan plan falls back to bg-notify flag chat');
});
// ── 6. task_create without session_id takes the caller's AGENT_SESSION_ID ──
test('task_create falls back to AGENT_SESSION_ID for the owner chat; missing env session is ignored', async () => {
  const { tools } = require('../src/mcp-skills/tools/101-durable-tasks');
  const plan = {
    goal: 'env', user_value: 'v', acceptance_criteria: [{ id: 'c' }],
    items: [{ title: 'step', execution_kind: 'programmatic', validation: { ok: true } }],
  };
  writeSession('s-env', -4242);
  const saved = process.env.AGENT_SESSION_ID;
  try {
    process.env.AGENT_SESSION_ID = 's-env';
    const r = await tools.task_create.handler({ ...plan }, { userId: P });
    assert.equal(r.task.origin_session_id, 's-env');
    assert.equal(JSON.parse(r.task.origin_chat_json).chatId, -4242, 'chat snapshot taken at creation');
    process.env.AGENT_SESSION_ID = 's-missing';
    const r2 = await tools.task_create.handler({ ...plan }, { userId: P });
    assert.equal(r2.task.origin_session_id, null, 'a missing env session is not an error and not an owner');
  } finally {
    if (saved === undefined) delete process.env.AGENT_SESSION_ID; else process.env.AGENT_SESSION_ID = saved;
  }
});

// ── 7. a real plan step (session s-plan-<id8>, chatId=null) is stopped from its owner chat only ──
test('chat stop reaches a plan step through its plan session owner chat', () => {
  const store = freshStore();
  writeSession('s-own7', -700);
  const plan = activePlan(store, { session_id: 's-own7' });
  const planSession = `s-plan-${plan.id.slice(0, 8)}`;
  // A plan launched from inside that plan's step inherits the host plan's owner.
  const nested = activePlan(store, { session_id: planSession });
  assert.equal(G._resolvePlanOwner(store, nested).chatId, -700, 'nested plan → host plan owner chat');

  runner._activeTimers.clear();
  const step = { killed: null, kill(s) { this.killed = s; } };
  runner._activeTimers.set(`durable-${P}-z`, { username: P, audience: 'default', chatId: null, sessionId: planSession, proc: step });
  assert.equal(runner.stopUserTask(P, -800, 'default'), false, 'foreign chat does not reach the step');
  assert.equal(step.killed, null);
  assert.equal(runner.stopUserTask(P, -700, 'default'), true, 'owner chat stops its plan step');
  assert.ok(step.killed);
  runner._activeTimers.clear();
});
