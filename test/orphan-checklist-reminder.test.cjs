'use strict';
// BV-08 / BV-08a (#1729): an orphaned checklist section gets ONE reminder no earlier than
// 30 min after it was found, with «▶️ Делать» / «✖️ Отменить»; /all_forgotten_checklists
// lists them all. Fake Telegram sink, no LLM, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-data-'));
const G = require('../src/gtd-controller');
const O = require('../src/orphan-checklists');
const projects = require('../src/projects');
const sessions = require('../src/session-store');

const MIN = 60 * 1000;
const notRunning = () => false;

function profile() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-users-'));
  const workDir = path.join(base, 'u1');
  fs.mkdirSync(workDir, { recursive: true });
  const meta = projects.createProject(workDir, { type: 'generic', name: 'tg bot' });
  const projectDir = projects.projectDir(workDir, meta.id);
  return { base, workDir, projectDir, projectName: meta.name };
}

function writeChecklist(projectDir, text) {
  fs.writeFileSync(path.join(projectDir, 'checklist.md'), text);
}

function sink() {
  const sent = [];
  let nextId = 100;
  const notify = async (token, chatId, text, threadId, extra) => { sent.push({ token, chatId, text, threadId, extra }); return nextId++; };
  return { sent, notify };
}

async function orphanFromForeignRun(p, text = 'Goal: История группы в тихом режиме\nOwner-session: s-B\n- [x] PR tg-bot#290\n- [ ] живая проверка в группе\n- [ ] деплой\n') {
  writeChecklist(p.projectDir, text);
  const rec = await G.scheduleFromChecklist({ workDir: p.workDir, sessionId: 's-A', chatId: '42', threadId: 7, username: 'u1', projectDir: p.projectDir, isSessionRunning: notRunning });
  assert.strictEqual(rec, null, 'foreign section is not attached to session A');
  const [orphan] = Object.values(O.loadStore(p.workDir).records);
  assert.ok(orphan, 'orphan recorded on skip');
  return orphan;
}

const remind = (p, s, now) => O.remindDue({ baseUsersDir: p.base, now, isSessionRunning: notRunning, notify: s.notify, botTokenFor: () => 'TOKEN' });

test('no reminder before 30 min, exactly one after, never again for the same items', async () => {
  const p = profile();
  const orphan = await orphanFromForeignRun(p);
  const t0 = orphan.firstSeenAt;
  const s = sink();

  assert.strictEqual(await remind(p, s, t0 + 29 * MIN), 0);
  assert.strictEqual(s.sent.length, 0, 'nothing before 30 min');

  assert.strictEqual(await remind(p, s, t0 + 31 * MIN), 1);
  assert.strictEqual(s.sent.length, 1);
  const msg = s.sent[0];
  assert.strictEqual(msg.chatId, '42');
  assert.strictEqual(msg.threadId, 7, 'reminder goes to the forum topic where it was noticed');
  assert.strictEqual(msg.text, '🔁 «История группы в тихом режиме»: остался пункт «живая проверка в группе» и ещё 1');
  const buttons = msg.extra.reply_markup.inline_keyboard[0];
  assert.deepStrictEqual(buttons.map(b => b.text), ['▶️ Делать', '✖️ Отменить']);
  assert.deepStrictEqual(buttons.map(b => b.callback_data), [`ocl|do|${orphan.id}`, `ocl|no|${orphan.id}`]);
  for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64);

  await remind(p, s, t0 + 40 * MIN);
  await remind(p, s, t0 + 3 * 24 * 60 * MIN);
  assert.strictEqual(s.sent.length, 1, 'same open items -> never re-sent');
  const rec = O.loadStore(p.workDir).records[orphan.id];
  assert.ok(rec.remindedAt && rec.reminderMessageId === 100);
});

test('fresh file (still being written) postpones the reminder', async () => {
  const p = profile();
  const orphan = await orphanFromForeignRun(p);
  const s = sink();
  // checklist.md touched 10 min "ago" relative to the tick → wait until 30 min after the write.
  const t = orphan.firstSeenAt + 31 * MIN;
  const touched = new Date(t - 10 * MIN);
  fs.utimesSync(path.join(p.projectDir, 'checklist.md'), touched, touched);
  assert.strictEqual(await remind(p, s, t), 0);
});

test('owner comes back (open GTD) -> no reminder', async () => {
  const p = profile();
  const orphan = await orphanFromForeignRun(p);
  G.writeGtd(p.workDir, { sessionId: 's-B', status: 'open', projectDir: p.projectDir, dueAt: Date.now() + 1e9 });
  const s = sink();
  assert.strictEqual(await remind(p, s, orphan.firstSeenAt + 31 * MIN), 0);
});

test('cancel: marks cancelledAt + Cancelled line, no reminder afterwards, file kept', async () => {
  const p = profile();
  const orphan = await orphanFromForeignRun(p);
  const out = O.act({ workDir: p.workDir, username: 'u1', id: orphan.id, action: 'no' });
  assert.strictEqual(out.status, 'cancelled');
  assert.strictEqual(out.text, '✖️ Отменено: «История группы в тихом режиме»');
  const raw = fs.readFileSync(path.join(p.projectDir, 'checklist.md'), 'utf8');
  assert.match(raw, /Owner-session: s-B\nCancelled: \d{4}-\d{2}-\d{2}\n/);
  assert.match(raw, /- \[ \] деплой/, 'checklist.md is not deleted or rewritten');
  assert.ok(O.loadStore(p.workDir).records[orphan.id].cancelledAt);
  const s = sink();
  assert.strictEqual(await remind(p, s, orphan.firstSeenAt + 31 * MIN), 0);
  assert.strictEqual(await remind(p, s, orphan.firstSeenAt + 5 * 24 * 60 * MIN), 0);
  // …and a later run in another session does not resurrect it either.
  assert.strictEqual(await G.scheduleFromChecklist({ workDir: p.workDir, sessionId: 's-C', projectDir: p.projectDir, isSessionRunning: notRunning }), null);
  assert.deepStrictEqual(O.listForgotten({ workDir: p.workDir, username: 'u1', isSessionRunning: notRunning }), []);
});

test('do: starts a background GTD run for the orphan projectDir in its own session', async () => {
  const p = profile();
  // The current chat session of chat 42 — the orphan must NOT be attached to it.
  const current = sessions.createSession(p.workDir, { task: 'unrelated talk', chatId: '42', audience: 'default' });
  const orphan = await orphanFromForeignRun(p);
  const out = O.act({ workDir: p.workDir, username: 'u1', id: orphan.id, action: 'do', chatId: '42', threadId: 7 });
  assert.strictEqual(out.status, 'started');
  assert.strictEqual(out.text, '▶️ Взял в работу: «История группы в тихом режиме»');
  assert.ok(out.sessionId && out.sessionId !== current && out.sessionId !== 's-A', 'fresh session (owner s-B no longer exists)');
  assert.strictEqual(sessions.getCurrentSessionId(p.workDir, '42', 'default'), current, 'chat pointer untouched');
  assert.strictEqual(G.readChecklist(p.projectDir).owner, out.sessionId, 'section re-signed to the run session');

  const rec = G.readGtd(p.workDir, out.sessionId);
  assert.strictEqual(rec.status, 'open');
  assert.strictEqual(rec.projectDir, p.projectDir);
  assert.strictEqual(rec.source, 'orphan-checklist');
  assert.strictEqual(rec.label, 'История группы в тихом режиме');
  assert.strictEqual(rec.chatId, '42');
  assert.strictEqual(rec.threadId, 7);
  assert.ok(O.loadStore(p.workDir).records[orphan.id].doingAt);

  // The existing GTD tick fires it (no LLM: fake runTask) in the orphan's session.
  const runs = [];
  const tg = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { tg.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
  try {
    await G.runDue({
      secrets: { TELEGRAM_BOT_TOKEN: 'T' }, baseUsersDir: p.base, now: Date.now() + 1000,
      isTaskRunning: () => false, getSession: sessions.getSession,
      runTask: async (o) => { runs.push(o); return 'GTD: continue'; },
    });
  } finally { global.fetch = realFetch; }
  assert.strictEqual(runs.length, 1, 'one background run');
  assert.strictEqual(runs[0].sessionId, out.sessionId);
  assert.strictEqual(runs[0].internalGtd, true);
  assert.strictEqual(runs[0].threadId, 7);
  assert.match(runs[0].task, /живая проверка в группе/);
  assert.match(runs[0].task, new RegExp(`Owner-session: ${out.sessionId}`));
  assert.ok(!tg.some(m => /остался пункт/.test(m.body.text || '')), 'no orphan reminder for a section in work');

  // A second tap is idempotent.
  const again = O.act({ workDir: p.workDir, username: 'u1', id: orphan.id, action: 'do', chatId: '42' });
  assert.strictEqual(again.status, 'already-running');
});

test('do: reuses the owner session when it still exists', async () => {
  const p = profile();
  const owner = sessions.createSession(p.workDir, { task: 'yesterday', chatId: '42', audience: 'default' });
  writeChecklist(p.projectDir, `Goal: g\nOwner-session: ${owner}\n- [ ] x\n`);
  await G.scheduleFromChecklist({ workDir: p.workDir, sessionId: 's-A', chatId: '42', projectDir: p.projectDir, isSessionRunning: notRunning });
  const [orphan] = Object.values(O.loadStore(p.workDir).records);
  const out = O.act({ workDir: p.workDir, username: 'u1', id: orphan.id, action: 'do', chatId: '42' });
  assert.strictEqual(out.sessionId, owner);
});

test('/all_forgotten_checklists lists orphaned, not-cancelled, unfinished sections', async () => {
  const p = profile();
  assert.deepStrictEqual(O.listForgotten({ workDir: p.workDir, username: 'u1', isSessionRunning: notRunning }), []);

  writeChecklist(p.projectDir, 'Goal: История группы\nOwner-session: s-gone\n- [ ] живая проверка\n- [ ] деплой\n');
  // Profile-root checklist, legacy (no owner).
  writeChecklist(p.workDir, 'Goal: Разобрать почту\n- [ ] inbox zero\n');
  // Another project: owned + actively tracked -> not forgotten.
  const other = projects.createProject(p.workDir, { type: 'generic', name: 'busy' });
  const otherDir = projects.projectDir(p.workDir, other.id);
  writeChecklist(otherDir, 'Goal: busy\nOwner-session: s-live\n- [ ] x\n');
  G.writeGtd(p.workDir, { sessionId: 's-live', status: 'open', projectDir: otherDir, dueAt: Date.now() + 1e9 });
  // A finished checklist -> not listed.
  const done = projects.createProject(p.workDir, { type: 'generic', name: 'done' });
  writeChecklist(projects.projectDir(p.workDir, done.id), 'Goal: done\n- [x] y\n');

  const list = O.listForgotten({ workDir: p.workDir, username: 'u1', chatId: '42', isSessionRunning: notRunning });
  assert.deepStrictEqual(list.map(e => e.label).sort(), ['История группы', 'Разобрать почту']);
  const grp = list.find(e => e.label === 'История группы');
  assert.strictEqual(grp.projectName, p.projectName);
  assert.strictEqual(grp.openCount, 2);
  assert.strictEqual(grp.firstOpen, 'живая проверка');
  assert.match(O.listEntryText(grp), /«История группы» · tg bot\nОткрыто пунктов: 2\. Первый: «живая проверка»/);
  assert.strictEqual(list.find(e => e.label === 'Разобрать почту').projectName, 'профиль');

  // Listing counts as the reminder — the tick does not re-send the same items.
  const s = sink();
  assert.strictEqual(await remind(p, s, Date.now() + 60 * MIN), 0);

  // Cancelled entries disappear from the list.
  O.act({ workDir: p.workDir, username: 'u1', id: grp.id, action: 'no' });
  assert.deepStrictEqual(O.listForgotten({ workDir: p.workDir, username: 'u1', isSessionRunning: notRunning }).map(e => e.label), ['Разобрать почту']);
});

test('command intent matches both spellings', () => {
  const { FORGOTTEN_CHECKLISTS_INTENT } = require('../src/runner/intent-engine');
  assert.ok(FORGOTTEN_CHECKLISTS_INTENT.test('/all_forgotten_checklists'));
  assert.ok(FORGOTTEN_CHECKLISTS_INTENT.test('/all_forgotten_checlists'));
  assert.ok(FORGOTTEN_CHECKLISTS_INTENT.test('/all_forgotten_checklists@trained_bot'));
  assert.ok(!FORGOTTEN_CHECKLISTS_INTENT.test('/all_forgotten_checklists please'));
});

test('labels are cut on a word boundary to ≤ 60 chars', () => {
  const l = O.makeLabel('Довести до прода историю группы в тихом режиме с проверкой в живом форуме и деплоем');
  assert.ok(l.length <= 60, l);
  assert.ok(l.endsWith('…'));
  assert.ok(!/\s…$/.test(l));
});

test('unknown / malformed ids are rejected deterministically', () => {
  const p = profile();
  assert.strictEqual(O.act({ workDir: p.workDir, username: 'u1', id: 'deadbeef0000', action: 'do' }).status, 'not-found');
  assert.strictEqual(O.act({ workDir: p.workDir, username: 'u1', id: '../etc', action: 'do' }).status, 'bad-request');
});

test('POST /internal/orphan-checklists/action: do starts + kicks the tick, no cancels', async () => {
  const { handleInternal } = require('../src/handlers/internal');
  const p = profile();
  const orphan = await orphanFromForeignRun(p);
  let ticks = 0;
  const call = async (body) => {
    let out = null;
    const json = (_res, status, payload) => { out = { status, payload }; };
    await handleInternal({ method: 'POST' }, new URL('http://x/internal/orphan-checklists/action'), {}, {
      json, readBody: async () => JSON.stringify(body), BASE_USERS_DIR: p.base, getGtdTickNow: () => async () => { ticks++; },
    });
    return out;
  };
  assert.strictEqual((await call({ username: '../x', action: 'do', id: orphan.id })).status, 400);
  assert.strictEqual((await call({ username: 'u1', action: 'rm', id: orphan.id })).status, 400);
  const done = await call({ username: 'u1', action: 'do', id: orphan.id, chatId: 42, threadId: 7 });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.payload.status, 'started');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ticks, 1, 'GTD tick kicked right away');
  const no = await call({ username: 'u1', action: 'no', id: orphan.id });
  assert.strictEqual(no.payload.status, 'cancelled');
  assert.match(no.payload.text, /^✖️ Отменено: «/);
  assert.strictEqual(G.readGtd(p.workDir, done.payload.sessionId).status, 'closed', 'cancel stops the run started by «Делать»');
});
