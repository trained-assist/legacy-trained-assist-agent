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
