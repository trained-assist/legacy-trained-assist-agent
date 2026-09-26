import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { DurableTaskStore } = require('../../src/durable-task-store');
const Database = require('better-sqlite3');
const valid = () => ({ title: 'Implement atomic persistence', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'master', context_budget: 'medium', validation: { validator: 'tests', expected: 'pass' } });
const plan = () => ({ id: 'plan', profile_id: 'alice', goal: 'Persist plans', user_value: 'Resume work after restart', acceptance_criteria: [{ id: 'restart', description: 'Same plan after process restart', validations: [{ step: valid().title, validation: valid().validation }] }], items: [valid()] });

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-persistence-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('engineering plan persistence', () => {
  it('real process restart: playbook → one task_create with 16 items → task_get unchanged; other profile cannot read/write', () => fixture(dir => {
    const env = { ...process.env, AGENT_DATA_DIR: dir, USERS_DIR: join(dir, 'users') };
    const script = `
      const tools = require('./src/mcp-skills/tools/101-durable-tasks').tools;
      const playbook = { id: 'development', version: 1 };
      const titles = ['Record restart user value', 'Record restart and isolation acceptance', 'Define subprocess validator', 'Inspect SQLite transactions', 'Reproduce partial plan writes', 'Design atomic createPlan', 'Check migration rollback', 'Separate schema and MCP slices', 'Implement plan persistence', 'Run persistence regression', 'Open implementation PR', 'Check CI and staging SHA', 'Deploy checked commit', 'Read plan after process restart', 'Check profile isolation', 'Collect acceptance evidence'];
      (async () => {
        const items = titles.map((title, i) => ({ title, stage: String(i), instructions: 'Plan persistence item ' + i,
          execution_kind: i === 11 ? 'programmatic' : 'agent', executor_role: i === 11 ? null : 'developer',
          minimum_model_level: i === 11 ? null : 'master', context_budget: i === 11 ? null : 'small',
          validation: { validator: i === 11 ? 'ci' : 'artifact', criterion_id: 'persist', expected: 'pass' } }));
        const result = await tools.task_create.handler({ goal: 'Persist engineering plans', user_value: 'Survive restart', acceptance_criteria: [{ id: 'persist', description: 'All fields preserved' }], playbook_id: playbook.id, playbook_version: playbook.version, items }, {userId:'alice'});
        const got = await tools.task_get.handler({task_id:result.task.id}, {userId:'alice'});
        console.log(JSON.stringify(got));
      })().catch(e => { console.error(e); process.exit(1); });`;
    const before = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: resolve('.'), env, encoding: 'utf8' }));
    const after = JSON.parse(execFileSync(process.execPath, ['-e', `
      const tools = require('./src/mcp-skills/tools/101-durable-tasks').tools;
      (async () => {
        const id = ${JSON.stringify(before.task.id)};
        const denied = await tools.task_get.handler({task_id:id}, {userId:'bob'});
        if (!denied.error) throw Error('profile leak');
        const deniedWrite = await tools.task_update.handler({task_id:id, goal:'stolen'}, {userId:'bob'});
        if (!deniedWrite.error) throw Error('foreign write');
        const list = await tools.task_list.handler({}, {userId:'bob'});
        if (list.tasks.length) throw Error('list leak');
        console.log(JSON.stringify(await tools.task_get.handler({task_id:id}, {userId:'alice'})));
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: resolve('.'), env, encoding: 'utf8' }));
    expect(after).toEqual(before);
    expect(after.task.status).toBe('draft');
    expect(after.items).toHaveLength(16);
    expect(after.items[11].executor_role).toBeNull();
    expect(JSON.parse(after.items[0].validation_json).criterion_id).toBe('persist');
  }));

  it('rolls back task, preceding items and session attachment on any invalid item', () => {
    const store = new DurableTaskStore(':memory:');
    try {
      expect(() => store.createPlan({ ...plan(), session_id: 's1', items: [valid(), { ...valid(), context_budget: 'unbounded' }] })).toThrow(/context_budget/);
      for (const table of ['durable_tasks', 'task_items', 'task_sessions']) expect(store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(0);
      store.createPlan({ ...plan(), session_id: 's1' });
      expect(() => store.createPlan({ ...plan(), id: 'second', session_id: 's1' })).toThrow(/active task/);
      expect(store.getTask('second', 'alice')).toBeNull();
    } finally { store.close(); }
  });

  it('ownership check precedes item UPDATE, including empty patches', () => {
    const store = new DurableTaskStore(':memory:');
    try {
      const { items } = store.createPlan(plan());
      const before = store.getTaskItem(items[0].id);
      expect(store.updateTaskItem(before.id, { title: 'foreign write' }, 'bob')).toBeNull();
      expect(store.updateTaskItem(before.id, {}, 'bob')).toBeNull();
      expect(store.getTaskItem(before.id)).toEqual(before);
      expect(store.getTask('plan', 'alice').revision).toBe(1);
    } finally { store.close(); }
  });

  it('draft is executable only after explicit activation; finalization stays gated', () => {
    const store = new DurableTaskStore(':memory:');
    try {
      store.createPlan(plan());
      expect(store.claimNextRunnable()).toBeNull();
      // P3a: draft→active is the explicit activation path for a contract plan.
      expect(store.updateTask('plan', 'alice', { status: 'active' }).status).toBe('active');
      expect(store.claimNextRunnable().status).toBe('running');
      // P3d will own 'done' — it needs per-criterion validation first.
      for (const finalize of [
        () => store.updateTask('plan', 'alice', { status: 'done' }),
        () => store.completeTask('plan', 'alice'),
      ]) expect(finalize).toThrow(/finalization/);
    } finally { store.close(); }
  });

  it('migrates a real v1 database, preserves child rows and maps tier levels; repeat startup is idempotent', () => fixture(dir => {
    // Extract only the original v1 schema, which stays in _migrate for compatibility.
    const source = readFileSync('src/durable-task-store.js', 'utf8');
    const schema = source.split('this.db.exec(`')[1].split('`);')[0];
    const file = join(dir, 'legacy.db');
    const db = new Database(file);
    db.exec(schema);
    db.exec("INSERT INTO durable_tasks VALUES ('t','alice',NULL,'legacy','active',1,1,0)");
    for (const [i, tier] of ['free', 'standard', 'strong'].entries()) db.prepare("INSERT INTO task_items (id,task_id,position,title,execution_tier,current_tier,created_at,updated_at) VALUES (?,'t',?,'legacy',?,?,1,1)").run(String(i), i, tier, tier);
    db.exec("INSERT INTO task_sessions VALUES ('t','s','alice',1,1)");
    db.exec("INSERT INTO executions (id,task_id,task_item_id,status,started_at) VALUES ('e','t','0','done',1)");
    db.close();
    for (let i = 0; i < 2; i++) {
      const store = new DurableTaskStore(file);
      expect(store.listTaskItems('t', 'alice').map(item => item.minimum_model_level)).toEqual(['bachelor', 'master', 'doctor']);
      expect(store.listSessions('t', 'alice')).toHaveLength(1);
      expect(store.getExecution('e').task_item_id).toBe('0');
      expect(store.db.pragma('foreign_key_check')).toEqual([]);
      expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
      store.close();
    }
  }));
});

it('MCP rejects foreign project/session references and path traversal before inserting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-references-'));
  const saved = { AGENT_DATA_DIR: process.env.AGENT_DATA_DIR, USERS_DIR: process.env.USERS_DIR };
  try {
    process.env.AGENT_DATA_DIR = join(root, 'data');
    process.env.USERS_DIR = join(root, 'users');
    for (const module of ['../../src/mcp-skills/tools/101-durable-tasks', '../../src/data-paths']) delete require.cache[require.resolve(module)];
    const tools = require('../../src/mcp-skills/tools/101-durable-tasks').tools;
    for (const user of ['alice', 'bob']) {
      mkdirSync(join(root, 'users', user, 'projects', 'project'), { recursive: true });
      mkdirSync(join(root, 'users', user, 'sessions'), { recursive: true });
    }
    writeFileSync(join(root, 'users/bob/projects/project/project.json'), JSON.stringify({id:'project'}));
    writeFileSync(join(root, 'users/bob/sessions/s1.json'), '{}');
    for (const refs of [{ project_id: 'project' }, { session_id: 's1' }, { project_id: '../../../bob' }, { session_id: '../bob/s1' }]) {
      await expect(tools.task_create.handler({ ...plan(), ...refs }, {userId:'alice'})).rejects.toThrow(/not found/);
    }
    expect((await tools.task_list.handler({}, {userId:'alice'})).tasks).toEqual([]);
    writeFileSync(join(root, 'users/alice/projects/project/project.json'), JSON.stringify({id:'project'}));
    writeFileSync(join(root, 'users/alice/sessions/s1.json'), '{}');
    const result = await tools.task_create.handler({ ...plan(), profile_id: 'bob', project_id: 'project', session_id: 's1' }, {userId:'alice'});
    expect(result.task.profile_id).toBe('alice');
    const got = await tools.task_get.handler({task_id:result.task.id}, {userId:'alice'});
    expect(got.sessions[0].session_id).toBe('s1');
    expect(readFileSync(got.projection, 'utf8')).toContain('developer/master/medium');
    rmSync(got.projection);
    const rebuilt = await tools.task_get.handler({task_id:result.task.id}, {userId:'alice'});
    expect(readFileSync(rebuilt.projection, 'utf8')).toContain('Implement atomic persistence');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const module of ['../../src/mcp-skills/tools/101-durable-tasks', '../../src/data-paths']) delete require.cache[require.resolve(module)];
    rmSync(root, { recursive: true, force: true });
  }
});
