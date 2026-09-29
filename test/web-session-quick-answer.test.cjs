'use strict';
// Корневая причина фантомной веб-сессии (#1867, репорт 29.09.2026 10:14 МСК):
// веб минтит точный id s-web-… и отдаёт его клиенту, а runner на быстрых ответах этот id
// игнорирует — пишет обмен в побочную qa-<hash> сессию (recordQuickExchange) и возвращает
// строку. streamWebTask видит ответ → 'done' с s-web-id → квитанция state:done, но файла
// s-web-… нет → /web/session-get и /web/reply-bearer → 404 «session not found».
// Два места одного класса: pre-queue quick-answer (runner/index.js, isPreQueueQuickIntent)
// и utility-ветка quick-answer внутри _runTask (isUtility → recordQuickExchange).
// Тест идёт через НАСТОЯЩИЙ runner (контракт web ↔ runner), без моков runTask.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-qa-exact-'));
process.env.HOME = tmp;
process.env.USERS_DIR = path.join(tmp, 'users');
process.env.AGENT_DATA_DIR = path.join(tmp, 'agent-data');
process.env.WEB_CONVREF_CANARY = 'web-canary';
const workDir = path.join(tmp, 'users', 'web-canary');
fs.mkdirSync(workDir, { recursive: true });

const runner = require('../src/runner');
const sessions = require('../src/session-store');

let n = 0;
async function webRun(task) {
  const id = `s-web-${Date.now()}-${(++n).toString(16).padStart(8, '0')}`;
  const result = await runner.runTask({
    taskId: `web-canary-web-${n}`,
    user: { id: 0, name: 'web-canary', username: 'web-canary', workDir },
    fromUser: true, task, context: '', sessionId: id,
    webExactSession: true, forceNew: true, secrets: {},
    outputCallback: () => {},
  });
  return { id, result };
}

for (const [label, task] of [
  ['pre-queue quick-answer (/usage)', '/usage'],
  ['utility quick-answer внутри _runTask (мои сессии)', 'мои сессии'],
]) {
  test(`${label}: ответ веба лежит в той сессии, чей id отдан клиенту`, async () => {
    const { id, result } = await webRun(task);
    assert.ok(typeof result === 'string' && result.trim(), 'быстрый ответ должен прийти');
    const s = sessions.getSession(workDir, id);
    assert.ok(s, `id ${id} отдан клиенту, ответ пришёл, но файла сессии нет → 404 session not found`);
    const last = (s.messages || []).at(-1);
    assert.equal(last?.role, 'assistant', 'ответ должен быть записан в эту же сессию');
  });
}
