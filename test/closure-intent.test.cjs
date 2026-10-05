'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-intent-'));
process.env.AGENT_DATA_DIR = process.env.AGENT_DATA_DIR || path.join(ROOT, 'data');
process.env.USERS_DIR = process.env.USERS_DIR || path.join(ROOT, 'users');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
// #1856: закрывающие реплики — stop / wrap_up / task.
// Инцидент 29.09: «ты нашел уже всё» после «Стоп» ушло обычным deep-раном и
// искало 11+ минут. Владелец: это «собери итог из найденного», а не «ничего не делай».
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyClosure, closureVerdict, latestMessage, rememberClosure, recallClosure, _hints } = require('../src/closure-intent');
const serviceLlm = require('../src/service-llm');

function withLadder(content, text) {
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async () => ({ content });
  return Promise.resolve()
    .then(() => checkCompleteness(text))
    .finally(() => {
      serviceLlm.serviceChat = real;
      serviceLlm.available = realAvailable;
    });
}

const { checkCompleteness, DELAY_CONTINUE_MS, DELAY_CLOSURE_STOP_MS } = require('../src/intake-gate');
const answerRouter = require('../src/answer-router');
const { buildEngineCommand, computeEngineTimeoutMs, runEngineProcess } = require('../src/runner/claude-runner');

const WRAP_UP = ['ты нашел уже всё', 'ты уже всё нашёл', 'хватит, ты уже всё нашёл', 'достаточно, давай итог',
  'хватит искать', 'собери что есть', 'Подведи итоги', 'you already found everything', 'wrap it up'];
const STOP = ['стоп', 'Стоп.', 'хватит, не надо', 'отмена', 'всё, не надо больше', 'stop', 'cancel'];
const TASK = ['хватит искать вакансии, найди резюме', 'найди файл от 14 сентября', 'сделай отчёт по кандидатам',
  'стоп, найди лучше резюме на hh', 'давай дальше'];

test('wrap_up: «поиск окончен, собери итог»', () => {
  for (const t of WRAP_UP) assert.equal(closureVerdict(t), 'wrap_up', t);
});

test('stop: «остановись, больше ничего не надо»', () => {
  for (const t of STOP) assert.equal(closureVerdict(t), 'stop', t);
});

test('task: новая просьба (в т.ч. «хватит искать X, найди Y») — обычная задача', () => {
  for (const t of TASK) assert.equal(closureVerdict(t), 'task', t);
  // «найди …» без закрывающего слова — не явный случай: решает судья, дефолт task.
  assert.equal(classifyClosure('найди файл от 14 сентября'), null);
  assert.equal(classifyClosure('хватит искать вакансии, найди резюме'), 'task');
});

test('классифицируется последняя реплика пачки шлюза', () => {
  assert.equal(latestMessage('[Сообщение 1] Стоп\n[Сообщение 2] ты нашел уже всё'), 'ты нашел уже всё');
  assert.equal(closureVerdict('[Сообщение 1]\nСтоп\n\n[Сообщение 2]\nты нашел уже всё'), 'wrap_up');
  assert.equal(closureVerdict('[Сообщение 1]\nты уже всё нашёл\n\n[Сообщение 2]\nнайди ещё резюме на hh'), 'task');
});

test('длинный текст не считается закрывающей репликой', () => {
  assert.equal(classifyClosure(`хватит искать. ${'Нужно подробно разобрать рынок и конкурентов. '.repeat(5)}`), null);
});

// ── intake-gate: детерминированный pre-check + LLM-судья ─────────────────────

function fakeFetch(content) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });
}
const failFetch = async () => { throw new Error('LLM must not be called for a clear closure'); };

test('intake-gate: явный wrap_up решается без модели — короткая пауза + честный анонс', async () => {
  for (const t of ['ты нашел уже всё', 'достаточно, давай итог']) {
    const r = await withLadder('wrap_up', t);
    assert.equal(r.level, 'wrap_up', t);
    assert.equal(r.closure, 'wrap_up');
    assert.equal(r.complete, true);
    assert.equal(r.delayMs, DELAY_CONTINUE_MS);
    assert.match(r.announce, /без новых поисков/);
  }
  // и без ключа OpenRouter (раньше — hold)
  assert.equal((await withLadder('wrap_up', 'ты уже всё нашёл')).level, 'wrap_up');
});

test('intake-gate: явный stop — ран доходит до runner-а (он гасит и отвечает одной строкой)', async () => {
  const r = await withLadder('stop', 'хватит, не надо');
  assert.deepEqual(r, { level: 'stop', closure: 'stop', complete: true, delayMs: DELAY_CLOSURE_STOP_MS, announce: null });
});

test('intake-gate: «хватит искать X, найди Y» идёт обычным путём к судье', async () => {
  const r = await withLadder('clear', 'хватит искать вакансии, найди резюме');
  assert.equal(r.level, 'clear');
});

test('intake-gate: LLM-вердикты wrap_up/stop для неоднозначных фраз', async () => {
  const w = await withLadder('wrap_up', 'ну всё, по-моему материала уже хватает');
  assert.equal(w.level, 'wrap_up');
  assert.equal(w.complete, true);
  // LLM-«стоп» без явной фразы ничего не гасит и не запускает — держим ввод.
  const s = await withLadder('stop', 'ладно, забудь про это пока');
  assert.equal(s.level, 'stop');
  assert.equal(s.complete, false);
  assert.equal(s.delayMs, null);
});

test('intake-gate: падение судьи — прежнее поведение (ошибка на HTTP-границу), не stop', async () => {
  const real = serviceLlm.serviceChat;
  const realAvailable = serviceLlm.available;
  serviceLlm.available = () => true;
  serviceLlm.serviceChat = async () => { throw new Error('boom'); };
  try {
    await assert.rejects(() => checkCompleteness('ну всё, по-моему материала уже хватает'));
  } finally {
    serviceLlm.serviceChat = real;
    serviceLlm.available = realAvailable;
  }
});

// ── мост судья → runner ──────────────────────────────────────────────────────

test('подсказка wrap_up от судьи забирается runner-ом один раз, по тому же тексту и чату', () => {
  _hints.clear();
  const at = { username: 'alice', chatId: 42, threadId: null };
  assert.equal(rememberClosure({ ...at, text: 'ну всё, материала хватает', closure: 'wrap_up' }), true);
  assert.equal(recallClosure({ ...at, chatId: 43, text: 'ну всё, материала хватает' }), null, 'другой чат');
  assert.equal(recallClosure({ ...at, text: '[Сообщение 1]\nНу всё, материала хватает!' }), 'wrap_up', 'нормализация');
  assert.equal(recallClosure({ ...at, text: 'ну всё, материала хватает' }), null, 'одноразово');
  rememberClosure({ ...at, text: 'x y', closure: 'wrap_up', now: Date.now() - 16 * 60_000 });
  assert.equal(recallClosure({ ...at, text: 'x y' }), null, 'TTL');
});

// ── режим финализации: промпт, потолок, запрет поиска ─────────────────────────

test('answer-router: wrap_up — известный режим, блок запрещает новые поиски', () => {
  assert.equal(answerRouter.normalizeMode('wrap_up'), 'wrap_up');
  const block = answerRouter.buildWrapUpBlock();
  assert.match(block, /ФИНАЛИЗАЦИЯ/);
  assert.match(block, /НЕ запускай новых поисков/);
  assert.ok(answerRouter.WRAP_UP_TIMEOUT_MS <= 3 * 60_000, 'жёсткий потолок ≤ 3 мин');
  assert.ok(answerRouter.WRAP_UP_WARN_MS < answerRouter.WRAP_UP_TIMEOUT_MS);
  assert.ok(answerRouter.WRAP_UP_MAX_TOOL_CALLS <= 3);
  for (const t of ['WebSearch', 'WebFetch', 'mcp__search-skills', 'mcp__trained-skills__web_research']) {
    assert.ok(answerRouter.WRAP_UP_DENY_CLAUDE.includes(t), t);
  }
  assert.equal(answerRouter.WRAP_UP_DENY_OPENCODE.websearch, false);
  assert.equal(answerRouter.WRAP_UP_DENY_OPENCODE.webfetch, false);
});

test('deep-блок: закрывающая реплика → коротко из собранного, без новых поисков', () => {
  assert.match(answerRouter.buildDeepBlock(), /закрывающая[\s\S]*НЕ запускай новых поисков/);
});

test('claude-runner: потолок финализации — мягкий сигнал на 2-й минуте, kill на 3-й', () => {
  assert.deepEqual(computeEngineTimeoutMs(answerRouter.WRAP_UP_TIMEOUT_MS, answerRouter.WRAP_UP_WARN_MS),
    { hardTimeoutMs: answerRouter.WRAP_UP_TIMEOUT_MS, warnTimeoutMs: answerRouter.WRAP_UP_WARN_MS });
  // невалидный warn → прежняя формула
  assert.deepEqual(computeEngineTimeoutMs(600_000, 900_000), { hardTimeoutMs: 600_000, warnTimeoutMs: 480_000 });
});

test('claude-runner: --disallowedTools только когда передан список (остальные раны — прежний argv)', () => {
  const base = { engine: 'claude', prompt: 'p', mcpConfig: '/x/.mcp.json', user: { workDir: '/x' } };
  const [, plain] = buildEngineCommand(base);
  assert.ok(!plain.includes('--disallowedTools'));
  const [, restricted] = buildEngineCommand({ ...base, disallowedTools: answerRouter.WRAP_UP_DENY_CLAUDE });
  const i = restricted.indexOf('--disallowedTools');
  assert.ok(i > 0);
  assert.ok(restricted[i + 1].split(',').includes('WebSearch'));
  assert.ok(i < restricted.indexOf('--print'), 'флаг до --print');
});

test('claude-runner: тул-бюджет — 4-й вызов инструмента обрывает ран (timedOut+toolBudgetKilled)', async () => {
  const bin = path.join(ROOT, 'fake-claude-tools');
  const tool = n => `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/f${n}"}}]}}'`;
  fs.writeFileSync(bin, `#!/usr/bin/env bash\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"Итог: нашёл 3 вакансии"}]}}'\n${[1, 2, 3, 4, 5].map(tool).join('\n')}\nexec sleep 30\n`);
  fs.chmodSync(bin, 0o755);
  const opts = {
    engine: 'claude', taskId: 't-budget', chatId: '42', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
    user: { username: 'budget', workDir: ROOT, name: 'B' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: bin, engineArgs: [], cwd: ROOT,
  };
  const started = Date.now();
  const r = await runEngineProcess({ ...opts, timeoutMs: answerRouter.WRAP_UP_TIMEOUT_MS, warnTimeoutMs: answerRouter.WRAP_UP_WARN_MS, maxToolCalls: 3 });
  assert.equal(r.toolBudgetKilled, true);
  assert.equal(r.timedOut, true, 'runner уходит в ветку потолка (без автопродолжения для wrap_up)');
  assert.ok(Date.now() - started < 10_000, 'не ждёт sleep 30');
  assert.match(r.fullOutput.text, /Итог/, 'написанное до обрыва сохранено');
});
