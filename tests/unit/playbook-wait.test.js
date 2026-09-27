// Durable wait steps: a programmatic step whose condition is not met yet sleeps
// (no model, no attempt spent, survives restarts) and re-polls until it passes or
// its timeout elapses. Plus the wait-condition validators (http_ok, token_present,
// task_done), the run-notebook PR fallback, and the notebook line in agent prompts.
//
// data-paths.js captures USERS_DIR/AGENT_DATA_DIR at load, so every loader clears
// the require cache (same pattern as playbook-hooks.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let root;
const saved = {};
const ENV_KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT'];

const MODS = [
  '../../src/gtd-controller.js', '../../src/durable-task-store.js', '../../src/durable-task-migrations.js',
  '../../src/playbook-hooks.js', '../../src/playbook-store.js', '../../src/playbook-compiler.js',
  '../../src/playbook-validators.js', '../../src/data-paths.js',
];

function fresh() {
  for (const m of MODS) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}
function freshGTD() { fresh(); return require('../../src/gtd-controller.js'); }

const drain = (ms = 25) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'playbook-wait-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'data');
  process.env.AGENT_TOKENS_DIR = join(root, 'tokens');
  process.env.AGENT_TOKENS_ROOT = join(root, 'tokens');
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

function waitPlan(G, { wait = { poll_sec: 300, timeout_sec: 3600 }, validation = { cond: true }, hooks = null, policy = null } = {}) {
  const store = G.durableStore();
  const r = store.createPlan({
    profile_id: 'u1', goal: 'wait goal', user_value: 'uv',
    acceptance_criteria: [{ id: 'c', description: 'c' }],
    execution_policy: policy || { validation_mode: 'programmatic', hooks_approved: true },
    hooks,
    items: [{ title: 'wait for it', stage: 's1', execution_kind: 'programmatic', validation, wait }],
  });
  store.updateTask(r.task.id, 'u1', { status: 'active' });
  const [item] = store.listTaskItems(r.task.id, 'u1');
  return { store, taskId: r.task.id, itemId: item.id };
}

const tick = (G, registry, extra = {}) => G.runDueDurable({
  secrets: {}, now: Date.now(), isTaskRunning: () => false, registry,
  runTask: async () => 'DURABLE: done', hookSinks: { notify: async () => {} }, ...extra,
});

describe('wait — contract and compile', () => {
  it('compiles a step wait with defaults and keeps it on the item', () => {
    fresh();
    const { compilePlaybook, DEFAULT_WAIT_POLL_SEC, DEFAULT_WAIT_TIMEOUT_SEC } = require('../../src/playbook-compiler.js');
    const { validatePlaybook } = require('../../src/playbook-store.js');
    const pb = {
      id: 'w', version: 1, scope: 'profile', title: 'W', goal_template: '{input}',
      stages: [{ id: 's', title: 'S', steps: [
        { title: 'deploy live', execution_kind: 'programmatic', validation: { http_ok: 'https://x/health' }, wait: {} },
        { title: 'errors gone', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' }, wait: { poll_sec: 600, timeout_sec: 7200 } },
      ] }],
    };
    expect(() => validatePlaybook(pb)).not.toThrow();
    const { items } = compilePlaybook(pb, { goal: 'g' });
    expect(items[0].wait).toEqual({ poll_sec: DEFAULT_WAIT_POLL_SEC, timeout_sec: DEFAULT_WAIT_TIMEOUT_SEC });
    expect(items[1].wait).toEqual({ poll_sec: 600, timeout_sec: 7200 });
  });

  it('rejects wait on an agent step and a too-short poll', () => {
    fresh();
    const { validateItem } = require('../../src/durable-task-plan.js');
    const agent = { title: 't', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { ok: true }, wait: {} };
    expect(() => validateItem(agent)).toThrow(/programmatic/);
    const fast = { title: 't', execution_kind: 'programmatic', validation: { ok: true }, wait: { poll_sec: 5 } };
    expect(() => validateItem(fast)).toThrow(/wait.poll_sec/);
  });
});

describe('wait — durable executor', () => {
  it('sleeps without spending attempts, then completes when the condition passes', async () => {
    const G = freshGTD();
    const { store, itemId, taskId } = waitPlan(G);
    let ready = false;
    const registry = { cond: async () => ({ status: ready ? 'pass' : 'fail', subject: null, evidence: {} }) };

    await tick(G, registry);
    let item = store.getTaskItem(itemId);
    expect(item.status).toBe('waiting');
    expect(item.attempt_count).toBe(0);
    expect(item.wait_started_at).toBeGreaterThan(0);
    expect(item.due_at).toBeGreaterThan(Date.now() + 250_000);
    const firstStart = item.wait_started_at;

    // Not due yet → nothing is claimed.
    await tick(G, registry);
    expect(store.getTaskItem(itemId).status).toBe('waiting');

    // Next poll (still unmet) keeps the original wait window.
    await tick(G, registry, { now: item.due_at + 1 });
    item = store.getTaskItem(itemId);
    expect(item.status).toBe('waiting');
    expect(item.wait_started_at).toBe(firstStart);
    expect(item.attempt_count).toBe(0);

    ready = true;
    await tick(G, registry, { now: item.due_at + 1 });
    expect(store.getTaskItem(itemId).status).toBe('done');
    expect(store.getTask(taskId, 'u1').status).toBe('done');
  });

  it('fails terminally with task_failed once the wait times out', async () => {
    const G = freshGTD();
    const { store, itemId, taskId } = waitPlan(G, {
      hooks: { task_failed: [{ type: 'notify', text: 'stuck: {error}' }] },
    });
    const delivered = [];
    const registry = { cond: async () => ({ status: 'fail', subject: null, evidence: {} }) };
    // Start the wait, then pretend it began long ago.
    await tick(G, registry);
    store.db.prepare('UPDATE task_items SET wait_started_at = ?, due_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 3600 * 1000, Date.now() - 1, itemId);

    await tick(G, registry, { hookSinks: { notify: async ({ text }) => { delivered.push(text); } } });
    await drain();
    const item = store.getTaskItem(itemId);
    expect(item.status).toBe('failed');
    expect(item.last_error).toMatch(/wait timeout/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/stuck: wait timeout/);
    expect(store.getTask(taskId, 'u1').status).not.toBe('done');
  });

  it('never asks the LLM judge on a waiting step, even under programmatic+llm', async () => {
    const G = freshGTD();
    const { store, itemId } = waitPlan(G, { policy: { validation_mode: 'programmatic+llm', hooks_approved: true } });
    let llmCalls = 0;
    const registry = { cond: async () => ({ status: 'inconclusive', subject: null, evidence: { reason: 'not yet' } }) };
    await tick(G, registry, { llmValidate: async () => { llmCalls += 1; return { status: 'pass', subject: null, evidence: {} }; } });
    expect(llmCalls).toBe(0);
    expect(store.getTaskItem(itemId).status).toBe('waiting');
  });
});

describe('run notebook', () => {
  it('agent step prompt names the notebook and the plan id', async () => {
    const G = freshGTD();
    const store = G.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'nb goal', user_value: 'uv', acceptance_criteria: [{ id: 'c', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'write', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { ok: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    let prompt = '';
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      runTask: async ({ task }) => { prompt = task; return 'DURABLE: done'; },
    });
    await drain();
    const nb = G.runNotebookPath(store.getTask(r.task.id, 'u1'));
    expect(nb).toContain(join('u1', 'playbook-runs', `${r.task.id}.md`));
    expect(prompt).toContain(nb);
    expect(prompt).toContain(`Plan (task) id: ${r.task.id}`);
  });

  it('ci/merge validators find the PR an earlier step wrote to the notebook', () => {
    fresh();
    const { extractPrRef } = require('../../src/playbook-validators.js');
    const ctx = {
      item: { title: 'Wait for CI' }, task: { goal: 'g' },
      runText: 'old https://github.com/o/r/pull/1\n## 9. Open PR\nhttps://github.com/o/r/pull/42',
    };
    expect(extractPrRef(ctx)).toMatchObject({ owner: 'o', repo: 'r', number: '42' });
    expect(extractPrRef({ item: { title: 'x https://github.com/a/b/pull/7' }, runText: ctx.runText }).number).toBe('7');
    expect(extractPrRef({ item: {}, runText: '' })).toBeNull();
  });
});

describe('wait-condition validators', () => {
  it('http_ok passes on 2xx + contains, fails otherwise', async () => {
    fresh();
    const { makeHttpOkValidator } = require('../../src/playbook-validators.js');
    const fake = body => async () => ({ ok: true, status: 200, text: async () => body });
    const v = makeHttpOkValidator({ fetchImpl: fake('{"commit":"abc123"}') });
    expect((await v({ validation: { url: 'https://h/health', contains: 'abc123' } })).status).toBe('pass');
    expect((await v({ validation: { url: 'https://h/health', contains: 'zzz' } })).status).toBe('fail');
    const down = makeHttpOkValidator({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect((await down({ validation: 'https://h/health' })).status).toBe('fail');
    expect((await v({ validation: 'not-a-url' })).status).toBe('inconclusive');
  });

  it('token_present passes once the profile has the credential file', () => {
    fresh();
    const { tokenPresent } = require('../../src/playbook-validators.js');
    expect(tokenPresent({ profileId: 'u1', validation: 'github' }).status).toBe('fail');
    mkdirSync(join(root, 'tokens', 'u1'), { recursive: true });
    writeFileSync(join(root, 'tokens', 'u1', 'github'), 'ghp_x');
    expect(tokenPresent({ profileId: 'u1', validation: 'github' }).status).toBe('pass');
    expect(tokenPresent({ profileId: 'u1', validation: '../etc' }).status).toBe('inconclusive');
  });

  it('task_done reflects another plan status', () => {
    fresh();
    const { makeTaskDoneValidator } = require('../../src/playbook-validators.js');
    const statuses = { t1: 'active', t2: 'done' };
    const v = makeTaskDoneValidator({ taskStatus: id => statuses[id] ?? null });
    expect(v({ profileId: 'u1', validation: 't1' }).status).toBe('fail');
    expect(v({ profileId: 'u1', validation: 't2' }).status).toBe('pass');
    expect(v({ profileId: 'u1', validation: 'nope' }).status).toBe('inconclusive');
  });
});

describe('run-time probes declared in the notebook', () => {
  const notebook = [
    '## 5. Declare plan',
    'PROBE deploy_live: http_ok https://h/health contains abc123',
    '- `PROBE error_gone: command true`',
    'PROBE staging: skip no staging here',
    'PROBE flaky: command false',
    'PROBE flaky: command true', // re-declared later — last wins
  ].join('\n');

  it('parses the last declaration of each probe', () => {
    fresh();
    const { parseProbes } = require('../../src/playbook-validators.js');
    const p = parseProbes(notebook);
    expect(p.deploy_live).toEqual({ kind: 'http_ok', arg: 'https://h/health contains abc123' });
    expect(p.error_gone).toEqual({ kind: 'command', arg: 'true' });
    expect(p.flaky.arg).toBe('true');
  });

  it('probe runs http_ok / command / skip and fails when undeclared', async () => {
    fresh();
    const { makeProbeValidator, makeHttpOkValidator } = require('../../src/playbook-validators.js');
    const httpOk = makeHttpOkValidator({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'commit abc123' }) });
    const v = makeProbeValidator({ httpOk });
    const ctx = name => ({ validation: name, runText: notebook, projectDir: root });
    expect((await v(ctx('deploy_live'))).status).toBe('pass');
    expect((await v(ctx('error_gone'))).status).toBe('pass');
    expect((await v(ctx('flaky'))).status).toBe('pass');
    expect((await v(ctx('staging'))).evidence).toMatchObject({ skipped: true });
    const missing = await v(ctx('nope'));
    expect(missing.status).toBe('fail');
    expect(missing.evidence.reason).toBe('probe-not-declared');
  });

  it('probes_declared checks the declaring step', () => {
    fresh();
    const { probesDeclared } = require('../../src/playbook-validators.js');
    expect(probesDeclared({ validation: ['deploy_live', 'error_gone'], runText: notebook }).status).toBe('pass');
    const r = probesDeclared({ validation: ['deploy_live', 'x'], runText: notebook });
    expect(r.status).toBe('fail');
    expect(r.evidence.missing).toEqual(['x']);
  });
});

describe('resumeItem', () => {
  it('re-arms a failed wait step with a fresh budget and wait window', async () => {
    const G = freshGTD();
    const { store, itemId } = waitPlan(G);
    store.db.prepare(`UPDATE task_items SET status='failed', attempt_count=3, wait_started_at=1, last_error='wait timeout' WHERE id=?`).run(itemId);
    const item = store.resumeItem(itemId, 'u1');
    expect(item).toMatchObject({ status: 'pending', attempt_count: 0, wait_started_at: null, last_error: null });
    expect(store.resumeItem(itemId, 'someone-else')).toBeNull();
  });
});

describe('BLOCKED-ON-USER', () => {
  it('parks the step without recovery and asks the owner once per block', async () => {
    const G = freshGTD();
    const store = G.durableStore();
    const r = store.createPlan({
      profile_id: 'u1', goal: 'needs creds', user_value: 'uv', acceptance_criteria: [{ id: 'c', description: 'c' }],
      execution_policy: { validation_mode: 'programmatic' },
      items: [{ title: 'connect', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { ok: true } }],
    });
    store.updateTask(r.task.id, 'u1', { status: 'active' });
    const [item] = store.listTaskItems(r.task.id, 'u1');
    const sent = [];
    let runs = 0;
    const tickOnce = () => G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: {},
      hookSinks: { notify: async ({ text }) => { sent.push(text); } },
      runTask: async () => { runs += 1; return 'нет доступа\nDURABLE: failed: BLOCKED-ON-USER: дай GitHub-токен с правом repo'; },
    });
    await tickOnce(); await drain();
    let it = store.getTaskItem(item.id);
    expect(it.status).toBe('failed');
    expect(it.last_recovery_action).toBe('await-user');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('дай GitHub-токен с правом repo');
    expect(sent[0]).toContain(`task_item_resume ${item.id}`);

    await tickOnce(); await drain();
    expect(runs).toBe(1); // no retry while blocked

    store.resumeItem(item.id, 'u1');
    await tickOnce(); await drain();
    expect(runs).toBe(2);
    expect(sent).toHaveLength(2); // asks again after resume
  });
});
