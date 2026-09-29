'use strict';

// Playbook authoring — turns a natural-language process description into a
// valid Playbook v1 via Hermes (issue #1372, slice P1).
//
// The user never writes JSON: they describe the process, Hermes rewrites it
// into the Playbook v1 contract (contracts/playbook.schema.json) following the
// house meta-patterns baked into AUTHORING_PROMPT, the validator enforces the
// contract, and the result is saved into the profile as a custom playbook.
//
// Flow:
//   playbook_draft  description        → Hermes → draft (profile scope) on disk
//   playbook_edit   id + instruction   → Hermes → updated draft on disk
//   playbook_save   id                 → validator → ~/users/<profile>/playbooks/<id>.json
//
// Drafts are durable: stored under the profile's playbooks/.drafts/ dir, so an
// edit/save can resume after a restart without replaying the conversation.
// Drafts never shadow a live playbook until save() promotes them, and a save
// pins a monotonically increasing version (v = max version across all levels
// + 1) so an already-running plan pinned to an older version is never mutated.
// A declared scope of "system" cannot be saved here — repo playbooks change
// only through a PR.

const fs = require('fs');
const path = require('path');
const {
  PlaybookStore,
  validatePlaybook,
  renderPlaybook,
  playbookError,
  PLAYBOOK_ID_RE,
  siblingRepoRoots,
} = require('./playbook-store');
const { listValidatorCatalog } = require('./playbook-validators');
const { userWorkDir } = require('./data-paths');
const { atomicText } = require('./atomic-json');
const { hermesRun } = require('./hermes-run');

const schema = require('../contracts/playbook.schema.json');

// Resolve local "#/$defs/X" refs into a self-contained schema. Hermes is a
// text-in/JSON-out worker: a flattened schema is far more reliable for the
// model than $ref indirection, while server-side validation still uses the
// authoritative schema file.
function inlineSchema(node, defs) {
  if (Array.isArray(node)) return node.map(n => inlineSchema(n, defs));
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
      const key = node.$ref.slice('#/$defs/'.length);
      if (!Object.prototype.hasOwnProperty.call(defs, key)) {
        throw new Error(`inlineSchema: unknown ref ${node.$ref}`);
      }
      return inlineSchema(defs[key], defs);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs' || k === '$id') continue;
      out[k] = inlineSchema(v, defs);
    }
    return out;
  }
  return node;
}

const AUTHORING_SCHEMA = inlineSchema(schema, schema.$defs || {});

// Authoring output is inherently large: the prompt asks for 15-20 steps, each
// carrying validation/executor/timing fields. The generic hermes-run default
// (3000) fits a research answer but truncates a full Playbook v1 for verbose
// models, and the whole JSON is invalid once cut — playbook_draft also accepts
// a model override, so the budget must not depend on the chosen model.
const AUTHORING_MAX_TOKENS = 6000;

// House meta-patterns. This is the difference between a pile of steps and a
// playbook the executor can actually run: machine-checkable validation on
// every agent step, an executor profile instead of a concrete model, cheap
// programmatic steps for objective checks, and hooks only on boundaries.
const AUTHORING_PROMPT = [
  'Ты — редактор плейбуков внутри trained-assist. Пользователь описывает рабочий процесс своими словами,',
  'а ты превращаешь его в Playbook v1 — валидный JSON строго по переданной схеме. Верни ТОЛЬКО JSON.',
  '',
  'Обязательные мета-паттерны:',
  '1. Плейбук — версионированный артефакт, не промпт. id — латиница, kebab-case, по смыслу процесса (например "finance-intake");',
  '   version — 1; scope — "profile".',
  '2. У каждого agent-шага ДОЛЖЕН быть машинно-проверяемый validation — непустой объект с конкретными проверяемыми',
  '   условиями ({"facts_file_exists": true}, {"explicit_go_no_go": true}), а не проза. По нему исполнитель решает «готово?».',
  '3. Шаг объявляет профиль исполнителя, а не конкретную модель: executor_role (researcher|developer|reviewer|verifier),',
  '   minimum_model_level (bachelor|master|doctor), context_budget (small|medium|large). Имён моделей/провайдеров быть НЕ должно.',
  '4. Объективные проверки (CI зелёный, merge, файл существует, ответ API) — это execution_kind "programmatic",',
  '   без executor_role/minimum_model_level/context_budget. Не тратим модель на то, что отвечает API.',
  '5. Режь процесс на мелкие шаги, всего 15-20 пунктов. Для шагов, которые могут падать или идти долго,',
  '   задавай max_attempts (2-3) и execution_timeout_seconds (обычно 300-900). Для ожидания CI/деплоя — delay_after_sec.',
  '6. defaults: max_attempts 3, execution_timeout_seconds 600, recovery_policy "default".',
  '7. Хуки — только на границах (stage.on_enter/on_exit, step.on_complete/on_fail, hooks.task_done/task_failed).',
  '   Закрытый словарь type: notify|check|create_issue|publish. notify наружу (боссу/клиенту) — редко и по делу:',
  '   это внешнее сообщение, оно требует согласия.',
  '8. goal_template — как запускается плейбук; может содержать {input} (подставится цель запуска).',
  '9. Тексты title/instructions — короткие и конкретные, повелительные. Язык — русский.',
  '10. Не выдумывай фазы вне описанного процесса. Чего не хватает — сделай разумное допущение внутри шага,',
  '    но не добавляй целые этапы от себя.',
  '11. Для scope "profile" обязателен непустой when_to_use — 1-2 фразы «когда предлагать этот плейбук»,',
  '    на языке пользователя (по ним агент узнаёт плейбук из обычной просьбы без id).',
  '12. В programmatic-шаге validation — ТОЛЬКО ключи из списка доступных проверок ниже (ровно эти имена),',
  '    и без instructions к исполнению: объективную проверку исполняет рантайм по ключу, а не модель.',
].join('\n');

// ── Authoring catalog: what the runtime can actually check and reuse ─────────
// D1 (issue #1851): Hermes used to invent validators (shell_command_success)
// and leave {var} literals unbacked, and the bad playbook still saved. The
// prompt now carries the REAL registry keys and the shared step-type library,
// and authoring enforces those keys on draft/edit/save. Both catalogs are read
// dynamically from their single sources (C3), never hardcoded.

// The shared step-type library lives in the domain-skill (sibling) repos as
// library/step-types.json. A profile without a sibling (or a missing/broken
// file) yields an empty catalog — not an error.
function loadStepTypeCatalog({ siblingRoots } = {}) {
  const roots = siblingRoots || siblingRepoRoots();
  for (const root of roots) {
    const file = path.join(root, 'library', 'step-types.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // missing / unreadable / malformed → try the next root
    }
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw && raw.step_types) ? raw.step_types : null);
    if (!arr) continue;
    return arr
      .map(t => ({ id: t && (t.id || t.title), purpose: (t && t.purpose) || '', execution_kind: (t && t.execution_kind) || '' }))
      .filter(t => t.id);
  }
  return [];
}

function buildValidatorCatalogBlock(catalog) {
  const rows = Array.isArray(catalog) ? catalog : listValidatorCatalog();
  return [
    '[ДОСТУПНЫЕ ПРОВЕРКИ (validation) — только эти ключи для execution_kind "programmatic"]',
    ...rows.map(r => `- ${r.key}${r.note ? ` — ${r.note}` : ''}`),
    'Любой другой ключ в programmatic-шаге — ошибка: система не сможет его проверить. Для смысловых',
    'проверок, которые оценивает модель, используй agent-шаг (там validation — свободный объект).',
  ].join('\n');
}

function buildStepTypeCatalogBlock(stepTypes) {
  const rows = Array.isArray(stepTypes) ? stepTypes : loadStepTypeCatalog();
  if (!rows.length) return '';
  return [
    '[КАТАЛОГ ТИПОВЫХ ШАГОВ (step_type — назначение; поле информационное, можно указать на шаге)]',
    ...rows.map(t => `- ${t.id}${t.purpose ? ` — ${t.purpose}` : ''}`),
  ].join('\n');
}

// AUTHORING_PROMPT + the two dynamic catalogs. Kept separate from the constant
// so the base prompt stays a stable export and tests can assert the catalogs.
function buildAuthoringPrompt({ validatorCatalog, stepTypes } = {}) {
  const blocks = [buildValidatorCatalogBlock(validatorCatalog), buildStepTypeCatalogBlock(stepTypes)].filter(Boolean);
  return [AUTHORING_PROMPT, ...blocks].join('\n\n');
}

// Split a goal_template into {name} tokens. {input} is always allowed (C7): it is
// the run's goal slot, not a declared input.
function goalTemplateVars(goalTemplate) {
  const text = typeof goalTemplate === 'string' ? goalTemplate : '';
  const out = new Set();
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== 'input') out.add(m[1]);
  }
  return [...out];
}

// Semantic rules that the JSON schema cannot express — enforced ONLY on the
// authoring path (draft/edit/save), never in validatePlaybook/_load, so already
// saved playbooks keep loading (C1). Agent steps are exempt (C4).
function assertAuthoringSemantics(playbook, { validatorKeys = null, requireWhenToUse = false } = {}) {
  const keys = new Set(validatorKeys || listValidatorCatalog().map(v => v.key));
  const declaredInputs = new Set((Array.isArray(playbook.inputs) ? playbook.inputs : []).map(i => i && i.name));
  for (const stage of playbook.stages || []) {
    for (const step of stage.steps || []) {
      if (step && step.execution_kind === 'programmatic') {
        for (const key of Object.keys(step.validation || {})) {
          if (!keys.has(key)) {
            throw playbookError('PROGRAMMATIC_UNKNOWN_VALIDATOR',
              `unknown programmatic validator "${key}" в шаге «${step.title}»; доступны: ${[...keys].join(', ')}`);
          }
        }
      }
    }
  }
  const undeclared = goalTemplateVars(playbook.goal_template).filter(v => !declaredInputs.has(v));
  if (undeclared.length) {
    const list = undeclared.map(v => `{${v}}`).join(', ');
    throw playbookError('GOAL_TEMPLATE_UNDECLARED_VAR',
      `${list} в goal_template без inputs[] — объяви ${undeclared.join(', ')} в inputs[] (кроме {input})`);
  }
  if (requireWhenToUse && !(typeof playbook.when_to_use === 'string' && playbook.when_to_use.trim())) {
    throw playbookError('WHEN_TO_USE_REQUIRED',
      'для profile-плейбука нужен непустой when_to_use — 1-2 фразы «когда предлагать» (иначе он недостижим из обычной просьбы)');
  }
  return true;
}

function assertId(id, field) {
  if (typeof id !== 'string' || !PLAYBOOK_ID_RE.test(id)) {
    throw playbookError('INVALID_ID', `${field} должен быть latin kebab-case: ${JSON.stringify(id)}`);
  }
  return id;
}

// A missing username must fail loudly, never resolve to a literal "users/undefined"
// profile — that is how a dropped ctx argument once leaked test artifacts into
// ~/users/undefined/. Defense in depth on top of the MCP ctx-forwarding fix.
function assertUser(username) {
  if (typeof username !== 'string' || !username.trim()) {
    throw playbookError('USER_REQUIRED', 'username (profile id) обязателен');
  }
  return username;
}

function draftsDir(username) {
  return path.join(userWorkDir(username), 'playbooks', '.drafts');
}

function draftPath(username, id) {
  return path.join(draftsDir(username), `${id}.json`);
}

function profilePlaybookPath(username, id) {
  return path.join(userWorkDir(username), 'playbooks', `${id}.json`);
}

function writeJsonAtomic(file, obj) {
  // Byte-identical to the previous writer: pretty JSON + trailing newline.
  atomicText(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function buildDraftContext(description, seed) {
  const parts = ['Описание процесса от пользователя:', String(description).trim()];
  if (seed) {
    parts.push('');
    parts.push('Возьми за основу существующий плейбук (сохрани смысл, структуру можно менять):');
    parts.push(JSON.stringify(seed, null, 2));
  }
  return parts.join('\n');
}

function buildEditContext(current, instruction) {
  return [
    'Текущий плейбук (JSON):',
    JSON.stringify(current, null, 2),
    '',
    'Правка от пользователя:',
    String(instruction).trim(),
    '',
    'Верни ЦЕЛИКОМ обновлённый плейбук (не патч). Сохрани id и всё, чего правка не касается.',
  ].join('\n');
}

function buildRepairContext(raw, error) {
  return [
    'Предыдущий ответ не прошёл валидацию схемы Playbook v1.',
    `Ошибка: ${error && error.message ? error.message : String(error)}`,
    'Предыдущий ответ (JSON):',
    JSON.stringify(raw, null, 2),
    '',
    'Исправь строго по схеме. Верни ТОЛЬКО валидный JSON-объект Playbook v1.',
  ].join('\n');
}

// Drafts are always profile-scope candidates; version is (re)computed at save.
function normalizeDraft(raw, { fallbackId = null } = {}) {
  const out = { ...raw };
  out.scope = 'profile';
  out.version = 1;
  if (typeof out.id !== 'string' || !PLAYBOOK_ID_RE.test(out.id)) {
    if (fallbackId && PLAYBOOK_ID_RE.test(fallbackId)) out.id = fallbackId;
    else {
      throw playbookError('AUTHORING_INVALID',
        `Hermes вернул некорректный id ${JSON.stringify(raw.id)} — нужен latin kebab-case`);
    }
  }
  return out;
}

function summarizePlaybook(pb) {
  return {
    id: pb.id,
    title: pb.title,
    version: pb.version,
    when_to_use: pb.when_to_use || null,
    stages: (pb.stages || []).length,
    steps: (pb.stages || []).reduce((n, s) => n + (s.steps || []).length, 0),
  };
}

// Structural diff between two playbooks (what an edit changed), by title/id.
function diffPlaybooks(before, after) {
  const stageMap = pb => new Map((pb.stages || []).map(s => [s.id, s]));
  const bStages = stageMap(before);
  const aStages = stageMap(after);
  const stagesAdded = [...aStages.keys()].filter(k => !bStages.has(k)).map(k => aStages.get(k).title);
  const stagesRemoved = [...bStages.keys()].filter(k => !aStages.has(k)).map(k => bStages.get(k).title);

  const stepTitles = pb => new Set((pb.stages || []).flatMap(s => (s.steps || []).map(st => st.title)));
  const bSteps = stepTitles(before);
  const aSteps = stepTitles(after);
  return {
    stages_added: stagesAdded,
    stages_removed: stagesRemoved,
    steps_added: [...aSteps].filter(t => !bSteps.has(t)),
    steps_removed: [...bSteps].filter(t => !aSteps.has(t)),
  };
}

function createPlaybookAuthoring({
  runHermes = hermesRun,
  storeFor = username => new PlaybookStore({ profileId: username }),
} = {}) {
  async function callHermes({ username, task, context, model }) {
    let raw;
    try {
      raw = await runHermes({
        username,
        task: `${buildAuthoringPrompt()}\n\n---\n\n${task}`,
        context,
        outputSchema: AUTHORING_SCHEMA,
        model: model || undefined,
        maxTokens: AUTHORING_MAX_TOKENS,
      });
    } catch (error) {
      throw playbookError('AUTHORING_INVALID', `Hermes не вернул валидный JSON: ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw playbookError('AUTHORING_INVALID', 'Hermes вернул не JSON-объект Playbook v1');
    }
    return raw;
  }

  // One authoring call + schema validation + semantic rules, with a single
  // repair attempt that feeds the errors back to Hermes. On a second failure the
  // caller gets a clear error and nothing is written to disk.
  async function authorAndValidate({ username, task, context, model, fallbackId = null }) {
    const raw = await callHermes({ username, task, context, model });
    try {
      const playbook = normalizeDraft(raw, { fallbackId });
      validatePlaybook(playbook);
      assertAuthoringSemantics(playbook, { requireWhenToUse: playbook.scope === 'profile' });
      return playbook;
    } catch (first) {
      const repaired = await callHermes({
        username,
        task,
        model,
        context: buildRepairContext(raw, first),
      });
      try {
        const playbook = normalizeDraft(repaired, { fallbackId });
        validatePlaybook(playbook);
        assertAuthoringSemantics(playbook, { requireWhenToUse: playbook.scope === 'profile' });
        return playbook;
      } catch (second) {
        throw playbookError('AUTHORING_INVALID',
          `Hermes дважды вернул невалидный Playbook v1: ${second.message}`);
      }
    }
  }

  function readDraft(username, id) {
    assertUser(username);
    assertId(id, 'playbook_id');
    const file = draftPath(username, id);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw playbookError('INVALID_JSON', `${file}: ${error.message}`);
    }
  }

  function writeDraft(username, playbook) {
    writeJsonAtomic(draftPath(username, playbook.id), playbook);
  }

  return {
    readDraft,

    async draft({ username, description, based_on = null, model = null, vars = {} } = {}) {
      assertUser(username);
      if (!description || !String(description).trim()) {
        throw playbookError('DESCRIPTION_REQUIRED', 'нужно описание процесса словами');
      }
      let seed = null;
      if (based_on) {
        assertId(based_on, 'based_on');
        seed = storeFor(username).resolve(based_on);
        if (!seed) throw playbookError('BASE_NOT_FOUND', `плейбук-основа «${based_on}» не найден`);
      }
      const playbook = await authorAndValidate({
        username,
        model,
        fallbackId: based_on,
        task: seed
          ? 'Составь Playbook v1 по описанию процесса, взяв за основу плейбук из контекста.'
          : 'Составь Playbook v1 по описанию процесса из контекста.',
        context: buildDraftContext(description, seed),
      });
      writeDraft(username, playbook);
      return { draft: playbook, render: renderPlaybook(playbook, vars), summary: summarizePlaybook(playbook) };
    },

    async edit({ username, playbook_id, instruction, model = null, vars = {} } = {}) {
      assertUser(username);
      assertId(playbook_id, 'playbook_id');
      if (!instruction || !String(instruction).trim()) {
        throw playbookError('INSTRUCTION_REQUIRED', 'нужна формулировка правки');
      }
      const before = readDraft(username, playbook_id) || storeFor(username).resolve(playbook_id);
      if (!before) {
        throw playbookError('DRAFT_NOT_FOUND', `нет ни черновика, ни плейбука «${playbook_id}»`);
      }
      const playbook = await authorAndValidate({
        username,
        model,
        fallbackId: playbook_id,
        task: 'Отредактируй Playbook v1 по правке пользователя из контекста. Верни плейбук целиком.',
        context: buildEditContext(before, instruction),
      });
      playbook.id = playbook_id; // editing a playbook never changes its identity
      writeDraft(username, playbook);
      return {
        draft: playbook,
        render: renderPlaybook(playbook, vars),
        diff: diffPlaybooks(before, playbook),
        summary: summarizePlaybook(playbook),
      };
    },

    async save({ username, playbook_id, vars = {} } = {}) {
      assertUser(username);
      assertId(playbook_id, 'playbook_id');
      const draft = readDraft(username, playbook_id);
      if (!draft) {
        throw playbookError('DRAFT_NOT_FOUND', `нет черновика «${playbook_id}» — сначала playbook_draft или playbook_edit`);
      }
      if (draft.scope !== 'profile') {
        throw playbookError('SAVE_SYSTEM_SCOPE',
          'системный (scope "system") плейбук меняется только через PR в репозиторий; сохранить можно только profile-scope черновик');
      }
      const version = storeFor(username).maxVersion(playbook_id) + 1;
      const playbook = { ...draft, scope: 'profile', version };
      validatePlaybook(playbook);
      // R6: repeat the authoring semantics on save (a hand-edited draft must not
      // smuggle an invented validator or a stray {var} into a saved playbook).
      assertAuthoringSemantics(playbook, { requireWhenToUse: true });
      const file = profilePlaybookPath(username, playbook_id);
      writeJsonAtomic(file, playbook);
      fs.rmSync(draftPath(username, playbook_id), { force: true });
      return {
        saved: { id: playbook.id, version, scope: 'profile', source: 'profile', path: file },
        render: renderPlaybook(playbook, vars),
        summary: summarizePlaybook(playbook),
      };
    },
  };
}

module.exports = {
  createPlaybookAuthoring,
  AUTHORING_PROMPT,
  AUTHORING_MAX_TOKENS,
  AUTHORING_SCHEMA,
  buildAuthoringPrompt,
  loadStepTypeCatalog,
  buildValidatorCatalogBlock,
  buildStepTypeCatalogBlock,
  assertAuthoringSemantics,
  summarizePlaybook,
  diffPlaybooks,
  _internal: { inlineSchema, normalizeDraft, draftPath, profilePlaybookPath, goalTemplateVars },
};
