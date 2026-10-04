// #120 / #121 through the real `playbook_run` MCP handler — the fast path must be a
// property of the RUN, not only of the compiler: schema, pass-through, the created
// durable plan, and the step-selection preset the agent reads.
//
// Case 9a6854e4: an approved architecture sat in the goal while the run re-derived
// scenario/context/requirements/design for 26 minutes and 6 model runs. The contract of
// the fast path: the frame is VERIFIED, not re-derived, and delivery is never compressed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PATHS = '../../src/data-paths.js';
const STORE = '../../src/playbook-store.js';
const COMPILER = '../../src/playbook-compiler.js';
const AUTHORING = '../../src/playbook-authoring.js';
const DSTORE = '../../src/durable-task-store.js';
const DURABLE = '../../src/mcp-skills/tools/101-durable-tasks.js';
const PROJECTS = '../../src/projects.js';
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';
const GTD = '../../src/gtd-controller.js';

const PROFILE = 'alice';
const CTX = { userId: PROFILE };
const MODULES = [TOOL, COMPILER, AUTHORING, STORE, DURABLE, DSTORE, PROJECTS, PATHS, GTD];
const ENV_KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'PLAYBOOK_SIBLING_ROOTS', 'AGENT_SESSION_FILE', 'AGENT_SESSION_ID', 'AGENT_USER_ID', 'PLAYBOOK_GUIDE_DEFAULT'];

let root; let prevEnv;

function loadTools() {
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
  return require(TOOL).tools;
}

function itemsOf(taskId) {
  const G = require(GTD);
  return G.durableStore().listTaskItems(taskId, PROFILE);
}

const FRAMING_STAGES = ['frame', 'propose', 'design'];
const DELIVERY_GATES = ['Песочница', 'Реализация', 'Полная локальная проверка', 'Открыть PR',
  'CI зелёный', 'Деплой', 'Проверка сценария', 'Архивация'];

beforeEach(() => {
  prevEnv = {};
  for (const k of ENV_KEYS) { prevEnv[k] = process.env[k]; delete process.env[k]; }
  root = mkdtempSync(join(tmpdir(), 'spec-ref-run-'));
  process.env.USERS_DIR = join(root, 'users');
  process.env.AGENT_DATA_DIR = join(root, 'agent-data');
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('#120 fast path through playbook_run', () => {
  it('spec_ref collapses the frame in the CREATED plan and keeps every delivery gate', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({
      playbook_id: 'feature', mode: 'background',
      goal: 'Реализовать PR1 по одобренной архитектуре',
      vars: { repo: 'acme/todo-cli' },
      spec_ref: 'trained-assist/agent#2061',
    }, CTX);
    expect(res.task).toBeTruthy();
    const items = itemsOf(res.task.id);
    const titles = items.map(i => i.title);

    expect(titles[0]).toBe('Сверка одобренной спецификации');
    const framing = items.filter(i => FRAMING_STAGES.includes(i.stage));
    expect(framing).toHaveLength(1);
    for (const gone of ['Сценарий пользователя', 'Исследование', 'Сложность требований', 'Предложение изменения', 'Декларация плана']) {
      expect(titles.some(t => t.includes(gone)), `re-derived framing step present: ${gone}`).toBe(false);
    }
    for (const gate of DELIVERY_GATES) {
      expect(titles.some(t => t.includes(gate)), `delivery gate kept: ${gate}`).toBe(true);
    }
    // The check step carries the spec, the budget that keeps it cheap, and a real anchor.
    const check = items[0];
    expect(check.execution_timeout_seconds).toBeLessThanOrEqual(300);
    expect(check.minimum_model_level).toBe('bachelor');
    expect(check.instructions).toContain('trained-assist/agent#2061');
    const validation = check.validation_json ? JSON.parse(check.validation_json) : {};
    expect(validation.file_exists).toBe('spec-check/coverage.md');
    // The response carries the measurement, so a run's effect is visible not asserted.
    expect(res.spec_ref_fast_path).toMatchObject({ collapsed_steps: 5, check_artifact: 'spec-check/coverage.md' });
    expect(res.spec_ref_hint).toBeUndefined();
  });

  it('suggests spec_ref when the goal names an approved spec but the run omitted it', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({
      playbook_id: 'feature', mode: 'background',
      goal: 'Реализовать issue #2061 (одобренная владельцем архитектура)',
      vars: { repo: 'acme/todo-cli' },
    }, CTX);
    expect(res.spec_ref_hint).toBe('issue #2061');
    expect(res.spec_ref_fast_path).toBeNull(); // a hint never auto-applies
    const titles = itemsOf(res.task.id).map(i => i.title);
    expect(titles).toContain('Сценарий пользователя: ценность и шаги'); // full frame still ran
  });

  it('a raw goal keeps the full framing — no regression on the normal path', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({
      playbook_id: 'feature', mode: 'background',
      goal: 'Добавить экспорт CSV', vars: { repo: 'acme/todo-cli' },
    }, CTX);
    const titles = itemsOf(res.task.id).map(i => i.title);
    expect(titles).not.toContain('Сверка одобренной спецификации');
    for (const kept of ['Сценарий пользователя', 'Исследование', 'Сложность требований']) {
      expect(titles.some(t => t.includes(kept)), `framing step kept on the normal path: ${kept}`).toBe(true);
    }
  });

  it('#121: the step-selection preset names the sandbox case and the fast path', async () => {
    const tools = loadTools();
    const res = await tools.playbook_run.handler({
      playbook_id: 'feature', mode: 'background',
      goal: 'Проверить пресет', vars: { repo: 'acme/todo-cli' },
    }, CTX);
    expect(res.steps_hint).toMatch(/ПЕСОЧНИЦА/);
    expect(res.steps_hint).toMatch(/red-tests-first/);
    expect(res.steps_hint).toMatch(/spec_ref/);
    // Gates stay unswitchable whatever the preset says.
    const gates = res.steps.filter(s => s.protected);
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) expect(g.enabled).toBe(true);
  });
});
