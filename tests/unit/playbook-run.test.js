// Unit tests for Playbook compilation (issue #1372, slice P2): a saved
// Playbook v1 + a goal compile into a durable DRAFT plan through the same
// atomic task_create path, pinning {playbook_id, playbook_version}.
//
// Covers: step contract carry-over (role/level/budget/validation/defaults),
// goal_template rendering, derived vs explicit acceptance criteria, version-pin
// immutability (editing a playbook never mutates a running plan), compile-time
// rejection of a contract-invalid agent step, profile isolation, the checklist.md
// projection on a non-legacy plan, and survival across a real process restart.
//
// data-paths.js captures USERS_DIR/AGENT_DATA_DIR at load, so every loader clears
// the require cache (same pattern as tests/unit/durable-plan-persistence.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let root;
let prevUsers;
let prevData;
let prevSiblingRoots;

const PATHS = '../../src/data-paths.js';
const STORE = '../../src/playbook-store.js';
const AUTHORING = '../../src/playbook-authoring.js';
const COMPILER = '../../src/playbook-compiler.js';
const DSTORE = '../../src/durable-task-store.js';
const DURABLE = '../../src/mcp-skills/tools/101-durable-tasks.js';
const PROJECTS = '../../src/projects.js';
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';

function fresh(...mods) {
  for (const m of mods) delete require.cache[require.resolve(m)];
}

function loadTools() {
  fresh(TOOL, COMPILER, AUTHORING, STORE, DURABLE, DSTORE, PROJECTS, PATHS);
  // Merge in the durable-task tools so assertions can reuse task_get/task_list;
  // both files resolve the same lazily-cached modules and SQLite store.
  return { ...require(TOOL).tools, ...require(DURABLE).tools };
}

function profilePlaybooks(profile) { return join(root, 'users', profile, 'playbooks'); }

function writeProfilePlaybook(profile, obj) {
  mkdirSync(profilePlaybooks(profile), { recursive: true });
  writeFileSync(join(profilePlaybooks(profile), `${obj.id}.json`), JSON.stringify(obj, null, 2));
}

function writeProject(profile, id) {
  const dir = join(root, 'users', profile, 'projects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id }));
}

const ALICE = { userId: 'alice' };

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  prevData = process.env.AGENT_DATA_DIR;
  prevSiblingRoots = process.env.PLAYBOOK_SIBLING_ROOTS;
  root = mkdtempSync(join(tmpdir(), 'playbook-run-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'data');
  // The development playbook now lives in the trained-assist-engineering sibling
  // repo. CI has no sibling checkout on disk, so point resolution at a fixture
  // sibling built from tests/fixtures/development.json — otherwise these tests
  // would pass only on a dev machine that happens to have the sibling cloned.
  const siblingRoot = join(root, 'siblings', 'trained-assist-engineering');
  mkdirSync(join(siblingRoot, 'playbooks'), { recursive: true });
  writeFileSync(join(siblingRoot, 'playbooks', 'development.json'),
    readFileSync(new URL('../fixtures/development.json', import.meta.url), 'utf8'));
  process.env.PLAYBOOK_SIBLING_ROOTS = siblingRoot;
});

afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR;
  else process.env.USERS_DIR = prevUsers;
  if (prevData === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = prevData;
  if (prevSiblingRoots === undefined) delete process.env.PLAYBOOK_SIBLING_ROOTS;
  else process.env.PLAYBOOK_SIBLING_ROOTS = prevSiblingRoots;
  rmSync(root, { recursive: true, force: true });
});

describe('compilePlaybook', () => {
  const base = () => ({
    id: 'sample', version: 1, scope: 'profile', title: 'Sample',
    goal_template: 'Оценить {input}',
    user_value_template: 'Решение по «{input}»',
    defaults: { max_attempts: 5, execution_timeout_seconds: 900 },
    stages: [{
      id: 's1', title: 'Stage',
      steps: [
        { title: 'Первый шаг', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small', validation: { facts: true } },
        { title: 'Проверка', execution_kind: 'programmatic', validation: { ci_green: true } },
      ],
    }],
  });

  it('renders the goal, carries the step contract and applies playbook defaults', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const out = compilePlaybook(base(), { goal: 'acme' });
    expect(out.goal).toBe('Оценить acme');
    expect(out.user_value).toBe('Решение по «acme»');
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({
      title: 'Первый шаг', stage: 's1', execution_kind: 'agent',
      executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small',
      max_attempts: 5, execution_timeout_seconds: 900, delay_after_sec: 0,
    });
    expect(out.items[0].validation).toEqual({ facts: true });
    expect(out.items[1]).toMatchObject({ execution_kind: 'programmatic', executor_role: null, minimum_model_level: null, context_budget: null });
  });

  it('keeps a slotless goal_template and appends the run goal (never drops it)', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const pb = base();
    pb.goal_template = 'Оценить проект';
    expect(compilePlaybook(pb, { goal: 'acme' }).goal).toBe('Оценить проект — acme');
  });

  it('rejects an agent step missing its executor contract instead of inventing a default', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const pb = base();
    delete pb.stages[0].steps[0].executor_role;
    expect(() => compilePlaybook(pb, { goal: 'x' })).toThrow(/COMPILE_INVALID/);
  });

  it('requires a goal', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    expect(() => compilePlaybook(base(), { goal: '  ' })).toThrow(/GOAL_REQUIRED/);
  });

  // #1725: an engineering plan whose steps kept a literal «Репозиторий: {repo}» stalled in the background.
  const withRepoInput = () => {
    const pb = base();
    pb.inputs = [{ name: 'repo', description: 'целевой репозиторий owner/name', derive: 'github_repo' }];
    pb.stages[0].steps[0].instructions = 'Репозиторий: {repo}';
    return pb;
  };

  it('rejects a run without a required input instead of leaving {repo} in the steps', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    expect(() => compilePlaybook(withRepoInput(), { goal: 'починить кнопку' })).toThrow(/INPUT_REQUIRED[\s\S]*vars\.repo/);
  });

  it('renders a required input from vars', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const out = compilePlaybook(withRepoInput(), { goal: 'починить кнопку', vars: { repo: 'acme/app' } });
    expect(out.items[0].instructions).toBe('Репозиторий: acme/app');
  });

  it('derives the repo from a single GitHub link in the goal, never from two different ones', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const out = compilePlaybook(withRepoInput(), { goal: 'баг https://github.com/acme/app/issues/7' });
    expect(out.items[0].instructions).toBe('Репозиторий: acme/app');
    expect(() => compilePlaybook(withRepoInput(), { goal: 'https://github.com/a/x и https://github.com/b/y' }))
      .toThrow(/INPUT_REQUIRED/);
  });

  it('an optional input may stay unset; playbooks without inputs are unchanged', () => {
    fresh(COMPILER, STORE, PATHS);
    const { compilePlaybook } = require(COMPILER);
    const pb = withRepoInput();
    pb.inputs[0].required = false;
    expect(compilePlaybook(pb, { goal: 'x' }).items[0].instructions).toBe('Репозиторий: {repo}');
    expect(compilePlaybook(base(), { goal: 'x' }).items).toHaveLength(2);
  });
});

describe('MCP surface: playbook_run', () => {
  it('compiles the system development playbook into a draft plan with the pinned version', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Готовить P2' }, ALICE);

    expect(res.task.status).toBe('draft');
    expect(res.task.goal).toBe('Готовить P2');
    expect(res.task.playbook_id).toBe('development');
    expect(res.task.playbook_version).toBe(1);
    expect(res.playbook).toMatchObject({ id: 'development', version: 1, scope: 'system', source: 'sibling' });
    expect(res.summary).toEqual({ stages: 5, items: 16 });
    expect(res.items).toHaveLength(16);

    const first = res.items[0];
    expect(first.stage).toBe('frame');
    expect(first.executor_role).toBe('researcher');
    expect(first.minimum_model_level).toBe('bachelor');
    expect(first.context_budget).toBe('small');
    expect(first.max_attempts).toBe(3);
    expect(first.execution_timeout_seconds).toBe(600);
    expect(JSON.parse(first.validation_json)).toEqual({ user_value_written: true });

    const programmatic = res.items.find(i => i.title === 'Run tests, lint and regression checks');
    expect(programmatic.execution_kind).toBe('programmatic');
    expect(programmatic.executor_role).toBeNull();
    expect(res.render).toContain('Engineering development');
  });

  it('activate=true creates the plan already active (agreed task = activation consent, #1719)', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Согласовано', activate: true }, ALICE);
    expect(res.task.status).toBe('active');
    const got = await tools.task_get.handler({ task_id: res.task.id }, ALICE);
    expect(got.task.status).toBe('active');
    // Activation is not hook consent: external-effect hooks still need approve_hooks.
    expect(JSON.parse(got.task.execution_policy_json || '{}').hooks_approved).not.toBe(true);
  });

  it('returns every step with enabled, and switches off the ones that do not apply before start', async () => {
    const tools = loadTools();
    const all = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Все шаги' }, ALICE);
    expect(all.steps).toHaveLength(16);
    expect(all.steps.every(s => s.enabled)).toBe(true);
    expect(all.steps.find(s => s.step === 'Wait for CI and staging; repair failures').protected).toBe(true);
    expect(all.steps_hint).toMatch(/enabled:false/);

    const res = await tools.playbook_run.handler({
      playbook_id: 'development', goal: 'Однострочный фикс', activate: true,
      steps: [
        { step: 'Identify root cause when needed', enabled: false, reason: 'причина уже известна' },
        { step: 8, enabled: false, reason: 'одна правка — нарезать нечего' },
        { step: 'Implement', enabled: true },
      ],
    }, ALICE);
    expect(res.task.status).toBe('active');
    const off = res.steps.filter(s => !s.enabled).map(s => s.step);
    expect(off).toEqual(['Identify root cause when needed', 'Split implementation into small slices']);
    const got = await tools.task_get.handler({ task_id: res.task.id }, ALICE);
    const skipped = got.items.filter(i => i.status === 'skipped').map(i => i.title);
    expect(skipped).toEqual(off);
  });

  it('refuses to switch off a CI/merge gate, an unknown step or a step without reason — and writes no plan', async () => {
    const tools = loadTools();
    const gate = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'g',
      steps: [{ step: 'Wait for CI and staging; repair failures', enabled: false, reason: 'долго' }] }, ALICE);
    expect(gate.code).toBe('STEP_PROTECTED');
    const unknown = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'g',
      steps: [{ step: 'Нет такого', enabled: false, reason: 'r' }] }, ALICE);
    expect(unknown.code).toBe('STEP_NOT_FOUND');
    const noReason = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'g',
      steps: [{ step: 2, enabled: false }] }, ALICE);
    expect(noReason.code).toBe('STEP_REASON_REQUIRED');
    const list = await tools.task_list.handler({}, ALICE);
    expect(list.tasks).toHaveLength(0);
  });

  it('without activate the plan stays a draft', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Черновик', activate: false }, ALICE);
    expect(res.task.status).toBe('draft');
  });

  it('derives task-level acceptance criteria from step validations, or uses explicit ones', async () => {
    const tools = loadTools();
    const derived = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'derived' }, ALICE);
    const criteria = JSON.parse(derived.task.acceptance_criteria_json);
    expect(criteria).toHaveLength(1);
    expect(criteria[0].source).toBe('playbook:development@1');
    expect(criteria[0].validations).toHaveLength(16);

    const explicit = await tools.playbook_run.handler({
      playbook_id: 'development', goal: 'explicit',
      acceptance_criteria: [{ id: 'acme', description: 'acme accepted' }],
    }, ALICE);
    expect(JSON.parse(explicit.task.acceptance_criteria_json)).toEqual([{ id: 'acme', description: 'acme accepted' }]);
  });

  it('renders checklist.md for a project-bound contract plan and re-renders it from the DB', async () => {
    const tools = loadTools();
    writeProject('alice', 'proj');
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'G', project_id: 'proj' }, ALICE);

    expect(res.projection).toBeTruthy();
    const md = readFileSync(res.projection, 'utf8');
    expect(md).toContain('[researcher/bachelor/small] Define user value');
    expect(md).toContain('[programmatic] Run tests, lint and regression checks');

    const got = await tools.task_get.handler({ task_id: res.task.id }, ALICE);
    expect(got.items).toHaveLength(16);
    expect(readFileSync(got.projection, 'utf8')).toContain('Finalize only with current acceptance evidence');
  });

  it('carries the playbook hooks into the persisted plan (P4)', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'hooks' }, ALICE);
    const hooks = JSON.parse(res.task.hooks_json);
    expect(hooks.task_done).toEqual([{ type: 'notify', to: 'owner', text: 'Task done: {goal}' }]);
    expect(hooks.task_failed[0]).toMatchObject({ type: 'notify', to: 'owner' });
    // External-effect hooks are only consented to when the run opts in.
    expect(res.task.execution_policy_json).toBeNull();
    const approved = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'hooks ok', approve_hooks: true }, ALICE);
    expect(JSON.parse(approved.task.execution_policy_json)).toEqual({ hooks_approved: true });
    const esc = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'escalate ok', escalate_to_doctor: true }, ALICE);
    expect(JSON.parse(esc.task.execution_policy_json)).toEqual({ quality_escalation_to_doctor: true });
  });

  it('pins the version: editing the playbook never mutates a plan already run', async () => {
    const tools = loadTools();
    const first = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'pin' }, ALICE);
    expect(first.task.playbook_version).toBe(1);
    const titles = first.items.map(i => i.title);

    writeProfilePlaybook('alice', {
      id: 'development', version: 2, scope: 'profile', title: 'Dev v2', goal_template: '{input}',
      stages: [{ id: 'only', title: 'Only', steps: [{ title: 'Override step', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'small', validation: { ok: true } }] }],
    });

    const afterEdit = await tools.task_get.handler({ task_id: first.task.id }, ALICE);
    expect(afterEdit.task.playbook_version).toBe(1);
    expect(afterEdit.items.map(i => i.title)).toEqual(titles);

    const second = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'new' }, ALICE);
    expect(second.task.playbook_version).toBe(2);
    expect(second.items).toHaveLength(1);
    expect(second.task.goal).toBe('new');
  });

  it('returns coded errors for an unknown playbook and a contract-invalid step, never writing a plan', async () => {
    const tools = loadTools();
    expect((await tools.playbook_run.handler({ playbook_id: 'ghost', goal: 'x' }, ALICE)).code).toBe('PLAYBOOK_NOT_FOUND');

    writeProfilePlaybook('alice', {
      id: 'broken', version: 1, scope: 'profile', title: 'Broken', goal_template: '{input}',
      stages: [{ id: 's', title: 'S', steps: [{ title: 'Agent without a role', execution_kind: 'agent', validation: { ok: true } }] }],
    });
    const bad = await tools.playbook_run.handler({ playbook_id: 'broken', goal: 'x' }, ALICE);
    expect(bad.code).toBe('COMPILE_INVALID');

    const list = await tools.task_list.handler({}, ALICE);
    expect(list.tasks).toEqual([]);
    expect((await tools.playbook_run.handler({ playbook_id: 'development' }, ALICE)).code).toBe('GOAL_REQUIRED');
  });

  it('a missing required input is a coded error and writes no plan (#1725)', async () => {
    const tools = loadTools();
    writeProfilePlaybook('alice', {
      id: 'eng', version: 1, scope: 'profile', title: 'Eng', goal_template: '{input}',
      inputs: [{ name: 'repo', derive: 'github_repo' }],
      stages: [{ id: 's', title: 'S', steps: [{ title: 'Код в {repo}', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'medium', validation: { ok: true } }] }],
    });
    const bad = await tools.playbook_run.handler({ playbook_id: 'eng', goal: 'сделать фичу' }, ALICE);
    expect(bad.code).toBe('INPUT_REQUIRED');
    expect((await tools.task_list.handler({}, ALICE)).tasks).toEqual([]);
    const ok = await tools.playbook_run.handler({ playbook_id: 'eng', goal: 'сделать фичу', vars: { repo: 'acme/app' } }, ALICE);
    expect(ok.items[0].title).toBe('Код в acme/app');
  });

  it('scopes the plan to the caller profile', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'private' }, ALICE);
    expect(res.task.profile_id).toBe('alice');
    const denied = await tools.task_get.handler({ task_id: res.task.id }, { userId: 'bob' });
    expect(denied.error).toMatch(/not found/);
  });

  it('a compiled plan survives a real process restart (task_get returns the same contract)', () => {
    const env = { ...process.env, AGENT_DATA_DIR: join(root, 'data'), USERS_DIR: join(root, 'users') };
    const writeScript = `
      const tools = require('./src/mcp-skills/tools/102-playbooks').tools;
      const durable = require('./src/mcp-skills/tools/101-durable-tasks').tools;
      (async () => {
        const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'restart P2' }, {userId:'alice'});
        console.log(JSON.stringify(await durable.task_get.handler({task_id:res.task.id}, {userId:'alice'})));
      })().catch(e => { console.error(e); process.exit(1); });`;
    const before = JSON.parse(execFileSync(process.execPath, ['-e', writeScript], { cwd: resolve('.'), env, encoding: 'utf8' }));

    const readScript = `
      const durable = require('./src/mcp-skills/tools/101-durable-tasks').tools;
      (async () => {
        const id = ${JSON.stringify(before.task.id)};
        const denied = await durable.task_get.handler({task_id:id}, {userId:'bob'});
        if (!denied.error) throw Error('profile leak');
        console.log(JSON.stringify(await durable.task_get.handler({task_id:id}, {userId:'alice'})));
      })().catch(e => { console.error(e); process.exit(1); });`;
    const after = JSON.parse(execFileSync(process.execPath, ['-e', readScript], { cwd: resolve('.'), env, encoding: 'utf8' }));

    expect(after).toEqual(before);
    expect(after.task.status).toBe('draft');
    expect(after.task.playbook_version).toBe(1);
    expect(after.items).toHaveLength(16);
    expect(JSON.parse(after.items[5].validation_json)).toBeTruthy();
  });
});
