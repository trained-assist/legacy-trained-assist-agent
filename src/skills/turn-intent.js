'use strict';
// Turn-intent → skill sections (architecture issue #76 L1): mount the MCP servers and
// modules of THIS turn instead of the whole profile set.
//
// One deterministic pass over the task text — no model call (issue's «дешёвый первый
// шаг»: a domain keyword is enough to decide). Anything this map does not recognise
// falls through to the FULL profile set: never narrow on a guess — the risk here is
// quality, not money. Model-based estimation (the input-router's `sections[]`, #1542 P1)
// is the natural L2 and deliberately not wired yet: its section ids don't match the
// catalog and its shadow result isn't available synchronously.
//
// The map IS the maintenance cost the issue calls out: a new section no intent points
// at can never be mounted by a turn. Gates (test/turn-intent.test.cjs):
//   1. every catalog section except `core` is covered by at least one intent
//      (named directly, or named via an ancestor that intent selects);
//   2. every intent names only sections that exist in config/skill-catalog.json;
//   3. every intent's `sample` actually matches its own regex (no dead rules).
//
// Consumers:
//   src/runner/index.js  estimate → planFor({intent}) → mount note → tool_escalation net
//   src/skills/resolve.js  relevance filter (uses its own section-tree helper)

const ESCALATION_MARKER = 'TOOL_ESCALATION';

// id        — intent name (stable, appears in logs/audit)
// sections  — config/skill-catalog.json section ids this intent mounts
// sample    — a real turn that MUST match (kept honest by the CI gate)
// test      — deterministic match over the task text
const TURN_INTENTS = [
  { id: 'recruiting', sections: ['recruiting'],
    sample: 'нужен специалист по подбору персонала',
    test: /рекрут|подбор\w*|найти (?:специалиста|сотрудника|работника|кандидата)|нанимать|стажер|кадров/i },
  { id: 'hh', sections: ['recruiting/hh'],
    sample: 'покажи мои вакансии',
    test: /\bhh(?:\.ru)?\b|hh_|headhunter|ваканси|резюме|кандидат\w*|отклик\w*|соискател|совместн[а-яё]* поиск|холодн[а-яё]* поиск|ats[- _]?конфиг/i },
  { id: 'interview', sections: ['recruiting/interview'],
    sample: 'расшифруй интервью с кандидатом',
    test: /интервью|собеседовани|расшифров\w*|транскрипт|видеозапис\w*|изучи (?:эти |все )?видео/i },
  { id: 'company', sections: ['recruiting/company'],
    sample: 'проверь компанию по ИНН',
    test: /\bинн\b|checko|dadata|\bогрн\b|компани\w*|контрагент/i },
  { id: 'gdrive', sections: ['gdrive'],
    sample: 'открой таблицу в гугл-диске',
    test: /gdrive_|google (?:drive|docs|sheets)|гугл[- ]?(?:диск|док|таблиц|драйв)|в гугл\w* док\w*/i },
  { id: 'documents', sections: ['documents'],
    sample: 'собери презентацию в pdf',
    test: /презентац|\bpptx?\b|\bdocx\b|\bpdf\b|слайд\w*|экспор[а-яё]* в (?:pdf|word|docx|pptx)/i },
  { id: 'crm-weeek', sections: ['crm-weeek'],
    sample: 'покажи сделки по фамилии',
    test: /weeek|\bcrm\b|воронк|сделк\w*/i },
  { id: 'getcourse', sections: ['getcourse'],
    sample: 'сделай вебинар в getcourse',
    test: /getcourse|вебинар/i },
  { id: 'nalog', sections: ['nalog'],
    sample: 'выбери чек по налогам',
    test: /налог|нпд|самозанят|lknpd|фнс|чек(?!-)/i },
  { id: 'tilda', sections: ['tilda'],
    sample: 'страница опубликована на тильде',
    test: /\btilda\b|тильд/i },
  { id: 'illustrate', sections: ['illustrate'],
    sample: 'нарисуй иллюстрацию к разделу',
    test: /нарису|иллюстр|картинк|рисунок/i },
  { id: 'flexi-expo', sections: ['flexi-expo'],
    sample: 'проработай эту выставку от начала до конца',
    test: /выставк|\bexpo\b|экспо|стенд\w*/i },
  // Общий writer сообщений (#2034): ходы про «напиши/сформулируй сообщение» и про
  // оценку сообщения. Без этого интента секция communication не монтировалась бы
  // НИ ОДНИМ ходом — гейт CI (каждая секция покрыта интентом) правда, а не формальность.
  // Классы букв — [а-яё], НЕ \w: в JS \w не матчит кириллицу, и «напиш\w* сообщение»
  // молча не матчит «напиши сообщение» (остальные интенты спасает префиксное совпадение).
  { id: 'message-writing', sections: ['communication'],
    sample: 'напиши сообщение кандидату, который откликнулся на вакансию',
    test: /(?:напиш[а-яё]*|сформулируй|сгенерируй|черновик)\s+(?:сообщени[а-яё]*|ответ[а-яё]*)|качеств[а-яё]*\s+сообщени|оцени[а-яё]*\s+сообщени/i },
  { id: 'marketing', sections: ['marketing'],
    sample: 'сделай разбор customer development',
    test: /маркетинг|customer development|cd[_-]|юзабилити/i },
  { id: 'freelance', sections: ['freelance'],
    sample: 'нужно техническое задание на аутсорс-проект',
    test: /фриланс|аутсорс|техническ[а-яё]* задани|техзадани|freelance_/i },
  // ТЗ/спецификация: генерация спецификаций живёт в software-engineering
  // (65-spec-generation.js), контекст проекта — во freelance. Ход «собери ТЗ»
  // матчит оба интента → секции объединяются, инженерные ТЗ-тулы не прячутся
  // под фриланс-интентом (регрессия #1963: фриланс-аудитория потеряла
  // engineering_generate_spec и молча делала клиентское ТЗ из шаблона).
  { id: 'spec', sections: ['freelance', 'software-engineering'],
    sample: 'собери ТЗ по проекту visitka',
    test: /техническ[а-яё]*\s*задани|техзадани|специфик\w*|(?:^|[^а-яё])тз(?![а-яё])/i },
  { id: 'software-engineering', sections: ['software-engineering'],
    sample: 'задеплой ветку с фиксом бага',
    test: /\b(?:pr|commit|merge|deploy|github|git|repo|branch|worktree|npm|node|eslint)\b|engineering_|деплой|задеплой|ишью|репозитори|ветк\w*|коммит|мерж|пулл[- ]?реквест|баг/i },
  { id: 'website-api', sections: ['website-api'],
    sample: 'черновик api из сайта готов',
    test: /api из сайта|website[- _]?api|черновик api/i },
  { id: 'demo', sections: ['demo'],
    sample: 'включи демо-режим рекрутинга',
    test: /демо[- ]?режим|демо-ваканси|демо рекрутинг/i },
];

/**
 * Deterministic estimate for one turn. Returns null when nothing matched → the caller
 * mounts the full profile set. Never throws, never calls a model, no fs.
 *
 * @param {string} task user text of this turn
 * @returns {{intents: string[], sections: string[]} | null}
 */
function estimateTurnIntent(task) {
  const text = String(task || '');
  if (!text) return null;
  const intents = [];
  const sections = [];
  for (const entry of TURN_INTENTS) {
    let matched = false;
    try { matched = entry.test.test(text); } catch { matched = false; }
    if (!matched) continue;
    if (!intents.includes(entry.id)) intents.push(entry.id);
    for (const s of entry.sections) if (!sections.includes(s)) sections.push(s);
  }
  if (!intents.length) return null;
  return { intents, sections };
}

/**
 * Prompt block injected into the run when the mount is narrowed (issue #76 §3):
 * the model must NOT silently give up on a missing tool — it emits the escalation
 * marker and the runner re-runs the task with the full profile set (one transition).
 */
function buildMountNote({ sections = [] } = {}) {
  if (!sections.length) return '';
  return [
    '[МОНТИРОВАНИЕ ИНСТРУМЕНТОВ ЭТОГО ХОДА]',
    `Подключены только секции навыков: ${sections.join(', ')} (плюс ядро).`,
    'Если для задачи нужен инструмент, которого нет в списке доступных, — НЕ отказывайся и НЕ упрощай задачу молча. Сделай всё возможное имеющимися средствами и добавь в КОНЕЦ ответа отдельную строку ровно в таком формате:',
    `${ESCALATION_MARKER}: <какой инструмент или раздел нужен>`,
    'Система доустановит полный набор и повторит задачу автоматически. Строку пиши ТОЛЬКО если инструмента действительно не хватает; если задача выполнена — не пиши её.',
  ].join('\n');
}

// The marker line anywhere in the run's text (the note asks for it as its own line).
const MARKER_RE = new RegExp(`^[^\\S\\n]*${ESCALATION_MARKER}\\s*[:：]\\s*(.+)$`, 'mi');
// Softer phrasing, accepted only in the FINAL answer — mid-run narration may quote
// rules about tools that don't exist. False positive costs one full-set re-run.
const PHRASE_RE = /не хватает инструмент|нет (?:нужного|доступного|подходящего) инструмент|у меня нет доступа к инструмент|отсутствует инструмент|don'?t have (?:the |a )?(?:required |necessary )?tool|no (?:access to the |required )?tool/i;

/**
 * Did the task hit a missing tool? (issue #76 §3, «молча остаться без инструмента
 * нельзя»). Returns null or {reason, via}.
 */
function detectEscalation(text, lastMessage = '') {
  const full = String(text || '');
  const m = full.match(MARKER_RE);
  if (m) return { reason: String(m[1] || '').trim().slice(0, 300), via: 'marker' };
  const last = String(lastMessage || '');
  if (last) {
    const p = last.match(PHRASE_RE);
    if (p) return { reason: String(p[0]).slice(0, 300), via: 'phrase' };
  }
  return null;
}

module.exports = {
  TURN_INTENTS,
  ESCALATION_MARKER,
  estimateTurnIntent,
  buildMountNote,
  detectEscalation,
};
