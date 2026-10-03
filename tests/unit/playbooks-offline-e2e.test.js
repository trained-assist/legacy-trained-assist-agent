// Offline end-to-end of the three engineering playbooks (feature / debugging /
// new-software) on the REAL durable executor: real playbooks from the sibling
// software-engineering-playbooks checkout (CI clones it next to core), real
// compiler, store, runDueDurable, durable waits and restart re-queue — only the
// engines are scripted and GitHub is faked. Runs in seconds; it is the regression
// net for everything the live e2e (scripts/e2e/playbooks-e2e.js) found:
//   • levels route to the plan's engines and executions record them (#1627)
//   • a step killed by a restart is re-queued at boot (#1637)
//   • every step works in ONE plan workspace (#1647)
//   • ci_green sees green CI through Actions runs when check-runs is closed (fine-grained PAT)
//   • a step can park on task_item_wait and is re-run when the condition holds
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_PARENT = resolve(HERE, '..', '..', '..');
const SIBLING = ['software-engineering-playbooks', 'trained-assist-engineering']
  .map(d => join(REPO_PARENT, d))
  .find(d => existsSync(join(d, 'playbooks', 'feature.json')));
const ROOTS = process.env.PLAYBOOK_SIBLING_ROOTS || SIBLING || null;

const MODS = ['gtd-controller', 'durable-task-store', 'durable-task-migrations', 'durable-wait', 'data-paths',
  'playbook-store', 'playbook-compiler', 'playbook-executor', 'playbook-validators', 'playbook-hooks',
  'mcp-skills/tools/101-durable-tasks'].map(m => `../../src/${m}.js`);
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'PLAYBOOK_LEVEL_MAP', 'PLAYBOOK_SIBLING_ROOTS'];
const PROFILE = 'e2e';
const PR_URL = 'https://github.com/o/sandbox/pull/7';
const LEVEL_MAP = {
  doctor: { engine: 'opencode', ocProfile: 'service' },
  master: { engine: 'opencode', ocProfile: 'free' },
  bachelor: { engine: 'opencode', ocProfile: 'free' },
};

let root; const saved = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.PLAYBOOK_LEVEL_MAP;
  if (ROOTS) process.env.PLAYBOOK_SIBLING_ROOTS = ROOTS;
  root = mkdtempSync(join(tmpdir(), 'playbooks-offline-e2e-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

const drain = (ms = 15) => new Promise(r => setTimeout(r, ms));

// Fake GitHub: CI and merge become true on the 2nd poll. ci_green goes through the
// real validator with check-runs 403 (null) and green Actions runs.
function fakeGitHub() {
  const V = require('../../src/playbook-validators.js');
  let ciPolls = 0; let mergePolls = 0;
  const ghFetch = async (url) => {
    if (url.includes('/check-runs')) return null; // fine-grained PAT → 403
    if (url.includes('/actions/runs')) {
      ciPolls += 1;
      return { workflow_runs: [{ name: 'CI', status: ciPolls >= 2 ? 'completed' : 'in_progress', conclusion: ciPolls >= 2 ? 'success' : null }] };
    }
    if (/\/pulls\/\d+$/.test(url)) {
      const merged = url.includes('#merge') ? false : mergePolls >= 2;
      return { head: { sha: 'abc123' }, merged, state: merged ? 'closed' : 'open', html_url: PR_URL };
    }
    return null;
  };
  const base = V.createDefaultRegistry({ ghToken: () => 'tok', ghFetch, gitInfo: () => null });
  return {
    ...base,
    merged: async (ctx) => { mergePolls += 1; return base.merged(ctx); },
  };
}

// Scripted engines: behave like a well-formed agent, per step title.
function scriptedEngine({ calls, killOnce = null, onStep = null }) {
  const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
  const killed = new Set();
  const waited = new Set();
  return async ({ task: prompt, engine, ocProfile, sessionId, webExactSession }) => {
    const title = (prompt.match(/Step \(\d+\/\d+\): (.*)/) || [])[1] || '';
    const stepId = (prompt.match(/Step id: (\S+)/) || [])[1];
    const label = (prompt.match(/root_task_id: "([^"]+)"/) || [])[1] || null;
    calls.push({ title, engine, ocProfile, label, sessionId, webExactSession });
    if (onStep) await onStep({ title, stepId, prompt, tools });
    if (killOnce && killOnce.test(title) && !killed.has(title)) {
      killed.add(title);
      return new Promise(() => {}); // the engine dies with the restart; never answers
    }
    if (/^CI зел/.test(title) && !waited.has(stepId)) {
      waited.add(stepId);
      const r = await tools.task_item_wait.handler({
        item_id: stepId, until: { ci_green: PR_URL }, poll_every_sec: 60, timeout_sec: 3600, reason: 'ждём CI',
      }, { userId: PROFILE });
      if (r && r.error) throw new Error(r.error);
      return 'ждём CI\nDURABLE: waiting';
    }
    const pr = /Открыть PR/.test(title) ? `\nPR: ${PR_URL}` : '';
    return `ИТОГ ШАГА\n- ${title}: сделано${pr}\nDURABLE: done`;
  };
}

async function drive(G, taskId, { runTask, registry, restartOn = null, maxTicks = 200, llmValidate = null, notify = null }) {
  const store = G.durableStore();
  for (let i = 0; i < maxTicks; i++) {
    store.db.prepare(`UPDATE task_items SET due_at = ? WHERE task_id = ? AND status = 'waiting'`).run(Date.now(), taskId);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry, runTask,
      llmValidate: llmValidate || (async () => ({ status: 'pass', subject: null, evidence: { reason: 'offline e2e judge' } })),
      hookSinks: { notify: notify || (async () => {}) },
    });
    await drain();
    if (restartOn && restartOn()) G.reconcileOrphanedRunning(store, { graceMs: 0 });
    const t = store.getTask(taskId, PROFILE);
    if (t.status === 'done' || t.status === 'blocked') return t;
  }
  return store.getTask(taskId, PROFILE);
}

function startPlan(G, playbookId) {
  const { PlaybookStore } = require('../../src/playbook-store.js');
  const { compilePlaybook } = require('../../src/playbook-compiler.js');
  const pb = new PlaybookStore({ profileId: PROFILE }).get(playbookId);
  expect(pb, `playbook ${playbookId} must resolve from the sibling repo`).toBeTruthy();
  const c = compilePlaybook(pb, { goal: 'offline e2e: todo-cli', vars: { repo: 'acme/todo-cli' } });
  const store = G.durableStore();
  const { task } = store.createPlan({
    profile_id: PROFILE, goal: c.goal, user_value: c.user_value, acceptance_criteria: c.acceptance_criteria,
    items: c.items, hooks: c.hooks, playbook_id: pb.id, playbook_version: pb.version,
    execution_policy: { level_map: LEVEL_MAP, hooks_approved: true },
  });
  store.updateTask(task.id, PROFILE, { status: 'active' });
  return { store, task, items: c.items };
}

const suite = ROOTS ? describe : describe.skip;
if (!ROOTS && process.env.CI) throw new Error('offline playbook e2e: sibling software-engineering-playbooks checkout is missing in CI');

suite('playbooks offline e2e (real executor, scripted engines)', () => {
  for (const id of ['feature', 'debugging', 'new-software']) {
    it(`${id}: every step reaches done, levels route to the plan engines, one workspace`, async () => {
      const G = require('../../src/gtd-controller.js');
      const { store, task, items } = startPlan(G, id);
      const calls = [];
      const t = await drive(G, task.id, { runTask: scriptedEngine({ calls }), registry: fakeGitHub() });

      const rows = store.listTaskItems(task.id, PROFILE);
      expect(rows.filter(r => r.status !== 'done').map(r => `${r.position + 1}. ${r.title}: ${r.status} ${r.last_error || ''}`)).toEqual([]);
      expect(t.status).toBe('done');

      // level → engine routing, as recorded on the executions
      const ex = store.db.prepare('SELECT model_level, engine, profile FROM executions WHERE task_id = ? AND engine IS NOT NULL').all(task.id);
      expect(ex.length).toBeGreaterThan(0);
      for (const e of ex) expect([e.model_level, e.engine, e.profile]).toEqual([e.model_level, 'opencode', LEVEL_MAP[e.model_level].ocProfile]);
      if (items.some(i => i.minimum_model_level === 'doctor')) expect(ex.some(e => e.profile === 'service')).toBe(true);

      // one workspace label for the whole plan
      const labels = new Set(calls.map(c => c.label));
      expect([...labels]).toEqual([`plan-${task.id.slice(0, 8)}`]);
      // every step runs in the plan's OWN exact session — never the profile's chat session
      expect([...new Set(calls.map(c => `${c.sessionId}|${c.webExactSession}`))]).toEqual([`s-plan-${task.id.slice(0, 8)}|true`]);

      // The CI step parked on a durable wait while CI was red — that is unchanged (#1408).
      // What changed with #1959 is the RESUME: on the second claim the deterministic
      // `already_done: { ci_green: true }` pre-check finds the condition already true and
      // closes the step with ZERO model runs instead of paying for a second call that would
      // only re-confirm what the registry already knows. So exactly ONE model run for the step.
      const ciCalls = calls.filter(c => /^CI зел/.test(c.title));
      expect(ciCalls.length).toBe(1);
      // ...and it closed deterministically, not silently: the skip is audited with evidence.
      const ciStep = store.listTaskItems(task.id, PROFILE).find(r => /^CI зел/.test(r.title));
      const ciEvidence = store.db.prepare(
        "SELECT evidence_json FROM task_validation_results WHERE task_id = ? AND validator = 'ci_green'"
      ).get(task.id);
      expect(ciStep.status, 'ci-green step must reach done').toBe('done');
      expect(JSON.parse(ciEvidence.evidence_json).already_done,
        'resume must be closed by the already_done pre-check, not by a second model run').toBe(true);
    }, 30_000);
  }

  it('already_done: a step whose pre-check passes is closed with ZERO model runs (#1959)', async () => {
    const G = require('../../src/gtd-controller.js');
    const V = require('../../src/playbook-validators.js');
    const store = G.durableStore();
    const { task } = store.createPlan({
      profile_id: PROFILE, goal: 'already_done smoke', user_value: 'v',
      acceptance_criteria: [{ id: 'c', description: 'v', validations: [{ step: 'CI зелёный', validation: { ci_green: true } }] }],
      items: [
        { title: 'CI зелёный', instructions: `PR: ${PR_URL}`, execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ci_green: true }, already_done: { ci_green: true } },
        { title: 'Реализация', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { implementation_complete_and_sandbox_green: true } },
      ],
    });
    store.updateTask(task.id, PROFILE, { status: 'active' });
    // CI is already green → the already_done pre-check passes on the first poll.
    const registry = V.createDefaultRegistry({
      ghToken: () => 'tok',
      ghFetch: async url => {
        if (/\/pulls\/\d+$/.test(url)) return { head: { sha: 'abc123' }, state: 'open', html_url: PR_URL };
        if (url.includes('/check-runs')) return { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] };
        return null;
      },
      gitInfo: () => null,
    });
    const calls = [];
    const t = await drive(G, task.id, { runTask: scriptedEngine({ calls }), registry });

    const rows = store.listTaskItems(task.id, PROFILE);
    const ci = rows.find(r => /^CI зел/.test(r.title));
    expect(ci.status).toBe('done');
    // the pre-checked step never spawned an engine; the next step still did
    expect(calls.some(c => /^CI зел/.test(c.title))).toBe(false);
    expect(calls.some(c => /^Реализация/.test(c.title))).toBe(true);
    // the skip is audited as already_done, so the finalization gate is satisfied
    const v = store.db.prepare("SELECT evidence_json FROM task_validation_results WHERE task_id = ? AND validator = 'ci_green'").get(task.id);
    expect(JSON.parse(v.evidence_json).already_done).toBe(true);
    expect(t.status).toBe('done');
  }, 30_000);

  it('the agent may legally add a step after the current one and skip a later one', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task } = startPlan(G, 'feature');
    const calls = [];
    let added = null; let skipped = null;
    const onStep = async ({ title, stepId, prompt, tools }) => {
      if (!/^Предложение изменения/.test(title) || added) return;
      const planId = (prompt.match(/Plan id: (\S+)/) || [])[1];
      // add a follow-up check right after THIS step, with a full step contract
      const a = await tools.task_item_add.handler({
        task_id: planId, after_item_id: stepId, title: 'Доп. проверка: бенчмарк сортировки',
        execution_kind: 'agent', executor_role: 'verifier', minimum_model_level: 'bachelor', context_budget: 'small',
        validation: { benchmark_recorded: true }, instructions: 'Замерь todo list на 10k задач.',
      }, { userId: PROFILE });
      expect(a.error).toBeUndefined();
      added = a.item;
      // skip a later step that does not apply to a CLI, with a reason
      const { items } = await tools.task_get.handler({ task_id: planId }, { userId: PROFILE });
      const observe = items.find(i => /^Наблюдение после релиза/.test(i.title));
      const k = await tools.task_item_skip.handler({ item_id: observe.id, reason: 'CLI без прода — наблюдать нечего' }, { userId: PROFILE });
      expect(k.error).toBeUndefined();
      skipped = observe.id;
    };
    const t = await drive(G, task.id, { runTask: scriptedEngine({ calls, onStep }), registry: fakeGitHub() });

    expect(added).toBeTruthy();
    const titles = calls.map(c => c.title);
    const iPropose = titles.findIndex(x => /^Предложение изменения/.test(x));
    expect(titles[iPropose + 1]).toBe('Доп. проверка: бенчмарк сортировки'); // runs right after the step that added it
    const addedCall = calls.find(c => c.title === 'Доп. проверка: бенчмарк сортировки');
    expect([addedCall.engine, addedCall.ocProfile]).toEqual(['opencode', 'free']); // follows the plan level map
    expect(titles.some(x => /^Наблюдение после релиза/.test(x))).toBe(false); // skipped step never ran
    const sk = store.getTaskItem(skipped);
    expect(sk.status).toBe('skipped');
    expect(sk.last_error).toContain('CLI без прода');
    expect(t.status).toBe('done'); // a legal skip does not block finalization
  }, 30_000);

  it('plan edits have guard rails: no skipping a started step, no step without validation', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task } = startPlan(G, 'feature');
    const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
    const [first] = store.listTaskItems(task.id, PROFILE);
    store.updateTaskItem(first.id, { status: 'done' }, PROFILE);
    const k = await tools.task_item_skip.handler({ item_id: first.id, reason: 'поздно' }, { userId: PROFILE });
    expect(k.error).toMatch(/not started/);
    const noReason = await tools.task_item_skip.handler({ item_id: first.id, reason: ' ' }, { userId: PROFILE });
    expect(noReason.error).toBeTruthy();
    const a = await tools.task_item_add.handler({
      task_id: task.id, after_item_id: first.id, title: 'без проверки',
      execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small',
    }, { userId: PROFILE });
    expect(a.error).toMatch(/validation/);
    const other = await tools.task_item_add.handler({ task_id: task.id, title: 'x', validation: { ok: true } }, { userId: 'someone-else' });
    expect(other.error).toMatch(/not found/);
  });

  it('a step cut off by a restart is resumed in its own engine session — no re-run from scratch (#1671)', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task } = startPlan(G, 'feature');
    const calls = [];
    const base = scriptedEngine({ calls });
    let cutOff = null; // the resume sink of the run the restart killed
    const runTask = async (o) => {
      const title = (o.task.match(/Step \(\d+\/\d+\): (.*)/) || [])[1] || '';
      if (/^Реализация/.test(title) && !cutOff) {
        calls.push({ title, engine: o.engine, ocProfile: o.ocProfile });
        cutOff = o.resumeSink;
        return new Promise(() => {}); // engine dies with the old process
      }
      return base(o);
    };
    // drive until the implement step is cut off
    for (let i = 0; i < 100 && !cutOff; i++) {
      await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: fakeGitHub(), runTask,
        llmValidate: async () => ({ status: 'pass', subject: null, evidence: {} }), hookSinks: { notify: async () => {} } });
      await drain();
    }
    expect(cutOff).toMatchObject({ kind: 'durable', taskId: task.id });
    // restart: the boot sweep must NOT re-queue a step that is being resumed
    expect(G.reconcileOrphanedRunning(store, { graceMs: 0, exceptItemIds: [cutOff.itemId] })).toBe(0);
    expect(store.getTaskItem(cutOff.itemId).status).toBe('running');
    // the resumed engine session finishes; its reply settles the step
    await G.resumeDurableReply(cutOff, 'ИТОГ ШАГА\n- доделано после рестарта\nDURABLE: done', {
      store, registry: fakeGitHub(), hookSinks: { notify: async () => {} },
      llmValidate: async () => ({ status: 'pass', subject: null, evidence: { reason: 'offline e2e judge' } }),
    });
    expect(store.getTaskItem(cutOff.itemId).status).toBe('done');
    const t = await drive(G, task.id, { runTask, registry: fakeGitHub() });
    expect(t.status).toBe('done');
    expect(calls.filter(c => /^Реализация/.test(c.title))).toHaveLength(1); // never re-run from scratch
  }, 30_000);

  it('quality failures: attempt 2 gets the failure reasons, attempt 3 runs one level up', async () => {
    const G = require('../../src/gtd-controller.js');
    const { task } = startPlan(G, 'feature');
    const calls = []; const prompts = [];
    let fails = 0;
    const base = scriptedEngine({ calls });
    const runTask = async (o) => {
      const title = (o.task.match(/Step \(\d+\/\d+\): (.*)/) || [])[1] || '';
      if (/^Реализация/.test(title)) {
        prompts.push(o.task);
        if (fails < 2) { fails += 1; calls.push({ title, engine: o.engine, ocProfile: o.ocProfile }); return `тесты красные, попытка ${fails}\nDURABLE: failed: тесты красные (попытка ${fails})`; }
      }
      return base(o);
    };
    const t = await drive(G, task.id, { runTask, registry: fakeGitHub() });
    expect(t.status).toBe('done');
    const impl = calls.filter(c => /^Реализация/.test(c.title));
    expect(impl.map(c => `${c.engine}/${c.ocProfile}`)).toEqual(['opencode/free', 'opencode/free', 'opencode/service']);
    expect(prompts[0]).not.toContain('ПРОШЛЫЕ ПОПЫТКИ');
    expect(prompts[1]).toContain('ПРОШЛЫЕ ПОПЫТКИ');
    expect(prompts[1]).toContain('попытка 1');
    expect(prompts[2]).toContain('попытка 1');
    expect(prompts[2]).toContain('попытка 2');
  }, 30_000);

  it('doctor without credentials walks claude → codex → opencode doctor (#1689)', async () => {
    const G = require('../../src/gtd-controller.js');
    const { PlaybookStore } = require('../../src/playbook-store.js');
    const { compilePlaybook } = require('../../src/playbook-compiler.js');
    const pb = new PlaybookStore({ profileId: PROFILE }).get('new-software');
    const c = compilePlaybook(pb, { goal: 'offline e2e: doctor fallback', vars: { repo: 'acme/todo-cli' } });
    const store = G.durableStore();
    // default doctor rung (claude + fallback ladder); cheap levels on free
    const { task } = store.createPlan({
      profile_id: PROFILE, goal: c.goal, user_value: c.user_value, acceptance_criteria: c.acceptance_criteria,
      items: c.items, hooks: c.hooks, playbook_id: pb.id, playbook_version: pb.version,
      execution_policy: { level_map: { master: LEVEL_MAP.master, bachelor: LEVEL_MAP.bachelor }, hooks_approved: true },
    });
    store.updateTask(task.id, PROFILE, { status: 'active' });
    const calls = [];
    const base = scriptedEngine({ calls: [] });
    const runTask = async (o) => {
      const title = (o.task.match(/Step \(\d+\/\d+\): (.*)/) || [])[1] || '';
      calls.push({ title, engine: o.engine, ocProfile: o.ocProfile });
      if (o.engine === 'claude') return 'Not logged in · Please run /login';
      if (o.engine === 'codex') return 'Error: invalid api key';
      return base(o);
    };
    const t = await drive(G, task.id, { runTask, registry: fakeGitHub() });
    expect(t.status).toBe('done');
    const doc = calls.filter(x => /^Варианты решения/.test(x.title)).map(x => `${x.engine}/${x.ocProfile}`);
    expect(doc).toEqual(['claude/null', 'codex/null', 'opencode/doctor']);
    const ex = store.db.prepare(`SELECT engine, provider, error_class FROM executions e JOIN task_items i ON i.id = e.task_item_id
      WHERE e.task_id = ? AND i.title LIKE 'Варианты решения%' ORDER BY e.started_at`).all(task.id);
    expect(ex.map(e => [e.engine, e.provider, e.error_class])).toEqual([
      ['claude', null, 'AUTH'], ['codex', 'fallback-from-claude', 'AUTH'], ['opencode', 'fallback-from-claude', null]]);
  }, 30_000);

  it('doctor skips an engine marked unavailable by engine health, without burning an attempt', async () => {
    const G = require('../../src/gtd-controller.js');
    const { PlaybookStore } = require('../../src/playbook-store.js');
    const { compilePlaybook } = require('../../src/playbook-compiler.js');
    const pb = new PlaybookStore({ profileId: PROFILE }).get('new-software');
    const c = compilePlaybook(pb, { goal: 'offline e2e: health', vars: { repo: 'acme/todo-cli' } });
    const store = G.durableStore();
    const { task } = store.createPlan({
      profile_id: PROFILE, goal: c.goal, user_value: c.user_value, acceptance_criteria: c.acceptance_criteria,
      items: c.items, hooks: c.hooks, execution_policy: { level_map: { master: LEVEL_MAP.master, bachelor: LEVEL_MAP.bachelor } },
    });
    store.updateTask(task.id, PROFILE, { status: 'active' });
    const calls = [];
    const runTask = scriptedEngine({ calls });
    const registry = fakeGitHub();
    for (let i = 0; i < 200; i++) {
      store.db.prepare(`UPDATE task_items SET due_at = ? WHERE task_id = ? AND status = 'waiting'`).run(Date.now(), task.id);
      await G.runDueDurable({
        secrets: {}, now: Date.now(), isTaskRunning: () => false, registry, runTask,
        llmValidate: async () => ({ status: 'pass', subject: null, evidence: {} }), hookSinks: { notify: async () => {} },
        engineHealth: e => ({ status: e === 'claude' ? 'unavailable' : 'healthy' }),
      });
      await drain();
      if (store.getTask(task.id, PROFILE).status === 'done') break;
    }
    expect(store.getTask(task.id, PROFILE).status).toBe('done');
    const doc = calls.filter(x => /^Варианты решения/.test(x.title)).map(x => x.engine);
    expect(doc).toEqual(['codex']);
  }, 30_000);

  it('soft finalization: semantic checks the judge rejects do not block — logged as unconfirmed', async () => {
    const G = require('../../src/gtd-controller.js');
    const { readDefects } = require('../../src/playbook-defects-log.js');
    const { task } = startPlan(G, 'feature');
    const t = await drive(G, task.id, { runTask: scriptedEngine({ calls: [] }), registry: fakeGitHub(),
      llmValidate: async () => ({ status: 'fail', subject: null, evidence: { reason: 'judge says no' } }) });
    expect(t.status).toBe('done'); // red checks (pr_opened, ci_green, merged…) passed deterministically
    const d = readDefects({ taskId: task.id });
    expect(d.length).toBeGreaterThan(0);
    expect(d.every(x => x.kind === 'unconfirmed')).toBe(true);
    expect(d.map(x => x.validator)).not.toContain('ci_green');
  }, 30_000);

  it('strict finalization: the same run is blocked (never a silent stall) and the owner is told', async () => {
    const G = require('../../src/gtd-controller.js');
    const { readDefects } = require('../../src/playbook-defects-log.js');
    const { PlaybookStore } = require('../../src/playbook-store.js');
    const { compilePlaybook } = require('../../src/playbook-compiler.js');
    const pb = new PlaybookStore({ profileId: PROFILE }).get('feature');
    const c = compilePlaybook(pb, { goal: 'strict', vars: { repo: 'acme/todo-cli' } });
    const store = G.durableStore();
    const { task } = store.createPlan({ profile_id: PROFILE, goal: c.goal, user_value: c.user_value,
      acceptance_criteria: c.acceptance_criteria, items: c.items, hooks: c.hooks, playbook_id: pb.id, playbook_version: pb.version,
      execution_policy: { level_map: LEVEL_MAP, hooks_approved: true, finalization: 'strict' } });
    store.updateTask(task.id, PROFILE, { status: 'active' });
    const told = [];
    const t = await drive(G, task.id, { runTask: scriptedEngine({ calls: [] }), registry: fakeGitHub(),
      llmValidate: async () => ({ status: 'fail', subject: null, evidence: { reason: 'judge says no' } }),
      notify: async ({ text }) => { told.push(text); } });
    expect(t.status).toBe('blocked');
    expect(store.getTask(task.id, PROFILE).blocker_reason).toMatch(/unmet checks/);
    expect(told.some(x => /unmet checks/.test(x))).toBe(true);
    expect(readDefects({ taskId: task.id, kind: 'blocked' }).length).toBeGreaterThan(0);
  }, 30_000);

  it('an agent may close its current step as an exception — no judge, logged, plan goes on', async () => {
    const G = require('../../src/gtd-controller.js');
    const { readDefects } = require('../../src/playbook-defects-log.js');
    const { task } = startPlan(G, 'feature');
    const judged = [];
    const onStep = async ({ title, stepId, tools }) => {
      if (!/^Наблюдение после релиза/.test(title)) return;
      const r = await tools.task_item_exception.handler({ item_id: stepId, reason: 'CLI без прода — наблюдать нечего' }, { userId: PROFILE });
      expect(r.error).toBeUndefined();
    };
    const t = await drive(G, task.id, { runTask: scriptedEngine({ calls: [], onStep }), registry: fakeGitHub(),
      llmValidate: async (ctx) => { judged.push(ctx.item.title); return { status: 'pass', subject: null, evidence: {} }; } });
    expect(t.status).toBe('done');
    expect(judged.some(x => /^Наблюдение после релиза/.test(x))).toBe(false); // no judge for an exception
    const ex = readDefects({ taskId: task.id, kind: 'exception' });
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ step: expect.stringMatching(/^Наблюдение/), reason: 'CLI без прода — наблюдать нечего', playbook: 'feature' });
    // guard: a step that is not running cannot be excepted
    const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
    const [first] = G.durableStore().listTaskItems(task.id, PROFILE);
    expect((await tools.task_item_exception.handler({ item_id: first.id, reason: 'x' }, { userId: PROFILE })).error).toMatch(/running/);
  }, 30_000);

  it('a step killed by a restart is re-queued and completes', async () => {
    const G = require('../../src/gtd-controller.js');
    const { store, task } = startPlan(G, 'feature');
    const calls = [];
    let restarted = false;
    const runTask = scriptedEngine({ calls, killOnce: /Песочница|Реализация/ });
    const t = await drive(G, task.id, {
      runTask, registry: fakeGitHub(),
      // simulate the deploy restart right after the killed engine was fired
      restartOn: () => {
        const running = store.db.prepare(`SELECT count(*) n FROM task_items WHERE task_id = ? AND status = 'running'`).get(task.id).n;
        if (running && !restarted) { restarted = true; return true; }
        if (!running) restarted = false;
        return false;
      },
    });
    expect(t.status).toBe('done');
    const interrupted = store.db.prepare(`SELECT count(*) n FROM executions WHERE task_id = ? AND status = 'interrupted'`).get(task.id).n;
    expect(interrupted).toBeGreaterThan(0);
  }, 30_000);
});
