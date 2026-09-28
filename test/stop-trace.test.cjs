'use strict';
// «⛔ Стоп» — spec: docs/user-scenarios/core/02-stop-and-supplement.md.
// Три слоя, которые раньше не работали вместе:
//   1. реальный kill дерева процессов под run-as изоляцией (§2, K3/K11);
//   2. trace-тумбстоун + гейт на каждой точке спавна (§2а, R1/R2/K14);
//   3. честный ответ /tasks/stop и закрытие GTD/durable записей (SS-03/R3/R4).
//
// Правило входа из §4: реальная точка входа (runTask, stop-функции), без
// sleep-угадайки и без сети. Корень изолируется ДО первого require — иначе
// tombstone уехал бы в живой ~/agent-data и мог заблокировать реальный запуск.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-trace-'));
process.env.AGENT_DATA_DIR = path.join(ROOT, 'data');
process.env.USERS_DIR = path.join(ROOT, 'users');
process.env.MIN_FREE_RAM_MB = '0';                 // RAM-watchdog иначе ждёт 60с на macOS
process.env.TELEGRAM_API_URL = 'http://127.0.0.1:9'; // тест не ходит в api.telegram.org
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const { test } = require('node:test');
const assert = require('node:assert/strict');

const STOP_MSG = '⛔ Остановлено до начала выполнения.';
const stopTrace = require('../src/stop-trace');
const { stopEngineProcess, signalSlot, STOP_ESCALATE_MS } = require('../src/runner/engine-stop');
const runner = require('../src/runner');

// У каждого кейса свой диалог/профиль: tombstones живут на диске на весь файл,
// перекрытие координат сделало бы тесты зависимыми от порядка.
const trace = (chatId, username = 'alice') =>
  stopTrace.traceIdFor({ chatId, audience: 'default', threadId: null, username });
const workDir = username => {
  const dir = path.join(process.env.USERS_DIR, username);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── 1. traceId: адрес диалога выводится, а не хранится ────────────────────────

test('traceIdFor: TG-лан считается из bot+chat+topic, профиль/сессия на неё не влияют', () => {
  const base = stopTrace.traceIdFor({ chatId: -100123, audience: 'recruiter', threadId: 42, username: 'alice' });
  assert.equal(base, stopTrace.traceIdFor({ chatId: -100123, audience: 'recruiter', threadId: 42, username: 'alice', sessionId: 's-1' }),
    'TG-трейс не зависит от sessionId: одна сессия ≠ один диалог');
  assert.notEqual(base, stopTrace.traceIdFor({ chatId: -100123, audience: 'recruiter', threadId: 7, username: 'alice' }),
    'другой топик = другой трейс (K4/CH-06)');
  assert.notEqual(base, stopTrace.traceIdFor({ chatId: -100123, audience: 'default', threadId: 42, username: 'alice' }),
    'другой бот = другой трейс (K4, #1302 §3.2)');
});

test('traceIdFor: web-ран адресуется профилем+сессией, без адреса — null (fail-open)', () => {
  assert.equal(stopTrace.traceIdFor({ chatId: 0, username: 'alice', sessionId: 's-1' }), 'web:alice:s-1');
  assert.equal(stopTrace.traceIdFor({ chatId: 0, username: 'alice' }), null, 'нет chatId и нет sessionId → адреса нет');
  assert.equal(stopTrace.traceIdFor({}), null);
  assert.equal(stopTrace.traceIdFor({ chatId: null, username: 'alice' }), null);
});

test('traceIdFor: неизвестный audience не падает — уходит на legacy-ключ', () => {
  const t = stopTrace.traceIdFor({ chatId: 5, audience: 'no-such-bot', threadId: null, username: 'a' });
  assert.match(t, /^tg-legacy:no-such-bot\|5\|/);
});

// ── 2. Гейт: !fromUser && initiatedAt <= stoppedAt ────────────────────────────

test('гейт: блокирует только внутренние хопы, чей initiatedAt старше отметки Стопа', () => {
  const t = trace(4101);
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: 1000 }), false, 'без отметки ничего не блокируется');
  assert.equal(stopTrace.markTraceStopped(t, { username: 'alice', chatId: 4101 }), true);
  const stoppedAt = stopTrace.traceStoppedAt(t);
  assert.ok(Number.isFinite(stoppedAt));

  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: stoppedAt - 1, fromUser: false }), true, 'старый хоп блокируется');
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: stoppedAt, fromUser: false }), true, 'граница включительно');
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: stoppedAt + 1, fromUser: false }), false, 'новая задача после Стопа живёт (K1)');
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: 1, fromUser: true }), false, 'fromUser = всегда пусто (K1/SS-05)');
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: null, fromUser: false }), false, 'неизвестный initiatedAt → fail-open');
  assert.equal(stopTrace.isRunStopped({ traceId: null, initiatedAt: 1, fromUser: false }), false, 'нет адреса → fail-open');
  assert.equal(stopTrace.isRunStopped({ traceId: trace(4199), initiatedAt: 1, fromUser: false }), false, 'чужой диалог не затронут (K4)');
});

test('гейт: TTL 24ч — протухшая отметка снимается и ничего не блокирует', () => {
  const t = trace(4102);
  stopTrace.markTraceStopped(t, {});
  const file = stopTrace._internals.tombstonePath(t);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.expiresAt = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.equal(stopTrace.traceStoppedAt(t), null, 'протухшая отметка читается как «не останавливалось»');
  assert.equal(fs.existsSync(file), false, 'и удаляется, чтобы TTL доработал');
});

test('гейт: битый tombstone читается как «останавливалось» (fail-closed на запись, не fail-open)', () => {
  const t = trace(4103);
  stopTrace.markTraceStopped(t, {});
  fs.writeFileSync(stopTrace._internals.tombstonePath(t), '{ не json');
  const stoppedAt = stopTrace.traceStoppedAt(t);
  assert.ok(Number.isFinite(stoppedAt), 'файл существует → Stop был; прятать его нельзя');
  assert.ok(stoppedAt <= Date.now());
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: stoppedAt - 1 }), true);
});

test('isUserStoppedReply: матчит все ответы Стопа, но НЕ loop-guard «⛔ Остановлено: модель…»', () => {
  for (const s of ['⛔ Остановлено', '⛔ Остановлено\n\nтекст', '⛔ Остановлено. Можешь задать новый вопрос.', STOP_MSG]) {
    assert.equal(stopTrace.isUserStoppedReply(s), true, JSON.stringify(s));
  }
  assert.equal(stopTrace.isUserStoppedReply('⛔ Остановлено: модель зациклилась'), false,
    'loop-guard — сбой модели, а не действие юзера (R4)');
  assert.equal(stopTrace.isUserStoppedReply('⛔ Задача остановлена.'), false);
  assert.equal(stopTrace.isUserStoppedReply(null), false);
});

// ── 3. Реальный kill: TERM слоту → 5с → KILL ──────────────────────────────────

function fakeProc(alive = true) {
  return { exitCode: alive ? null : 0, signalCode: null, killed: null, kill(sig) { this.killed = sig; } };
}

test('kill: TERM уходит слоту (pkill -u) и прямому ребёнку, userStopped ставится', () => {
  const calls = [];
  const proc = fakeProc();
  const state = { proc, slot: 'ta-agent-3', userStopped: false };
  const ok = stopEngineProcess(state, {
    exec: (bin, argv) => calls.push([bin, ...argv]),
    setTimeout: () => ({ unref() {} }),
  });
  assert.equal(ok, true);
  assert.equal(state.userStopped, true, 'R5: без userStopped close ушёл бы в автопродолжение');
  assert.equal(proc.killed, 'SIGTERM');
  assert.deepEqual(calls, [['sudo', '-n', '-u', 'ta-agent-3', '--', 'pkill', '-TERM', '-u', 'ta-agent-3']],
    'K3: сигнал пользователю слота, а не sudo-обёртке — иначе движок переживает и TERM, и KILL');
});

test('kill: эскалация шлёт KILL, только пока процесс жив', () => {
  const signals = [];
  const proc = fakeProc();
  let escalate;
  stopEngineProcess({ proc, slot: 'ta-agent-3' }, {
    exec: (_bin, argv) => signals.push(argv.find(a => /^-(TERM|KILL)$/.test(a))),
    setTimeout: fn => { escalate = fn; return { unref() {} }; },
  });
  assert.equal(typeof escalate, 'function');
  escalate();
  assert.deepEqual(signals, ['-TERM', '-KILL'], 'живой движок добивается KILL через STOP_ESCALATE_MS');
  assert.equal(proc.killed, 'SIGKILL');

  // Процесс уже вышел: слот мог быть переарендован чужому рану — второй сигнал
  // убил бы невиновного (K4). Проверяем, что KILL не уходит.
  const deadSignals = [];
  const dead = fakeProc(false);
  let escalate2;
  stopEngineProcess({ proc: dead, slot: 'ta-agent-3' }, {
    exec: (_bin, argv) => deadSignals.push(argv.find(a => /^-(TERM|KILL)$/.test(a))),
    setTimeout: fn => { escalate2 = fn; return { unref() {} }; },
  });
  escalate2();
  assert.deepEqual(deadSignals, ['-TERM'], 'мёртвому — только исходный TERM, эскалация пропущена');
  assert.equal(dead.killed, 'SIGTERM', 'KILL прямому ребёнку не шлётся');
});

test('kill: двойной Stop не плодит таймеры; без изоляции — только прямой ребёнок', () => {
  const calls = [];
  const state = { proc: fakeProc(), slot: null };
  let scheduled = 0;
  const sched = () => { scheduled++; return { unref() {} }; };
  stopEngineProcess(state, { exec: (b, a) => calls.push([b, ...a]), setTimeout: sched });
  assert.equal(calls.length, 0, 'signalSlot(null) — no-op');
  assert.equal(state.proc.killed, 'SIGTERM');
  assert.equal(state.userStopped, true);
  assert.equal(scheduled, 1, 'таймер эскалации ровно один');
  // Повторный Стоп уже имеет таймер → второй не создаётся.
  stopEngineProcess(state, { exec: () => { throw new Error('no slot'); }, setTimeout: () => { throw new Error('не должен плодиться'); } });
  assert.equal(scheduled, 1, 'повторный Stop переиспользует тот же таймер');
});

test('signalSlot: ошибка исполнения не роняет Стоп (fail-open)', () => {
  assert.equal(signalSlot('ta-agent-1', 'TERM', () => { throw new Error('ENOENT'); }), false);
  assert.equal(signalSlot(null, 'TERM', () => { throw new Error('не должен вызываться'); }), false);
  assert.ok(STOP_ESCALATE_MS >= 4000, 'эскалация не раньше, чем шлюз успеет ответить');
});

// ── 4. Гейт в runner: поведение через реальный runTask ────────────────────────

test('runTask: остановленный trace не доходит ни до журнала, ни до спавна', async () => {
  const wd = workDir('alice');
  assert.equal(stopTrace.markTraceStopped(trace(4242), { username: 'alice', chatId: 4242 }), true);

  const gated = runner.runTask({
    taskId: 'alice-stopped-1',
    user: { id: 4242, name: 'alice', username: 'alice', workDir: wd },
    task: 'сделай отчёт', context: null,
    initiatedAt: Date.now() - 60_000, // исходный запрос старше отметки Стопа
    secrets: {}, initialMsgId: null,
  });
  assert.equal(runner.getPendingTasks().length, 0,
    'заблокированный хоп не журналируется — resume не поднимет цепочку после рестарта (K14)');
  assert.equal(runner._liveRuns.size, 1, 'реестр живых ранов заполнен синхронно, до первого await');
  assert.equal(await gated, STOP_MSG);
  assert.equal(runner._liveRuns.size, 0, 'реестр снимается на settle внешнего промиса (спанет retry-backoff)');
});

test('runTask: тот же вызов без отметки проходит гейт и журналируется', async () => {
  const wd = workDir('alice');
  // Не давать движку реально запускаться: входим в admission с уже поставленным
  // session-stop — consumePendingStop вернёт тот же ответ ДО спавна. Журнал
  // пишется ДО очереди, поэтому его наличие и есть доказательство «гейт прошёл».
  runner._queuedByOwner.set(runner._ownerKey('alice', 's-ctl'), 1);
  runner.stopSessionTask('alice', 's-ctl');

  const control = runner.runTask({
    taskId: 'alice-control-1',
    user: { id: 4343, name: 'alice', username: 'alice', workDir: wd },
    task: 'привет', context: null,
    sessionId: 's-ctl',
    initiatedAt: Date.now() - 60_000,
    secrets: {}, initialMsgId: null,
  });
  assert.ok(runner.getPendingTasks().some(p => p.taskId === 'alice-control-1'),
    'неостановленный диалог журналируется — гейт не «всегда блокирует»');
  assert.equal(await control, STOP_MSG, 'остановлен на consumePendingStop, до спавна не дошло');
  runner._queuedByOwner.clear();
});

// ── 5. Адресация: откуда Stop берёт координаты трейсов ────────────────────────

test('stopTracesFor: чат-скоуп ставит тумбстоун на свой диалог, чужой не трогает', () => {
  const mine = trace(111);
  const other = trace(222);

  assert.equal(runner.stopTracesFor({ username: 'alice', chatId: 111, audience: 'default' }), 1);
  assert.ok(Number.isFinite(stopTrace.traceStoppedAt(mine)), 'свой диалог помечен');
  assert.equal(stopTrace.traceStoppedAt(other), null, 'другой диалог того же профиля не тронут (K4)');

  // Реестр живых ранов даёт координаты рана БЕЗ процесса (backoff/очередь) —
  // ровно тот случай, когда шлюз прислал только {username} (R1/R2).
  runner._liveRuns.set('probe#1', { username: 'alice', chatId: 333, threadId: null, audience: 'default', sessionId: 's-9', taskId: 'alice-retry-1' });
  assert.equal(runner.stopTracesFor({ username: 'alice', audience: 'default' }), 1,
    'профильный Стоп находит координаты рана без процесса через реестр');
  assert.ok(Number.isFinite(stopTrace.traceStoppedAt(trace(333))));
  assert.equal(runner.stopTracesFor({ username: 'bob', audience: 'default' }), 0, 'чужой профиль ничего не получает');
  runner._liveRuns.clear();
});

test('stopTracesFor: журнал pending-tasks даёт координаты после рестарта (K14)', () => {
  const pendingDir = path.join(process.env.AGENT_DATA_DIR, 'pending-tasks');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'alice-resume-1.json'), JSON.stringify({
    taskId: 'alice-resume-1', username: 'alice', userId: 555, threadId: null,
    audience: 'default', sessionId: 's-7', initiatedAt: Date.now() - 1000, phase: 'running',
  }));

  assert.equal(runner.stopTracesFor({ username: 'alice', audience: 'default' }), 1);
  assert.ok(Number.isFinite(stopTrace.traceStoppedAt(trace(555))),
    'тумбстоун ставится ДО рестарта — resume увидит его и не поднимет цепочку');
  assert.equal(runner.getPendingTasks().length, 1, 'журнал сам по себе не трогаем');
  fs.rmSync(path.join(pendingDir, 'alice-resume-1.json'), { force: true });
});

test('confirmStopped: true когда нечему выходить, false когда процесс жив по истечении waitMs', async () => {
  runner._activeTimers.clear();
  assert.equal(await runner.confirmStopped({ username: 'nobody', audience: 'default' }, 50), true);

  const state = { username: 'alice', audience: 'default', chatId: 42, threadId: null, proc: fakeProc() };
  runner._activeTimers.set('alice-1', state);
  assert.equal(await runner.confirmStopped({ username: 'alice', audience: 'default' }, 60), false,
    'живой процесс = подтвердить не удалось (SS-03)');
  state.proc.exitCode = 0;
  assert.equal(await runner.confirmStopped({ username: 'alice', audience: 'default' }, 60), true, 'процесс вышел → подтверждено');
  assert.equal(await runner.confirmStopped({ username: 'bob', audience: 'default' }, 60), true, 'чужой процесс нас не касается');
  runner._activeTimers.clear();
});

// ── 6. Контракты точек входа (source-contract, как в web-stop-before-spawn) ───

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('контракт: обе точки гейта на месте — до очереди и внутри admission', () => {
  const src = read('src/runner/index.js');
  const gate = /isRunStopped\(\{ traceId: runTrace, initiatedAt: opts\.initiatedAt, fromUser: opts\.fromUser \}\)/g;
  assert.equal((src.match(gate) || []).length, 2, 'ровно две проверки: до journal и в admission.run');
  assert.ok(src.indexOf('stop-gate: blocked before queue') < src.indexOf('// Journal BEFORE waiting'),
    'верхний гейт стоит ДО journal — иначе resume поднял бы остановленную цепочку');
  assert.ok(src.indexOf('stop-gate: blocked in admission queue') > src.indexOf('const current = admission.run('),
    'нижний гейт внутри admission — хоп, стоявший в очереди, не проспавнится (R2)');
  assert.ok(/timedOut && !sessionState\?\.userStopped/.test(src), 'R5: userStopped приоритетнее timedOut');
});

test('контракт: kill — везде через engine-stop, тумбстоун — на каждом явном Stop', () => {
  const src = read('src/runner/index.js');
  for (const fn of ['stopTask', 'stopUserTask', 'stopSessionTask', 'killTaskByUsername']) {
    const at = src.indexOf(`function ${fn}(`);
    assert.ok(at >= 0, `function ${fn} не найдена`);
    const next = src.indexOf('\nfunction ', at + 10);
    const body = src.slice(at, next < 0 ? undefined : next);
    assert.ok(/stopEngineProcess\(/.test(body), `${fn}: kill через slot-pkill, а не proc.kill (K3)`);
  }
  // Тумбстоун ставят только явные Stop-пути. stopUserTask/killTaskByUsername
  // зовут ещё wakeup/skip — их контракт «убить и дать очереди поехать дальше»,
  // поэтому отметка ЦЕПОЧКИ ставится на вызывающей стороне, не внутри kill.
  for (const fn of ['stopTask', 'stopSessionTask']) {
    const at = src.indexOf(`function ${fn}(`);
    const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
    assert.ok(/stopTracesFor\(/.test(body), `${fn} — самостоятельный Stop-API, обязан ставить тумбстоун (R1)`);
  }
  // Обе команды-Стоп в чате.
  for (const intent of ['STOP_TASK_INTENT.test', 'GTD_STOP_INTENT.test']) {
    const at = src.indexOf(intent);
    assert.ok(at >= 0, intent);
    const block = src.slice(at, src.indexOf('return Promise.resolve(msg);', at));
    assert.ok(/stopTracesFor\(/.test(block), `${intent}: набранный Стоп ставит тумбстоун`);
  }
  // wakeup/skip СОЗНАТЕЛЬНО без тумбстоуна.
  for (const intent of ['WAKEUP_INTENT.test', 'SKIP_TASK_INTENT.test']) {
    const at = src.indexOf(intent);
    const block = src.slice(at, src.indexOf('return Promise.resolve(msg);', at));
    assert.ok(!/stopTracesFor\(/.test(block), `${intent}: не закрывает цепочку — только kill`);
  }
  assert.ok(/timedOut && !sessionState\?\.userStopped/.test(src), 'R5: userStopped приоритетнее timedOut');
});

test('контракт: /tasks/stop отвечает аддитивно, /run помечен fromUser', () => {
  const server = read('src/server.js');
  const at = server.indexOf("url.pathname === '/tasks/stop'");
  const body = server.slice(at, server.indexOf("url.pathname === '/run'", at));
  assert.ok(body.includes('killed, stopped, stoppedTraces, gtdCancelled, confirmed'),
    'аддитивные поля, прежний killed не тронут (обратная совместимость с шлюзом)');
  assert.ok(/gtd\.clearGtdForChat\(/.test(body) && /gtd\.clearAllGtd\(/.test(body),
    'chatId → clearGtdForChat, иначе профильный clearAllGtd (R3)');
  assert.ok(/await confirmStopped\(owner, waitMs\)/.test(body), 'подтверждение выхода перед ответом (SS-03)');
  assert.ok(/fromUser: true, task: effectiveTask/.test(server), 'POST /run = fromUser → гейт его не блокирует (K1/SS-05)');
  assert.ok(/fromUser: true/.test(read('src/web-routes.js')), 'web-ран тоже fromUser');
});

test('контракт: GTD и durable закрывают запись на ответ остановки (R3/R4)', () => {
  const gtd = read('src/gtd-controller.js');
  assert.equal((gtd.match(/isUserStoppedReply\(/g) || []).length, 3,
    'три места: пре-проверка перед fire, .then() итерации, settleResumedGtd');
  assert.ok(/stoppedAt >= createdAt/.test(gtd), 'гейт до fire: rec.createdAt старше отметки Стопа → закрыть (R3)');

  const settleStart = gtd.indexOf('async function settleDurableReply(');
  const waitingAt = gtd.indexOf("if (lastDurableMarker(said) === 'waiting')", settleStart);
  const stopBlock = gtd.slice(settleStart, waitingAt);
  assert.ok(/isUserStoppedReply\(said\)/.test(stopBlock), 'settleDurableReply: проверка остановки раньше всех веток');
  assert.ok(/'USER_STOP'/.test(stopBlock) && /return;/.test(stopBlock), 'USER_STOP терминален');
  assert.ok(!/recoverDurableItem\(/.test(stopBlock), 'recovery не достигается (R4)');
});

test('контракт: stop-trace живёт на диске и наследует адресацию admission-лана', () => {
  const traceSrc = read('src/stop-trace.js');
  assert.ok(/stoppedTracesDir\(\)/.test(traceSrc), 'путь только через data-paths (не inline os.homedir)');
  assert.ok(/conversationKey\(ref\)/.test(traceSrc), 'TG-трейс = тот же ключ, что и admission-lane');
  assert.ok(/fail-open/i.test(traceSrc), 'fail-open задокументирован: заблокированный агент хуже одного ускользнувшего респавна');
  const dp = read('src/data-paths.js');
  assert.ok(/function stoppedTracesDir\(\)/.test(dp));
  assert.ok(!/stoppedChainsDir/.test(dp), 'chainId-ключи удалены вместе с реестром цепочек');
});
