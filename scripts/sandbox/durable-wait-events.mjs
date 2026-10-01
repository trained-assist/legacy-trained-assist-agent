#!/usr/bin/env node
// Sandbox — исполняемая форма сценария
// docs/user-scenarios/core/05-durable-wait-events.md (EV-01…EV-12),
// дизайн — issue #1846 (срезы S1–S5), план 16eac5da.
//
// Зачем: замкнуть цикл «изменил → увидел результат» без человека. Одна команда:
//
//     npm run sandbox:durable-wait-events
//
// Уровень автономности: S3 — e2e-харнесс через реальные функциональные блоки
// (SQLite-store + gtd-controller wait-тик + MCP-тул task_item_wait + реестр
// playbook-validators + HTTP-поверхность вебхука), с фейковым GitHub (payload
// приходит как есть; внешние вызовы GitHub API у проверщиков — фейк) и
// инжектированным временем. Полный src/server.js не поднимается (резюмировал бы
// чужие задачи) — маршрут проверяется структурно по исходнику, а поведение
// вебхука — вызовом его обработчика напрямую. S4 (прод-смоук «секунды») =
// приёмка на деплое, здесь недостижим.
// Целевое время цикла: ≤60 с (фактически секунды).
//
// Что проверяет (сценарий 05 → EV):
//   EV-01 (новое)   каталог событий есть в реестре: issue_pr_merged,
//                  issue_pr_ci_green, workflow_run_completed, workflow_run_green,
//                  workflow_job_completed; каждый — функция, не throw
//   EV-02 (новое)   шаг подписывается: until:{issue_pr_merged:"o/r#N"} принят;
//                  НЕИЗВЕСТНЫЙ тип отклонён с перечислением каталога (Фаза A.1)
//   EV-03 (регресс) парковка ожидания: waiting, попытка не потрачена,
//                  следующий шаг заблокирован
//   EV-04 (новое)   fail-closed порядок вебхука (Фаза 0.1): 404 без секрета →
//                  413 тело велико → 401 подпись неверна → 400 не-JSON → 202;
//                  и ни один отказ НЕ трогает шаг
//   EV-05 (новое)   fast path (Фаза B.1): pull_request(closed,merged) по
//                  o/r#N и workflow_run(completed) по …/actions/runs/<id> →
//                  ждущий шаг с совпавшим субъектом взведён (due_at=now) + кик
//   EV-06 (новое)   субъект не совпал (чужое репо / чужой номер / PR без мержа)
//                  → шаг НЕ взведён, кик не по нашей подписке
//   EV-07 (новое)   идемпотентность: повторная доставка того же события не
//                  будит повторно (Фаза B.1 «дубли идут в никуда»)
//   EV-08 (новое)   ВЕРДИКТ ДАЁТ ПРОВЕРЩИК, не вебхук (Фаза B.2): после кика
//                  pass → satisfied + блок [ПРОБУЖДЕНИЕ ПОСЛЕ ОЖИДАНИЯ];
//                  fail не-финальный → шаг ждёт дальше; fail финальный →
//                  resolved:'failed' и ветка провала, не таймаут
//   EV-09 (регресс) запасной путь (Фаза B.3): вебхука нет — тик ожиданий
//                  опрашивает проверщик и будит шаг; потеря вебхука = медленнее
//   EV-10 (новое)   задержка пробуждения по событию ≤5 с (сейчас был бы опрос:
//                  30 с пол + 30 с тик = 60 с) — это и есть ценность эпика
//   EV-11 (новое)   маршрут смонтирован ДО глобального Bearer-гейта (GitHub шлёт
//                  только HMAC, Bearer не пришлёт) + nginx пробрасывает публичный
//                  префикс до :8080
//   EV-12 (новое)   каталог виден исполнителю (Фаза A.2): описание task_item_wait
//                  перечисляет типы событий; в плейбуке feature нет
//                  delay_after_sec: 600 (событие, а не sleep)
//
// Контракты, которые песочница пинит для реализации (дизайн §1–2):
//   • createDefaultRegistry() содержит 5 новых ключей; каждый — функция.
//   • Обработчик вебхука — экспортируемая функция (req, url, res, ctx) → true,
//     живёт в src/handlers/github-webhook.js (или рядом: src/github-webhook.js,
//     src/handlers/github.js, src/handlers/webhooks.js, src/github-events.js…);
//     false = маршрут не этот. ctx: json/readBody/readBodyBuffer/secrets.
//   • POST /webhooks/github: подпись X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256
//     (тело СЫРОЕ) секретом, сравнение timing-safe ДО разбора JSON; секрет из
//     secrets.GITHUB_WEBHOOK_SECRET (фикстура кладёт его во все известные имена).
//   • Вебхук ТОЛЬКО будит: due_at=now у совпавшего waiting-шага + кик
//     (durable-kick.notify / gtd.kickDurable). Вердикт — проверщик из реестра.
//   • Матчер: тип события + субъект (`owner/repo#N`, `owner/repo/actions/runs/<id>`).
//   • Маршрут живёт до глобального Bearer-гейта src/server.js (как /health).
//
// Пока срезы S1–S5 не сделаны, песочница обязана быть КРАСНОЙ по этим причинам.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const started = process.hrtime.bigint();

// ── изоляция: никакого общего ~/agent-data, ~/users или /tmp ядра ─────────────
const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-events-sandbox-'));
fs.mkdirSync(path.join(seed, 'users'), { recursive: true });
fs.mkdirSync(path.join(seed, 'tokens'), { recursive: true });
process.env.AGENT_DATA_DIR = path.join(seed, 'agent-data');
process.env.USERS_DIR = path.join(seed, 'users');
process.env.AGENT_TOKENS_DIR = path.join(seed, 'tokens');
process.env.AGENT_SECRET = 'sandbox-events-kick-secret';
process.env.DURABLE_KICK = '1';

// Секрет вебхука кладём во все имена, которые реализация вправе читать: пока ни
// одного нет, проверка «404 без секрета» и «202 с секретом» не отличимы.
const WEBHOOK_SECRET = 'sandbox-github-webhook-secret';
const SECRET_ENV_NAMES = [
  'GITHUB_WEBHOOK_SECRET', 'GH_WEBHOOK_SECRET', 'DURABLE_WEBHOOK_SECRET',
  'WEBHOOK_SECRET', 'GITHUB_WEBHOOKS_SECRET',
];
function setSecret(on) {
  for (const n of SECRET_ENV_NAMES) {
    if (on) process.env[n] = WEBHOOK_SECRET;
    else delete process.env[n];
  }
}
setSecret(true);

// Вебхук-обработчик ищется ПО ВОЗМОЖНОСТИ, а не по имени: реализация вправе
// назвать модуль как угодно — песочница пинет контракт, а не имя файла.
const HOOK_CANDIDATES = [
  '../../src/handlers/github-webhook.js',
  '../../src/github-webhook.js',
  '../../src/handlers/github.js',
  '../../src/handlers/webhooks.js',
  '../../src/github-events.js',
  '../../src/github-events-webhook.js',
  '../../src/durable-wait-events.js',
  '../../src/handlers/durable-wait-events.js',
];

const MODULES = [
  '../../src/gtd-controller.js',
  '../../src/durable-task-store.js',
  '../../src/durable-wait.js',
  '../../src/data-paths.js',
  '../../src/durable-kick.js',
  '../../src/playbook-validators.js',
  '../../src/mcp-skills/tools/101-durable-tasks.js',
  ...HOOK_CANDIDATES,
];
let _tag = 0;
function fresh() {
  const dir = path.join(seed, `data-${++_tag}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.AGENT_DATA_DIR = dir;
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch { /* нет модуля */ } }
  const G = require('../../src/gtd-controller.js');
  const waitLib = require('../../src/durable-wait.js');
  const tools = require('../../src/mcp-skills/tools/101-durable-tasks.js').tools;
  const validators = require('../../src/playbook-validators.js');
  return { G, store: G.durableStore(), waitLib, tools, validators };
}
const drain = () => new Promise((r) => setTimeout(r, 0));

/** Найти обработчик вебхука: первый кандидат, отдающий функцию-роут. */
function webhookRoute() {
  for (const rel of HOOK_CANDIDATES) {
    let mod;
    try { mod = require(rel); } catch { continue; }
    const fns = [];
    if (typeof mod === 'function') fns.push([mod, mod.name || 'default']);
    else if (mod && typeof mod === 'object') {
      for (const [k, v] of Object.entries(mod)) if (typeof v === 'function') fns.push([v, k]);
    }
    for (const [fn, name] of fns) {
      if (/^handle/i.test(name) || /webhook|github|event/i.test(name) || fn.length >= 3) {
        return { rel, fn, name };
      }
    }
  }
  return null;
}

// ── HTTP-поверхность: фейковый req/res, тело ровно как его дал GitHub ────────
const SIGNATURE_HEADER = 'x-hub-signature-256';
const sigOf = (body, secret = WEBHOOK_SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

/**
 * Доставить одно событие в обработчик.
 * `secret` — секрет, КОТОРЫМ НАСТРОЕН агент (ctx.secrets + env); `signSecret` —
 * чем подписано тело (по умолчанию тем же). Их различение и есть проверка
 * подписи: «агент настроен на A, пришло подписанное B» → обязано быть 401.
 * @returns {Promise<{status:number|null, body:any, handled:any, bodyRead:boolean}>}
 */
async function deliver(route, { event, payload, secret = WEBHOOK_SECRET, signSecret = null, sign = true, raw = null, pathname = '/webhooks/github' } = {}) {
  const body = raw != null ? raw : Buffer.from(JSON.stringify(payload));
  const headers = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': 'sandbox-delivery-1',
  };
  if (sign) headers[SIGNATURE_HEADER] = sigOf(body, signSecret || secret);
  const req = { method: 'POST', headers, url: pathname };
  const url = new URL(`http://127.0.0.1:3001${pathname}`);
  const rec = { status: null, body: null, handled: undefined, bodyRead: false };
  const ctx = {
    // Ровно как src/server.js: превышение лимита → throw, маппится в 413 обработчиком.
    readBodyBuffer: async (_req, maxBytes = 1_048_576) => {
      rec.bodyRead = true;
      if (body.length > maxBytes) throw new Error('body too large');
      return body;
    },
    readBody: async () => body.toString('utf8'),
    json: (_res, status, data) => { rec.status = status; rec.body = data; return true; },
    secrets: Object.fromEntries(SECRET_ENV_NAMES.map((n) => [n, secret || ''])),
    getGtdTickNow: () => async () => {},
  };
  try { rec.handled = await route.fn(req, url, { writeHead() { return this; }, end() { return this; } }, ctx); }
  catch (e) { rec.threw = `${e.name}: ${e.message}`; }
  return rec;
}

// ── настоящие payload-формы GitHub (как в api.github.com) ────────────────────
const REPO = 'trained-assist/trained-assist-agent';
const SUBJECT = { owner: 'trained-assist', repo: 'trained-assist-agent', number: 1846 };
const subjectStr = `${REPO}#${SUBJECT.number}`;
const RUN_ID = 987654321;

function prPayload({ repo = REPO, number = SUBJECT.number, merged = true, action = merged ? 'closed' : 'opened' } = {}) {
  return {
    action,
    repository: { full_name: repo, name: repo.split('/')[1], owner: { login: repo.split('/')[0] } },
    pull_request: {
      number, merged, merged_at: merged ? new Date().toISOString() : null,
      state: merged ? 'closed' : 'open', html_url: `https://github.com/${repo}/pull/${number}`,
      head: { sha: 'deadbeef' }, base: { ref: 'main' },
    },
  };
}
function runPayload({ repo = REPO, id = RUN_ID, conclusion = 'success' } = {}) {
  return {
    action: 'completed',
    repository: { full_name: repo, owner: { login: repo.split('/')[0] }, name: repo.split('/')[1] },
    workflow_run: { id, conclusion, status: 'completed', event: 'pull_request', html_url: `https://github.com/${repo}/actions/runs/${id}` },
  };
}
const runSubject = (id = RUN_ID) => `${REPO}/actions/runs/${id}`;

// ── сцены-хелперы ────────────────────────────────────────────────────────────
function activePlan(store, items) {
  const r = store.createPlan({
    profile_id: 'u1', goal: 'durable-wait events sandbox', user_value: 'v',
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
const PASS_ALL = { command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: {} }) };

/** Один ждущий шаг, подписанный на событие (Фаза A через настоящий MCP-тул). */
async function subscribeOn(store, tools, G, until, { reason = 'событие GitHub' } = {}) {
  const taskId = activePlan(store, [agentItem('Ждём событие'), agentItem('Следующий шаг')]);
  await G.runDueDurable({
    secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
    runTask: async (opts) => {
      const itemId = /Step id: (\S+)/.exec(opts.task)[1];
      const res = await tools.task_item_wait.handler(
        { item_id: itemId, until, reason, timeout_sec: 6 * 3600 }, { userId: 'u1' });
      return res && res.error ? `ERR:${res.error}` : 'DURABLE: waiting';
    },
  });
  await drain();
  const [item, next] = store.listTaskItems(taskId, 'u1');
  return { taskId, item, next, store };
}

/** Кик-шпион: регистрируем in-process будильник (тот же seam, что у MCP-тула). */
function spyKick() {
  const calls = [];
  require('../../src/durable-kick.js').useInProcess((reason) => { calls.push(reason || 'kick'); });
  return calls;
}

// ── отчётность в стиле scripts/sandbox/durable-wait-latency.mjs ──────────────
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

const NEW_KEYS = [
  'issue_pr_merged', 'issue_pr_ci_green',
  'workflow_run_completed', 'workflow_run_green', 'workflow_job_completed',
];

// ── сцены ─────────────────────────────────────────────────────────────────────
async function ev01() {
  await check('EV-01', 'каталог событий в реестре (5 новых ключей, все — функции)', async () => {
    const { validators } = fresh();
    const reg = validators.createDefaultRegistry({ ghToken: () => 't', ghFetch: async () => ({}) });
    const missing = NEW_KEYS.filter((k) => typeof reg[k] !== 'function');
    if (missing.length) {
      return { ok: false, reason: `в createDefaultRegistry нет/не функция: ${missing.join(', ')} — task_item_wait отклонит until с этими ключами` };
    }
    // Зарегистрирован ≠ рабочий: ключ обязан вернуть вердикт на правдоподобном
    // субъекте, а не бросить (иначе pollDurableWait уходит в inconclusive).
    const subject = { issue_pr_merged: subjectStr, issue_pr_ci_green: subjectStr, workflow_run_completed: runSubject(), workflow_run_green: runSubject(), workflow_job_completed: `${RUN_ID}` };
    const broken = [];
    for (const k of NEW_KEYS) {
      try {
        const r = await reg[k]({ item: agentItem(k), profileId: 'u1', validation: subject[k], key: k });
        if (!r || !['pass', 'fail', 'inconclusive'].includes(r.status)) broken.push(`${k}→${JSON.stringify(r && r.status)}`);
      } catch (e) { broken.push(`${k} бросил ${e.name}: ${e.message}`); }
    }
    if (broken.length) return { ok: false, reason: `ключи есть, но не дают вердикт: ${broken.join('; ')}` };
    return { ok: true, note: `${NEW_KEYS.length} ключей, все дают вердикт` };
  });
}

async function ev02() {
  await check('EV-02', 'подписка: until с типом события принят, неизвестный тип отклонён с каталогом', async () => {
    const { store, tools, G, waitLib } = fresh();
    const keys = Object.keys(require('../../src/playbook-validators.js').createDefaultRegistry({ ghToken: () => 't', ghFetch: async () => ({}) }));
    const good = waitLib.normalizeAgentWait(
      { item_id: 'x', until: { issue_pr_merged: subjectStr }, reason: 'PR' }, { now: Date.now(), registryKeys: keys });
    if (good.error) return { ok: false, reason: `подписка на issue_pr_merged отклонена: ${good.error}` };
    const bad = waitLib.normalizeAgentWait(
      { item_id: 'x', until: { pr_is_something: 'x' } }, { now: Date.now(), registryKeys: keys });
    if (!bad.error) return { ok: false, reason: 'неизвестный тип в until принят — шаг уснёт до таймаута с заведомо невыполнимым условием' };
    if (!NEW_KEYS.every((k) => bad.error.includes(k))) {
      return { ok: false, reason: `в отказе нет перечисления каталога событий (ожидались ${NEW_KEYS.join(', ')}): ${bad.error}` };
    }
    // И сквозь настоящий тул: паркует шаг, а не падает.
    const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
    if (item.status !== 'waiting') return { ok: false, reason: `шаг не припаркован (status=${item.status}) — подписка не доехала до wait_json` };
    return { ok: true, note: 'принят; неизвестный тип отклонён с каталогом; шаг waiting' };
  });
}

async function ev03() {
  await check('EV-03', 'парковка ожидания: waiting, попытка не потрачена, следующий шаг заблокирован (регресс)', async () => {
    const { store, tools, G } = fresh();
    const { item, next } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
    return guard(
      item.status === 'waiting' && item.attempt_count === 0 && next && next.status === 'pending',
      `ожидание не запарковано (status=${item.status}, attempts=${item.attempt_count}, next=${next && next.status})`,
    ) || { ok: true, note: 'waiting, attempts=0, next blocked' };
  });
}

async function ev04() {
  await check('EV-04', 'fail-closed порядок вебхука: 404/413/401/400/202, отказ не трогает шаг', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: `нет обработчика вебхука (искал: ${HOOK_CANDIDATES.map((p) => path.basename(p)).join(', ')}) — POST /webhooks/github не смонтирован` };
    const { store, tools, G } = fresh();
    const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
    const before = store.listTaskItems(item.task_id, 'u1')[0];
    const payload = prPayload();
    const spies = spyKick();
    const cases = [];

    // 1. секрет вебхука не настроен вовсе → 404, никто не обслуживается.
    setSecret(false);
    const noSecret = await deliver(route, { event: 'pull_request', payload, secret: '', sign: true });
    cases.push(['без секрета', noSecret, 404]);
    setSecret(true);

    // 2. тело больше лимита → 413 (чистая функция чтения тела, как в server.js).
    const huge = await deliver(route, { event: 'pull_request', payload, raw: Buffer.alloc(2 * 1024 * 1024, 0x61) });
    cases.push(['тело 2 МБ', huge, 413]);

    // 3. подпись по чужому секрету, агент настроен на наш → 401, тело НЕ разбирается.
    const badSig = await deliver(route, { event: 'pull_request', payload, signSecret: 'wrong-secret' });
    cases.push(['чужая подпись', badSig, 401]);

    // 4. подпись верна, но тело не-JSON → 400.
    const badJson = await deliver(route, { event: 'pull_request', payload, raw: Buffer.from('не json') });
    cases.push(['не-JSON с верной подписью', badJson, 400]);

    const after = store.listTaskItems(item.task_id, 'u1')[0];
    const problems = [];
    for (const [label, rec, want] of cases) {
      if (rec.threw) problems.push(`${label}: обработчик бросил ${rec.threw} (ожидался HTTP ${want})`);
      else if (rec.handled === false) problems.push(`${label}: маршрут не обслужен (handler вернул false) — ожидался HTTP ${want}`);
      else if (rec.status !== want) problems.push(`${label}: HTTP ${rec.status} — ожидался ${want}`);
    }
    if (!badSig.bodyRead) problems.push('чужая подпись: тело даже не прочитано — нечем было проверить HMAC');
    if (after.due_at !== before.due_at || after.status !== before.status) {
      problems.push(`отказ тронул шаг (due_at ${before.due_at}→${after.due_at}, status ${before.status}→${after.status})`);
    }
    if (spies.length) problems.push(`отказ разбудил durable-тик (кики: ${spies.join(', ')})`);
    if (problems.length) return { ok: false, reason: problems.join('; ') };
    return { ok: true, note: '404/413/401/400 соблюдены, шаг и тик не тронуты' };
  });
}

async function ev05() {
  await check('EV-05', 'fast path: pull_request merged и workflow_run completed взводят свой шаг', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: 'нет обработчика вебхука — проверить доставку события нечем' };
    const notes = [];

    // 5a. PR смержен по o/r#N.
    {
      const { store, tools, G } = fresh();
      const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
      const before = store.listTaskItems(item.task_id, 'u1')[0];
      const spies = spyKick();
      const t0 = Date.now();
      const rec = await deliver(route, { event: 'pull_request', payload: prPayload() });
      const after = store.listTaskItems(item.task_id, 'u1')[0];
      if (rec.status !== 202) return { ok: false, reason: `валидная доставка pull_request → HTTP ${rec.status} (ожидался 202)${rec.threw ? `, бросил ${rec.threw}` : ''}` };
      const kicked = after.due_at <= t0 + 1000 && (after.due_at < before.due_at || spies.length > 0);
      if (!kicked) {
        return { ok: false, reason: `202, но шаг не взведён (due_at ${before.due_at}→${after.due_at}, кики: ${spies.length}) — вебхук должен поставить due_at=now и кикнуть durable-тик` };
      }
      notes.push(`pr: due_at=now, кик=${spies.length || 'через store'}`);
    }

    // 5b. Прогон Actions завершён по …/actions/runs/<id>.
    {
      const { store, tools, G } = fresh();
      const { item } = await subscribeOn(store, tools, G, { workflow_run_completed: runSubject() });
      const before = store.listTaskItems(item.task_id, 'u1')[0];
      const spies = spyKick();
      const rec = await deliver(route, { event: 'workflow_run', payload: runPayload() });
      const after = store.listTaskItems(item.task_id, 'u1')[0];
      if (rec.status !== 202) return { ok: false, reason: `валидная доставка workflow_run → HTTP ${rec.status} (ожидался 202)` };
      if (!(after.due_at < before.due_at || spies.length > 0)) {
        return { ok: false, reason: `workflow_run: шаг не взведён (due_at ${before.due_at}→${after.due_at}, кики: ${spies.length}) — матчер не связал событие с субъектом «${runSubject()}»` };
      }
      notes.push('run: due_at=now');
    }
    return { ok: true, note: notes.join('; ') };
  });
}

async function ev06() {
  await check('EV-06', 'субъект не совпал (чужое репо / номер / без мержа) → шаг не взведён', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: 'нет обработчика вебхука' };
    const noise = [
      ['чужое репо', { event: 'pull_request', payload: prPayload({ repo: 'someone/other-repo' }) }],
      ['чужой номер', { event: 'pull_request', payload: prPayload({ number: 9999 }) }],
      ['PR без мержа', { event: 'pull_request', payload: prPayload({ merged: false, action: 'opened' }) }],
    ];
    for (const [label, ev] of noise) {
      const { store, tools, G } = fresh();
      const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
      const before = store.listTaskItems(item.task_id, 'u1')[0];
      const rec = await deliver(route, ev);
      const after = store.listTaskItems(item.task_id, 'u1')[0];
      const w = JSON.parse(after.wait_json || '{}');
      if (rec.status !== 202) return { ok: false, reason: `${label}: HTTP ${rec.status} — постороннее событие должно приниматься 202 (доставка успешна), но матчить нечего` };
      if (after.due_at !== before.due_at) {
        return { ok: false, reason: `${label}: взведён наш шаг (due_at ${before.due_at}→${after.due_at}) — матчер слишком широкий` };
      }
      if (w.resolved) return { ok: false, reason: `${label}: вебхук разрешил ожидание без проверщика (resolved=${w.resolved})` };
    }
    return { ok: true, note: '3 посторонних события: ни один шаг не взведён' };
  });
}

async function ev07() {
  await check('EV-07', 'идемпотентность: повторная доставка не будит повторно', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: 'нет обработчика вебхука' };
    const { store, tools, G } = fresh();
    const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
    const first = await deliver(route, { event: 'pull_request', payload: prPayload() });
    const mid = store.listTaskItems(item.task_id, 'u1')[0];
    const second = await deliver(route, { event: 'pull_request', payload: prPayload() });
    const after = store.listTaskItems(item.task_id, 'u1')[0];
    if (first.status !== 202 || second.status !== 202) return { ok: false, reason: `повторная доставка → HTTP ${second.status} (ожидался 202, GitHub ретраит)` };
    // Дубль не должен ни сдвигать шаг дальше, ни накапливать повторные будильники:
    // проверяем, что wait_json не превратилась в «уже разрешено» без проверщика.
    const w = JSON.parse(after.wait_json || '{}');
    if (w.resolved) return { ok: false, reason: `дубль разрешил ожидание без проверщика (resolved=${w.resolved}) — вебхук не решает, только будит` };
    if (after.due_at < mid.due_at) return { ok: false, reason: `дубль отодвинул шаг в прошлое (due_at ${mid.due_at}→${after.due_at}) — дедуп по x-github-delivery не работает` };
    return { ok: true, note: 'оба раза 202, ожидание не разрешено вебхуком' };
  });
}

async function ev08() {
  await check('EV-08', 'вердикт даёт проверщик: pass → satisfied, fail → ждёт, final → failed', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: 'нет обработчика вебхука' };

    // 8a. подписка + событие + проверщик «зелёный» → шаг разблокирован.
    {
      const { store, tools, G, waitLib } = fresh();
      const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
      spyKick();
      await deliver(route, { event: 'pull_request', payload: prPayload() });
      const reg = { ...PASS_ALL, issue_pr_merged: async () => ({ status: 'pass', subject: {}, evidence: { merged: true } }) };
      await G.runWaitTick({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: reg, freeSlots: () => 4, runTask: async () => 'DURABLE: done' });
      await drain();
      const w = JSON.parse(store.listTaskItems(item.task_id, 'u1')[0].wait_json || '{}');
      if (w.resolved !== 'satisfied') return { ok: false, reason: `после кика и «зелёного» проверщика ожидание не удовлетворено (resolved=${w.resolved || '—'}) — тик ожиданий не подхватил взведённый шаг` };
      const note = waitLib.resumeNote(w);
      if (!/\[ПРОБУЖДЕНИЕ ПОСЛЕ ОЖИДАНИЯ\]/.test(note)) return { ok: false, reason: 'шаг разбужен без блока [ПРОБУЖДЕНИЕ ПОСЛЕ ОЖИДАНИЯ]' };
    }

    // 8b. ложное срабатывание (проверщик «ещё нет») → шаг продолжает ждать.
    {
      const { store, tools, G } = fresh();
      const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr });
      spyKick();
      await deliver(route, { event: 'pull_request', payload: prPayload() });
      const reg = { ...PASS_ALL, issue_pr_merged: async () => ({ status: 'fail', subject: {}, evidence: { reason: 'ещё не смержен' } }) };
      await G.runWaitTick({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: reg, freeSlots: () => 4, runTask: async () => 'DURABLE: done' });
      await drain();
      const row = store.listTaskItems(item.task_id, 'u1')[0];
      const w = JSON.parse(row.wait_json || '{}');
      if (w.resolved) return { ok: false, reason: `не-финальный провал разбудил шаг (resolved=${w.resolved}) — ждать надо дальше` };
      if (row.status !== 'waiting') return { ok: false, reason: `после ложного срабатывания шаг ушёл из waiting (status=${row.status})` };
    }

    // 8c. финальный провал (CI красный насовсем) → шаг будится сразу по ветке
    // провала, а не по таймауту.
    {
      const { store, tools, G } = fresh();
      const { item } = await subscribeOn(store, tools, G, { workflow_run_green: runSubject() });
      spyKick();
      await deliver(route, { event: 'workflow_run', payload: runPayload({ conclusion: 'failure' }) });
      const reg = { ...PASS_ALL, workflow_run_green: async () => ({ status: 'fail', subject: {}, evidence: { final: true, conclusion: 'failure' } }) };
      await G.runWaitTick({ secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: reg, freeSlots: () => 4, runTask: async () => 'DURABLE: done' });
      await drain();
      const w = JSON.parse(store.listTaskItems(item.task_id, 'u1')[0].wait_json || '{}');
      if (w.resolved !== 'failed') return { ok: false, reason: `финальный провал не разбудил шаг (resolved=${w.resolved || '—'}) — ждать красный CI бессмысленно, шаг должен уйти в починку` };
    }
    return { ok: true, note: 'satisfied / keep / failed — вердикт проверщика' };
  });
}

async function ev09() {
  await check('EV-09', 'запасной путь: без вебхука тик ожиданий всё равно будит шаг (регресс)', async () => {
    const { store, tools, G } = fresh();
    // Никакого вебхука: только тик ожиданий, как сегодня. Шаг подписан с обычным
    // интервалом опроса; тик приходит, когда шаг «пора» (nextDueAt) — ровно так
    // он и ходит в бою.
    const taskId = activePlan(store, [agentItem('Ждём событие')]);
    await G.runDueDurable({
      secrets: {}, now: Date.now(), isTaskRunning: () => false, registry: PASS_ALL,
      runTask: async (opts) => {
        const itemId = /Step id: (\S+)/.exec(opts.task)[1];
        await tools.task_item_wait.handler(
          { item_id: itemId, until: { issue_pr_merged: subjectStr }, poll_every_sec: 30, timeout_sec: 6 * 3600, reason: 'событие GitHub' },
          { userId: 'u1' });
        return 'DURABLE: waiting';
      },
    });
    await drain();
    const parked = store.listTaskItems(taskId, 'u1')[0];
    if (parked.status !== 'waiting') return { ok: false, reason: `подписка не запаркована (status=${parked.status})` };
    // Тик ожиданий в момент, когда шаг стал due (now = due_at + 1мс).
    const reg = { ...PASS_ALL, issue_pr_merged: async () => ({ status: 'pass', subject: {}, evidence: { merged: true } }) };
    const fired = await G.runWaitTick({ secrets: {}, now: parked.due_at + 1, isTaskRunning: () => false, registry: reg, freeSlots: () => 4, runTask: async () => 'DURABLE: done' });
    await drain();
    const row = store.listTaskItems(taskId, 'u1')[0];
    const w = JSON.parse(row.wait_json || '{}');
    const ok = w.resolved === 'satisfied' || row.status === 'done' || fired > 0;
    return guard(ok, `без вебхука шаг не проснулся (fired=${fired}, status=${row.status}, resolved=${w.resolved || '—'}) — потеря вебхука не должна ломать ожидание`)
      || { ok: true, note: `опрос дождался условия (fired=${fired}, resolved=${w.resolved || 'done'})` };
  });
}

async function ev10() {
  await check('EV-10', 'задержка пробуждения по событию ≤5 с (было бы 30+30=60 с опросом)', async () => {
    const route = webhookRoute();
    if (!route) return { ok: false, reason: 'нет обработчика вебхука — задержку по событию измерять нечем' };
    const { store, tools, G, waitLib } = fresh();
    const { item } = await subscribeOn(store, tools, G, { issue_pr_merged: subjectStr }, { reason: 'PR смержен' });
    const t0 = Date.now();
    const rec = await deliver(route, { event: 'pull_request', payload: prPayload() });
    const t1 = Date.now();
    const after = store.listTaskItems(item.task_id, 'u1')[0];
    if (rec.status !== 202) return { ok: false, reason: `доставка → HTTP ${rec.status}` };
    const wakeLatencySec = Math.max(0, Math.round((Math.max(after.due_at, t0) - t0) / 1000));
    const handlerSec = Math.round((t1 - t0) / 1000);
    if (wakeLatencySec > 5) {
      return { ok: false, reason: `шаг взводится через ${wakeLatencySec}с — событие должно будить сразу, не по расписанию опроса` };
    }
    const pollFloor = require('../../src/durable-wait.js').MIN_POLL_SEC;
    return { ok: true, note: `по событию ${wakeLatencySec}с (обработка ${handlerSec}с) против опроса ${pollFloor}с пол + тик` };
  });
}

async function ev11() {
  await check('EV-11', 'маршрут до Bearer-гейта + nginx пробрасывает публичный префикс', async () => {
    const serverSrc = fs.readFileSync(path.join(CORE_ROOT, 'src', 'server.js'), 'utf8');
    // Маршрут может быть смонтирован как вызов модуля (путь живёт в модуле) —
    // ищем признак монтирования, а не литеральную строку пути.
    const mountAt = serverSrc.search(/webhooks\/github|github-webhook|handleGithubWebhook|githubWebhook/);
    if (mountAt < 0) return { ok: false, reason: 'в src/server.js нет монтирования вебхука GitHub (/webhooks/github) — маршрут не подключён' };
    const gateAt = serverSrc.indexOf('Auth: all endpoints require Bearer token');
    if (gateAt < 0) gateAt = serverSrc.indexOf("Bearer ${secrets.AGENT_SECRET}` && !kickByRunToken");
    if (gateAt > 0 && mountAt > gateAt) {
      return { ok: false, reason: 'маршрут стоит ПОСЛЕ глобального Bearer-гейта — GitHub Bearer не пришлёт, до маршрута не дойти (нужно до гейта, как /health)' };
    }
    const relay = path.join(CORE_ROOT, 'infra', 'nginx', 'relay.conf');
    const relaySrc = fs.existsSync(relay) ? fs.readFileSync(relay, 'utf8') : '';
    if (!/location\s+\/agent\//.test(relaySrc)) {
      return { ok: false, reason: 'в infra/nginx/relay.conf нет location /agent/ — публичный адрес агента не пробрасывает вебхук' };
    }
    const relayTo = /location\s+\/agent\/\s*\{[^}]*proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(relaySrc);
    return { ok: true, note: `маршрут до гейта; публично: <AGENT_PUBLIC_URL>/webhooks/github → 127.0.0.1:${relayTo ? relayTo[1] : '8080'}` };
  });
}

async function ev12() {
  await check('EV-12', 'каталог виден исполнителю: описание task_item_wait + в плейбуке feature нет sleep 600', async () => {
    const { tools } = fresh();
    const desc = tools.task_item_wait.description || '';
    const missing = NEW_KEYS.filter((k) => !desc.includes(k));
    if (missing.length) return { ok: false, reason: `в описании task_item_wait нет типов событий: ${missing.join(', ')} — исполнитель не знает, на что подписываться` };
    if (!/owner\/repo|owner\/repo#|actions\/runs/.test(desc)) {
      return { ok: false, reason: 'в описании task_item_wait нет формы субъекта (owner/repo#N, owner/repo/actions/runs/<id>)' };
    }
    // Плейбук feature: событие вместо sleep-цикла внутри рана.
    const pbFiles = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.json$/.test(e.name) && /feature/i.test(e.name)) pbFiles.push(full);
      }
    };
    for (const root of [path.join(CORE_ROOT, 'playbooks'), path.join(CORE_ROOT, 'docs', 'playbooks'), CORE_ROOT]) {
      if (fs.existsSync(root)) walk(root);
    }
    const offenders = pbFiles.filter((f) => /"delay_after_sec"\s*:\s*600/.test(fs.readFileSync(f, 'utf8')));
    if (offenders.length) return { ok: false, reason: `в плейбуке feature остался sleep-подход: ${offenders.map((f) => path.basename(f)).join(', ')} — шаг должен ждать событие, а не откладываться на 600с` };
    return { ok: true, note: 'типы + форма субъекта в описании тула; sleep-подхода в плейбуке feature нет' };
  });
}

// ── прогон ────────────────────────────────────────────────────────────────────
const hook = webhookRoute();
await ev01();
await ev02();
await ev03();
await ev04();
await ev05();
await ev06();
await ev07();
await ev08();
await ev09();
await ev10();
await ev11();
await ev12();

const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log('');
for (const r of results) {
  const tag = r.skip ? 'SKIP' : (r.ok ? 'PASS' : 'FAIL');
  console.log(`${tag} ${r.id.padEnd(5)} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  if (!r.ok) console.log(`      ↳ причина: ${r.reason}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`обработчик вебхука: ${hook ? `${path.basename(hook.rel)}#${hook.name}` : 'НЕ НАЙДЕН — срезы S1–S5 не сделаны'}`);
console.log(`── ${results.length - failed.length}/${results.length} PASS · цикл ${(ms / 1000).toFixed(1)}с (цель ≤60с) · уровень S3`);
if (failed.length) {
  console.log(`DURABLE-WAIT-EVENTS SANDBOX: FAIL — ${failed.length} проверок красные.`);
  console.log('Красный по делу: каталога событий в реестре и вебхука POST /webhooks/github ещё нет (срезы S1–S5 эпика #1846).');
} else {
  console.log('DURABLE-WAIT-EVENTS SANDBOX: PASS — событийный цикл замкнут локально. Остаётся прод-смоук S4 (секунды на живом вебхуке).');
}
fs.rmSync(seed, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
