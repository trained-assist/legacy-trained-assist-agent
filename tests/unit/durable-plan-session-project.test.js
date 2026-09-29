// #1725 root 5: a plan created from a project-bound session is bound to THAT project.
// Before, task_create left project_id null unless passed explicitly, so the plan's own
// session (s-plan-*) got whatever project the profile touched last.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ENV_KEYS = ['AGENT_DATA_DIR', 'USERS_DIR', 'AGENT_SESSION_ID'];
let root;
let saved;

function fresh() {
  for (const m of ['../../src/mcp-skills/tools/101-durable-tasks.js', '../../src/data-paths.js',
    '../../src/durable-task-store.js', '../../src/projects.js']) delete require.cache[require.resolve(m)];
  return require('../../src/mcp-skills/tools/101-durable-tasks.js');
}

function seed({ sessionId, projectId, withProject = true }) {
  const workDir = join(root, 'users', 'alice');
  mkdirSync(join(workDir, 'sessions'), { recursive: true });
  if (withProject) {
    mkdirSync(join(workDir, 'projects', projectId), { recursive: true });
    writeFileSync(join(workDir, 'projects', projectId, 'project.json'),
      JSON.stringify({ id: projectId, name: projectId, type: 'generic' }));
  }
  writeFileSync(join(workDir, 'sessions', `${sessionId}.json`), JSON.stringify({ id: sessionId, projectId }));
}

const PLAN = {
  goal: 'g', user_value: 'v',
  acceptance_criteria: [{ id: 'ac1', text: 't', validation: { type: 'manual' } }],
  items: [{ title: 's', execution_kind: 'agent', executor_role: 'developer', minimum_model_level: 'bachelor', context_budget: 'small', validation: { type: 'manual' } }],
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), 'plan-session-project-'));
  process.env.AGENT_DATA_DIR = join(root, 'agent-data');
  process.env.USERS_DIR = join(root, 'users');
  delete process.env.AGENT_SESSION_ID;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

describe('task_create binds the plan to the calling session\'s project', () => {
  it('inherits project from AGENT_SESSION_ID when project_id is omitted', async () => {
    seed({ sessionId: 's-chat-1', projectId: 'media-transcription' });
    process.env.AGENT_SESSION_ID = 's-chat-1';
    const { task } = await fresh().tools.task_create.handler({ ...PLAN }, { userId: 'alice' });
    expect(task.project_id).toBe('media-transcription');
  });

  it('inherits project from an explicit session_id', async () => {
    seed({ sessionId: 's-chat-2', projectId: 'p-two' });
    const { task } = await fresh().tools.task_create.handler({ ...PLAN, session_id: 's-chat-2' }, { userId: 'alice' });
    expect(task.project_id).toBe('p-two');
  });

  it('an explicit project_id wins over the session binding', async () => {
    seed({ sessionId: 's-chat-3', projectId: 'from-session' });
    seed({ sessionId: 's-other', projectId: 'explicit' });
    process.env.AGENT_SESSION_ID = 's-chat-3';
    const { task } = await fresh().tools.task_create.handler({ ...PLAN, project_id: 'explicit' }, { userId: 'alice' });
    expect(task.project_id).toBe('explicit');
  });

  it('stays unbound when the session\'s project no longer exists (no throw)', async () => {
    seed({ sessionId: 's-chat-4', projectId: 'archived', withProject: false });
    process.env.AGENT_SESSION_ID = 's-chat-4';
    const { task } = await fresh().tools.task_create.handler({ ...PLAN }, { userId: 'alice' });
    expect(task.project_id ?? null).toBeNull();
  });

  it('stays unbound with no session at all', async () => {
    const { task } = await fresh().tools.task_create.handler({ ...PLAN }, { userId: 'alice' });
    expect(task.project_id ?? null).toBeNull();
  });

  it('never reads another profile\'s session', async () => {
    seed({ sessionId: 's-chat-5', projectId: 'alice-proj' });
    process.env.AGENT_SESSION_ID = 's-chat-5';
    expect(fresh()._sessionProjectId('bob', null)).toBeNull();
    expect(fresh()._sessionProjectId('alice', '../bob/sessions/x')).toBeNull();
  });
});
