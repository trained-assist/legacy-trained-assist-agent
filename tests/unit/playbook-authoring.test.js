// Unit tests for Playbook authoring (issue #1372, slice P1): Hermes-driven
// draft/edit, validation + single repair, durable drafts, profile-scope save
// with version bumping, and refusal to mutate repo ("system") playbooks.
//
// The LLM is injected: createPlaybookAuthoring({ runHermes }) takes a fake, so
// these tests never touch the network. data-paths captures USERS_DIR at load,
// so every loader clears the require cache (same pattern as
// tests/unit/playbook-store.test.js).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let root;
let prevUsers;

const STORE = '../../src/playbook-store.js';
const AUTHORING = '../../src/playbook-authoring.js';
const PATHS = '../../src/data-paths.js';
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';

function fresh(...mods) {
  for (const m of mods) delete require.cache[require.resolve(m)];
}

function profileDir(p) { return join(root, 'users', p, 'playbooks'); }
function systemDir() { return join(root, 'system'); }
function draftFile(p, id) { return join(profileDir(p), '.drafts', `${id}.json`); }
function savedFile(p, id) { return join(profileDir(p), `${id}.json`); }

function validPlaybook(over = {}) {
  return {
    id: 'sample', version: 1, scope: 'profile', title: 'Sample',
    when_to_use: 'когда нужно провести процесс Sample',
    goal_template: 'Сделать {input}',
    stages: [{
      id: 'stage-one', title: 'Этап один',
      steps: [{
        title: 'Шаг один', execution_kind: 'agent', executor_role: 'researcher',
        minimum_model_level: 'bachelor', context_budget: 'small',
        validation: { done: true },
      }],
    }],
    ...over,
  };
}

function writeSystemPlaybook(id, obj) {
  mkdirSync(systemDir(), { recursive: true });
  writeFileSync(join(systemDir(), `${id}.json`), JSON.stringify(obj, null, 2));
}

function writeDraft(p, obj) {
  mkdirSync(join(profileDir(p), '.drafts'), { recursive: true });
  writeFileSync(draftFile(p, obj.id), JSON.stringify(obj, null, 2));
}

// Fake Hermes: pops one response per call (value, Error to throw, or fn(args)).
function fakeHermes(responses) {
  const calls = [];
  const run = async args => {
    calls.push(args);
    const next = responses.shift();
    if (typeof next === 'function') return next(args);
    if (next instanceof Error) throw next;
    return next;
  };
  run.calls = calls;
  return run;
}

function load(opts = {}) {
  fresh(AUTHORING, STORE, PATHS, TOOL);
  const { PlaybookStore } = require(STORE);
  const { createPlaybookAuthoring } = require(AUTHORING);
  const storeFor = opts.storeFor
    || (u => new PlaybookStore({ profileId: u, systemDir: systemDir(), siblingRoots: [] }));
  const authoring = createPlaybookAuthoring({ runHermes: opts.runHermes, storeFor });
  return { authoring, PlaybookStore };
}

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  root = mkdtempSync(join(tmpdir(), 'playbook-authoring-'));
  process.env.USERS_DIR = join(root, 'users');
});

afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR;
  else process.env.USERS_DIR = prevUsers;
  rmSync(root, { recursive: true, force: true });
});

describe('AUTHORING_SCHEMA', () => {
  it('is self-contained (no $ref / $defs) and keeps the step contract', () => {
    fresh(AUTHORING, STORE, PATHS);
    const { AUTHORING_SCHEMA } = require(AUTHORING);
    const json = JSON.stringify(AUTHORING_SCHEMA);
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
    const step = AUTHORING_SCHEMA.properties.stages.items.properties.steps.items;
    expect(step.properties.execution_kind.enum).toContain('agent');
    expect(step.required).toContain('validation');
  });
});

describe('draft', () => {
  it('normalizes the Hermes answer to profile scope v1 and persists a durable draft', async () => {
    const run = fakeHermes([validPlaybook({ scope: 'system', version: 9 })]);
    const { authoring } = load({ runHermes: run });

    const out = await authoring.draft({ username: 'alice', description: 'Принимай заявки' });
    expect(out.draft.scope).toBe('profile');
    expect(out.draft.version).toBe(1);
    expect(out.render).toContain('Sample');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].task).toContain('Playbook v1');
    expect(existsSync(draftFile('alice', 'sample'))).toBe(true);
    expect(existsSync(savedFile('alice', 'sample'))).toBe(false);
  });

  it('requests a larger output budget than the generic hermes-run default (a full playbook is 15-20 steps)', async () => {
    // Regression: authoring inherited hermes-run's 3000 default, which fits a
    // research answer but truncates a full Playbook v1 for verbose models —
    // and playbook_draft accepts a model override, so the budget must not
    // depend on the chosen model.
    const run = fakeHermes([validPlaybook()]);
    const { authoring } = load({ runHermes: run });
    const { DEFAULT_MAX_TOKENS } = require('../../src/hermes-run');
    const { AUTHORING_MAX_TOKENS } = require(AUTHORING);

    await authoring.draft({ username: 'alice', description: 'Процесс' });
    expect(run.calls[0].maxTokens).toBe(AUTHORING_MAX_TOKENS);
    expect(AUTHORING_MAX_TOKENS).toBeGreaterThan(DEFAULT_MAX_TOKENS);
    expect(run.calls[0].model).toBeUndefined(); // default model left unchanged
  });

  it('repairs a schema-invalid answer once by feeding validation errors back', async () => {
    const bad = validPlaybook();
    delete bad.stages[0].steps[0].validation;
    const run = fakeHermes([bad, validPlaybook()]);
    const { authoring } = load({ runHermes: run });

    const out = await authoring.draft({ username: 'alice', description: 'Процесс' });
    expect(out.draft.id).toBe('sample');
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1].context).toContain('валидацию');
    expect(existsSync(draftFile('alice', 'sample'))).toBe(true);
  });

  it('fails with a clear error and writes nothing when Hermes stays invalid', async () => {
    const bad = validPlaybook();
    delete bad.stages[0].steps[0].validation;
    const run = fakeHermes([bad, bad]);
    const { authoring } = load({ runHermes: run });

    await expect(authoring.draft({ username: 'alice', description: 'Процесс' }))
      .rejects.toThrow(/AUTHORING_INVALID/);
    expect(existsSync(savedFile('alice', 'sample'))).toBe(false);
    expect(existsSync(draftFile('alice', 'sample'))).toBe(false);
    expect(run.calls).toHaveLength(2);
  });

  it('repairs an invalid generated id (repair prompt fixes it)', async () => {
    const run = fakeHermes([
      validPlaybook({ id: 'Финансы' }),
      validPlaybook({ id: 'finance-intake' }),
    ]);
    const { authoring } = load({ runHermes: run });
    const out = await authoring.draft({ username: 'alice', description: 'Финансы' });
    expect(out.draft.id).toBe('finance-intake');
  });

  it('rejects an empty description without calling Hermes', async () => {
    const run = fakeHermes([]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ username: 'alice', description: '   ' }))
      .rejects.toThrow(/DESCRIPTION_REQUIRED/);
    expect(run.calls).toHaveLength(0);
  });

  it('errors clearly when the base playbook is unknown', async () => {
    const run = fakeHermes([]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ username: 'alice', description: 'X', based_on: 'nope' }))
      .rejects.toThrow(/BASE_NOT_FOUND/);
    expect(run.calls).toHaveLength(0);
  });
});

describe('edit', () => {
  it('edits a repo playbook into a profile draft, reports the diff, and leaves the repo file intact', async () => {
    writeSystemPlaybook('sample', validPlaybook({ scope: 'system', version: 2, title: 'System' }));
    const after = validPlaybook({
      scope: 'profile', version: 1, title: 'System',
      stages: [{
        id: 'stage-one', title: 'Этап один',
        steps: [
          { title: 'Шаг один', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small', validation: { done: true } },
          { title: 'Шаг два', execution_kind: 'agent', executor_role: 'reviewer', minimum_model_level: 'master', context_budget: 'medium', validation: { explicit_verdict: true } },
        ],
      }],
    });
    const run = fakeHermes([after]);
    const { authoring } = load({ runHermes: run });

    const out = await authoring.edit({ username: 'alice', playbook_id: 'sample', instruction: 'Добавь ревью' });
    expect(out.draft.id).toBe('sample');
    expect(out.diff.steps_added).toContain('Шаг два');
    expect(existsSync(draftFile('alice', 'sample'))).toBe(true);

    const repo = JSON.parse(readFileSync(join(systemDir(), 'sample.json'), 'utf8'));
    expect(repo.scope).toBe('system');
    expect(repo.stages[0].steps).toHaveLength(1);
  });

  it('prefers an existing draft over the saved playbook', async () => {
    writeSystemPlaybook('sample', validPlaybook({ scope: 'system', version: 2, title: 'System' }));
    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'profile', title: 'Drafted' }));
    const run = fakeHermes([validPlaybook({ title: 'Drafted plus' })]);
    const { authoring } = load({ runHermes: run });

    const out = await authoring.edit({ username: 'alice', playbook_id: 'sample', instruction: 'x' });
    expect(out.draft.title).toBe('Drafted plus');
    expect(run.calls[0].context).toContain('Drafted');
  });

  it('errors clearly when neither a draft nor a playbook exists', async () => {
    const run = fakeHermes([]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.edit({ username: 'alice', playbook_id: 'ghost', instruction: 'x' }))
      .rejects.toThrow(/DRAFT_NOT_FOUND/);
  });
});

describe('save', () => {
  it('promotes a draft to a profile playbook and removes the draft', async () => {
    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'profile' }));
    const { authoring, PlaybookStore } = load();
    const store = new PlaybookStore({ profileId: 'alice', systemDir: systemDir(), siblingRoots: [] });

    const out = await authoring.save({ username: 'alice', playbook_id: 'sample' });
    expect(out.saved).toMatchObject({ id: 'sample', version: 1, scope: 'profile', source: 'profile' });
    expect(existsSync(savedFile('alice', 'sample'))).toBe(true);
    expect(existsSync(draftFile('alice', 'sample'))).toBe(false);
    expect(store.resolve('sample').source).toBe('profile');
  });

  it('numbers a profile override above the repo version it shadows', async () => {
    writeSystemPlaybook('sample', validPlaybook({ scope: 'system', version: 3 }));
    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'profile' }));
    const { authoring } = load();

    const first = await authoring.save({ username: 'alice', playbook_id: 'sample' });
    expect(first.saved.version).toBe(4);

    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'profile' }));
    const second = await authoring.save({ username: 'alice', playbook_id: 'sample' });
    expect(second.saved.version).toBe(5);
  });

  it('refuses a system-scope draft and writes no repo file', async () => {
    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'system' }));
    const { authoring } = load();
    await expect(authoring.save({ username: 'alice', playbook_id: 'sample' }))
      .rejects.toThrow(/SAVE_SYSTEM_SCOPE/);
    expect(existsSync(savedFile('alice', 'sample'))).toBe(false);
  });

  it('errors clearly with no draft to save', async () => {
    const { authoring } = load();
    await expect(authoring.save({ username: 'alice', playbook_id: 'ghost' }))
      .rejects.toThrow(/DRAFT_NOT_FOUND/);
  });
});

describe('MCP surface: playbook_draft / playbook_edit / playbook_save', () => {
  function loadTools() {
    fresh(TOOL, AUTHORING, STORE, PATHS);
    return require(TOOL).tools;
  }

  it('exposes the authoring tools with a valid input schema', () => {
    const tools = loadTools();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['playbook_draft', 'playbook_edit', 'playbook_save']));
    for (const name of ['playbook_draft', 'playbook_edit', 'playbook_save']) {
      expect(tools[name].inputSchema.type).toBe('object');
    }
  });

  it('returns a coded error (never throws, never hits the network) for bad input', async () => {
    const tools = loadTools();
    const ctx = { userId: 'alice' };
    expect((await tools.playbook_draft.handler({ description: '  ' }, ctx)).code).toBe('DESCRIPTION_REQUIRED');
    expect((await tools.playbook_edit.handler({ playbook_id: 'sample' }, ctx)).code).toBe('INSTRUCTION_REQUIRED');
    expect((await tools.playbook_save.handler({ playbook_id: 'ghost' }, ctx)).code).toBe('DRAFT_NOT_FOUND');
    expect((await tools.playbook_get.handler({ id: 'ghost', draft: true }, ctx)).error).toMatch(/draft not found/);
  });

  // Regression (live smoke caught it): the safe() wrapper dropped ctx, so the
  // authoring layer saw username=undefined and wrote into users/undefined/.
  it('forwards ctx.userId through the handler so save lands in the right profile', async () => {
    const tools = loadTools();
    writeDraft('alice', validPlaybook({ id: 'sample', scope: 'profile' }));

    const out = await tools.playbook_save.handler({ playbook_id: 'sample' }, { userId: 'alice' });
    expect(out.saved.path).toBe(savedFile('alice', 'sample'));
    expect(existsSync(savedFile('alice', 'sample'))).toBe(true);
    expect(existsSync(join(root, 'users', 'undefined'))).toBe(false);
  });
});

describe('authoring semantic rules (S4a, issue #1851)', () => {
  it('rejects a programmatic step with a validator outside the registry (D1) and writes nothing', async () => {
    const bad = validPlaybook({ stages: [{ id: 's', title: 'S', steps: [
      { title: 'Команда', execution_kind: 'programmatic', validation: { shell_command_success: true } },
    ] }] });
    const run = fakeHermes([bad, bad]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ username: 'alice', description: 'Процесс' }))
      .rejects.toThrow(/shell_command_success/);
    expect(existsSync(draftFile('alice', 'sample'))).toBe(false);
    expect(run.calls).toHaveLength(2); // one repair attempt
  });

  it('accepts a programmatic step whose keys are all in the registry', async () => {
    const good = validPlaybook({ stages: [{ id: 's', title: 'S', steps: [
      { title: 'Файл', execution_kind: 'programmatic', validation: { file_exists: { path: '/tmp/x' } } },
    ] }] });
    const run = fakeHermes([good]);
    const { authoring } = load({ runHermes: run });
    const out = await authoring.draft({ username: 'alice', description: 'Процесс' });
    expect(out.draft.stages[0].steps[0].execution_kind).toBe('programmatic');
  });

  it('rejects a goal_template {var} not declared in inputs[]', async () => {
    const bad = validPlaybook({ goal_template: 'Проверить {scenario} на проде', inputs: undefined });
    const run = fakeHermes([bad, bad]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ username: 'alice', description: 'Процесс' }))
      .rejects.toThrow(/scenario/);
  });

  it('allows {input} in goal_template without inputs[] (C7)', async () => {
    const good = validPlaybook({ goal_template: 'Сделать {input}', inputs: undefined });
    const run = fakeHermes([good]);
    const { authoring } = load({ runHermes: run });
    const out = await authoring.draft({ username: 'alice', description: 'Процесс' });
    expect(out.draft.goal_template).toBe('Сделать {input}');
  });

  it('allows arbitrary validation keys on agent steps (C4)', async () => {
    const good = validPlaybook({ stages: [{ id: 's', title: 'S', steps: [
      { title: 'Итог', execution_kind: 'agent', executor_role: 'verifier', minimum_model_level: 'bachelor', context_budget: 'small', validation: { my_free_key: true } },
    ] }] });
    const run = fakeHermes([good]);
    const { authoring } = load({ runHermes: run });
    const out = await authoring.draft({ username: 'alice', description: 'Процесс' });
    expect(out.draft.stages[0].steps[0].validation.my_free_key).toBe(true);
  });

  it('rejects a profile draft without when_to_use (R4)', async () => {
    const bad = validPlaybook();
    delete bad.when_to_use;
    const run = fakeHermes([bad, bad]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ username: 'alice', description: 'Процесс' }))
      .rejects.toThrow(/WHEN_TO_USE_REQUIRED/);
  });

  it('save repeats the semantic check and writes nothing on a hand-edited bad draft (R6)', async () => {
    const bad = validPlaybook({ stages: [{ id: 's', title: 'S', steps: [
      { title: 'Команда', execution_kind: 'programmatic', validation: { shell_command_success: true } },
    ] }] });
    writeDraft('alice', bad);
    const { authoring } = load();
    await expect(authoring.save({ username: 'alice', playbook_id: 'sample' }))
      .rejects.toThrow(/shell_command_success/);
    expect(existsSync(savedFile('alice', 'sample'))).toBe(false);
  });
});

describe('buildAuthoringPrompt (S4a step 1)', () => {
  it('carries every registry key and the sibling step-type catalog', () => {
    fresh(AUTHORING, STORE, PATHS, '../../src/playbook-validators.js');
    const { buildAuthoringPrompt } = require(AUTHORING);
    const { listValidatorCatalog } = require('../../src/playbook-validators');
    const prev = process.env.PLAYBOOK_SIBLING_ROOTS;
    const catRoot = mkdtempSync(join(tmpdir(), 'authoring-cat-'));
    mkdirSync(join(catRoot, 'library'), { recursive: true });
    mkdirSync(join(catRoot, 'playbooks'), { recursive: true });
    writeFileSync(join(catRoot, 'library', 'step-types.json'), JSON.stringify([{ id: 'define-use-case', purpose: 'ценность' }]));
    process.env.PLAYBOOK_SIBLING_ROOTS = catRoot;
    try {
      const prompt = buildAuthoringPrompt();
      for (const { key } of listValidatorCatalog()) expect(prompt).toContain(key);
      expect(prompt).toContain('define-use-case');
      expect(prompt).toContain('[ДОСТУПНЫЕ ПРОВЕРКИ');
    } finally {
      if (prev === undefined) delete process.env.PLAYBOOK_SIBLING_ROOTS;
      else process.env.PLAYBOOK_SIBLING_ROOTS = prev;
      rmSync(catRoot, { recursive: true, force: true });
    }
  });
});

describe('username guard (class fix: never resolve to users/undefined)', () => {
  it('refuses authoring without a username instead of writing to users/undefined', async () => {
    const run = fakeHermes([]);
    const { authoring } = load({ runHermes: run });
    await expect(authoring.draft({ description: 'x' })).rejects.toThrow(/USER_REQUIRED/);
    await expect(authoring.save({ playbook_id: 'sample' })).rejects.toThrow(/USER_REQUIRED/);
    await expect(authoring.edit({ playbook_id: 'sample', instruction: 'x' })).rejects.toThrow(/USER_REQUIRED/);
    expect(run.calls).toHaveLength(0);
    expect(existsSync(join(root, 'users', 'undefined'))).toBe(false);
  });
});
