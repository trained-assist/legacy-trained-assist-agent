'use strict';
// Фантомная веб-сессия (репорт владельца 29.09.2026 10:14 МСК, профиль mbk_luda_recruiter):
// id s-web-1790665749936-6de89430 (минт 10:09:09 МСК) отдан клиенту, но на диске его не было:
// POST /web/session-get → 404 {"error":"session not found"}; POST /web/reply-bearer → 404
// (src/handlers/web.js:427 и :267 — оба смотрят getSessionFor → файл на диске).
//
// Окно фантома: /web/run-bearer минтит id ДО прогона (handlers/web.js:382) и сразу пишет в
// receipt, streamWebTask шлёт SSE {type:'session'} до runTask (web-routes.js:435), а файл
// сессии создаётся только внутри _runTask — deferred: admission → очередь → quick-answer →
// createSession (runner/index.js:2102/2139). Рестарт assist-agent 10:13 МСК убил прогон в
// этом окне → в браузере ссылка осталась, на диске пусто (в списке 31 сессии её нет).
//
// ИНВАРИАНТ (R5-воспроизведение): любой id, отданный клиенту (событие 'session' или 'done'),
// обязан читаться с диска в момент выдачи И после «рестарта» (свежие модули, память пуста).
// Красный today: runTask молча умирает/проглатывается → id отдан, файла нет → 404.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// Загружает web-routes с подменённым runner.runTask и чистым профилем в tmp.
// Повторяет харнесс test/web-run-honest-done.test.cjs.
function loadStream(runTaskImpl) {
  process.env.WEB_CONVREF_CANARY = 'web-canary'; // exact-session path (canary on)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-durab-'));
  process.env.HOME = tmp;
  process.env.USERS_DIR = path.join(tmp, 'users');
  process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
  fs.mkdirSync(path.join(tmp, 'users', 'web-canary'), { recursive: true });
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store|runner(\/index)?)\.js$/.test(key)) delete require.cache[key];
  }
  const runnerPath = require.resolve('../src/runner');
  require.cache[runnerPath] = { id: runnerPath, filename: runnerPath, loaded: true,
    exports: { runTask: runTaskImpl, isSessionRunning: () => false, stopSessionTask: () => false } };
  return require('../src/web-routes');
}

// «Рестарт»: новая процесс-модель читает только диск — все модули состояния перезагружены.
function simulateRestart() {
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store)\.js$/.test(key)) delete require.cache[key];
  }
  return require('../src/web-routes');
}

async function drive(streamWebTask, extra = {}) {
  const req = new EventEmitter();
  let body = '';
  const res = { writeHead() {}, write(s) { body += s; }, end() { res.ended = true; } };
  streamWebTask({ req, res, secrets: {}, username: 'web-canary', task: 'hi', sessionId: null, ...extra });
  for (let i = 0; i < 50 && !res.ended; i++) await new Promise(r => setTimeout(r, 10));
  // «Клиент отключился»: снимает SSE-ping (clearInterval), иначе «убитый» runTask
  // (new Promise(() => {})) держит event loop живым и процесс не завершается.
  req.emit('close');
  return body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}

// Все id, которые клиент реально увидел (событие 'session' и 'done').
function idsSeenByClient(events) {
  const ids = [];
  for (const e of events) {
    if ((e.type === 'session' || e.type === 'done') && e.sessionId) ids.push(e.sessionId);
  }
  return [...new Set(ids)];
}

test('kill mid-run: отданный клиенту id читается с диска и после рестарта', async () => {
  // runTask «убит»: никогда не резолвится и ничего не пишет — как процесс при рестарте 10:13.
  const { streamWebTask, getSessionFor } = loadStream(() => new Promise(() => {}));
  const events = await drive(streamWebTask);
  const ids = idsSeenByClient(events);
  if (!ids.length) return; // id не выдавался — фантом невозможен (допустимый фикс)

  for (const id of ids) {
    assert.ok(getSessionFor('web-canary', id),
      `id ${id} отдан клиенту (событие session), но /web/session-get ответит 404 — фантом`);
  }
  const after = simulateRestart(); // новый процесс: память пуста, только диск
  for (const id of ids) {
    assert.ok(after.getSessionFor('web-canary', id),
      `id ${id} потерян после рестарта — ровно прод-инцидент 29.09 (session not found)`);
  }
});

test('проглоченный admission (runTask → undefined, ничего не персистит): id не должен 404нить', async () => {
  const { streamWebTask } = loadStream(async () => undefined);
  const events = await drive(streamWebTask);
  assert.equal(events.at(-1).type, 'error', 'согласованное поведение: без ответа → error');
  const ids = idsSeenByClient(events);
  if (!ids.length) return;

  const after = simulateRestart();
  for (const id of ids) {
    assert.ok(after.getSessionFor('web-canary', id),
      `id ${id} отдан клиенту, но после рестарта /web/reply-bearer даст «session not found»`);
  }
});

test('контроль: успешный прогон — id из done читается с диска (инвариант и так держится)', async () => {
  const { streamWebTask } = loadStream(async (o) => {
    const ss = require('../src/session-store');
    ss.createSession(o.user.workDir, { task: 'hi', id: o.sessionId });
    ss.appendReply(o.user.workDir, o.sessionId, 'ответ');
    return 'ответ';
  });
  const events = await drive(streamWebTask);
  assert.equal(events.at(-1).type, 'done');
  const ids = idsSeenByClient(events);
  assert.ok(ids.length, 'успешный run обязан отдать клиенту session id');
  const after = simulateRestart();
  for (const id of ids) {
    assert.ok(after.getSessionFor('web-canary', id), `успешный id ${id} не читается после рестарта`);
  }
});
