const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planLabel, bgStepText } = require('../src/gtd-controller');

// Two plans on the same playbook stream into one chat with identical step titles;
// every step notice must say which plan it belongs to.
test('step notice names its plan, so notices of parallel plans are distinguishable', () => {
  const item = { title: 'Сценарий пользователя: ценность и шаги', position: 0 };
  const a = bgStepText({ goal: 'Убрать 5-минутный пол у ожиданий шагов durable-плана (src/durable-wait.js). Сейчас…' }, item, '▶️ Шаг начат', 15);
  const b = bgStepText({ goal: 'Реализовать эпик #1846 — библиотека событий-подписок' }, item, '▶️ Шаг начат', 15);
  assert.equal(b, '▶️ Шаг начат (шаг 1/15): Сценарий пользователя: ценность и шаги\nПлан: Реализовать эпик #1846');
  assert.match(a, /\nПлан: Убрать 5-минутный пол/);
  assert.notEqual(a, b);
});

test('plan label is capped and never empty-prefixed', () => {
  assert.ok(planLabel('x '.repeat(200)).length <= 60);
  assert.ok(planLabel('слово '.repeat(40)).endsWith('…'));
  assert.equal(bgStepText({ goal: '' }, { title: 'T', position: 1 }, '✅ Шаг готов', 3), '✅ Шаг готов (шаг 2/3): T');
  assert.equal(bgStepText({ goal: 'Цель' }, { title: 'T', position: 0 }, '🛑 Шаг не удался', 3, 'ошибка'),
    '🛑 Шаг не удался (шаг 1/3): T\nПлан: Цель\nошибка');
});
