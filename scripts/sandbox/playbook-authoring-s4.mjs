#!/usr/bin/env node
// Sandbox S4 «конструктор личных плейбуков» — исполнимая форма сценария
// docs/user-scenarios/engineering/02-custom-playbook-authoring.md (шаги 1–10).
//
// Зачем: замкнуть цикл «изменил → увидел результат» без человека. Одна команда:
//
//     npm run sandbox:playbook-s4
//
// Уровень автономности: S5 — агент сам поднимает окружение и гоняет сценарий
// end-to-end локально; внешняя зависимость одна — Hermes/LLM — зафейкана
// (require.cache подменяет src/hermes-run.js, сети и ключа нет). Реальный
// LLM-черновик + живой бот остаются смоуком (шаг 9 сценария — приёмка на staging).
// Целевое время цикла: ≤30 с (фактически секунды).
//
// Что проверяет (сценарий → проверка):
//   S4a (D1) — «собрать плейбук без выдуманных проверок»:
//     C1  шаг 1: промпт Hermes несёт реестр проверок + каталог типовых шагов
//     C2  шаг 2: programmatic с ключом вне реестра → отказ, в тексте назван ключ
//     C3  шаг 3: {var} в goal_template без inputs[] → отказ, названа переменная
//     C4  шаги 4/5: валидный черновик (реестровый ключ, inputs, when_to_use) принят
//     C5  шаг 6: save повторяет проверки, файл не пишется, назван ключ
//     C6  шаг 6: валидный черновик сохраняется (нет ложного отказа)
//     C7  C4-регресс: agent-шаг с произвольным ключом валиден ({input} разрешён)
//   S4b (D2) — «найти из обычной просьбы»:
//     C8  шаг 8: store.list() отдаёт when_to_use профильного плейбука
//     C9  шаг 8: buildProfilePlaybookMenu собирает блок «[ТВОИ ПЛЕЙБУКИ]»
//     C10 шаг 8: нет профильных when_to_use → блок пуст (''), промпт не растёт
//     C11 шаг 8: runner кладёт блок меню в системный промпт профиля
//     C12 шаг 10: health профильного с when_to_use → dispatch pass (и в strict)
//     C13 шаг 10: health без when_to_use → dispatch fail с подсказкой заполнить
//
// Пока срезы S4a/S4b не сделаны, песочница обязана быть КРАСНОЙ по этим причинам.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const results = [];
function check(id, name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) results.push({ id, name, ok: true });
    else if (r && r.ok === false) results.push({ id, name, ok: false, reason: r.reason });
    else results.push({ id, name, ok: true, note: r && r.note });
  } catch (e) {
    results.push({ id, name, ok: false, reason: `${e.name}: ${e.message}` });
  }
}
async function acheck(id, name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) results.push({ id, name, ok: true });
    else if (r && r.ok === false) results.push({ id, name, ok: false, reason: r.reason });
    else results.push({ id, name, ok: true, note: r && r.note });
  } catch (e) {
    results.push({ id, name, ok: false, reason: `${e.name}: ${e.message}` });
  }
}
const fail = (id, name, reason) => results.push({ id, name, ok: false, reason });

// ── изолированное окружение профиля (никогда не трогаем ~/users) ──────────────
const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-s4-'));
const USERS = path.join(seed, 'users');
const DATA = path.join(seed, 'data');
const TOKENS = path.join(seed, 'tokens');
const SIBLING = path.join(seed, 'engineering'); // PLAYBOOK_SIBLING_ROOTS
fs.mkdirSync(path.join(SIBLING, 'library'), { recursive: true });
fs.mkdirSync(path.join(SIBLING, 'playbooks'), { recursive: true });
process.env.USERS_DIR = USERS;
process.env.AGENT_DATA_DIR = DATA;
process.env.AGENT_TOKENS_DIR = TOKENS;
process.env.AGENT_TOKENS_ROOT = TOKENS;
process.env.PLAYBOOK_SIBLING_ROOTS = SIBLING;

// Каталог типовых шагов — фикстура братского репозитория (в проде library/step-types.json).
const STEP_TYPES = [
  { id: 'define-use-case', purpose: 'зафиксировать ценность и негативную форму', execution_kind: 'agent' },
  { id: 'sandbox', purpose: 'замкнуть цикл «изменил — увидел результат»', execution_kind: 'agent' },
  { id: 'verify-on-prod', purpose: 'проверить, что релиз доехал на прод', execution_kind: 'agent' },
  { id: 'archive', purpose: 'убрать временные сущности', execution_kind: 'agent' },
];
fs.writeFileSync(path.join(SIBLING, 'library', 'step-types.json'), JSON.stringify(STEP_TYPES, null, 2));

// ── фейковый Hermes: подменяем src/hermes-run.js ДО загрузки автор-слоя ───────
const hermesState = { responses: [], calls: [] };
const fakeHermes = async (args) => {
  hermesState.calls.push(args || {});
  const next = hermesState.responses.shift();
  if (typeof next === 'function') return next(args);
  if (next instanceof Error) throw next;
  return next;
};
try {
  const hermesPath = require.resolve('../../src/hermes-run.js');
  const realHermes = require(hermesPath);
  realHermes.hermesRun = fakeHermes;
} catch (e) {
  fail('C0', 'ядро: src/hermes-run.js загружается для подмены', `${e.name}: ${e.message}`);
}

// ── контракты среза (какие сущности ждём от реализации) ───────────────────────
const REGISTRY_KEYS = (() => {
  try {
    const V = require('../../src/playbook-validators.js');
    return Object.keys(V.createDefaultRegistry({ ghToken: () => null, ghFetch: async () => null, gitInfo: () => null }));
  } catch { return []; }
})();
const UNKNOWN_KEY = 'shell_command_success'; // выдуманный (D1), нет в реестре
const USER = 'sandbox-user';

// Валидный Playbook v1 по целевому контракту (с when_to_use). over слоями.
function pb(over = {}) {
  return {
    id: 'prod-feature-check',
    version: 1,
    scope: 'profile',
    title: 'Проверить фичу на проде',
    when_to_use: 'когда просят проверить, доехала ли фича на прод и работает ли',
    goal_template: 'Проверить, что {scenario} работает на проде',
    inputs: [{ name: 'scenario', description: 'что именно проверяем' }],
    stages: [{
      id: 'checks', title: 'Проверки',
      steps: [
        { title: 'Файл артефакта на месте', execution_kind: 'programmatic', validation: { file_exists: { path: '/tmp/x' } } },
        { title: 'Вывод', execution_kind: 'agent', executor_role: 'verifier', minimum_model_level: 'bachelor', context_budget: 'small', validation: { explicit_verdict: true } },
      ],
    }],
    ...over,
  };
}

let tools;
try {
  tools = require('../../src/mcp-skills/tools/102-playbooks.js').tools;
} catch (e) {
  fail('C0b', 'ядро: MCP-тулы плейбуков загружаются', `${e.name}: ${e.message}`);
}

function callTool(name, args, ctx = { userId: USER }) {
  if (!tools || !tools[name]) throw new Error(`нет тула ${name}`);
  return tools[name].handler(args, ctx);
}
function setResponses(...rs) { hermesState.responses = rs; hermesState.calls = []; }
function draftFile(user, id) { return path.join(USERS, user, 'playbooks', '.drafts', `${id}.json`); }
function savedFile(user, id) { return path.join(USERS, user, 'playbooks', `${id}.json`); }

const started = process.hrtime.bigint();
console.log('PLAYBOOK-AUTHORING S4 SANDBOX — исполнимая форма сценария 02-custom-playbook-authoring');
console.log(`Уровень S5 (локально, Hermes зафейкан) · команда: npm run sandbox:playbook-s4`);
console.log(`Профиль: ${USERS} · сиблинг: ${SIBLING}`);
console.log(`Реестр проверок (${REGISTRY_KEYS.length}): ${REGISTRY_KEYS.join(', ') || '—'}`);
console.log('');

// ── C1: промпт Hermes несёт реестр и каталог типовых шагов (шаг 1) ────────────
await acheck('C1', 'промпт Hermes несёт реестр проверок и каталог step-types (шаг 1)', async () => {
  if (!tools) return { ok: false, reason: 'тулы плейбуков не загрузились' };
  setResponses(pb());
  await callTool('playbook_draft', { description: 'проверить фичу на проде' }, { userId: 'c1' });
  const prompt = String(hermesState.calls[0]?.task || '');
  if (!prompt) return { ok: false, reason: 'Hermes не был вызван' };
  const missingReg = REGISTRY_KEYS.filter(k => !prompt.includes(k));
  const missingTypes = STEP_TYPES.map(t => t.id).filter(id => !prompt.includes(id));
  if (missingReg.length || missingTypes.length) {
    return { ok: false, reason: `в промпте нет — проверок: [${missingReg.join(', ') || '—'}]; типов шагов: [${missingTypes.join(', ') || '—'}]` };
  }
  return { ok: true, note: `${REGISTRY_KEYS.length} ключей + ${STEP_TYPES.length} типов шагов` };
});

// ── C2: выдуманная программа-проверка отклоняется (шаг 2, D1) ────────────────
await acheck('C2', 'programmatic-ключ вне реестра → отказ, назван ключ (шаг 2)', async () => {
  const bad = pb({ stages: [{ id: 'checks', title: 'П', steps: [
    { title: 'Команда', execution_kind: 'programmatic', validation: { [UNKNOWN_KEY]: true } },
  ] }] });
  delete bad.when_to_use; // изолируем именно семантику programmatic-шага, не схему
  setResponses(bad, bad); // первый ответ + repair-круг — оба с выдуманной проверкой
  const out = await callTool('playbook_draft', { description: 'проверить' }, { userId: 'c2' });
  if (out && out.draft) return { ok: false, reason: 'черновик с выдуманной проверкой ПРИНЯТ (должен быть отклонён)' };
  const text = `${out?.error || ''} ${out?.code || ''}`;
  if (!text.includes(UNKNOWN_KEY)) return { ok: false, reason: `отказ есть, но ключ «${UNKNOWN_KEY}» не назван: ${text.slice(0, 160)}` };
  if (fs.existsSync(draftFile('c2', 'prod-feature-check'))) return { ok: false, reason: 'мусорный черновик записан на диск' };
  return { ok: true, note: 'отклонён, мусор не записан' };
});

// ── C3: {var} в goal_template без inputs[] отклоняется (шаг 3) ───────────────
await acheck('C3', '{var} в goal_template без inputs[] → отказ, названа переменная (шаг 3)', async () => {
  const bad = pb({ goal_template: 'Проверить {scenario} на проде', inputs: undefined });
  delete bad.when_to_use; // изолируем проверку {var}-без-inputs, не схему
  setResponses(bad, bad);
  const out = await callTool('playbook_draft', { description: 'проверить' }, { userId: 'c3' });
  if (out && out.draft) return { ok: false, reason: 'черновик с необъявленной {scenario} ПРИНЯТ' };
  const text = `${out?.error || ''} ${out?.code || ''}`;
  if (!/(scenario|inputs)/.test(text)) return { ok: false, reason: `отказ есть, но переменная/inputs не названы: ${text.slice(0, 160)}` };
  return { ok: true };
});

// ── C4: валидный черновик принят и сохраняет when_to_use (шаги 4/5) ──────────
await acheck('C4', 'валидный черновик принят; when_to_use в сводке (шаги 4/5)', async () => {
  setResponses(pb(), pb()); // ответ + тот же на repair-круг (до фикса схема не знает when_to_use)
  const out = await callTool('playbook_draft', { description: 'проверить фичу на проде' }, { userId: 'c4' });
  if (!out || !out.draft) return { ok: false, reason: `черновик не принят: ${out?.error || out?.code || 'нет ответа'}` };
  if (out.summary?.when_to_use !== pb().when_to_use) return { ok: false, reason: `сводка не несёт when_to_use (${JSON.stringify(out.summary)})` };
  if (!fs.existsSync(draftFile('c4', 'prod-feature-check'))) return { ok: false, reason: 'черновик не записан' };
  return { ok: true };
});

// ── C5: save повторяет проверки, файл не пишется (шаг 6) ─────────────────────
await acheck('C5', 'save черновика с выдуманной проверкой → ok:false, назван ключ, файл не создан (шаг 6)', async () => {
  const user = 'c5';
  fs.mkdirSync(path.join(USERS, user, 'playbooks', '.drafts'), { recursive: true });
  const bad = pb({ stages: [{ id: 'checks', title: 'П', steps: [
    { title: 'Команда', execution_kind: 'programmatic', validation: { [UNKNOWN_KEY]: true } },
  ] }] });
  delete bad.when_to_use; // рукописная правка: проверяем именно повтор семантики на save
  fs.writeFileSync(draftFile(user, 'prod-feature-check'), JSON.stringify(bad));
  const out = await callTool('playbook_save', { playbook_id: 'prod-feature-check' }, { userId: user });
  if (out && out.saved) return { ok: false, reason: 'save принял рукописную правку с выдуманной проверкой' };
  const text = `${out?.error || ''} ${out?.code || ''}`;
  if (!text.includes(UNKNOWN_KEY)) return { ok: false, reason: `save отклонён, но ключ не назван: ${text.slice(0, 160)}` };
  if (fs.existsSync(savedFile(user, 'prod-feature-check'))) return { ok: false, reason: 'файл профиля всё равно записан' };
  return { ok: true };
});

// ── C6: валидный рукописный черновик сохраняется (нет ложного отказа) ────────
await acheck('C6', 'save валидного черновика проходит (шаг 6)', async () => {
  const user = 'c6';
  fs.mkdirSync(path.join(USERS, user, 'playbooks', '.drafts'), { recursive: true });
  fs.writeFileSync(draftFile(user, 'prod-feature-check'), JSON.stringify(pb()));
  const out = await callTool('playbook_save', { playbook_id: 'prod-feature-check' }, { userId: user });
  if (!out || !out.saved) return { ok: false, reason: `валидный черновик не сохранён: ${out?.error || out?.code || 'нет ответа'}` };
  if (!fs.existsSync(savedFile(user, 'prod-feature-check'))) return { ok: false, reason: 'файл профиля не создан' };
  return { ok: true, note: `v${out.saved.version}` };
});

// ── C7: agent-шаг с произвольным ключом валиден; {input} без inputs[] (C4/C7) ─
await acheck('C7', 'agent-шаг с произвольным ключом и {input} без inputs[] валидны (регресс)', async () => {
  const free = pb({
    goal_template: 'Сделать {input}',
    inputs: undefined,
    stages: [{ id: 's', title: 'S', steps: [
      { title: 'Итог', execution_kind: 'agent', executor_role: 'researcher', minimum_model_level: 'bachelor', context_budget: 'small', validation: { my_free_key: true } },
    ] }],
  });
  setResponses(free, free);
  const out = await callTool('playbook_draft', { description: 'процесс' }, { userId: 'c7' });
  if (!out || !out.draft) return { ok: false, reason: `ложный отказ: ${out?.error || out?.code || 'нет ответа'}` };
  return { ok: true };
});

// ── C8: store.list() отдаёт when_to_use (шаг 8) ──────────────────────────────
check('C8', 'store.list() отдаёт when_to_use профильного плейбука (шаг 8)', () => {
  const { PlaybookStore } = require('../../src/playbook-store.js');
  const user = 'c8';
  fs.mkdirSync(path.join(USERS, user, 'playbooks'), { recursive: true });
  fs.writeFileSync(savedFile(user, 'prod-feature-check'), JSON.stringify(pb()));
  const list = new PlaybookStore({ profileId: user }).list();
  const row = (list.playbooks || []).find(p => p.id === 'prod-feature-check');
  if (!row) return { ok: false, reason: `list() не видит плейбук (diagnostics: ${JSON.stringify(list.diagnostics)})` };
  if (row.when_to_use !== pb().when_to_use) return { ok: false, reason: `в list() нет when_to_use: ${JSON.stringify(row)}` };
  return { ok: true };
});

// ── C9/C10: сборщик блока меню профиля (шаг 8) ───────────────────────────────
function buildMenu(user) {
  const mod = require('../../src/profile-playbook-menu.js');
  const { PlaybookStore } = require('../../src/playbook-store.js');
  const fn = mod.buildProfilePlaybookMenu || mod.default;
  if (typeof fn !== 'function') throw new Error('нет экспорта buildProfilePlaybookMenu');
  return fn({ profileId: user, store: new PlaybookStore({ profileId: user }) });
}

check('C9', 'buildProfilePlaybookMenu собирает блок «[ТВОИ ПЛЕЙБУКИ]» c id и when_to_use (шаг 8)', () => {
  const user = 'c9';
  fs.mkdirSync(path.join(USERS, user, 'playbooks'), { recursive: true });
  fs.writeFileSync(savedFile(user, 'prod-feature-check'), JSON.stringify(pb()));
  const menu = String(buildMenu(user) || '');
  if (!menu) return { ok: false, reason: 'блок пуст для профиля с when_to_use' };
  if (!menu.includes('[ТВОИ ПЛЕЙБУКИ]')) return { ok: false, reason: 'нет заголовка [ТВОИ ПЛЕЙБУКИ]' };
  if (!menu.includes('prod-feature-check') || !menu.includes(pb().when_to_use)) return { ok: false, reason: `нет id/when_to_use: ${menu.slice(0, 200)}` };
  if (!/playbook_run/.test(menu)) return { ok: false, reason: 'нет указания запускать playbook_run' };
  return { ok: true };
});

check('C10', 'без профильных when_to_use блок пуст, промпт не растёт (шаг 8)', () => {
  const user = 'c10';
  fs.mkdirSync(path.join(USERS, user, 'playbooks'), { recursive: true });
  const menu = String(buildMenu(user) || '');
  if (menu !== '') return { ok: false, reason: `ожидали пусто, получили: ${menu.slice(0, 120)}` };
  return { ok: true };
});

// ── C11: runner вставляет блок меню в системный промпт профиля (шаг 8) ───────
check('C11', 'runner кладёт блок меню в системный промпт под !internalGtd && user.username (шаг 8)', () => {
  const src = fs.readFileSync(path.join(CORE_ROOT, 'src', 'runner', 'index.js'), 'utf8');
  if (!/buildProfilePlaybookMenu/.test(src)) return { ok: false, reason: 'runner/index.js не вызывает buildProfilePlaybookMenu' };
  const guard = /internalGtd/.test(src) && /user\?\.username|user\.username/.test(src);
  if (!guard) return { ok: false, reason: 'нет гейта !internalGtd && user.username рядом с инъекцией' };
  return { ok: true };
});

// ── C12/C13: playbook_check_reachability маршрут P (шаг 10) ──────────────────────────────
async function healthDispatch(user, id, extra = {}) {
  const out = await callTool('playbook_check_reachability', { id, ...extra }, { userId: user });
  const rep = out?.reports?.find(r => r.id === id);
  const dispatch = rep?.rows?.find(r => r.gate === 'dispatch');
  return { out, rep, dispatch };
}

await acheck('C12', 'health профильного с when_to_use → dispatch pass (и в strict) (шаг 10)', async () => {
  const user = 'c12';
  fs.mkdirSync(path.join(USERS, user, 'playbooks'), { recursive: true });
  fs.writeFileSync(savedFile(user, 'prod-feature-check'), JSON.stringify(pb()));
  const plain = await healthDispatch(user, 'prod-feature-check');
  if (plain.dispatch?.status !== 'pass') return { ok: false, reason: `dispatch=${plain.dispatch?.status || 'нет строки'}: ${plain.dispatch?.detail || JSON.stringify(plain.out).slice(0, 160)}` };
  const strict = await healthDispatch(user, 'prod-feature-check', { strict: true });
  if (strict.dispatch?.status !== 'pass') return { ok: false, reason: `в strict dispatch=${strict.dispatch?.status}: ${strict.dispatch?.detail || ''}` };
  return { ok: true, note: plain.dispatch.detail?.slice(0, 80) };
});

await acheck('C13', 'health без when_to_use → dispatch fail с подсказкой «заполни when_to_use» (шаг 10)', async () => {
  const user = 'c13';
  fs.mkdirSync(path.join(USERS, user, 'playbooks'), { recursive: true });
  const noWtu = pb(); delete noWtu.when_to_use;
  fs.writeFileSync(savedFile(user, 'prod-feature-check'), JSON.stringify(noWtu));
  const r = await healthDispatch(user, 'prod-feature-check');
  if (r.dispatch?.status !== 'fail') return { ok: false, reason: `ожидали fail, получили ${r.dispatch?.status || 'нет строки'}` };
  if (!/when_to_use/i.test(r.dispatch.detail || '')) return { ok: false, reason: `в подсказке нет when_to_use: ${r.dispatch.detail}` };
  return { ok: true };
});

// ── отчёт ────────────────────────────────────────────────────────────────────
const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log('');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id.padEnd(4)} ${r.name}${r.ok && r.note ? ` — ${r.note}` : ''}`);
  if (!r.ok) console.log(`     ↳ причина: ${r.reason}`);
}
const failed = results.filter(r => !r.ok);
console.log('');
console.log(`── ${results.length - failed.length}/${results.length} PASS · цикл ${(ms / 1000).toFixed(1)}с (цель ≤30с) · уровень S5`);
if (failed.length) {
  console.log(`PLAYBOOK-AUTHORING S4 SANDBOX: FAIL — ${failed.length} проверок красные.`);
  console.log('Красный по делу: срезы S4a (реестр проверок + семантика на авторстве) и S4b (when_to_use → промпт/маршрут) ещё не сделаны.');
} else {
  console.log('PLAYBOOK-AUTHORING S4 SANDBOX: PASS — сценарий S4a/S4b замкнут. Остаётся живая приёмка на staging (шаг 9).');
}
fs.rmSync(seed, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
