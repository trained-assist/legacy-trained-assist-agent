#!/usr/bin/env node
'use strict';

// Песочница среза S1 (эпик #1851, issue #1878): замкнутый цикл «изменил → увидел
// результат» для сценария LB-01…LB-05 «проверить фичу на живом боте из сессии».
//
// Запуск (одна команда, детерминированный pass/fail, код выхода 0/1):
//   node scripts/sandbox/live-qa-check.cjs
//
// Уровень S5: поднимаем всё локально за секунды, внешние зависимости — фейки:
//   • journal (journalctl)  → подмена child_process, фикстура в temp;
//   • шлюз /health          → локальный stub-сервер (GATEWAY_HEALTH_URL);
//   • агент /health         → локальный stub-сервер (PORT = 127.0.0.1:<port>/health);
//   • движок (runTask)      → streamWebTask замокан, но пишет РЕАЛЬНЫЙ файл сессии
//     через session-store, чтобы qa_trace читал настоящий путь чтения.
// Реальный код, который проверяем: диспетчер server.js (порядок cookie-роутинга),
// src/handlers/web.js (маршрут /web/qa-bearer), src/handlers/qa-live.js,
// src/mcp-skills/tools/103-qa-live.js (инструменты), лимиты/вывод секретов.
//
// Сейчас обязан ПАДАТЬ по правильной причине: фичи S1b/S1c ещё нет.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { execSync } = cp;

const repoRoot = path.resolve(__dirname, '..', '..');
const STARTED = Date.now();
const results = [];

function step(id, title, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ id, title, ok: true, detail: detail || 'ok' }); })
    .catch((e) => { results.push({ id, title, ok: false, detail: (e && e.message) || String(e) }); });
}

const fail = (msg) => { throw new Error(msg); };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function parseSse(text) {
  const events = [];
  const re = /data:\s*(\{[^\n]*\})/g;
  let m;
  while ((m = re.exec(text))) {
    try { events.push(JSON.parse(m[1])); } catch { /* ignore partial */ }
  }
  return events;
}

async function main() {
  // ── 0. Изолированное окружение (temp HOME/AGENT_DATA_DIR/USERS_DIR) ────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-qa-'));
  const dataDir = path.join(tmp, 'agent-data');
  const usersDir = path.join(tmp, 'users');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(usersDir, { recursive: true });
  process.env.HOME = tmp;
  // Слот запущен не от владельца репо → git ругается на dubious ownership.
  // Глобальный конфиг резолвится от HOME, поэтому кладём свой с safe.directory.
  fs.writeFileSync(path.join(tmp, '.gitconfig'), '[safe]\n\tdirectory = *\n[user]\n\tname = sandbox\n\temail = sandbox@local\n');
  process.env.AGENT_DATA_DIR = dataDir;
  process.env.USERS_DIR = usersDir;
  process.env.NODE_ENV = 'test';
  delete process.env.WEB_VERIFY_SECRET;
  process.env.AGENT_GIT_DIR = repoRoot;
  process.env.WEB_CONVREF_CANARY = 'qa-sandboxuser,qa-sandboxtool';

  const SECRET = `sandbox-secret-${process.pid}`;
  process.env.AGENT_SECRET = SECRET;
  process.env.USER_ID = 'sandboxuser';
  process.env.WEB_JWT_SECRET = process.env.WEB_JWT_SECRET || 'sandbox-jwt';

  const head = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();

  // ── 1. Фейк журнала: journalctl → фикстура, всё остальное — по-настоящему ─
  const journalFile = path.join(tmp, 'journal.txt');
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.writeFileSync(journalFile, `${stamp} vm assist-agent[1]: ERROR sandbox-fixture error-line\n`);
  const appendJournal = (line) => fs.appendFileSync(journalFile, `${line}\n`);
  const journalOut = () => fs.readFileSync(journalFile, 'utf8');

  const isJournal = (...parts) => parts.flat().join(' ').includes('journalctl');
  const orig = {
    exec: cp.exec, execSync: cp.execSync,
    execFile: cp.execFile, execFileSync: cp.execFileSync,
    spawn: cp.spawn, spawnSync: cp.spawnSync,
  };
  cp.execSync = function (cmd, opt) {
    if (isJournal(cmd)) return Buffer.from(journalOut());
    return orig.execSync.apply(this, arguments);
  };
  cp.exec = function (cmd, opt, cb) {
    if (isJournal(cmd)) {
      const done = typeof opt === 'function' ? opt : cb;
      const out = journalOut();
      if (done) process.nextTick(() => done(null, out, ''));
      return { stdout: out };
    }
    return orig.exec.apply(this, arguments);
  };
  cp.execFileSync = function (file, args) {
    if (isJournal(file, args)) return Buffer.from(journalOut());
    return orig.execFileSync.apply(this, arguments);
  };
  cp.execFile = function (file, args, opt, cb) {
    if (isJournal(file, args)) {
      const done = typeof opt === 'function' ? opt : cb;
      const out = journalOut();
      if (done) process.nextTick(() => done(null, out, ''));
      return { stdout: out };
    }
    return orig.execFile.apply(this, arguments);
  };
  cp.spawnSync = function (file, args) {
    if (isJournal(file, args)) {
      return { stdout: Buffer.from(journalOut()), stderr: Buffer.from(''), status: 0, signal: null, error: null, pid: process.pid };
    }
    return orig.spawnSync.apply(this, arguments);
  };
  cp.spawn = function (file, args) {
    if (isJournal(file, args)) {
      const { EventEmitter } = require('events');
      const { PassThrough } = require('stream');
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.write(journalOut());
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    }
    return orig.spawn.apply(this, arguments);
  };

  // ── 2. Stub-серверы: агент /health и шлюз /health ─────────────────────────
  const jsonStub = (payload) => http.createServer((req, res) => {
    if (String(req.url).includes('health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
  const agentPort = await listen(jsonStub({ commit: head, fullSha: head, uptime: 12.5, vm: 'sandbox' }));
  process.env.PORT = String(agentPort);
  const gwPort = await listen(jsonStub({ status: 'ok', buildSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }));
  process.env.GATEWAY_HEALTH_URL = `http://127.0.0.1:${gwPort}/health`;

  // ── 3. Реальный диспетчер: порядок cookie-роутинга берём из server.js ─────
  const serverSrc = fs.readFileSync(path.join(repoRoot, 'src', 'server.js'), 'utf8');
  const from = serverSrc.indexOf("url.pathname.startsWith('/web/')");
  const to = serverSrc.indexOf('handleWebRoute(req, url, res, secrets)');
  if (from < 0 || to < 0 || to < from) fail('не удалось разобрать блок /web/* в src/server.js — песочница устарела');
  const block = serverSrc.slice(from, to);
  const exempt = new Set(Array.from(block.matchAll(/!== '(\/web\/[^']+)'/g), (m) => m[1]));
  if (exempt.size < 10) fail(`из server.js извлечено только ${exempt.size} исключений — разбор сломался`);

  const { handleWeb } = require(path.join(repoRoot, 'src', 'handlers', 'web.js'));
  const wr = require(path.join(repoRoot, 'src', 'web-routes.js'));
  const store = require(path.join(repoRoot, 'src', 'session-store.js'));
  const { userWorkDir } = require(path.join(repoRoot, 'src', 'data-paths.js'));

  // ── 4. Фейк движка: streamWebTask → реальная запись сессии + SSE ──────────
  const ANSWER = 'Sandbox-ответ: проверка живого бота.';
  const captured = [];
  const sessionIds = [];
  wr.streamWebTask = async function sandboxStream({ res, username, task, sessionId, newSessionId }) {
    const id = sessionId || newSessionId || `s-web-${Date.now()}-feedbabe`;
    captured.push({ username, task, id });
    sessionIds.push(id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* gone */ } };
    send({ type: 'session', sessionId: id });
    const wd = userWorkDir(username);
    store.createSession(wd, { task, id, chatId: null });
    store.appendReply(wd, id, ANSWER);
    send({ type: 'chunk', text: ANSWER });
    send({ type: 'done', sessionId: id });
    appendJournal(
      `[buttons] session=${id} internalGtd=false reason=none textLen=${ANSWER.length} ` +
      `attached=["Проверка"] callbacks=[{"t":"Проверка","c":"cb:demo"}]`
    );
    try { res.end(); } catch { /* gone */ }
    return undefined;
  };

  // Декой-сессия чужого профиля — для проверки скоупа trace.
  const DECOY_OWNER = 'realperson';
  const DECOY_ID = 's-web-999-decoyowner';
  store.createSession(userWorkDir(DECOY_OWNER), { task: 'чужая сессия', id: DECOY_ID, chatId: null });
  appendJournal(`[buttons] session=${DECOY_ID} internalGtd=false reason=none textLen=3 attached=["Чужая"] callbacks=[]`);
  fs.mkdirSync(path.join(dataDir, 'execution-history'), { recursive: true });

  // ── 5. HTTP-харнесс: те же два вызова, что и server.js ────────────────────
  let lastCookieRouted = false;
  const harness = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const secrets = { AGENT_SECRET: SECRET };
      if (url.pathname.startsWith('/web/') && !exempt.has(url.pathname)) {
        const took = await wr.handleWebRoute(req, url, res, secrets);
        if (took === true || res.writableEnded) { lastCookieRouted = true; return; }
      }
      const handled = await handleWeb(req, url, res, { secrets });
      if (handled !== false) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); } catch { /* ignore */ }
    }
  });
  const base = `http://127.0.0.1:${await listen(harness)}`;

  const raw = [];
  async function post(payload, { bearer = true } = {}) {
    const r = await fetch(`${base}/web/qa-bearer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${SECRET}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    raw.push(text);
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: r.status, text, json };
  }

  const CALLER = 'sandboxuser';
  const qaProfile = path.join(usersDir, `qa-${CALLER}`);
  let sessionId = null;

  // ── LOOP: самопроверка песочницы (иначе красное может быть из-за неё) ─────
  await step('LOOP', 'харнесс: фейк журнала + SSE-парсер + диспетчер доходят', async () => {
    const out = cp.execSync('sudo -n journalctl -u assist-agent --since @0 -o cat --no-pager').toString();
    if (!out.includes('sandbox-fixture error-line')) fail('фейк journalctl не подхватился — подмена child_process не работает');
    const probe = { buf: '' };
    await wr.streamWebTask({
      req: { on() {} },
      res: { writeHead() {}, write: (s) => { probe.buf += String(s); }, end() {} },
      secrets: { AGENT_SECRET: SECRET },
      username: `qa-${CALLER}`,
      task: 'проба харнесса',
      sessionId: null,
      newSessionId: `s-web-${Date.now()}-probeprob`,
    });
    const ev = parseSse(probe.buf);
    if (!ev.find((e) => e.sessionId)) fail('SSE из фейка streamWebTask не распарсился (нет sessionId)');
    const r = await post({ op: 'status', expectSha: head }, { bearer: false });
    if (r.status === 0) fail('харнесс не отвечает на HTTP');
    return 'журнал/SSE/HTTP живые';
  });

  // ── LB-01: статус релиза (prod_status) ────────────────────────────────────
  await step('LB-01', 'status: 401 без bearer + агент/шлюз/ожидаемый SHA/ошибки', async () => {
    const noAuth = await post({ op: 'status' }, { bearer: false });
    if (noAuth.status !== 401) fail(`без bearer ожидался 401, получено ${noAuth.status}`);
    if (lastCookieRouted) fail('маршрут НЕ исключён из cookie-роутинга в src/server.js — запрос съел handleWebRoute, агент не увидел запрос');
    const r = await post({ op: 'status', caller: CALLER, expectSha: head, sinceMinutes: 30 });
    if (r.status !== 200) fail(`/web/qa-bearer op=status → HTTP ${r.status}: ${r.text.slice(0, 160)} (маршрута или обработчика ещё нет — фича S1b не реализована)`);
    const j = r.json || {};
    if (!j.agent || !/^[0-9a-f]{7,40}$/i.test(String(j.agent.commit || ''))) fail('agent.commit не похож на SHA');
    if (!j.gateway || typeof j.gateway.buildSha !== 'string') fail('gateway.buildSha отсутствует');
    if (!j.expected || j.expected.reached !== true) fail(`expected.reached=${JSON.stringify(j.expected)} — merge-base с expectSha должен дать true`);
    if (!j.errors || typeof j.errors.count !== 'number') fail('errors.count не число (журнал не прочитан)');
    return `agent=${String(j.agent.commit).slice(0, 7)} reached=true errors=${j.errors.count}`;
  });

  // ── LB-02: отправка от тест-профиля (qa_user_send) ────────────────────────
  await step('LB-02', 'send: SSE-ответ, профиль qa-<caller>, username из тела игнорируется', async () => {
    const r = await post({ op: 'send', caller: CALLER, text: 'Проверка S1: ответь одно словно — готово', username: 'real-client' });
    if (r.status !== 200) fail(`op=send → HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    if (lastCookieRouted) fail('send съел cookie-роутинг — /web/qa-bearer не исключён в src/server.js');
    const events = parseSse(r.text);
    const sid = (events.find((e) => e.sessionId) || {}).sessionId;
    if (!sid) fail(`в SSE нет sessionId: ${r.text.slice(0, 200)}`);
    sessionId = sid;
    const last = captured[captured.length - 1];
    if (!last) fail('streamWebTask не вызван — send не дошёл до выполнения');
    if (last.username !== `qa-${CALLER}`) fail(`ожидался серверный профиль qa-${CALLER}, а ушёл «${last.username}» — username из тела не игнорируется`);
    if (!fs.existsSync(path.join(qaProfile, 'profile.json'))) fail('профиль qa-<caller> не создан при первом send (нет profile.json)');
    return `session=${sid} profile=qa-${CALLER}`;
  });

  // ── LB-03: след по sessionId (qa_trace) ───────────────────────────────────
  await step('LB-03', 'trace: messages + buttons + journal + executions, чужой sid = 404', async () => {
    if (!sessionId) fail('нет sessionId из LB-02');
    const r = await post({ op: 'trace', caller: CALLER, sessionId, sinceMinutes: 30 });
    if (r.status !== 200) fail(`op=trace → HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    const j = r.json || {};
    if (!j.session || typeof j.session.messageCount !== 'number') fail('session.messageCount отсутствует');
    if (!Array.isArray(j.messages) || j.messages.length < 2) fail(`messages: ожидалось ≥2, получено ${(j.messages || []).length}`);
    if (!j.buttons || !Array.isArray(j.buttons.labels) || !j.buttons.labels.length) fail('buttons.labels пуст — строка [buttons] не разобрана');
    if (!Array.isArray(j.buttons.callbacks)) fail('buttons.callbacks не массив (аддитивный ключ callbacks= не подключён)');
    if (!Array.isArray(j.journal) || !j.journal.length) fail('journal пуст — строки session=<sid> не найдены');
    if (!Array.isArray(j.executions)) fail('executions не массив');

    const foreign = await post({ op: 'trace', caller: CALLER, sessionId: DECOY_ID });
    if (foreign.status !== 404) fail(`чужая сессия должна давать 404, получено ${foreign.status} — скоуп по qa-<caller> не работает`);
    return `messages=${j.messages.length} labels=${j.buttons.labels.length} journal=${j.journal.length}`;
  });

  // ── Инструменты (S1c): 3 MCP-инструмента против того же харнесса ─────────
  await step('TOOL', 'tools: prod_status / qa_user_send / qa_trace без секрета в выводе', async () => {
    const toolFile = path.join(repoRoot, 'src', 'mcp-skills', 'tools', '103-qa-live.js');
    if (!fs.existsSync(toolFile)) fail('src/mcp-skills/tools/103-qa-live.js отсутствует — фича S1c не реализована');
    process.env.AGENT_PUBLIC_URL = base;
    process.env.USER_ID = 'sandboxtool';
    delete require.cache[toolFile];
    const mod = require(toolFile);
    const defs = mod && mod.tools || {};
    for (const name of ['prod_status', 'qa_user_send', 'qa_trace']) {
      if (!defs[name] || typeof defs[name].handler !== 'function') fail(`инструмент ${name} не объявлен в 103-qa-live.js`);
    }
    const ctx = { userId: 'sandboxtool' };
    const out1 = await defs.prod_status.handler({ expectSha: head }, ctx);
    const out2 = await defs.qa_user_send.handler({ text: 'Проверка из инструмента' }, ctx);
    const s2 = JSON.stringify(out1) + JSON.stringify(out2);
    if (!String(s2).trim()) fail('пустой вывод инструмента');
    if (s2.includes(SECRET)) fail('в вывод инструмента попал AGENT_SECRET');
    const sid = sessionIds[sessionIds.length - 1];
    if (sid && !s2.includes(sid)) fail('qa_user_send не вернул sessionId из SSE');
    const out3 = await defs.qa_trace.handler({ sessionId: sid || sessionId }, ctx);
    const s3 = JSON.stringify(out3);
    if (!String(s3).trim()) fail('пустой вывод qa_trace');
    if (s3.includes(SECRET)) fail('в вывод qa_trace попал AGENT_SECRET');
    return '3 инструмента отвечают, секрета в выводе нет';
  });

  // ── LB-04: лимит 20 вызовов send в час ────────────────────────────────────
  await step('LB-04', 'rate-limit: 20 send/час, 21-й → 429', async () => {
    let ok200 = 0;
    let saw429 = null;
    // LB-02 уже потратил 1 вызов → здесь шлём 2..21
    for (let i = 2; i <= 21; i++) {
      const r = await post({ op: 'send', caller: CALLER, text: `Лимит ${i}` });
      if (r.status === 200) ok200++;
      else if (r.status === 429) { saw429 = i; break; }
      else fail(`send #${i} → HTTP ${r.status} (ожидалось 200, а 21-й — 429)`);
    }
    if (!saw429) fail(`429 не получен за 21 вызов (200: ${ok200}) — лимит 20/час не работает`);
    return `200×${ok200}, 429 на вызове #${saw429}`;
  });

  // ── LB-05: секреты не утекают ─────────────────────────────────────────────
  await step('LB-05', 'secrets: ни один ответ не содержит AGENT_SECRET', async () => {
    const leaks = raw.filter((t) => t && t.includes(SECRET));
    if (leaks.length) fail(`секрет утёк в ${leaks.length} ответ(ах): ${leaks[0].slice(0, 120)}`);
    return `проверено ответов: ${raw.length}`;
  });

  // ── Итог ──────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const featureAbsent = !fs.existsSync(path.join(repoRoot, 'src', 'handlers', 'qa-live.js'))
    || results.some((r) => !r.ok && /S1b|S1c|фича|404/.test(r.detail));
  console.log('\n=== ПЕСОЧНИЦА #1851 S1 — LB-01…LB-05 (live-qa-check) ===');
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`${r.id.padEnd(6)} ${mark}  ${r.title}`);
    if (!r.ok) console.log(`       → ${r.detail}`);
  }
  console.log(`--- уровень S5 (локально, фейки внешних зависимостей), цикл ${((Date.now() - STARTED) / 1000).toFixed(1)}s`);
  console.log(`--- запуск: node scripts/sandbox/live-qa-check.cjs`);
  if (pass === results.length) {
    console.log(`SANDBOX: PASS (${pass}/${results.length})`);
  } else {
    console.log(`SANDBOX: FAIL (${pass}/${results.length})`);
    if (featureAbsent) {
      console.log('ПРАВИЛЬНАЯ ПРИЧИНА: фича S1b/S1c ещё не реализована — маршрут /web/qa-bearer и/или инструменты 103-qa-live.js отсутствуют.');
    }
  }

  harness.close();
  return pass === results.length;
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; setTimeout(() => process.exit(ok ? 0 : 1), 300); })
  .catch((e) => { console.error('SANDBOX: ERROR', e && e.stack || e); process.exit(2); });
