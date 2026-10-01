'use strict';
// POST /tasks/supplement — «➕ Дополнить» на идущей задаче (spec Core 02 SS-07/08,
// §5 PR#4, issue #1934). Серверная атомарная операция: остановить цепочку →
// подтвердить → ровно один новый ран в той же сессии; или честный отказ статусом.
//
// Правило входа из §4 спеки: реальная точка (supplementTask — то, что зовёт
// серверный роут), kill — через настоящие stop-функции, подтверждение — через
// настоящий confirmStopped. Движок подменяется швом `run` (ран не должен
// реально спавниться — нам нужна ровно одна запись «ран стартовал»).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'task-supp-'));
process.env.AGENT_DATA_DIR = path.join(ROOT, 'data');
process.env.USERS_DIR = path.join(ROOT, 'users');
process.env.MIN_FREE_RAM_MB = '0';
process.env.TELEGRAM_API_URL = 'http://127.0.0.1:9'; // сюда сообщения не уходят: запуск подменён
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stopTrace = require('../src/stop-trace');
const runner = require('../src/runner');

const workDir = username => {
  const dir = path.join(process.env.USERS_DIR, username);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
// Процесс, который умирает от TERM (дефолт) или переживает его (unconfirmed-кейс).
function fakeProc({ diesOnKill = true } = {}) {
  return {
    exitCode: null, signalCode: null, killed: null,
    kill(sig) { this.killed = sig; if (diesOnKill) this.exitCode = 0; },
  };
}
function freshMaps() {
  runner._activeTimers.clear();
  runner._liveRuns.clear();
}
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── Валидация ────────────────────────────────────────────────────────────────

test('без адреса (ни chatId, ни sessionId) — bad_request, ничего не тронуто', async () => {
  freshMaps();
  let ran = 0;
  const res = await runner.supplementTask(
    { username: 'ana', text: 'дополнение', workDir: workDir('ana'), secrets: {} },
    { run: () => { ran++; return Promise.resolve('x'); } },
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 'bad_request');
  assert.match(res.error, /sessionId or chatId required/);
  assert.equal(ran, 0, 'без адреса не останавливаем и не запускаем');
});

// ── SS-08: гонка «задача кончилась, пока я писал дополнение» ─────────────────

test('SS-08: нечего останавливать → already_finished, тумбстоун не ставится, ран не стартует', async () => {
  freshMaps();
  let ran = 0;
  const chatId = 31337;
  const res = await runner.supplementTask(
    { username: 'ben', chatId, text: 'а вдруг кончилось', workDir: workDir('ben'), secrets: {} },
    { run: () => { ran++; return Promise.resolve('x'); } },
  );
  assert.equal(res.status, 'already_finished', 'шлюз запустит дополнение обычным /run (SS-08)');
  assert.equal(ran, 0, 'агент сам не запускает — это делает шлюз');
  assert.equal(stopTrace.traceStoppedAt(
    stopTrace.traceIdFor({ chatId, audience: 'default', threadId: null, username: 'ben' })), null,
    'отметки нет: продолжение сессии не должно упереться в гейт',
  );
});

// ── SS-03: подтверждение не пришло ───────────────────────────────────────────

test('SS-03: процесс пережил TERM → stop_unconfirmed, ран НЕ запущен, но цепочка помечена', async () => {
  freshMaps();
  let ran = 0;
  const chatId = 555;
  const state = { username: 'bob', audience: 'default', chatId, threadId: null, sessionId: null, proc: fakeProc({ diesOnKill: false }) };
  runner._activeTimers.set('bob-1', state);

  const res = await runner.supplementTask(
    { username: 'bob', chatId, text: 'доп', workDir: workDir('bob'), secrets: {}, waitMs: 60 },
    { run: () => { ran++; return Promise.resolve('x'); } },
  );
  assert.equal(res.status, 'stop_unconfirmed', 'SS-03: шлюзу — честное «не подтвердилось», не «остановлено»');
  assert.equal(res.confirmed, false);
  assert.equal(ran, 0, 'K7: без подтверждения перезапуск запрещён — двойного рана не будет');
  assert.equal(state.userStopped, true, 'kill реально отправлен (и эскалация KILL уже вооружена)');
  assert.ok(Number.isFinite(stopTrace.traceStoppedAt(
    stopTrace.traceIdFor({ chatId, audience: 'default', threadId: null, username: 'bob' }))),
    'тумбстоун поставлен: ретраи старой цепочки не встанут, даже если подтверждение не пришло');
  runner._activeTimers.clear();
});

// ── SS-07: остановлено и подтверждено → один ран в той же сессии ────────────

test('SS-07: остановлено и подтверждено → ровно один новый ран в той же сессии', async () => {
  freshMaps();
  const wd = workDir('cat');
  const sessionId = 's-cat-1';
  const state = { username: 'cat', audience: 'default', chatId: 4242, threadId: null, sessionId, proc: fakeProc() };
  runner._activeTimers.set('cat-1', state);

  const calls = [];
  const t0 = Date.now();
  const res = await runner.supplementTask(
    { username: 'cat', sessionId, text: 'ещё вот это', workDir: wd, secrets: {}, waitMs: 500 },
    { run: opts => { calls.push(opts); return Promise.resolve('started'); } },
  );

  assert.equal(res.status, 'restarted', 'SS-07: старая цепочка остановлена и подтверждена');
  assert.equal(res.confirmed, true);
  assert.equal(calls.length, 1, 'ровно один ран (SS-07 «без дубля»)');
  const opts = calls[0];
  assert.equal(opts.sessionId, sessionId, 'та же sessionId — история сохранена');
  assert.equal(opts.fromUser, true, 'K1: новый запрос юзера проходит гейт структурно');
  assert.ok(Number.isFinite(opts.initiatedAt) && opts.initiatedAt >= t0,
    'D1-якорь: initiatedAt = момент приёма дополнения, не время старого запроса');
  assert.equal(opts.task, '[Дополнение к задаче]\nещё вот это', 'SS-07: текст дополнения со спе');
  assert.match(opts.taskId, /^cat-supp-\d+$/, 'taskId дополнения');
  assert.equal(res.taskId, opts.taskId);
  assert.equal(res.sessionId, sessionId);
  assert.equal(state.userStopped, true, 'старая цепочка остановлена до перезапуска');
  // Гейт: новый ран (initiatedAt позже отметки) не заблокирован — и с fromUser, и без.
  const trace = stopTrace.traceIdFor({ sessionId, username: 'cat' });
  assert.equal(stopTrace.isRunStopped({ traceId: trace, initiatedAt: opts.initiatedAt, fromUser: false }), false,
    'якорь свежий → ретраи дополнения живы (D1)');
  runner._activeTimers.clear();
});

// ── K7: два параллельных «Дополнить» ────────────────────────────────────────

test('K7: параллельный второй «Дополнить» → in_progress, второй ран не создаётся', async () => {
  freshMaps();
  const chatId = 7001;
  runner._activeTimers.set('dave-1',
    { username: 'dave', audience: 'default', chatId, threadId: null, sessionId: 's-dave', proc: fakeProc() });

  let releaseConfirm;
  const gate = new Promise(resolve => { releaseConfirm = resolve; });
  const calls = [];
  const deps = {
    run: opts => { calls.push(opts); return Promise.resolve('x'); },
    confirm: async () => { await gate; return true; },
  };
  const args = { username: 'dave', chatId, text: 'первый', workDir: workDir('dave'), secrets: {}, waitMs: 500 };

  const first = runner.supplementTask(args, deps);
  // Первый вызов дошёл до `await confirm` — ключ диалога уже взят (синхронно).
  const second = await runner.supplementTask(
    { ...args, text: 'второй' },
    { run: opts => { calls.push(opts); return Promise.resolve('x'); }, confirm: async () => true },
  );
  assert.equal(second.status, 'in_progress', 'K7: второй supok не проходит');

  releaseConfirm();
  const firstRes = await first;
  assert.equal(firstRes.status, 'restarted');
  assert.equal(calls.length, 1, 'ровно один ран на диалог, какой бы supok ни был первым');
  assert.equal(calls[0].task, '[Дополнение к задаче]\nпервый', 'побеждает первый принятый');
  runner._activeTimers.clear();
});

// ── Контракт серверного роута ────────────────────────────────────────────────

test('контракт: роут /tasks/supplement валидирует адрес и текст, зовёт supplementTask', () => {
  const server = read('src/server.js');
  // Начало блока — комментарий роута (в нём же задокументированы статусы),
  // поэтому ищем «POST /tasks/supplement», а не условие if.
  const at = server.indexOf('POST /tasks/supplement');
  assert.ok(at > 0, 'роут /tasks/supplement есть');
  const block = server.slice(at, server.indexOf("url.pathname === '/run'", at));
  assert.ok(/supplementTask\(\{/.test(block), 'роут делегирует в runner.supplementTask');
  assert.ok(block.includes('sessionId or chatId required'), 'адрес диалога обязателен (K4)');
  assert.ok(block.includes('missing text'), 'пустой supplement без файлов — 400');
  assert.ok(/materializeFileRefs\(/.test(block), 'файлы тем же материализатором, что POST /run (SS-10)');
  assert.ok(/result\.ok === false \? 400 : 200/.test(block), 'bad_request из runner → HTTP 400');
  assert.ok(block.includes('already_finished') && block.includes('stop_unconfirmed') && block.includes('in_progress'),
    'все статусы из SS-07/08/K7 задокументированы на роуте');
  assert.ok(/Math\.min\(Math\.max\(rawWaitMs, 0\), 10000\)/.test(block), 'waitMs ограничено 10с (SS-03)');

  const src = read('src/runner/index.js');
  assert.ok(/async function supplementTask\(/.test(src), 'supplementTask живёт в runner');
  const body = src.slice(src.indexOf('async function supplementTask('), src.indexOf('module.exports'));
  assert.ok(body.includes('[Дополнение к задаче]'), 'SS-07: текст дополнения');
  assert.ok(/await confirm\(owner, waitMs\)/.test(body), 'подтверждение остановки ДО перезапуска (SS-01→SS-07)');
  assert.ok(/fromUser: true/.test(body), 'новый ран помечен fromUser (K1)');
  assert.ok(/status: 'already_finished'/.test(body) && /status: 'stop_unconfirmed'/.test(body)
    && /status: 'in_progress'/.test(body), 'все исходы реализованы, не только успех');
  assert.ok(/stopTracesFor\(owner\)/.test(body), 'тумбстоун старой цепочки ставится (SS-04)');
});
