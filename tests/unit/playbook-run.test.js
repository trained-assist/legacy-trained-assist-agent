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
  root = mkdtempSync(join(tmpdir(), 'playbook-run-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'data');
});

afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR;
  else process.env.USERS_DIR = prevUsers;
  if (prevData === undefined) delete process.env.AGENT_DATA_DIR;
  else process.env.AGENT_DATA_DIR = prevData;
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
