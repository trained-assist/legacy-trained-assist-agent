// #1725 root 4: a plan launched from chat must not stay silent until its step budget is
// spent. The first failed attempt of any step sends ONE Telegram line to the owner;
// opt-in bg-notify (stream / explicit off) and batch children are left alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-fail-'));
process.env.AGENT_DATA_DIR = path.join(root, 'agent-data');
process.env.USERS_DIR = path.join(root, 'users');
process.env.AGENT_TOKENS_ROOT = path.join(root, 'tokens');
delete process.env.AGENT_TOKENS_DIR;

const { DurableTaskStore } = require('../src/durable-task-store');
const { writeBgNotify } = require('../src/bg-notify');
const gtd = require('../src/gtd-controller');

const store = new DurableTaskStore(path.join(root, 'state.db'));
const ITEM = { title: 'Исследование', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'master', context_budget: 'small', validation: { type: 'manual' } };

function plan(profile, extra = {}) {
  fs.mkdirSync(path.join(process.env.AGENT_TOKENS_ROOT, profile), { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_TOKENS_ROOT, profile, '.chatid'), '777');
  const r = store.createPlan({ profile_id: profile, goal: 'Сделать PR', user_value: 'v',
    acceptance_criteria: [{ id: 'a', text: 't', validation: { type: 'manual' } }], items: [ITEM, { ...ITEM, title: 'Второй' }], ...extra });
  return { task: store.getTask(r.task.id, profile), items: r.items };
}

function recorder() {
  const sent = [];
  return { sent, send: async (text, target) => { sent.push({ text, chatId: target.chatId }); } };
}

test('first failure → one message to the owner chat; later failures of the same plan stay quiet', async () => {
  const { task, items } = plan('alice');
  const r = recorder();
  const a = await gtd.firstFailureNotice({}, store, task, items[0], 'engineering_spawn_workspace is not available', { send: r.send });
  assert.equal(a.sent, true);
  assert.equal(r.sent.length, 1);
  assert.equal(String(r.sent[0].chatId), '777');
  assert.match(r.sent[0].text, /Сделать PR/);
  assert.match(r.sent[0].text, /шаг 1\/2 «Исследование» не удался/);
  assert.match(r.sent[0].text, /not available/);
  const b = await gtd.firstFailureNotice({}, store, task, items[1], 'again', { send: r.send });
  assert.equal(b.sent, false);
  assert.equal(b.reason, 'already_sent');
  assert.equal(r.sent.length, 1);
});

test('concurrent settles of the same plan send at most once', async () => {
  const { task, items } = plan('erin');
  const r = recorder();
  await Promise.all([0, 1, 0].map(i => gtd.firstFailureNotice({}, store, task, items[i], 'x', { send: r.send })));
  assert.equal(r.sent.length, 1);
});

test('bg-notify configured (on OR explicitly off) → the default notice stands down', async () => {
  const r = recorder();
  writeBgNotify('bob', { enabled: true, chatId: 1 });
  const on = plan('bob');
  assert.equal((await gtd.firstFailureNotice({}, store, on.task, on.items[0], 'x', { send: r.send })).reason, 'bg_notify_configured');
  writeBgNotify('carol', { enabled: false });
  const off = plan('carol');
  assert.equal((await gtd.firstFailureNotice({}, store, off.task, off.items[0], 'x', { send: r.send })).reason, 'bg_notify_configured');
  assert.equal(r.sent.length, 0);
});

test('a batch child plan is reported by the fanout supervisor, not here', async () => {
  const r = recorder();
  const { task, items } = plan('dave');
  const child = { ...task, parent_task_id: 'parent-1' };
  assert.equal((await gtd.firstFailureNotice({}, store, child, items[0], 'x', { send: r.send })).reason, 'batch_child');
  assert.equal(r.sent.length, 0);
});

test('no owner chat on record → nothing sent, nothing claimed', async () => {
  const r = recorder();
  const res = store.createPlan({ profile_id: 'ghost', goal: 'g', user_value: 'v',
    acceptance_criteria: [{ id: 'a', text: 't', validation: { type: 'manual' } }], items: [ITEM] });
  const task = store.getTask(res.task.id, 'ghost');
  assert.equal((await gtd.firstFailureNotice({}, store, task, res.items[0], 'x', { send: r.send })).reason, 'no_chat_id');
  assert.equal(store.hasHookRun(`${task.id}:first-step-failure`), false);
});
