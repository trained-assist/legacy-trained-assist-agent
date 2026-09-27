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
  doctor: { engine: 'opencode', ocProfile: 'deepseek' },
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
  return async ({ task: prompt, engine, ocProfile }) => {
    const title = (prompt.match(/Step \(\d+\/\d+\): (.*)/) || [])[1] || '';
    const stepId = (prompt.match(/Step id: (\S+)/) || [])[1];
    const label = (prompt.match(/root_task_id: "([^"]+)"/) || [])[1] || null;
    calls.push({ title, engine, ocProfile, label });
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

async function drive(G, taskId, { runTask, registry, restartOn = null, maxTicks = 200 }) {
  const store = G.durableStore();
  for (let i = 0; i < maxTicks; i++) {
    store.db.prepare(`UPDATE task_items SET due_at = ? WHERE task_id = ? AND status = 'waiting'`).run(Date.now(), taskId);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry, runTask,
      llmValidate: async () => ({ status: 'pass', subject: null, evidence: { reason: 'offline e2e judge' } }),
      hookSinks: { notify: async () => {} },
    });
    await drain();
    if (restartOn && restartOn()) G.reconcileOrphanedRunning(store, { graceMs: 0 });
    const t = store.getTask(taskId, PROFILE);
    if (t.status === 'done') return t;
  }
  return store.getTask(taskId, PROFILE);
}

function startPlan(G, playbookId) {
  const { PlaybookStore } = require('../../src/playbook-store.js');
  const { compilePlaybook } = require('../../src/playbook-compiler.js');
  const pb = new PlaybookStore({ profileId: PROFILE }).get(playbookId);
  expect(pb, `playbook ${playbookId} must resolve from the sibling repo`).toBeTruthy();
  const c = compilePlaybook(pb, { goal: 'offline e2e: todo-cli' });
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
      if (items.some(i => i.minimum_model_level === 'doctor')) expect(ex.some(e => e.profile === 'deepseek')).toBe(true);

      // one workspace label for the whole plan
      const labels = new Set(calls.map(c => c.label));
      expect([...labels]).toEqual([`plan-${task.id.slice(0, 8)}`]);

      // the CI step parked on a durable wait and was re-run after CI went green
      expect(calls.filter(c => /^CI зел/.test(c.title)).length).toBe(2);
    }, 30_000);
  }

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
