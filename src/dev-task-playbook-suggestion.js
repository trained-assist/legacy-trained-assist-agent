'use strict';

// Slice C of sub-issue #1573 (epic #1372): auto-offer the audience-default
// playbook at the start of a *development-like* task, so the agent proposes the
// process scaffold instead of waiting to be asked.
//
// This module is pure and read-only. It decides whether the agent should be
// *told* a playbook is available, and returns the prompt section to inject. It
// NEVER compiles, creates or activates a plan — the draft→active gate
// (`task_update status=active`) remains an explicit user step (guardrail in the
// text itself).
//
// Opt-in-safe by construction:
//   • not a development-like task        → '' (prompt unchanged)
//   • playbook not available to profile  → '' (no sibling/override → nothing)
//   • disabled via DEV_PLAYBOOK_SUGGESTION=off → ''
// so a profile without the engineering sibling sees byte-identical behaviour.

const { PlaybookStore } = require('./playbook-store');
const { suggestPlaybookForAudience } = require('./audience-default-playbook');

// Conservative, development-oriented heuristic over the raw user task text.
// Deliberately NOT "any message with a verb": the consequence is only a prompt
// hint, but an over-eager match on unrelated tasks would be noise.
//
// Covers the canonical phrasing («поставь изменение X»), bug work, feature/
// implementation work, and explicit repo/PR vocabulary. English mirror included.
// NB: JS \b is ASCII-only — never place it next to Cyrillic (Cyrillic is a
// non-word char, so "\\bбаг\\b" never matches). Cyrillic alternatives are plain
// substrings; ASCII terms keep their word boundaries.
const DEV_TASK_RE = new RegExp([
  // canonical change request
  '(?:поставь|внеси|сделай|добавь|нужн[оа])\\s+(?:это\\s+)?изменени',
  // bugs
  'почини|исправь|фикс|багфикс|hotfix|bugfix',
  'баг|\\bbug\\b|ошибк',
  // build / implement / feature
  'реализ[уо][йе]|реализовать|имплементир|реализаци',
  '\\bimplement\\b|\\bdevelop\\b|\\bbuild\\b',
  'отрефактор|рефактор|refactor',
  'разработа[йть]|разработк',
  '(?:сделай|добавь|нужн[ао])\\s+фич|\\bfeature\\b|фич[ауеи]',
  // tests
  '(?:напиши|добавь|покрой|прогони)\\s+тест|\\btests?\\b',
  // repo / PR vocabulary
  'репозитор|\\brepo\\b|\\bissue\\s*#?\\d+|тикет\\s*#?\\d+',
  'pull\\s*request|\\bPR\\b|gh\\s+pr|открой\\s+(?:pr|ветк)|создай\\s+(?:pr|ветк)',
  'закоммить|закоммит|\\bcommit\\b|коммит|\\bmerge\\b|смерж|мерж',
  '\\bendpoint\\b|\\bapi\\b|\\bsql\\b|скрипт|пакет|библиотек',
].join('|'), 'i');

function isDevelopmentTask(task) {
  const text = typeof task === 'string' ? task.trim() : '';
  if (!text) return false;
  if (text.length < 4) return false;
  // Slash commands are deterministic commands, not dev intent.
  if (text.startsWith('/')) return false;
  return DEV_TASK_RE.test(text);
}

const ENGINEERING_FAMILY = ['feature', 'debugging', 'new-software'];
const ENGINEERING_FAMILY_HINTS = {
  feature: 'новая фича или изменение в существующем продукте (самый частый случай)',
  debugging: 'баг / регрессия / ошибка в логах: воспроизвести → причина → фикс → убедиться, что ошибка ушла',
  'new-software': 'новый модуль/сервис с нуля, свобода в архитектуре: сначала песочница, потом код',
};

function isDisabled(env) {
  const raw = (env || process.env).DEV_PLAYBOOK_SUGGESTION;
  return typeof raw === 'string' && /^(off|0|false|no|disabled)$/i.test(raw.trim());
}

// Build the prompt section to inject, or '' when nothing should change.
// `store` is injectable for tests; production builds a profile-scoped store.
function buildDevPlaybookSuggestion({ task, profileId = null, audience = null, store = null, env = process.env } = {}) {
  if (isDisabled(env)) return '';
  if (!isDevelopmentTask(task)) return '';

  let playbookStore = store;
  if (!playbookStore) {
    try { playbookStore = new PlaybookStore({ profileId }); }
    catch { return ''; }
  }

  let suggestion;
  try { suggestion = suggestPlaybookForAudience(audience, { store: playbookStore, env }); }
  catch { return ''; }
  // Availability is the opt-in gate: no resolved playbook → unchanged prompt.
  if (!suggestion || suggestion.available !== true) return '';

  const id = suggestion.playbook_id;
  // The engineering family (software-engineering-playbooks): offer every member
  // that resolves for this profile, so the agent picks feature vs debugging vs
  // new-software by the task instead of forcing everything through one process.
  const family = ENGINEERING_FAMILY.includes(id)
    ? ENGINEERING_FAMILY.filter(pid => { try { return !!playbookStore.resolve(pid); } catch { return false; } })
    : [];
  if (family.length > 1) {
    return [
      '[ПРОЦЕСС РАЗРАБОТКИ ДОСТУПЕН — предложи его, но НЕ запускай сам]',
      'Для инженерных задач есть плейбуки (пошаговый контракт с проверками и durable-ожиданиями CI/деплоя/ответа):',
      ...family.map(pid => `- \`${pid}\` — ${ENGINEERING_FAMILY_HINTS[pid]}`),
      'Если задача крупная (фича, баг с неясной причиной, несколько файлов/модулей, новый сервис) — предложи провести её через подходящий плейбук: `playbook_run(playbook_id: "<id>", goal: "...")` (собрать черновик-план).',
      'После согласия пользователя план активируется явным шагом `task_update status=active`.',
      'НИКОГДА не запускай и не активируй план самовольно: `draft→active` — только явное решение пользователя. Мелкую правку просто сделай.',
    ].join('\n');
  }
  const scaffold = id === 'development'
    ? '`ba_development_playbook` (развернуть шаги) → `playbook_run` (собрать черновик-план)'
    : `\`playbook_run(playbook_id: "${id}")\` (собрать черновик-план)`;

  return [
    '[ПРОЦЕСС РАЗРАБОТКИ ДОСТУПЕН — предложи его, но НЕ запускай сам]',
    `Для этой задачи доступен плейбук процесса \`${id}\` (пошаговый инженерный контракт: frame → discover → design → build → deliver).`,
    `Если задача крупная (фича, неоднозначная правка, несколько файлов/модулей) — предложи пользователю провести её через процесс: ${scaffold}.`,
    'После согласия пользователя план активируется явным шагом `task_update status=active`.',
    'НИКОГДА не запускай и не активируй план самовольно: `draft→active` — только явное решение пользователя. Мелкую правку просто сделай.',
  ].join('\n');
}

module.exports = {
  ENGINEERING_FAMILY,
  DEV_TASK_RE,
  isDevelopmentTask,
  buildDevPlaybookSuggestion,
};
