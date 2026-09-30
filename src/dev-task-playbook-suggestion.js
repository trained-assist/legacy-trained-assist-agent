'use strict';

// Slice C of sub-issue #1573 (epic #1372): auto-offer the audience-default
// playbook at the start of a *development-like* task, so the agent proposes the
// process scaffold instead of waiting to be asked.
//
// This module is pure and read-only — it returns a prompt section to inject.
// The module itself never compiles, creates or activates a plan; the prompt
// it generates tells the agent when playbook_run(activate: true) is appropriate
// (agreed task → activate, not-yet-agreed → suggest only). The earlier
// «never activate yourself» wording contradicted the persona's «don't re-ask
// on an agreed task» rule, so the agent skipped the playbook entirely — fixed
// in #1719.
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
// No member is advertised as «the usual one»: the earlier «самый частый случай»
// on feature made the model push bug reports through the feature process
// (user scenario, requirement challenge, design proposal…), steps that the
// debugging playbook deliberately leaves out.
const ENGINEERING_FAMILY_HINTS = {
  feature: 'новая функциональность или изменение поведения по запросу (не баг)',
  debugging: 'баг / регрессия / ошибка в логах: воспроизвести → причина → фикс → убедиться, что ошибка ушла',
  'new-software': 'новый модуль/сервис с нуля, свобода в архитектуре: сначала песочница, потом код',
};

// Which family member fits this task text. Bug signals win over build signals:
// «почини баг в новой фиче» is a bug. null = no strong signal, the model picks.
const BUG_TASK_RE = new RegExp([
  'баг|\\bbug\\b|ошибк|почини|исправь|багфикс|hotfix|bugfix',
  'не\\s+(?:работает|отвечает|приходит|открывается|грузится|запускается|отправляет|сохраняет)',
  'перестал|сломал|слома[нл]|пада[ею]т|упал|вылета|завис|регресс',
  '\\bregression\\b|\\bcrash|\\bbroken\\b|\\berror\\b|\\bexception\\b|stack\\s*trace|traceback',
].join('|'), 'i');
const NEW_SOFTWARE_RE = /с\s+нуля|нов(?:ый|ого)\s+(?:сервис|модул|репозитор|бот)|\bfrom\s+scratch\b|\bnew\s+(?:service|module|repo)/i;

function recommendEngineeringPlaybook(task) {
  const text = typeof task === 'string' ? task : '';
  if (!text.trim()) return null;
  if (BUG_TASK_RE.test(text)) return 'debugging';
  if (NEW_SOFTWARE_RE.test(text)) return 'new-software';
  return null;
}

const RECOMMEND_REASONS = {
  debugging: 'в запросе признаки бага. Баг-репорт идёт через `debugging` (контекст → воспроизведение → причина → фикс → ошибка ушла в проде), НЕ через `feature`: шаги «сценарий пользователя», «челлендж требований», «предложение дизайна» для бага лишние.',
  'new-software': 'в запросе новый модуль/сервис с нуля.',
};

function isDisabled(env) {
  const raw = (env || process.env).DEV_PLAYBOOK_SUGGESTION;
  return typeof raw === 'string' && /^(off|0|false|no|disabled)$/i.test(raw.trim());
}

// Shared by both variants. One tracker: an active plan is executed by the durable
// executor and projects its own checklist.md, so a parallel root checklist.md
// would be a second, competing tracker for the same work.
const CONSENT_RULES = [
  'Крупная задача (фича, баг с неясной причиной, несколько файлов/модулей, новый сервис) идёт через плейбук: `playbook_run(playbook_id: "<id>", goal: "...", vars: { repo: "owner/name" })` — целевой репозиторий обязателен (или ссылка на него в goal), без него план не создастся.',
  'Задача уже согласована (пользователь сам попросил, сказал «делай/давай», нажал кнопку действия) → это и есть согласие: вызывай `playbook_run(...)` без `mode`, НЕ переспрашивай. Режим выбирает код: в Telegram — гайд в этом диалоге, либо фон, если здесь уже идёт другой гайд. `mode: "background"` (+ `activate: true`) — только если пользователь явно сказал «в фоне / параллельно / сам доделай». Ответ содержит `mode`: guide → веди шаги здесь по `checklist_md`, отмечай `[x]` в checklist.md по факту, гейты — только по зелёной проверке; background → шаги исполняет durable-исполнитель, не дублируй их, коротко сообщи, что план запущен и сколько в нём шагов.',
  'Плейбук — шаблон: перед запуском посмотри его шаги (`playbook_get`) и сразу выключи те, что к этой цели не относятся (для небольшой задачи обычно треть): `playbook_run(..., steps: [{ step: "<название или номер>", enabled: false, reason: "почему не нужен" }])`. Гейты CI/staging/мержа выключить нельзя. Ответ `playbook_run` содержит `steps` — все шаги с `enabled`.',
  'Задача ещё не согласована → только предложи плейбук одной фразой; без согласия план не активируй.',
  'С активным фоновым планом НЕ веди отдельный checklist.md в корне проекта — план сам исполняется и ведёт свою проекцию; в гайде checklist.md и есть трекер, секцию уже дописал тул — не дублируй. Внешние эффекты хуков (уведомления/issue/публикация) — только с `approve_hooks: true`. Мелкую правку просто сделай, без плейбука.',
];

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
    const recommended = recommendEngineeringPlaybook(task);
    const pick = recommended && family.includes(recommended)
      ? [`Для этой задачи: \`${recommended}\` — ${RECOMMEND_REASONS[recommended]}`]
      : [];
    return [
      '[ПРОЦЕСС РАЗРАБОТКИ ДОСТУПЕН]',
      'Для инженерных задач есть плейбуки (пошаговый контракт с проверками и durable-ожиданиями CI/деплоя/ответа):',
      ...family.map(pid => `- \`${pid}\` — ${ENGINEERING_FAMILY_HINTS[pid]}`),
      ...pick,
      ...CONSENT_RULES,
    ].join('\n');
  }

  return [
    '[ПРОЦЕСС РАЗРАБОТКИ ДОСТУПЕН]',
    `Для этой задачи доступен плейбук процесса \`${id}\` (пошаговый инженерный контракт: frame → discover → design → build → deliver).`,
    ...CONSENT_RULES,
  ].join('\n');
}

module.exports = {
  ENGINEERING_FAMILY,
  DEV_TASK_RE,
  BUG_TASK_RE,
  recommendEngineeringPlaybook,
  isDevelopmentTask,
  buildDevPlaybookSuggestion,
};
