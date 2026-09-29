#!/usr/bin/env node
// Sandbox — исполнимая форма сценария
// docs/user-scenarios/core/04-durable-wait-latency.md (DW-01…DW-09),
// дизайн docs/specs/durable-wait-latency-design.md (срезы S1–S6), план a61bb2c5.
//
// Зачем: замкнуть цикл «изменил → увидел результат» без человека. Одна команда:
//
//     npm run sandbox:durable-wait
//
// Уровень автономности: S3 — e2e-харнесс через реальные функциональные блоки
// (store + gtd-controller + MCP-тулы + чтение src/server.js), с инжектированным
// временем/депс; полный src/server.js и внешние зависимости (GitHub, движок) —
// фейки/моки. S4 (прод-смоук «<1 мин») = приёмка на деплое, здесь недостижим.
// Целевое время цикла: ≤60 с (фактически секунды).
//
// Что проверяет (DW → проверка):
//   DW-01 (регресс)  агентское ожидание паркует шаг: waiting, попытка возвращена,
//                    следующие шаги заблокированы
//   DW-02 (новое)    poll_every_sec:30 соблюдается везде: MIN_POLL_SEC=30,
//                    normalizeAgentWait принимает 30, nextDueAt ≤ now+30с,
//                    схема плана (durable-task-plan.js) не отклоняет 30
//   DW-03 (новое)    тик ожиданий существует (экспорт *wait* / DURABLE_WAIT_TICK_MS);
//                    он опрашивает только ожидание, НЕ клеймит due-шаг без
//                    ожидания (в другом плане) и не двигает чек-листовый
//                    heartbeat (tickCount)
//   DW-04 (новое)    task_item_wake будит сервер (POST /internal/durable/kick),
//                    маршрут существует; «≤5 с» замеряется прод-смоуком S6
//   DW-05 (новое)    модель задержки пробуждения: пол опроса + период диспетчера
//                    ≤60 с (сейчас 60 + 300 = 360)
//   DW-06 (follow-up) вебхука GitHub нет → проверка вынесена в issue #1846 (SKIP)
//   DW-07 (новое)    тексты: описание task_item_wait «min 30» + правило
//                    «для CI — until:{ci_green}, а не sleep_sec»; секция в спеке
//   DW-08 (регресс)  перекрытие проходов → ровно один claim на шаг
//   DW-09 (регресс)  ожидание переживает рестарт процесса (SQLite)
//
// Контракты, которые песочница пинит для реализации (дизайн §2):
//   • MIN_POLL_SEC = 30 (durable-wait.js; схема durable-task-plan.js; описание тула).
//   • claimNextRunnable(now, { waitsOnly }) — due-шаг БЕЗ wait не клеймится тиком ожиданий.
//   • gtd-controller экспортирует runWaitTick(deps) И/ИЛИ server.js планирует
//     DURABLE_WAIT_TICK_MS; тик ожиданий не увеличивает tickHeartbeat().tickCount.
//   • POST /internal/durable/kick → kickDurable(); task_item_wake шлёт туда кик.
//   • для CI правильно until:{ci_green}, а не sleep_sec.
//
// Пока срезы S1–S5 не сделаны, песочница обязана быть КРАСНОЙ по этим причинам.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const started = process.hrtime.bigint();

// ── изоляция: никакого общего ~/agent-data, ~/users или /tmp ядра ─────────────
const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-wait-sandbox-'));
fs.mkdirSync(path.join(seed, 'users'), { recursive: true });
fs.mkdirSync(path.join(seed, 'tokens'), { recursive: true });
process.env.AGENT_DATA_DIR = path.join(seed, 'agent-data');
process.env.USERS_DIR = path.join(seed, 'users');
process.env.AGENT_TOKENS_DIR = path.join(seed, 'tokens');
// Будильник в другой процесс шлёт кик с Bearer AGENT_SECRET — без этого фикстурного
// значения клиент молча не шлёт HTTP и проверка DW-04 не отличит «выключено» от «нет».
process.env.AGENT_SECRET = 'sandbox-durable-kick-secret';

const MODULES = [
  '../../src/gtd-controller.js',
  '../../src/durable-task-store.js',
  '../../src/durable-wait.js',
  '../../src/data-paths.js',
  '../../src/mcp-skills/tools/101-durable-tasks.js',
];
let _tag = 0;
function fresh() {
  const dir = path.join(seed, `data-${++_tag}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.AGENT_DATA_DIR = dir;
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const G = require('../../src/gtd-controller.js');
  const waitLib = require('../../src/durable-wait.js');
  const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
  return { G, store: G.durableStore(), waitLib, tools };
}
// Перезагрузка без смены каталога данных: имитация рестарта процесса (DW-09).
function reload() {
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const G = require('../../src/gtd-controller.js');
  return { G, store: G.durableStore(), waitLib: require('../../src/durable-wait.js') };
}
const drain = () => new Promise((r) => setTimeout(r, 0));

function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'durable-wait sandbox', user_value: 'v',
    acceptance_criteria: [{ description: 'c' }],
    execution_policy: { validation_mode: 'programmatic' },
    items,
  });
  store.db.prepare('UPDATE durable_tasks SET status=? WHERE id=?').run('active', r.task.id);
  return r.task.id;
}
const agentItem = (title) => ({
  title, execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small', validation: { command_exit_zero: 'true' },
});
const progItem = (title, validation = { command_exit_zero: 'true' }) => ({
  title, execution_kind: 'programmatic', executor_role: 'developer',
  minimum_model_level: 'bachelor', context_budget: 'small', validation,
});
const PASS_ALL = { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) };

// ── отчётность в стиле scripts/sandbox/speech-f0.mjs ─────────────────────────
const results = [];
async function check(id, name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) results.push({ id, name, ok: true });
    else if (r && r.ok === false) results.push({ id, name, ok: false, reason: r.reason });
    else if (r && r.skip) results.push({ id, name, ok: true, skip: true, note: r.note });
    else results.push({ id, name, ok: true, note: r && r.note });
  } catch (e) {
    results.push({ id, name, ok: false, reason: `${e.name}: ${e.message}` });
  }
}
const guard = (cond, reason) => (cond ? true : { ok: false, reason });

// ── чтение реального server.js: как часто диспетчер зовёт durable-проход ─────
const serverSrc = fs.readFileSync(path.join(CORE_ROOT, 'src', 'server.js'), 'utf8');
function gtdDispatcherSec(src) {
  const m = src.match(/setInterval\(\s*run\s*,\s*([0-9_]+)\s*\*\s*([0-9_]+)\s*\*\s*1000\s*\)/);
  if (m) return Number(m[1].replace(/_/g, '')) * Number(m[2].replace(/_/g, ''));
  return 300; // документированный 5-мин GTD-тик — фолбэк, если строка переписана
}
const hasWaitTickInServer = () => /DURABLE_WAIT_TICK_MS|runWaitTick/.test(serverSrc);
const internalSrc = fs.readFileSync(path.join(CORE_ROOT, 'src', 'handlers', 'internal.js'), 'utf8');

// ── сцены ─────────────────────────────────────────────────────────────────────
async function dw01() {
  await check('DW-01', 'агентское ожидание паркует шаг (регресс)', async () => {
    const { G, store, tools } = fresh();
    const taskId = activePlan(store, [agentItem('Ждём ответ'), agentItem('Следующий шаг')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 3 * 86400, reason: 'ключ' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();
    const [item, next] = store.listTaskItems(taskId, 'u1');
    return guard(
      item.status === 'waiting' && item.attempt_count === 0 && next.status === 'pending',
      `ожидание не запарковано (status=${item.status}, attempts=${item.attempt_count}, next=${next.status})`,
    ) || { ok: true, note: 'waiting, attempts=0, next blocked' };
  });
}

async function dw02(waitLib) {
  await check('DW-02', 'poll_every_sec:30 соблюдается везде (пол, кламп, nextDueAt, схема плана)', async () => {
    const floor = waitLib.MIN_POLL_SEC;
    if (floor !== 30) return { ok: false, reason: `MIN_POLL_SEC=${floor} — пол ещё не снижен до 30` };
    const now = Date.now();
    const { wait, error } = waitLib.normalizeAgentWait(
      { item_id: 'x', until: { ci_green: 'https://github.com/o/r/pull/1' }, poll_every_sec: 30, reason: 'CI' },
      { now, registryKeys: ['ci_green'] },
    );
    if (error) return { ok: false, reason: `normalizeAgentWait отказал: ${error}` };
    if (wait.poll_every_sec !== 30) return { ok: false, reason: `poll_every_sec=${wait.poll_every_sec} — клампится не в 30` };
    const due = waitLib.nextDueAt(wait, now);
    if (due > now + 31_000) return { ok: false, reason: `nextDueAt через ${Math.round((due - now) / 1000)}с > 30с` };
    // Общий контракт: та же граница в схеме компилятора плейбуков (durable-task-plan.js).
    const { store } = fresh();
    let schemaNote = 'схема плана принимает 30';
    try {
      activePlan(store, [{ ...progItem('Плейбук-ожидание'), validation: { ci_green: true }, wait: { poll_every_sec: 30, timeout_sec: 600 } }]);
    } catch (e) {
      schemaNote = null;
      return { ok: false, reason: `MIN_POLL_SEC=30, но схема плана отклоняет wait.poll_every_sec:30 — ${e.message}` };
    }
    return { ok: true, note: `пол=${floor}, nextDueAt через ${Math.round((due - now) / 1000)}с, ${schemaNote}` };
  });
}

async function dw03() {
  await check('DW-03', 'тик ожиданий: опрашивает только ожидания, чек-листовый heartbeat не тронут', async () => {
    const { G, store } = fresh();
    // По возможности, а не по имени: любой экспорт gtd-controller, похожий на
    // «проход ожиданий» (runWaitTick / runWaitPass / durableWaitTick …).
    const waitTickName = Object.keys(G)
      .find((k) => /wait/i.test(k) && /run|tick|pass/i.test(k) && typeof G[k] === 'function');
    if (!waitTickName && !hasWaitTickInServer()) {
      return { ok: false, reason: 'нет ни экспорт-прохода ожиданий (gtd-controller), ни DURABLE_WAIT_TICK_MS/runWaitTick (server.js) — отдельного тика ожиданий нет' };
    }
    if (!waitTickName) {
      return { ok: false, reason: 'интервал в server.js есть, но gtd-controller не экспортирует проход ожиданий (*wait*) — нельзя прогнать детерминированно' };
    }
    // Сцена: в ДВУХ разных планах (позиционный гейт внутри одного плана и так
    // блокирует младших братьев — тест был бы пустым). Ожидание взведено
    // проходом; обычный шаг уже due. Тик ожиданий обязан (а) опросить ожидание,
    // (б) НЕ клеймить обычный шаг, (в) не увеличить чек-листовый heartbeat.
    const now0 = Date.now() - 600_000;
    const registry = { ...PASS_ALL, ci_green: async () => ({ status: 'fail', subject: {}, evidence: {} }) };
    const deps = { secrets: {}, runTask: async () => 'x', isTaskRunning: () => false, registry };
    const waitTaskId = activePlan(store, [
      { ...progItem('Жду CI'), validation: { ci_green: true }, wait: { poll_every_sec: 60, timeout_sec: 3600 } },
    ]);
    const plainTaskId = activePlan(store, [progItem('Обычный шаг')]);
    store.db.prepare('UPDATE task_items SET due_at = ? WHERE task_id = ?').run(now0 + 500_000, plainTaskId);
    await G.runDueDurable({ ...deps, now: now0 });   // взводим ожидание (wait_json появляется)
    const armed = store.listTaskItems(waitTaskId, 'u1')[0];
    if (!armed.wait_json) return { ok: false, reason: 'не удалось взвести ожидание — сцена песочницы не работает' };
    const beforeW = JSON.parse(armed.wait_json);
    const before = G.tickHeartbeat().tickCount;
    const now = Date.now();
    const fired = await G[waitTickName]({ ...deps, freeSlots: () => 4, now });
    const after = G.tickHeartbeat().tickCount;
    const afterW = JSON.parse(store.listTaskItems(waitTaskId, 'u1')[0].wait_json || '{}');
    const plainRow = store.listTaskItems(plainTaskId, 'u1')[0];
    if (after !== before) return { ok: false, reason: `тик ожиданий увеличил tickCount (${before}→${after}) — это чек-листовый проход` };
    if (plainRow && plainRow.status !== 'pending') return { ok: false, reason: `шаг БЕЗ ожидания заклеймлен тиком ожиданий (status=${plainRow.status}) — waitsOnly-фильтр не работает` };
    if (!(afterW.last_poll_at > (beforeW.last_poll_at || 0))) {
      return { ok: false, reason: `ожидание НЕ опрошено тиком ожиданий (last_poll_at ${beforeW.last_poll_at || '—'} → ${afterW.last_poll_at || '—'})` };
    }
    return { ok: true, note: `${waitTickName}: опрошено, обычный шаг не тронут, tickCount статичен, fired=${fired}` };
  });
}

async function dw04() {
  await check('DW-04', 'task_item_wake будит сервер (kick); маршрут /internal/durable/kick есть', async () => {
    const route = /\/internal\/durable\/kick/.test(internalSrc);
    const { G, store, tools } = fresh();
    const taskId = activePlan(store, [agentItem('Ждём ответ')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, awaiting_user: true, timeout_sec: 3 * 86400, reason: 'ответ' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();
    const item = store.listTaskItems(taskId, 'u1')[0];
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
    let woke;
    try { woke = await tools.task_item_wake.handler({ item_id: item.id, message: 'вот ответ' }, { userId: 'u1' }); }
    finally { global.fetch = realFetch; }
    const kicked = calls.some((u) => /\/internal\/(durable\/kick|gtd\/tick)/.test(u));
    if (!route && !kicked) return { ok: false, reason: 'wake не будит сервер: нет маршрута /internal/durable/kick и ни одного HTTP-кика из task_item_wake' };
    if (!kicked) return { ok: false, reason: 'маршрут есть/нет, но task_item_wake не шлёт кик (сервер узнает только на следующем тике)' };
    return { ok: true, note: `wake → ${calls.find((u) => /internal/.test(u))} (замер ≤5с — прод-смоук S6)` };
  });
}

async function dw05(waitLib) {
  await check('DW-05', 'модель задержки пробуждения ≤60 с (пол опроса + диспетчер)', () => {
    const now = Date.now();
    const { wait } = waitLib.normalizeAgentWait({ until: { file_exists: '/tmp/x' }, poll_every_sec: 30, reason: 'файл' }, { now, registryKeys: ['file_exists'] });
    const pollSec = Math.round((waitLib.nextDueAt(wait, now) - now) / 1000);
    const waitTick = hasWaitTickInServer();
    const dispatcherSec = waitTick ? 30 : gtdDispatcherSec(serverSrc);
    const latency = pollSec + dispatcherSec;
    if (latency > 60) {
      return { ok: false, reason: `поллинг ${pollSec}с + диспетчер ${dispatcherSec}с (${waitTick ? 'тик ожиданий' : '5-мин GTD-тик'}) = ${latency}с > 60с` };
    }
    return { ok: true, note: `${pollSec}с + ${dispatcherSec}с = ${latency}с (модель; замер — S6)` };
  });
}

async function dw07(tools) {
  const toolDesc = tools.task_item_wait.description || '';
  const specSrc = fs.readFileSync(path.join(CORE_ROOT, 'docs', 'specs', 'durable-wait-until.md'), 'utf8');
  await check('DW-07', 'тексты: тул «min 30» + правило ci_green-vs-sleep; секция в спеке', () => {
    const problems = [];
    if (!/min\s*30/.test(toolDesc)) problems.push('описание task_item_wait не говорит «min 30»');
    if (!/ci_green/.test(toolDesc)) problems.push('описание тула не упоминает ci_green');
    if (!/(а\s+не|вместо|not|instead\s+of)\s+`?\s*sleep/i.test(toolDesc)) problems.push('описание тула не говорит «для CI — until:{ci_green}, а не sleep_sec»');
    const specHasSection = /настраива[а-я]*\s+исполнител|исполнитель\s+настраива/i.test(specSrc);
    if (!specHasSection) problems.push('в docs/specs/durable-wait-until.md нет секции «что настраивает исполнитель»');
    if (problems.length) return { ok: false, reason: problems.join('; ') };
    return { ok: true, note: 'тексты исполнителю на месте' };
  });
}

async function dw08() {
  await check('DW-08', 'перекрытие проходов → ровно один claim (регресс)', async () => {
    const { G, store } = fresh();
    activePlan(store, [progItem('Готовый шаг')]);
    let runs = 0;
    const deps = { secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL, runTask: async () => { runs++; return 'DURABLE: done'; } };
    const [a, b] = await Promise.all([G.runDueDurable(deps), G.runDueDurable(deps)]);
    return guard(a + b === 1 && runs <= 1, `двойной запуск шага (fired=${a}+${b}, runTask=${runs})`)
      || { ok: true, note: `fired=${a + b}, runTask=${runs}` };
  });
}

async function dw09() {
  await check('DW-09', 'ожидание переживает рестарт процесса (SQLite, регресс)', async () => {
    const { G, store, tools } = fresh();
    const taskId = activePlan(store, [agentItem('Ждём')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler({ item_id: itemId, until: { file_exists: '/tmp/x' }, poll_every_sec: 60, reason: 'файл' }, { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();
    const before = store.listTaskItems(taskId, 'u1')[0];
    const { store: store2 } = reload();           // «рестарт»: новый singleton на тот же файл
    const after = store2.listTaskItems(taskId, 'u1')[0];
    const w = JSON.parse(after.wait_json || '{}');
    return guard(after.status === 'waiting' && !w.resolved && after.due_at === before.due_at,
      'ожидание не пережило перезагрузку store') || { ok: true, note: 'waiting сохранился' };
  });
}

// ── прогон ────────────────────────────────────────────────────────────────────
const boot = fresh();
await dw01();
await dw02(boot.waitLib);
await dw03();
await dw04();
await dw05(boot.waitLib);
results.push({ id: 'DW-06', name: 'CI по событию (webhook) — follow-up', ok: true, skip: true, note: 'вебхука GitHub нет, вынесено в issue #1846' });
await dw07(boot.tools);
await dw08();
await dw09();

const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log('');
for (const r of results) {
  const tag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
  console.log(`${tag} ${r.id.padEnd(5)} ${r.name}${r.note && !r.skip ? ` — ${r.note}` : ''}${r.skip ? ` — ${r.note || ''}` : ''}`);
  if (!r.ok) console.log(`      ↳ причина: ${r.reason}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`── ${results.length - failed.length}/${results.length} PASS · цикл ${(ms / 1000).toFixed(1)}с (цель ≤60с) · уровень S3`);
if (failed.length) {
  console.log(`DURABLE-WAIT SANDBOX: FAIL — ${failed.length} проверок красные.`);
  console.log('Красный по делу: срезы S1–S5 (пол опроса 30с + тик ожиданий + кик + тексты) ещё не сделаны.');
} else {
  console.log('DURABLE-WAIT SANDBOX: PASS — сценарий замкнут локально. Остаётся прод-смоук S6 (<1 мин).');
}
fs.rmSync(seed, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
