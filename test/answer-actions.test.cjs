'use strict';
// service-llm → llm-ladder worker: pin tests to an unroutable host + dummy token so they are
// self-contained (staging runs this file directly, outside scripts/run-cjs-tests.js) and can
// never reach the live worker via the VM's token file.
process.env.LLM_LADDER_URL = 'http://llm-ladder.invalid';
process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/answer-actions');

const ANSWER = 'Разобрал причину: шлюз держит busy весь прогон. Дальше предлагаю создать PR с фиксом в tg-bot и потом задеплоить воркер на прод после зелёного CI. Итог по деньгам уже посчитан.';

function mockFetch(content, ok = true) {
  global.fetch = async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) });
}

test('grounded actions pass, invented ones are dropped', () => {
  const r = A.validateActions({ kind: 'actions', actions: [
    { label: 'Создать PR', quote: 'создать PR с фиксом в tg-bot' },
    { label: 'Задеплоить воркер', quote: 'задеплоить воркер на прод после зелёного CI' },
    { label: 'Удалить базу', quote: 'удалить всю базу пользователей немедленно' },
  ] }, ANSWER);
  assert.deepEqual(r.actions.map(a => a.label), ['Создать PR', 'Задеплоить воркер']);
});

test('max 3, dedupe, service commands dropped', () => {
  const q = 'создать PR с фиксом в tg-bot';
  const r = A.validateActions({ kind: 'menu', actions: [
    { label: '1. Создать PR', quote: q }, { label: 'создать pr', quote: q },
    { label: '/checklist_turn_off', quote: q }, { label: 'Отключить чеклист', quote: q },
  ] }, ANSWER);
  assert.deepEqual(r.actions.map(a => a.label), ['Создать PR']);
});

test('kind none / junk → no actions', () => {
  assert.deepEqual(A.validateActions({ kind: 'none', actions: [{ label: 'x', quote: 'создать PR с фиксом' }] }, ANSWER).actions, []);
  assert.deepEqual(A.validateActions(null, ANSWER).actions, []);
});

// Label policy (owner decision 2026-09-28, second round): a label is a SHORT FORMULATION of the
// step, not a verbatim copy of the answer — echoing the prose back on a button reads «жёстко».
// The old tests below asserted the opposite contract (label must appear in the answer verbatim);
// they are replaced, because the owner explicitly changed that requirement. What MUST stay:
// an action is only ever extracted from a step the answer really proposed (grounded quote).
const QUOTED = 'Записал оба решения. Следующие шаги: «Начать #1753 P0» (дешёвый, развязывает остальное), «Запустить фазы #1755» или «Начать #1733 — экран вакансии и база».';

test('short formulation label is kept even when it does not appear verbatim in the answer', () => {
  const r = A.validateActions({ kind: 'menu', actions: [
    { label: 'Взять #1753', quote: 'Следующие шаги: «Начать #1753 P0» (дешёвый, развязывает остальное)' },
    { label: 'Сначала экран вакансии', quote: '«Начать #1733 — экран вакансии и база»' },
  ] }, QUOTED);
  assert.deepEqual(r.actions.map(a => a.label), ['Взять #1753', 'Сначала экран вакансии']);
});

test('action with a quote the answer never said is still dropped (no invented buttons)', () => {
  const r = A.validateActions({ kind: 'actions', actions: [
    { label: 'Срочно всё удалить', quote: 'немедленно зачистить все ветки и прод' },
  ] }, QUOTED);
  assert.deepEqual(r.actions, []);
});

test('label longer than MAX_LABEL is cut on a word boundary', () => {
  const r = A.validateActions({ kind: 'actions', actions: [
    { label: 'Начать #1753 P0 — самую дешёвую задачу, которая развязывает всё остальное', quote: '«Начать #1753 P0» (дешёвый, развязывает остальное)' },
  ] }, QUOTED);
  assert.equal(r.actions.length, 1);
  assert.ok(r.actions[0].label.length <= 40, `too long: ${r.actions[0].label}`);
  assert.ok(!r.actions[0].label.endsWith('ост'), r.actions[0].label);
});

// The prompt itself is part of the contract: it must ask for a SHORT FORMULATION (the owner's
// 2026-09-28 wording) and must keep requiring the grounded quote — a regression back to
// «дословно copy the answer» would fail here, not in production.
test('prompt asks for a short formulation label and still requires a verbatim quote', () => {
  assert.match(A.ACTIONS_SYSTEM, /КРАТКАЯ формулировка/);
  assert.match(A.ACTIONS_SYSTEM, /до \d+ символов/);
  assert.match(A.ACTIONS_SYSTEM, /не копируй дословно/);
  assert.match(A.ACTIONS_SYSTEM, /ДОСЛОВНЫЙ фрагмент ответа/);
  assert.doesNotMatch(A.ACTIONS_SYSTEM, /как действие НАЗВАНО в самом ответе/);
});

test('markup uses act|sid|n and fits callback_data', () => {
  const m = A.actionsMarkup('s-123-456', [{ label: 'Создать PR' }, { label: 'Задеплоить' }]);
  assert.equal(m.inline_keyboard[1][0].callback_data, 'act|s-123-456|1');
  assert.equal(m.inline_keyboard[0][0].text, '▶️ Создать PR');
});

test('extract: LLM failure → null (caller falls back to legacy)', async () => {
  mockFetch('', false);
  assert.equal(await A.extractAnswerActions(ANSWER, 'k'), null);
  mockFetch('not json');
  assert.equal(await A.extractAnswerActions(ANSWER, 'k'), null);
});

test('extract: happy path', async () => {
  mockFetch(JSON.stringify({ kind: 'plan', actions: [{ label: 'Создать PR', quote: 'создать PR с фиксом в tg-bot' }] }));
  const r = await A.extractAnswerActions(ANSWER, 'k');
  assert.equal(r.kind, 'plan');
  assert.equal(r.actions[0].label, 'Создать PR');
});

test('paragraphize: short / structured text untouched, no fetch', async () => {
  global.fetch = async () => { throw new Error('must not be called'); };
  assert.equal(await A.paragraphize('коротко', 'k'), 'коротко');
  const structured = Array.from({ length: 6 }, (_, i) => `Абзац ${i} ` + 'слово '.repeat(40)).join('\n\n');
  assert.equal(await A.paragraphize(structured, 'k'), structured);
});

test('paragraphize: accepts pure re-layout, rejects lossy rewrite', async () => {
  const wall = Array.from({ length: 30 }, (_, i) => `Предложение номер ${i} про деплой и тесты.`).join(' ');
  assert.ok(A.isWallOfText(wall));
  const relaid = wall.replace(/(номер 9 про деплой и тесты\.) /, '$1\n\n');
  mockFetch(JSON.stringify({ text: relaid }));
  assert.equal(await A.paragraphize(wall, 'k'), relaid);
  mockFetch(JSON.stringify({ text: 'Кратко: всё про деплой.' }));
  assert.equal(await A.paragraphize(wall, 'k'), wall);
});
