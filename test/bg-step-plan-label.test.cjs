const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planLabel, bgStepText } = require('../src/gtd-controller');

// Two plans on the same playbook stream into one chat with identical step titles;
// every step notice must say which plan it belongs to.
test('step notice names its plan, so notices of parallel plans are distinguishable', () => {
  const item = { title: 'Сценарий пользователя: ценность и шаги', position: 0 };
  const a = bgStepText({ goal: 'Убрать 5-минутный пол у ожиданий шагов durable-плана (src/durable-wait.js). Сейчас…' }, item, '▶️ Шаг начат', 15);
  const b = bgStepText({ goal: 'Реализовать эпик #1846 — библиотека событий-подписок' }, item, '▶️ Шаг начат', 15);
  assert.equal(b, '▶️ Шаг начат (шаг 1/15): Сценарий пользователя: ценность и шаги\nПлан: Реализовать эпик #1846 — библиотека событий-подписок');
  assert.match(a, /\nПлан: Убрать 5-минутный пол/);
  assert.notEqual(a, b);
});

// Real goals open with a GitHub link; the old 60-char cut dropped the URL «word»
// whole and the owner saw «План: Починить…» / «План: Эпик…».
test('a goal that opens with a GitHub link keeps its meaning', () => {
  const goal = 'Починить https://github.com/trained-assist/trained-assist-agent/issues/1861 — артефакты агентского шага durable-плана ложатся в инженерный workspace, а детерминированные проверки ищут их в папке проекта.';
  const label = planLabel(goal);
  assert.match(label, /^Починить #1861 — артефакты агентского шага durable-плана ложатся/);
  assert.match(label, /ищут их в папке проекта\.$/);
  assert.equal(planLabel('Реализовать https://github.com/trained-assist/software-engineering-playbooks/issues/53 — плейбук'),
    'Реализовать software-engineering-playbooks #53 — плейбук');
  assert.equal(planLabel('Проверить фикс https://github.com/trained-assist/trained-assist-agent/pull/1848.'), 'Проверить фикс PR #1848.');
});

test('plan label is capped at ~350 chars and never empty-prefixed', () => {
  assert.ok(planLabel('x '.repeat(400)).length <= 350);
  assert.ok(planLabel('слово '.repeat(100)).endsWith('…'));
  assert.equal(bgStepText({ goal: '' }, { title: 'T', position: 1 }, '✅ Шаг готов', 3), '✅ Шаг готов (шаг 2/3): T');
  assert.equal(bgStepText({ goal: 'Цель' }, { title: 'T', position: 0 }, '🛑 Шаг не удался', 3, 'ошибка'),
    '🛑 Шаг не удался (шаг 1/3): T\nПлан: Цель\nошибка');
});
