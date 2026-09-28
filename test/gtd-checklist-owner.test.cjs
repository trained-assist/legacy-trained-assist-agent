'use strict';
// BV-08 (#1729, docs/user-scenarios/core/02-background-run-visibility.md): a checklist
// section belongs to the session named in its `Owner-session:` line. Incident 28.09:
// yesterday's GTD continuation (tg-bot#290) popped into today's unrelated conversation
// because scheduleFromChecklist attached ANY unfinished root checklist.md to whichever
// session ran next.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-owner-data-'));
const G = require('../src/gtd-controller');
const O = require('../src/orphan-checklists');

function setup(checklist) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-owner-'));
  const projectDir = path.join(workDir, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  if (checklist != null) fs.writeFileSync(path.join(projectDir, 'checklist.md'), checklist);
  return { workDir, projectDir };
}
const notRunning = () => false;

test('readChecklist exposes owner + cancelled of the active section only', () => {
  const { projectDir } = setup('Goal: old\nOwner-session: s-old\n- [x] a\n\nGoal: new\nOwner-session: s-B\n- [ ] b\n');
  const cl = G.readChecklist(projectDir);
  assert.strictEqual(cl.goal, 'new');
  assert.strictEqual(cl.owner, 's-B');
  assert.strictEqual(cl.cancelled, false);
  assert.deepStrictEqual(cl.items.map(i => i.text), ['b']);
});

test('session B writes an owned checklist, session A runs -> no GTD in A', async () => {
  const { workDir, projectDir } = setup('Goal: история группы\nOwner-session: s-B\n- [x] PR\n- [ ] живая проверка\n');
  const rec = await G.scheduleFromChecklist({ workDir, sessionId: 's-A', chatId: '42', username: 'u', projectDir, isSessionRunning: notRunning });
  assert.strictEqual(rec, null);
  assert.strictEqual(G.readGtd(workDir, 's-A'), null, 'no GTD record for the foreign session');
  // B has no open GTD and is not running -> the section is an orphan, remembered for the reminder.
  const orphan = O.findRecord(workDir, projectDir, 'история группы');
  assert.ok(orphan, 'orphan recorded');
  assert.strictEqual(orphan.chatId, '42');
  assert.strictEqual(orphan.label, 'история группы');
  assert.strictEqual(orphan.firstOpen, 'живая проверка');
});

test('owner B still running -> A skips it, but it is not an orphan', async () => {
  const { workDir, projectDir } = setup('Goal: g\nOwner-session: s-B\n- [ ] x\n');
  const rec = await G.scheduleFromChecklist({ workDir, sessionId: 's-A', projectDir, isSessionRunning: (_u, sid) => sid === 's-B' });
  assert.strictEqual(rec, null);
  assert.strictEqual(O.findRecord(workDir, projectDir, 'g'), null);
});

test('owner B has an open GTD -> A skips, no orphan', async () => {
  const { workDir, projectDir } = setup('Goal: g\nOwner-session: s-B\n- [ ] x\n');
  G.writeGtd(workDir, { sessionId: 's-B', status: 'open', projectDir: '/elsewhere', dueAt: Date.now() + 1e6 });
  assert.strictEqual(await G.scheduleFromChecklist({ workDir, sessionId: 's-A', projectDir, isSessionRunning: notRunning }), null);
  assert.strictEqual(O.findRecord(workDir, projectDir, 'g'), null);
});

test('legacy ownerless checklist -> not attached to a new session', async () => {
  const { workDir, projectDir } = setup('Goal: legacy\n- [ ] x\n');
  const rec = await G.scheduleFromChecklist({ workDir, sessionId: 's-A', projectDir, isSessionRunning: notRunning });
  assert.strictEqual(rec, null);
  assert.strictEqual(G.readGtd(workDir, 's-A'), null);
  assert.ok(O.findRecord(workDir, projectDir, 'legacy'), 'legacy ownerless section is an orphan');
});

test('legacy ownerless checklist already tracked by A -> A keeps its open record', async () => {
  const { workDir, projectDir } = setup('Goal: legacy\n- [ ] x\n');
  const open = { sessionId: 's-A', status: 'open', projectDir, createdAt: 5, dueAt: Date.now() + 1e6 };
  G.writeGtd(workDir, open);
  const rec = await G.scheduleFromChecklist({ workDir, sessionId: 's-A', projectDir, isSessionRunning: notRunning });
  assert.ok(rec && rec.createdAt === 5 && rec.status === 'open');
});

test('owner === A -> attached (existing behavior)', async () => {
  const { workDir, projectDir } = setup('Goal: мой PR\nOwner-session: s-A\n- [ ] CI green\n- [ ] merged\n');
  const rec = await G.scheduleFromChecklist({ workDir, sessionId: 's-A', chatId: '7', username: 'u', projectDir, isSessionRunning: notRunning });
  assert.ok(rec, 'scheduled');
  assert.strictEqual(rec.status, 'open');
  assert.strictEqual(rec.originalTask, 'мой PR');
  assert.strictEqual(G.readGtd(workDir, 's-A').status, 'open');
});

test('cancelled section is never attached', async () => {
  const { workDir, projectDir } = setup('Goal: g\nOwner-session: s-A\nCancelled: 2026-09-28\n- [ ] x\n');
  assert.strictEqual(G.readChecklist(projectDir).cancelled, true);
  assert.strictEqual(await G.scheduleFromChecklist({ workDir, sessionId: 's-A', projectDir, isSessionRunning: notRunning }), null);
});

test('setChecklistOwner / markChecklistCancelled edit only the active section', () => {
  const { projectDir } = setup('Goal: old\n- [ ] keep\n\nGoal: new\n- [ ] x\n');
  assert.strictEqual(G.setChecklistOwner(projectDir, 's-Z'), true);
  let raw = fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8');
  assert.match(raw, /Goal: new\nOwner-session: s-Z\n- \[ \] x/);
  assert.doesNotMatch(raw, /Goal: old\nOwner-session/);
  assert.strictEqual(G.setChecklistOwner(projectDir, 's-Z'), false, 'idempotent');
  assert.strictEqual(G.setChecklistOwner(projectDir, 's-Y'), true, 'replaces the owner line');
  assert.strictEqual(G.readChecklist(projectDir).owner, 's-Y');
  assert.strictEqual(G.markChecklistCancelled(projectDir, { now: Date.UTC(2026, 8, 28) }), true);
  raw = fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8');
  assert.match(raw, /Owner-session: s-Y\nCancelled: 2026-09-28\n- \[ \] x/);
  const cl = G.readChecklist(projectDir);
  assert.strictEqual(cl.cancelled, true);
  assert.strictEqual(cl.goal, 'new', 'cancelled section stays active — older sections are not resurrected');
  // Item line numbers still line up for writeChecklistDone after the inserted lines.
  G.writeChecklistDone(projectDir, cl.items.map(i => ({ ...i, done: true })));
  assert.match(fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8'), /- \[x\] x/);
  assert.match(fs.readFileSync(path.join(projectDir, 'checklist.md'), 'utf8'), /- \[ \] keep/);
});

test('claimFreshChecklist signs a section written during the run, not a legacy one', () => {
  const { workDir, projectDir } = setup('Goal: fresh\n- [ ] x\n');
  assert.strictEqual(G.claimFreshChecklist({ workDir, projectDir, sessionId: 's-A', since: Date.now() - 5000 }), true);
  assert.strictEqual(G.readChecklist(projectDir).owner, 's-A');

  const legacy = setup('Goal: legacy\n- [ ] x\n');
  const old = new Date(Date.now() - 86400e3);
  fs.utimesSync(path.join(legacy.projectDir, 'checklist.md'), old, old);
  assert.strictEqual(G.claimFreshChecklist({ workDir: legacy.workDir, projectDir: legacy.projectDir, sessionId: 's-A', since: Date.now() - 5000 }), false);

  // Touched during the run, but another session's open GTD tracks it -> not ours.
  const tracked = setup('Goal: tracked\n- [ ] x\n');
  G.writeGtd(tracked.workDir, { sessionId: 's-B', status: 'open', projectDir: tracked.projectDir, dueAt: 1 });
  assert.strictEqual(G.claimFreshChecklist({ workDir: tracked.workDir, projectDir: tracked.projectDir, sessionId: 's-A', since: Date.now() - 5000 }), false);
});
