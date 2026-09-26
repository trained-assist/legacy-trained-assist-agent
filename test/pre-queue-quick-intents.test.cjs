'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Regression guard for the "quick command sat behind the running task" class.
// A pure-info / sync quick command must bypass the per-dialog admission queue and
// answer instantly (runner/index.js runTask() gates on isPreQueueQuickIntent).
// 2026-09-24: /switch2codex was missed. 2026-09-26: /oc_go was missed — it returned
// «↪️ Ожидаю завершения предыдущей работы…» instead of flipping the toggle instantly.
const { isPreQueueQuickIntent } = require('../src/runner/intent-engine');

test('pre-queue whitelist: sync quick commands answer before the admission queue', () => {
  for (const cmd of ['/ping', '/help', '/agent_info', '/switch2klod', '/oc_go', '/oc_openrouter', '/oc_deepseek', '/oc_max', '/settings']) {
    assert.equal(isPreQueueQuickIntent(cmd), true, `${cmd} must be a pre-queue quick intent`);
  }
});

test('pre-queue whitelist: a normal task still goes through the queue', () => {
  for (const t of ['сделай ревью кандидатов', 'запусти холодный поиск', 'почини баг в intake']) {
    assert.equal(isPreQueueQuickIntent(t), false, `${t} must NOT bypass the queue`);
  }
});

// #1479 (2026-09-26): unanchored info regexes («расход токенов», «какие возможности»,
// «помощь», «что за модель») swallowed real tasks with a canned ⚡ reply before the queue —
// the task was accepted and silently never ran. Prose must be a short standalone question.
const { getQuickAnswer } = require('../src/runner/intent-engine');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TASK_PROSE = [
  '[Сообщение 1]\n@super_personal_assistant_bot изучи рисеч по бенчмарку фрии моделей для проверки пул реквестов ci-cd и посчитай расход токенов на прогон',
  '[Сообщение 1]\nизучи бесплатные модели для ревью PR. Какие есть возможности без оплаты и что за модели лучше подходят для нашего пайплайна',
  '[Сообщение 1]\nпочини ретраи в intake\n\n[Сообщение 2]\nнужна помощь',
  'Сделай отчёт: стоимость сессий за неделю по каждому профилю, разбивка по движкам, и предложи, как снизить расход — таблицей, с выводами для владельца продукта',
];

test('#1479: a real task mentioning info keywords is NOT a pre-queue quick intent', () => {
  for (const t of TASK_PROSE) assert.equal(isPreQueueQuickIntent(t), false, t);
});

test('#1479: getQuickAnswer does not answer a real task with a canned info reply', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-1479-'));
  for (const t of TASK_PROSE) assert.equal(getQuickAnswer(t, 'u1479', workDir), null, t);
});

test('#1479: short standalone info questions and slash commands still answer instantly', () => {
  for (const q of ['что ты умеешь?', '[Сообщение 1]\nсколько я потратил токенов', 'какая у тебя модель', '@bot помощь', '/usage', '/secrets_list', '/help']) {
    assert.equal(isPreQueueQuickIntent(q), true, q);
  }
});
