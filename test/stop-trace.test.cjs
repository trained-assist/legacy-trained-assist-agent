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
process.env.STOP_ESCALATE_MS = '400';              // эскалация TERM→KILL: 5с по спеке, 400мс здесь (экспорт STOP_ESCALATE_MS остаётся дефолтом 5000)
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

// ── Среда §4: локальный Telegram-capture + фейковый claude на PATH ────────────
// Телеграм: send/edit в ветке остановки реально ходят в Bot API — на локальный
// capture, не на api.telegram.org (иначе ECONNREFUSED оборвал бы userStopped-ветку
// ДО записи частичного результата — SS-02). Порт фиксирован: TG_API читается из
// env при require модулей ниже.
const http = require('node:http');
const TG_CAPTURE_PORT = 18923;
process.env.TELEGRAM_API_URL = `http://127.0.0.1:${TG_CAPTURE_PORT}`;
let tgServer = null;
const tgReady = new Promise((resolve, reject) => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + Math.floor(Math.random() * 8000) } }));
    });
  });
  srv.listen(TG_CAPTURE_PORT, '127.0.0.1', () => { tgServer = srv; resolve(srv); });
  srv.on('error', reject);
});

// Фейковый claude: один диспетчер, режим в файле (ok | hang | crash0) — тесты
// переключают поведение движка, не переписывая бинарь. Каждый спавн пишет строку
// в spawns.log: «сколько раз реально стартовал движок» и есть наблюдаемая величина
// вместо sleep-угадайки. hang игнорирует TERM (trap '' — дети наследуют) и висит:
// Stop обязан добить группу эскалацией.
const BIN_DIR = path.join(ROOT, 'bin');
const MODE_DIR = path.join(ROOT, 'mode');
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.mkdirSync(MODE_DIR, { recursive: true });
fs.writeFileSync(path.join(MODE_DIR, 'mode'), 'ok');
fs.writeFileSync(path.join(BIN_DIR, 'claude'), `#!/bin/sh
echo x >> "${MODE_DIR}/spawns.log"
MODE=$(cat "${MODE_DIR}/mode" 2>/dev/null || echo ok)
case "$MODE" in
  hang)
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"работаю над отчётом"}],"stop_reason":"end_turn"}}'
    trap '' TERM
    sleep 300 &
    echo $! > "${MODE_DIR}/child.pid"
    echo $$ > "${MODE_DIR}/parent.pid"
    wait
    ;;
  crash0)
    exit 0
    ;;
  *)
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"готово"}],"stop_reason":"end_turn"}}'
    echo '{"type":"result","result":"готово","usage":{"input_tokens":5,"output_tokens":5}}'
    ;;
esac
`);
fs.chmodSync(path.join(BIN_DIR, 'claude'), 0o755);
process.env.PATH = `${BIN_DIR}${path.delimiter}${process.env.PATH}`;
// Явный путь, как в tests/runner-e2e.test.js: buildEngineCommand читает CLAUDE_BIN,
// и без него здесь может найтись настоящий claude — тест тогда уходит в реальный
// запуск (и виснет на нём), а spawns.log никогда не заполнится.
process.env.CLAUDE_BIN = path.join(BIN_DIR, 'claude');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const STOP_MSG = '⛔ Остановлено до начала выполнения.';
const stopTrace = require('../src/stop-trace');
const { stopEngineProcess, signalSlot, groupSignal, runAlive, leasedSlot, STOP_ESCALATE_MS } = require('../src/runner/engine-stop');
const { runEngineProcess } = require('../src/runner/claude-runner');
const gtdCtl = require('../src/gtd-controller');
const runner = require('../src/runner');

// Capture-сервер держит event loop открытым — закрываем после всех кейсов, иначе
// node --test не завершится (файл упадёт по таймауту runner'а, а не тестом).
after(() => new Promise(resolve => {
  if (!tgServer) return resolve();
  tgServer.closeAllConnections?.();
  tgServer.close(() => resolve());
}));

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
  assert.equal(escalate2, undefined, 'мёртвому процессу без аренды слота сигналить некому — таймер не ставится');
  assert.deepEqual(deadSignals, [], 'P4: слот мог уйти чужому рану — даже первый TERM не уходит');
  assert.equal(dead.killed, null, 'прямому ребёнку тоже ничего');
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
  assert.ok(/closeStoppedGtd\(/.test(body), 'GTD закрывается по предикату трейса (R3)');
  assert.ok(!/clearAllGtd\(/.test(body),
    'B1: профильный Стоп не закрывает доводки соседних чатов/ботов');
  assert.ok(/const stopped = killed > 0 \|\| idleRuns > 0 \|\| gtdCancelled > 0;/.test(body),
    'B2: запись отметки сама по себе не «остановлено»');
  assert.ok(/await confirmStopped\(owner, waitMs\)/.test(body), 'подтверждение выхода перед ответом (SS-03)');
  assert.ok(/fromUser: true, task: effectiveTask/.test(server), 'POST /run = fromUser → гейт его не блокирует (K1/SS-05)');
  assert.ok(/fromUser: true/.test(read('src/web-routes.js')), 'web-ран тоже fromUser');
});

test('контракт: GTD и durable закрывают запись на ответ остановки (R3/R4)', () => {
  const gtd = read('src/gtd-controller.js');
  assert.ok((gtd.match(/isUserStoppedReply\(/g) || []).length >= 3,
    'три места: пре-проверка перед fire, .then() итерации, settleResumedGtd');
  assert.ok(/stoppedAt >= createdAt/.test(gtd), 'гейт до fire: rec.createdAt старше отметки Стопа → закрыть (R3)');

  // Не якоримся на имени функции: main вынес тело durable-settle в
  // `_settleDurableReply`, а имя `settleDurableReply` оставил тонким wrapper'ом.
  // Важна сама ветка — она должна быть терминальной и не доходить до recovery.
  const at = gtd.indexOf('if (isUserStoppedReply(said)) {');
  assert.ok(at >= 0, 'durable-settle: проверка «ответ — остановка» есть');
  const ret = gtd.indexOf('return;', at);
  assert.ok(ret > at, 'ветка возвращает, не проваливаясь дальше');
  const win = gtd.slice(at, gtd.indexOf('}', ret) + 1);
  assert.ok(/'USER_STOP'/.test(win), 'помечаем USER_STOP (recovery-policy: terminal)');
  assert.ok(/return;/.test(win), 'досрочный выход — дальше ветка не идёт');
  assert.ok(!/recoverDurableItem\(/.test(win), 'recovery не достигается (R4)');
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

// ── 7. Ревью PR #1800: слот, «stopped», GTD соседей, дедлоки ─────────────────

const sigOf = argv => argv.find(a => /^-(TERM|KILL)$/.test(a));

test('P4: слот отдан (lease released) — pkill по слоту не уходит, только прямому ребёнку', () => {
  const signals = [];
  const proc = fakeProc();
  const state = { proc, slot: 'ta-agent-3', slotLease: { slot: 'ta-agent-3', released: true } };
  let escalate;
  stopEngineProcess(state, { exec: (_b, a) => signals.push(sigOf(a)), setTimeout: fn => { escalate = fn; return { unref() {} }; } });
  assert.deepEqual(signals, [], 'слот уже мог достаться чужому рану — ни TERM, ни KILL по нему');
  assert.equal(proc.killed, 'SIGTERM');
  escalate();
  assert.deepEqual(signals, [], 'и на эскалации тоже');
  assert.equal(proc.killed, 'SIGKILL');
});

test('P3: обёртка вышла, а слот ещё наш (ребёнок держит pipe) — эскалация добивает слот', () => {
  const signals = [];
  const proc = fakeProc(false);
  const lease = { slot: 'ta-agent-5', released: false };
  let escalate;
  const sent = stopEngineProcess({ proc, slotLease: lease }, { exec: (_b, a) => signals.push(sigOf(a)), setTimeout: fn => { escalate = fn; return { unref() {} }; } });
  assert.equal(sent, true);
  assert.deepEqual(signals, ['-TERM']);
  escalate();
  assert.deepEqual(signals, ['-TERM', '-KILL'], 'выживший в слоте ребёнок получает KILL, хотя обёртка мертва');
  assert.equal(proc.killed, null, 'мёртвой обёртке не сигналим');

  // lease отдан за эти 5с → KILL уже не наш
  const s2 = [];
  let esc2;
  const lease2 = { slot: 'ta-agent-6', released: false };
  stopEngineProcess({ proc: fakeProc(false), slotLease: lease2 }, { exec: (_b, a) => s2.push(sigOf(a)), setTimeout: fn => { esc2 = fn; return { unref() {} }; } });
  lease2.released = true;
  esc2();
  assert.deepEqual(s2, ['-TERM'], 'lease перепроверяется на момент эскалации');
});

test('P3: runAlive/confirmStopped смотрят на слот, а не на обёртку', async () => {
  const lease = { slot: 'ta-agent-7', released: false };
  const state = { username: 'carol', audience: 'default', chatId: 7, threadId: null, proc: fakeProc(false), slotLease: lease };
  assert.equal(leasedSlot(state), 'ta-agent-7');
  assert.equal(await runAlive(state, { hasProcesses: async () => true }), true, 'обёртка мертва, в слоте процессы → жив');
  assert.equal(await runAlive(state, { hasProcesses: async () => false }), false);
  lease.released = true;
  assert.equal(await runAlive(state, { hasProcesses: async () => { throw new Error('после release слот не опрашиваем'); } }), false);

  lease.released = false;
  runner._activeTimers.clear();
  runner._activeTimers.set('carol-1', state);
  assert.equal(await runner.confirmStopped({ username: 'carol', audience: 'default' }, 60, { runAlive: async () => true }), false,
    'в слоте остались процессы → «подтверждено» не говорим');
  assert.equal(await runner.confirmStopped({ username: 'carol', audience: 'default' }, 60, { runAlive: async () => false }), true);
  runner._activeTimers.clear();
});

test('B2: idle-раны считаются, раны с процессом и чужие — нет', () => {
  runner._liveRuns.clear(); runner._activeTimers.clear();
  const owner = { username: 'dave', audience: 'default', chatId: 900 };
  assert.equal(runner.countIdleLiveRuns(owner), 0, 'пустой чат → 0: «stopped» будет false');
  runner._liveRuns.set('dave-q#1', { username: 'dave', chatId: 900, threadId: null, audience: 'default', sessionId: null, taskId: 'dave-q' });
  assert.equal(runner.countIdleLiveRuns(owner), 1, 'ран в очереди/backoff без процесса');
  runner._activeTimers.set('dave-q', { username: 'dave', audience: 'default', chatId: 900, proc: fakeProc() });
  assert.equal(runner.countIdleLiveRuns(owner), 0, 'ран с процессом учтён в killed, не здесь');
  assert.equal(runner.countIdleLiveRuns({ username: 'dave', audience: 'default', chatId: 901 }), 0, 'другой чат');
  runner._liveRuns.clear(); runner._activeTimers.clear();
});

test('B1: closeStoppedGtd закрывает только доводки помеченных трейсов', () => {
  const wd = workDir('erin');
  const now = Date.now();
  const mk = (sessionId, chatId, createdAt) => gtdCtl.writeGtd(wd, {
    sessionId, chatId: String(chatId), threadId: null, username: 'erin', audience: 'default',
    createdAt, dueAt: now + 3600_000, etaMinutes: 60, iterations: 0, maxIterations: 5, status: 'open',
  });
  mk('s-erin-a', 7001, now - 60_000);
  mk('s-erin-b', 7002, now - 60_000);
  runner.stopTracesFor({ username: 'erin', chatId: 7001, audience: 'default' });
  assert.equal(gtdCtl.closeStoppedGtd(wd), 1, 'закрыта ровно одна');
  assert.equal(gtdCtl.readGtd(wd, 's-erin-a').closedReason, 'user-stop');
  assert.equal(gtdCtl.readGtd(wd, 's-erin-b').status, 'open', 'доводка соседнего чата жива (была бы убита clearAllGtd)');
  assert.equal(gtdCtl.closeStoppedGtd(wd), 0, 'идемпотентно');
});

test('D2: доводка, созданная ПОСЛЕ Стопа в том же диалоге, не считается остановленной', () => {
  const wd = workDir('erin');
  runner.stopTracesFor({ username: 'erin', chatId: 7003, audience: 'default' });
  const rec = {
    sessionId: 's-erin-c', chatId: '7003', threadId: null, username: 'erin', audience: 'default',
    createdAt: Date.now() + 5, dueAt: Date.now() + 3600_000, status: 'open',
  };
  assert.equal(gtdCtl.isGtdStopped(wd, rec), false, 'новая задача юзера после Стопа (K1) доводится');
  assert.equal(gtdCtl.isGtdStopped(wd, { ...rec, createdAt: Date.now() - 60_000 }), true);
  const src = read('src/gtd-controller.js');
  assert.equal((src.match(/!closeIfStopped\(workDir, (r|existing)\)/g) || []).length, 4,
    'все 4 места «уже есть open-запись» пропускают приговорённую Стопом запись, а не возвращают её');
});

test('D1: сообщение, отправленное до Стопа, но принятое после — его хопы не блокируются', async () => {
  const wd = workDir('frank');
  const t = trace(8080, 'frank');
  assert.equal(stopTrace.markTraceStopped(t, { username: 'frank', chatId: 8080 }), true);
  const stoppedAt = stopTrace.traceStoppedAt(t);
  // Не спавнить движок: consumePendingStop отвечает до спавна (как в контрольном кейсе выше).
  runner._queuedByOwner.set(runner._ownerKey('frank', 's-d1'), 1);
  runner.stopSessionTask('frank', 's-d1');
  const p = runner.runTask({
    taskId: 'frank-held-1',
    user: { id: 8080, name: 'frank', username: 'frank', workDir: wd },
    task: 'ещё вот это', context: null, sessionId: 's-d1',
    fromUser: true,
    // шлюз: msg.date*1000 — время отправки, floor до секунды, раньше отметки
    initiatedAt: Math.floor((stoppedAt - 1500) / 1000) * 1000,
    secrets: {}, initialMsgId: null,
  });
  const journaled = runner.getPendingTasks().find(x => x.taskId === 'frank-held-1');
  assert.ok(journaled, 'запрос человека проходит гейт');
  assert.ok(journaled.initiatedAt > stoppedAt, 'якорь цепочки = приём агентом, не время отправки');
  assert.equal(stopTrace.isRunStopped({ traceId: t, initiatedAt: journaled.initiatedAt, fromUser: false }), false,
    'ретрай/продолжение/резюм этой задачи (fromUser не наследуется) не умрёт на первом хопе');
  await p;
  runner._queuedByOwner.clear();
});

test('D1: ран без fromUser и без конфликта initiatedAt не трогает', () => {
  const src = read('src/runner/index.js');
  const at = src.indexOf('if (opts.fromUser && runTrace && Number.isFinite(opts.initiatedAt))');
  assert.ok(at > 0 && at < src.indexOf('// Journal BEFORE waiting'), 're-anchor стоит ДО журнала');
  assert.ok(src.slice(at, at + 400).includes('opts.initiatedAt <= stoppedAt'), 'двигаем только при реальном конфликте');
});

test('тумбстоун пишется атомарно (битый файл читается fail-closed)', () => {
  const src = read('src/stop-trace.js');
  assert.ok(!/fs\.writeFileSync\(/.test(src), 'никаких неатомарных записей отметки');
  assert.ok((src.match(/atomicJson\(/g) || []).length >= 2);
  assert.ok(!/execFileSync/.test(read('src/runner/engine-stop.js').replace(/\/\/.*$/gm, '')),
    'D5: Стоп не блокирует event loop синхронным sudo');
});

test('D3: хоп, снятый гейтом в очереди, гасит pending-stop сессии (контракт)', () => {
  // Поведенчески: A (хоп) в очереди → Стоп (pending-stop + отметка) → B (новое
  // сообщение ПОСЛЕ Стопа) встаёт за A. A снимается гейтом; если он не погасит
  // pending-stop, его «съест» B и умрёт «до начала выполнения». Спавн B в юнит-
  // тесте не поднять без движка, поэтому фиксируем контракт нижнего гейта.
  const src = read('src/runner/index.js');
  const at = src.indexOf('stop-gate: blocked in admission queue');
  const block = src.slice(at, src.indexOf('return STOP_NOT_STARTED_MSG;', at));
  assert.ok(/consumePendingStop\(opts\.user\.username, opts\.sessionId\);/.test(block),
    'нижний гейт гасит pending-stop сессии');
});

// ── 8. §4 e2e через реальный вход: kill группы, R1, R2, K14, SS-02 ─────────────
// Правило §4: вход через реальную точку (runTask / stop-функции / engine-stop),
// наблюдаем процессы и спавны (spawns.log, kill(pid,0)), без sleep-угадайки:
// все ожидания — условные (until), таймеры — захваченные руками, где нужно.

async function until(fn, { timeout = 20_000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* keep polling */ }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise(r => setTimeout(r, interval));
  }
}
const spawnCount = () => {
  try { return fs.readFileSync(path.join(MODE_DIR, 'spawns.log'), 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
};
const resetSpawns = () => { try { fs.rmSync(path.join(MODE_DIR, 'spawns.log'), { force: true }); } catch { /* ok */ } };
const setMode = m => fs.writeFileSync(path.join(MODE_DIR, 'mode'), m);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); t.unref?.(); }),
]);
const killPid = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } };

test('SS-01: реальное дерево — TERM игнорируется, эскалация KILL убивает группу, дети мертвы', async () => {
  // Фейковый движок в собственной группе (detached, как claude-runner): trap '' TERM
  // наследуется детьми — прямой SIGTERM его не берёт, а группа должна упасть от KILL
  // на эскалации (spec §4 case 1: «все дети мертвы»).
  const stubborn = path.join(ROOT, 'stubborn-engine.sh');
  fs.writeFileSync(stubborn, `#!/bin/sh
trap '' TERM
sleep 300 &
echo $! > "${MODE_DIR}/child.pid"
echo $$ > "${MODE_DIR}/parent.pid"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"работаю"}],"stop_reason":"end_turn"}}'
wait
`);
  fs.chmodSync(stubborn, 0o755);
  const activeTimers = new Map();
  const engineDone = runEngineProcess({
    engine: 'claude', taskId: 'alice-group-1', chatId: '4242', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: null, secrets: {}, user: { username: 'alice', workDir: ROOT, name: 'Alice' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers,
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }),
    outputCallback: null, engineBin: stubborn, engineArgs: [], cwd: ROOT,
  });
  let parent = null; let child = null;
  try {
    const state = await until(
      () => (fs.existsSync(path.join(MODE_DIR, 'parent.pid')) && [...activeTimers.values()][0]) || null,
      { label: 'engine spawned' },
    );
    parent = Number(fs.readFileSync(path.join(MODE_DIR, 'parent.pid'), 'utf8').trim());
    child = Number(fs.readFileSync(path.join(MODE_DIR, 'child.pid'), 'utf8').trim());
    assert.equal(state.pgid, state.proc.pid, 'детач-спавн: pgid = pid ребёнка (своя группа процессов)');
    assert.ok(alive(parent) && alive(child), 'и движок, и его ребёнок живы до Стопа');

    assert.equal(stopEngineProcess(state), true, 'Стоп отправил сигнал');
    // TERM оба игнорируют (trap '' / унаследовано) — живы прямо ПОСЛЕ сигнала:
    // если бы группового KILL не было, они живы были бы и через 5с.
    assert.ok(alive(parent) && alive(child), 'TERM пережит — эскалация обязательна');
    const res = await withTimeout(engineDone, 15_000, 'engine exit after escalation');
    assert.equal(res.sessionState.userStopped, true, 'R5: close не уходит в автопродолжение');
    await until(() => !alive(parent) && !alive(child), { label: 'group SIGKILL landed' });
  } finally {
    killPid(parent); killPid(child);
    try { fs.rmSync(path.join(MODE_DIR, 'parent.pid'), { force: true }); } catch { /* ok */ }
    try { fs.rmSync(path.join(MODE_DIR, 'child.pid'), { force: true }); } catch { /* ok */ }
  }
});

test('R1: движок упал → retry ждёт backoff → Стоп → таймер стреляет, но спавна нет', async () => {
  // Настоящие глобальные таймеры подменяются только для backoff-окна (30с в
  // не-TEST_MODE): уwarn/kill таймеров те же десятки минут, у retry — ровно
  // getRetryDelayMs(1). Стоп ставится ДО ручного вызова «стрельнувшего» таймера —
  // ровно как в проде, где он стреляет сам уже после отметки.
  await tgReady;
  setMode('crash0'); resetSpawns();
  const wd = workDir('lena');
  const realSetTimeout = global.setTimeout;
  const captured = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (Number(ms) >= 25_000 && Number(ms) < 60_000) { captured.push({ fn, ms }); return { unref() {} }; }
    return realSetTimeout(fn, ms, ...args);
  };
  try {
    const p = runner.runTask({
      taskId: 'lena-r1-1',
      user: { id: 6060, name: 'lena', username: 'lena', workDir: wd },
      task: 'сделай отчёт', context: null,
      initiatedAt: Date.now() - 1000,
      engine: 'claude', secrets: {}, initialMsgId: null,
    });
    const retryTimer = await until(() => captured.find(c => c.ms === 30_000) || null,
      { label: 'retry backoff timer scheduled' });
    assert.equal(spawnCount(), 1, 'один спавн: движок упал без подтверждённого ответа');
    // Ран в backoff'е виден Стопу как idle (без процесса) — координаты берёт реестр.
    assert.equal(runner.countIdleLiveRuns({ username: 'lena', chatId: 6060, audience: 'default' }), 1,
      'R1: backoff-ран без процесса находится через liveRuns');
    runner.stopTracesFor({ username: 'lena', chatId: 6060, audience: 'default' });
    retryTimer.fn(); // таймер стреляет ПОСЛЕ Стопа — как он стрельнул бы сам
    assert.equal(await withTimeout(p, 15_000, 'retry hop settles'), STOP_MSG,
      'хоп снят гейтом до журнала и до спавна');
    assert.equal(spawnCount(), 1, 'ретрай не заспавнил новый движок (R1 закрыт)');
  } finally {
    global.setTimeout = realSetTimeout;
    // Оборонительный kill: если до Стопа не дошли — не оставляем движок висеть
    // (иначе node --test не завершится: warn/kill-таймеры на 38/40 минут).
    runner.stopUserTask('lena', 6060, 'default', null);
    setMode('ok'); resetSpawns();
  }
});

test('R2: хоп стоит в admission, когда пришёл Стоп → хоп не стартует', async () => {
  await tgReady;
  setMode('hang'); resetSpawns();
  const wd = workDir('mira');
  const a = runner.runTask({
    taskId: 'mira-a',
    user: { id: 7070, name: 'mira', username: 'mira', workDir: wd },
    task: 'длинная работа', context: null, sessionId: 's-mira-a',
    initiatedAt: Date.now() - 5000, engine: 'claude', secrets: {}, initialMsgId: null,
  });
  let b = null;
  try {
    await until(() => spawnCount() >= 1, { label: 'A spawned' });
    // B той же ленты диалога: верхний гейт проходит (Стопа ещё нет), журнал
    // пишется ДО очереди — дальше B стоит в admission за A.
    b = runner.runTask({
      taskId: 'mira-b',
      user: { id: 7070, name: 'mira', username: 'mira', workDir: wd },
      task: 'вторая задача', context: null, sessionId: 's-mira-b',
      initiatedAt: Date.now() - 3000, engine: 'claude', secrets: {}, initialMsgId: null,
    });
    await until(() => runner.getPendingTasks().some(x => x.taskId === 'mira-b'),
      { label: 'B journaled (upper gate passed)' });
    // Композиция POST /tasks/stop: kill живого + тумбстоун диалога.
    runner.stopUserTask('mira', 7070, 'default', null);
    runner.stopTracesFor({ username: 'mira', chatId: 7070, audience: 'default' });

    assert.equal(await withTimeout(b, 20_000, 'B settles'), STOP_MSG,
      'хоп, стоявший в admission, снят нижним гейтом (R2)');
    assert.equal(spawnCount(), 1, 'B не заспавнился — движок стартовал только у A');
    await withTimeout(a, 20_000, 'A settles');
  } finally {
    runner.stopUserTask('mira', 7070, 'default', null);
    if (b) await Promise.allSettled([Promise.race([a, new Promise(r => setTimeout(r, 3000))]), Promise.race([b, new Promise(r => setTimeout(r, 3000))])]);
    setMode('ok'); resetSpawns();
  }
});

test('K14: рестарт — новый инстанс runner на том же data-dir не поднимает остановленную цепочку', async () => {
  const wd = workDir('grace');
  // 1) Стоп ДО «рестарта»: отметка лежит на диске (K14 — тумбстоун переживает рестарт).
  const t = trace(5551, 'grace');
  assert.equal(stopTrace.markTraceStopped(t, { username: 'grace', chatId: 5551 }), true);
  const stoppedAt = stopTrace.traceStoppedAt(t);
  // 2) Журнал, который resumePendingTasks передал бы в runTask (server.js: resume
  //    наследует initiatedAt из журнала и зовёт тот же runTask — гейт живёт в нём).
  const pendingDir = path.join(process.env.AGENT_DATA_DIR, 'pending-tasks');
  fs.mkdirSync(pendingDir, { recursive: true });
  const journalFile = path.join(pendingDir, 'grace-resume-1.json');
  fs.writeFileSync(journalFile, JSON.stringify({
    taskId: 'grace-resume-1', username: 'grace', userId: 5551, threadId: null,
    audience: 'default', sessionId: 's-grace', initiatedAt: stoppedAt - 5000,
    startedAt: Date.now() - 60_000, task: 'прерванная задача', phase: 'running',
  }));
  // 3) «Новый процесс»: чистый инстанс runner (модули стёрты из require.cache),
  //    те же data-dir и тумбстоун на диске — никакого in-memory состояния.
  for (const key of Object.keys(require.cache)) if (key.includes('/src/runner/')) delete require.cache[key];
  const fresh = require('../src/runner');
  try {
    const p = fresh.runTask({
      taskId: 'grace-resume-2',
      user: { id: 5551, name: 'grace', username: 'grace', workDir: wd },
      task: 'прерванная задача', context: null, sessionId: 's-grace',
      resumedAfterRestart: true, resumeAttempts: 1,
      initiatedAt: stoppedAt - 5000, // наследуется из журнала — то, что читает resume
      secrets: {}, initialMsgId: null,
    });
    assert.equal(await withTimeout(p, 15_000, 'fresh-instance resume hop'), STOP_MSG,
      'после рестарта resume-хоп снимается гейтом по дисковой отметке');
    assert.ok(!fresh.getPendingTasks().some(x => x.taskId === 'grace-resume-2'),
      'остановленная цепочка не журналируется — resume не поднимет её в следующий раз');
  } finally {
    fs.rmSync(journalFile, { force: true });
  }
});

test('SS-02: частичный результат в сессии, статус CANCELLED, ответ «Что успел»', async () => {
  await tgReady;
  setMode('hang'); resetSpawns();
  const wd = workDir('ivan');
  let out = '';
  const p = runner.runTask({
    taskId: 'ivan-ss02-1',
    user: { id: 9090, name: 'ivan', username: 'ivan', workDir: wd },
    task: 'сделай отчёт', context: null, sessionId: 's-ivan-02',
    initiatedAt: Date.now() - 5000, engine: 'claude', secrets: {}, initialMsgId: null,
    outputCallback: t => { out += t; },
  });
  try {
    await until(() => out.includes('работаю над отчётом'), { label: 'partial output streamed' });
    // Композиция POST /tasks/stop, что и в проде: kill + тумбстоун диалога.
    assert.equal(runner.stopUserTask('ivan', 9090, 'default', null), true, 'процесс остановлен');
    runner.stopTracesFor({ username: 'ivan', chatId: 9090, audience: 'default' });

    const res = await withTimeout(p, 20_000, 'stopped run settles');
    assert.match(String(res), /^⛔ Остановлено\. Что успел:/,
      'SS-02: прогресс-сообщение по спеке, а не голое «Остановлено»');

    const sess = JSON.parse(fs.readFileSync(path.join(wd, 'sessions', 's-ivan-02.json'), 'utf8'));
    const last = sess.messages[sess.messages.length - 1];
    assert.equal(last.role, 'assistant', 'последняя запись — ответ агента');
    assert.match(last.content, /^\[остановлено пользователем\]/, 'маркер остановки в истории');
    assert.ok(last.content.includes('работаю над отчётом'), 'последний связный ход сохранён, файлы/история не откатываются');

    const histDir = path.join(process.env.AGENT_DATA_DIR, 'execution-history');
    const cancelled = fs.readdirSync(histDir)
      .map(f => fs.readFileSync(path.join(histDir, f), 'utf8'))
      .filter(s => s.includes('"CANCELLED"') && s.includes('ivan-ss02-1'));
    assert.equal(cancelled.length, 1, 'исполнение финализировано как CANCELLED (SS-02)');

    assert.equal(spawnCount(), 1, 'R5: после Стопа нет автопродолжения');
  } finally {
    runner.stopUserTask('ivan', 9090, 'default', null);
    setMode('ok'); resetSpawns();
  }
});

test('контракт: SS-01 группа процессов, SS-02 формулировки, SS-03 окно+метрика', () => {
  const runnerSrc = read('src/runner/claude-runner.js');
  assert.ok(/detached: true/.test(runnerSrc), 'SS-01: движок спавнится в своей группе процессов');
  assert.ok(/pgid: proc\.pid/.test(runnerSrc), 'SS-01: pgid группы кладётся в sessionState');
  const stopSrc = read('src/runner/engine-stop.js');
  assert.ok(/function groupSignal\(/.test(stopSrc), 'SS-01: kill группы — отдельный примитив');
  assert.ok(/SIGKILL/.test(stopSrc) && /group\(pgid, 'SIGKILL'\)/.test(stopSrc), 'эскалация бьёт и по группе');
  const src = read('src/runner/index.js');
  assert.ok(src.includes('⛔ Остановлено. Что успел:'), 'SS-02: «Что успел» вместо голого «Остановлено»');
  assert.ok(src.includes('⛔ Остановлено до начала работы.'), 'SS-02: без связного хода — честно «до начала работы»');
  const server = read('src/server.js');
  assert.ok((server.match(/stop_unconfirmed/g) || []).length >= 2,
    'K11: метрика stop_unconfirmed в /tasks/stop и /tasks/supplement');
  assert.ok(/Math\.min\(Math\.max\(rawWaitMs, 0\), 10000\)/.test(server),
    'SS-03: окно подтверждения расширено до 10с по спеке (было 4500, спека требует 10с)');
});
