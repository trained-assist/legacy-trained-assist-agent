// Meta-playbooks / fanout step (#1752). Offline e2e through the real durable tick:
//   1. batch of 4 elements, no concurrency cap → all 4 children spawn on the first tick,
//      each child runs in its OWN project (runTask gets projectId), children complete,
//      the parent joins and completes; child hooks suppressed; owner gets 4 + summary.
//   2. supervisor: child failure → retry_step (budget 1) → second failure of the same
//      step in another element → pause_batch (policy fallback, no model) → running
//      siblings paused; resume via controlBatch.
//   3. model answer is sanitized: unknown action / continue-on-failure → policy.
//   4. free-slot budget: durableBudget(freeSlots) — 0 free slots fires nothing.
//   5. exclusive stage: a sibling inside the stage blocks another sibling's entry.
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }
const drain = () => new Promise(r => setTimeout(r, 5));

const PB = {
  id: 'mini-expo', version: 1, scope: 'profile', title: 'Мини-выставка', goal_template: '{goal}',
  user_value_template: 'готово: {goal}',
  hooks: { task_done: [{ type: 'notify', to: 'owner', text: 'child done {goal}' }] },
  stages: [
    { id: 'discover', title: 'Discover', steps: [
      { title: 'Найти каталог', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
    ] },
    { id: 'acceptance', title: 'Приёмка', steps: [
      { title: 'B1 тест', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
      { title: 'B5 уборка', execution_kind: 'agent', executor_role: 'verifier', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
    ] },
    { id: 'workflow', title: 'Живая работа', steps: [
      { title: 'D1 на стенде', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { command: 'true' } },
    ] },
  ],
};

function fresh(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fanout-${tag}-`));
  process.env.AGENT_DATA_DIR = path.join(root, 'agent-data');
  process.env.USERS_DIR = path.join(root, 'users');
  process.env.PLAYBOOK_VALIDATION_MODE = 'programmatic';
  fs.mkdirSync(path.join(root, 'users', 'u1', 'playbooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', 'u1', 'playbooks', 'mini-expo.json'), JSON.stringify(PB));
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
  const G = require('../src/gtd-controller.js');
  const F = require('../src/playbook-fanout.js');
  const { PlaybookStore } = require('../src/playbook-store.js');
  const playbook = new PlaybookStore({ profileId: 'u1', siblingRoots: [] }).get('mini-expo');
  return { G, F, store: G.durableStore(), playbook, root };
}

async function tick(G, runTask, extra = {}) {
  const n = await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, runTask, maxFires: 100, registry: extra.registry, llmValidate: async () => ({ status: 'pass' }), ...extra });
  await drain();
  return n;
}
function makeDue(store, taskId) { store.db.prepare(`UPDATE task_items SET due_at = 0 WHERE task_id = ? AND status IN ('waiting','pending')`).run(taskId); }
function makeAllDue(store) { store.db.prepare(`UPDATE task_items SET due_at = 0 WHERE status IN ('waiting','pending')`).run(); }

(async () => {
  // ── 1. happy path, no cap, per-element projects, join ──────────────────────
  {
    const { G, F, store, playbook } = fresh('1');
    const notes = [];
    const batch = F.createBatch(store, {
      profileId: 'u1', playbook, elements: ['https://a.example/ex', { goal: 'https://b.example', name: 'Выставка Б' }, 'https://c.example', 'https://d.example'],
      skipStages: ['workflow'], projectType: 'generic', owner: { chatId: 42 },
    });
    ok(batch.task.status === 'active', 'batch parent is active on creation');
    // Parent step: first tick spawns ALL four (no cap).
    const parentItem = store.getTaskItem(batch.item.id);
    const adv = await F.advanceFanout(store, { task: batch.task, item: parentItem, notify: async t => notes.push(t), llm: null });
    ok(adv.spawned === 4, `no batch cap: all 4 elements spawned at once (got ${adv.spawned})`);
    const state = F.parseFanout(store.getTaskItem(batch.item.id));
    const children = state.elements.map(e => store.getTask(e.childId, 'u1'));
    ok(children.every(c => c && c.status === 'active' && c.parent_task_id === batch.task.id), 'children are active plans linked to the parent');
    ok(new Set(children.map(c => c.project_id)).size === 4 && children.every(c => c.project_id), 'each element has its own project');
    ok(children.every(c => c.hooks_json == null), 'child task hooks suppressed (the batch reports instead)');
    const skipped = store.listTaskItems(children[0].id, 'u1').filter(i => i.stage === 'workflow');
    ok(skipped.length === 1 && skipped[0].status === 'skipped', 'skip_stages: workflow stage skipped in the child');
    ok(state.elements[1].name === 'Выставка Б', 'element name kept');

    // Drive children through the real tick: every agent step answers done.
    const fired = [];
    store.db.prepare('UPDATE task_items SET status = ?, due_at = ? WHERE id = ?').run('waiting', Date.now() + 3600e3, batch.item.id); // park parent
    for (let round = 0; round < 6; round++) {
      if (children.every(c => store.getTask(c.id, 'u1').status === 'done')) break;
      makeAllDue(store);
      store.db.prepare('UPDATE task_items SET due_at = ? WHERE id = ?').run(Date.now() + 3600e3, batch.item.id);
      await tick(G, async (opts) => { fired.push(opts); return 'ok\nDURABLE: done'; });
    }
    ok(children.every(c => store.getTask(c.id, 'u1').status === 'done'), `all children done (got ${children.map(c => store.getTask(c.id, 'u1').status).join(',')})`);
    ok(fired.length === 12, `3 non-skipped steps × 4 children fired (got ${fired.length})`);
    const byProject = fired.every(o => children.some(c => c.project_id === o.projectId));
    ok(byProject, 'P0-a: every durable step carries its plan projectId to the runner');
    ok(fired.every(o => o.resumeSink && o.resumeSink.kind === 'durable'), 'durable steps carry the durable resume sink (exact project binding)');
    // A finished child nudged the parent: its fanout item is due now.
    ok(store.getTaskItem(batch.item.id).due_at <= Date.now(), 'child completion makes the parent step due immediately');

    // Parent tick: observes 4 done → joined → completes via fanout_joined.
    const sent = [];
    await tick(G, async () => 'unused', { hookSinks: null, secrets: {} });
    const adv2 = F.parseFanout(store.getTaskItem(batch.item.id));
    ok(adv2.elements.every(e => e.status === 'done'), `all elements done in batch state (got ${adv2.elements.map(e => e.status).join(',')})`);
    ok(store.getTask(batch.task.id, 'u1').status === 'done', `parent completes when joined (got ${store.getTask(batch.task.id, 'u1').status})`);
    ok(adv2.journal.filter(j => j.event === 'child_done').length === 4, 'journal records each child_done');
    void sent; void notes;
  }

  // ── 2. supervisor policy: retry, then systemic pause, resume ───────────────
  {
    const { F, store, playbook } = fresh('2');
    const notes = [];
    const batch = F.createBatch(store, { profileId: 'u1', playbook, elements: ['x1', 'x2', 'x3'], skipStages: ['workflow'], owner: { chatId: 1 } });
    let item = store.getTaskItem(batch.item.id);
    await F.advanceFanout(store, { task: batch.task, item, notify: async t => notes.push(t), llm: null });
    let st = F.parseFanout(store.getTaskItem(batch.item.id));
    const [a, b, c] = st.elements.map(e => e.childId);
    const firstItem = id => store.listTaskItems(id, 'u1')[0];
    store.failItem(firstItem(a).id, 'u1', { error: 'HTTP 503 from catalog' });
    await F.advanceFanout(store, { task: batch.task, item: store.getTaskItem(batch.item.id), notify: async t => notes.push(t), llm: null });
    st = F.parseFanout(store.getTaskItem(batch.item.id));
    ok(st.elements[0].status === 'retrying' && st.elements[0].retries === 1, `first failure → retry_step (got ${st.elements[0].status}/${st.elements[0].retries})`);
    ok(firstItem(a).status === 'pending' && firstItem(a).attempt_count === 0, 'retry re-pends the failed step with a fresh attempt budget');
    ok(notes.length === 0, 'routine retry sends no message');
    // Same step fails again for A (budget spent) and for B → systemic → pause.
    store.failItem(firstItem(b).id, 'u1', { error: 'weeek token missing' });
    await F.advanceFanout(store, { task: batch.task, item: store.getTaskItem(batch.item.id), notify: async t => notes.push(t), llm: null });
    store.failItem(firstItem(a).id, 'u1', { error: 'HTTP 503 again' });
    await F.advanceFanout(store, { task: batch.task, item: store.getTaskItem(batch.item.id), notify: async t => notes.push(t), llm: null });
    st = F.parseFanout(store.getTaskItem(batch.item.id));
    ok(st.paused && st.paused.key === 'x1', `same step failed in two elements → pause_batch (got ${JSON.stringify(st.paused)})`);
    ok(store.getTask(c, 'u1').status === 'paused', 'pause_batch pauses running siblings (no burning on a shared failure)');
    ok(notes.some(t => /остановлена/.test(t)), 'pause is always delivered to the owner');
    const r = F.controlBatch(store, batch.task.id, 'u1', { action: 'resume' });
    ok(r.ok && store.getTask(c, 'u1').status === 'active', 'resume un-pauses siblings');
    const s2 = F.controlBatch(store, batch.task.id, 'u1', { action: 'skip', key: 'x2', reason: 'нет каталога' });
    ok(s2.ok && s2.status.elements.find(e => e.key === 'x2').status === 'skipped', 'owner can skip an element');
    ok(store.getTask(b, 'u1').status === 'cancelled', 'skipped element child plan is cancelled');
  }

  // ── 3. model decisions are bounded by the closed menu + budgets ────────────
  {
    const { F } = fresh('3');
    const state = { config: { max_child_retries: 1, max_supervisor_calls: 5 }, elements: [{ key: 'a' }, { key: 'b' }], journal: [] };
    const ev = { type: 'child_failed', child: { failedItem: { id: 'i', title: 'Scrape' } } };
    ok(F.sanitizeDecision({ action: 'rm -rf' }, ev, state.elements[0], state).by === 'policy', 'unknown action → deterministic policy');
    ok(F.sanitizeDecision({ action: 'continue' }, ev, state.elements[0], state).action === 'retry_step', 'continue past a failed step is refused');
    ok(F.sanitizeDecision({ action: 'retry_step' }, ev, { key: 'a', retries: 1 }, state).action === 'escalate_owner', 'retry beyond budget → escalate');
    const d = await F.decide(ev, state.elements[0], state, { llm: async () => ({ action: 'skip_item', reason: 'каталога нет', note_for_next: 'смотри поддомен' }) });
    ok(d.action === 'skip_item' && d.by === 'model' && d.note_for_next === 'смотри поддомен', 'a valid model decision is applied');
    const d2 = await F.decide(ev, state.elements[0], state, { llm: async () => { throw new Error('ladder down'); } });
    ok(d2.by === 'policy' && d2.action === 'retry_step', 'model failure falls back to the policy');
  }

  // ── 4. free-slot budget ────────────────────────────────────────────────────
  {
    const { G } = fresh('4');
    ok(G.durableBudget(() => 0) === 0, 'no free slots → nothing fires');
    ok(G.durableBudget(() => 9) === 9, 'budget = free slots (no fixed 3/tick)');
    ok(G.durableBudget(null) === G.MAX_FIRES_PER_TICK, 'no slot info → legacy cap');
    ok(G.durableBudget(() => { throw new Error('x'); }) === G.MAX_FIRES_PER_TICK, 'broken slot probe → legacy cap');
  }

  // ── 5. exclusive stage across siblings ─────────────────────────────────────
  {
    const { G, F, store, playbook } = fresh('5');
    const batch = F.createBatch(store, { profileId: 'u1', playbook, elements: ['e1', 'e2'], skipStages: ['workflow'], exclusiveStages: ['acceptance'] });
    await F.advanceFanout(store, { task: batch.task, item: store.getTaskItem(batch.item.id), llm: null });
    const st = F.parseFanout(store.getTaskItem(batch.item.id));
    const [t1, t2] = st.elements.map(e => store.getTask(e.childId, 'u1'));
    const items1 = store.listTaskItems(t1.id, 'u1'), items2 = store.listTaskItems(t2.id, 'u1');
    // e1: discover done, B1 done, B5 pending → inside acceptance. e2: discover done.
    store.completeItem(items1[0].id, 'u1'); store.completeItem(items1[1].id, 'u1');
    store.completeItem(items2[0].id, 'u1');
    const b1of2 = store.getTaskItem(items2[1].id);
    ok(F.stageLockedBySibling(store, store.getTask(t2.id, 'u1'), b1of2) === true, 'sibling inside the exclusive stage blocks entry');
    ok(F.stageLockedBySibling(store, store.getTask(t1.id, 'u1'), store.getTaskItem(items1[2].id)) === false, 'the holder itself continues');
    const fired = [];
    store.db.prepare('UPDATE task_items SET status = ?, due_at = ? WHERE id = ?').run('waiting', Date.now() + 3600e3, batch.item.id);
    makeDue(store, t2.id);
    await tick(G, async o => { fired.push(o.task); return 'DURABLE: done'; });
    ok(!fired.some(t => /B1 тест/.test(t) && t.includes(t2.id)), 'blocked sibling step was not fired');
    ok(store.getTaskItem(items2[1].id).status === 'waiting', 'blocked step waits, not failed');
    store.completeItem(items1[2].id, 'u1');
    ok(F.stageLockedBySibling(store, store.getTask(t2.id, 'u1'), store.getTaskItem(items2[1].id)) === false, 'lock released when the holder leaves the stage');
  }

  console.log(`playbook-fanout: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
