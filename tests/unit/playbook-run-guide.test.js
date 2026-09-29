// Sandbox for #1887 п.1 / #1894 — playbook_run «гайд» mode, end-to-end through the real
// MCP handler (no mocks of our own code): Telegram env → guide section in the project's
// checklist.md, no durable plan; second run in the same chat → background plan that is NOT
// attached to the live session; explicit mode:"background" wins; web / s-plan-* stay
// background; explicit guide+activate → MODE_CONFLICT; gates stay protected; the section the
// tool wrote is what GTD reads (Owner-session). Run: scripts/sandbox/playbook-guide-mode.sh
//
// Env trap: HOME is not swapped here, but USERS_DIR + AGENT_DATA_DIR are (data-paths.js
// captures them at load → every loader clears the require cache, as in playbook-run.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PATHS = '../../src/data-paths.js';
const STORE = '../../src/playbook-store.js';
const AUTHORING = '../../src/playbook-authoring.js';
const COMPILER = '../../src/playbook-compiler.js';
const DSTORE = '../../src/durable-task-store.js';
const DURABLE = '../../src/mcp-skills/tools/101-durable-tasks.js';
const PROJECTS = '../../src/projects.js';
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';
const GTD = '../../src/gtd-controller.js';

const PROFILE = 'alice';
const CTX = { userId: PROFILE };
const CHAT = '777001';
const SID = 'tg-777001-guide-sess';
const GATE = 'Wait for CI and staging; repair failures';
const ENV_KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'PLAYBOOK_SIBLING_ROOTS', 'AGENT_CHAT_ID', 'AGENT_SESSION_ID', 'AGENT_USER_ID', 'PLAYBOOK_GUIDE_DEFAULT'];

let root; let prevEnv; let prevCwd;

function fresh(...mods) { for (const m of mods) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } } }
function loadTools() {
  fresh(TOOL, COMPILER, AUTHORING, STORE, DURABLE, DSTORE, PROJECTS, PATHS, GTD);
  return { ...require(TOOL).tools, ...require(DURABLE).tools };
}
function projectDir(id) { return join(root, 'users', PROFILE, 'projects', id); }
function makeProject(id) {
  const dir = projectDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id, name: id, type: 'generic' }));
  return dir;
}
function telegram({ chat = CHAT, sid = SID } = {}) {
  process.env.AGENT_CHAT_ID = chat;
  process.env.AGENT_SESSION_ID = sid;
  process.env.AGENT_USER_ID = PROFILE;
}
function checklist(dir) { const f = join(dir, 'checklist.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; }
async function durableCount(tools) { return (await tools.task_list.handler({}, CTX)).tasks.length; }

beforeEach(() => {
  prevEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  prevCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'playbook-guide-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'data');
  for (const k of ['AGENT_CHAT_ID', 'AGENT_SESSION_ID', 'AGENT_USER_ID', 'PLAYBOOK_GUIDE_DEFAULT']) delete process.env[k];
  const sibling = join(root, 'siblings', 'trained-assist-engineering');
  mkdirSync(join(sibling, 'playbooks'), { recursive: true });
  writeFileSync(join(sibling, 'playbooks', 'development.json'),
    readFileSync(new URL('../fixtures/development.json', import.meta.url), 'utf8'));
  process.env.PLAYBOOK_SIBLING_ROOTS = sibling;
  process.chdir(makeProject('proj-a'));
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

describe('playbook_run mode selection (#1887 п.1)', () => {
  it('Telegram, empty chat, no mode → guide: section in project checklist.md, no durable plan', async () => {
    telegram();
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Гайд-цель A' }, CTX);
    expect(res.mode).toBe('guide');
    expect(res.mode_reason).toBe('default_telegram');
    expect(res.task).toBeUndefined();
    expect(await durableCount(tools)).toBe(0);
    const md = checklist(projectDir('proj-a'));
    expect(md).toMatch(/^Goal: Гайд-цель A$/m);
    expect(md).toMatch(new RegExp(`^Owner-session: ${SID}$`, 'm'));
    expect(md).toMatch(new RegExp(`^Owner-chat: ${CHAT}$`, 'm'));
    expect(md).toMatch(/^Mode: guide$/m);
    expect(md.match(/^- \[ \] /gm) || []).toHaveLength(16);
    expect(md).toMatch(new RegExp(`- \\[ \\] \\d+\\. ${GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\[ГЕЙТ`));
    expect(res.checklist_path).toBe(join(projectDir('proj-a'), 'checklist.md'));
    expect(res.steps.find(s => s.step === GATE).protected).toBe(true);
  });

  it('the guide section is the one GTD reads and owns (Owner-session = live session)', async () => {
    telegram();
    const tools = loadTools();
    await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Гайд для GTD' }, CTX);
    const { readChecklist } = require(GTD);
    const cl = readChecklist(projectDir('proj-a'));
    expect(cl && cl.goal).toBe('Гайд для GTD');
    expect(cl.owner).toBe(SID);
    expect(cl.items.some(i => /Goal:|Mode:|Owner-chat:/.test(i.text))).toBe(false);
  });

  it('second run in the same chat (even from another project) → background, not attached to the session', async () => {
    telegram();
    const tools = loadTools();
    const first = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Первый' }, CTX);
    expect(first.mode).toBe('guide');
    process.chdir(makeProject('proj-b'));
    const second = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Второй', activate: true }, CTX);
    expect(second.mode).toBe('background');
    expect(second.mode_reason).toBe('foreground_busy');
    expect(second.busy && second.busy.goal).toBe('Первый');
    expect(second.task.status).toBe('active');
    const got = await tools.task_get.handler({ task_id: second.task.id }, CTX);
    expect(got.sessions).toHaveLength(0);
    expect(checklist(projectDir('proj-b'))).not.toMatch(/Mode: guide/);
  });

  it('another chat is not blocked by this chat’s guide', async () => {
    telegram();
    const tools = loadTools();
    await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Чат 1' }, CTX);
    telegram({ chat: '777002', sid: 'tg-777002-sess' });
    process.chdir(makeProject('proj-c'));
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Чат 2' }, CTX);
    expect(res.mode).toBe('guide');
  });

  it('a closed / all-done / stale guide no longer holds the chat', async () => {
    telegram();
    const tools = loadTools();
    await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Брошенный' }, CTX);
    const f = join(projectDir('proj-a'), 'checklist.md');
    const old = (Date.now() - 25 * 3600e3) / 1000;
    utimesSync(f, old, old);
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'После 24ч' }, CTX);
    expect(res.mode).toBe('guide');
    writeFileSync(f, readFileSync(f, 'utf8') + 'Closed: 2026-09-29\n');
    const res2 = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'После Closed' }, CTX);
    expect(res2.mode).toBe('guide');
  });

  it('explicit mode:"background" in Telegram → background plan (as before)', async () => {
    telegram();
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Фон явно', mode: 'background' }, CTX);
    expect(res.mode).toBe('background');
    expect(res.mode_reason).toBe('explicit');
    expect(res.task.status).toBe('draft');
    expect(checklist(projectDir('proj-a'))).not.toMatch(/Mode: guide/);
  });

  it('web (chat 0) and durable-step sessions (s-plan-*) stay background', async () => {
    telegram({ chat: '0', sid: 'web-sess-1' });
    let tools = loadTools();
    const web = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Веб' }, CTX);
    expect(web.mode).toBe('background');
    expect(web.mode_reason).toBe('non_interactive');
    telegram({ sid: 's-plan-abc' });
    tools = loadTools();
    const step = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Шаг плана' }, CTX);
    expect(step.mode).toBe('background');
    expect(step.mode_reason).toBe('non_interactive');
  });

  it('explicit guide + activate → MODE_CONFLICT; default + activate → guide (activate ignored)', async () => {
    telegram();
    const tools = loadTools();
    const conflict = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'x', mode: 'guide', activate: true }, CTX);
    expect(conflict.code).toBe('MODE_CONFLICT');
    const def = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Скил зовёт activate', activate: true }, CTX);
    expect(def.mode).toBe('guide');
    expect(await durableCount(tools)).toBe(0);
  });

  it('gates stay protected in guide; switched-off steps are written [x] with the reason', async () => {
    telegram();
    const tools = loadTools();
    const gate = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'g',
      steps: [{ step: GATE, enabled: false, reason: 'долго' }] }, CTX);
    expect(gate.code).toBe('STEP_PROTECTED');
    expect(checklist(projectDir('proj-a'))).toBe('');
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'С выключенным',
      steps: [{ step: 'Identify root cause when needed', enabled: false, reason: 'причина известна' }] }, CTX);
    expect(res.mode).toBe('guide');
    expect(checklist(projectDir('proj-a'))).toMatch(/- \[x\] \d+\. Identify root cause when needed.*выключен: причина известна/);
  });

  it('rollback flag PLAYBOOK_GUIDE_DEFAULT=0 → default is background again', async () => {
    telegram();
    process.env.PLAYBOOK_GUIDE_DEFAULT = '0';
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Откат' }, CTX);
    expect(res.mode).toBe('background');
    expect(res.task.status).toBe('draft');
  });
  it('cwd outside a project folder (code worktree) → background no_project_dir; explicit guide → GUIDE_NO_PROJECT', async () => {
    telegram();
    const wt = join(root, 'users', PROFILE, 'engineering-workspaces', 'ws-1', 'code');
    mkdirSync(wt, { recursive: true });
    process.chdir(wt);
    const tools = loadTools();
    const res = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'Из воркспейса' }, CTX);
    expect(res.mode).toBe('background');
    expect(res.mode_reason).toBe('no_project_dir');
    expect(existsSync(join(wt, 'checklist.md'))).toBe(false);
    const explicit = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'x', mode: 'guide' }, CTX);
    expect(explicit.code).toBe('GUIDE_NO_PROJECT');
    const byId = await tools.playbook_run.handler({ playbook_id: 'development', goal: 'По project_id', project_id: 'proj-a' }, CTX);
    expect(byId.mode).toBe('guide');
    expect(checklist(projectDir('proj-a'))).toMatch(/^Goal: По project_id$/m);
  });
});
