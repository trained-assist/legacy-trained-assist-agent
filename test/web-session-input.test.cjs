'use strict';
// US-INPUT-01, web channel: «📋 Посмотреть input» under a web answer returns the
// REAL model input of the run that produced that answer, verbatim.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'web-input-'));
process.env.HOME = ROOT;
process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
process.env.USERS_DIR = path.join(ROOT, 'users');
for (const k of Object.keys(require.cache)) {
  if (/\/src\/(data-paths|web-routes|run-input-store)\.js$/.test(k)) delete require.cache[k];
}
const { userWorkDir } = require('../src/data-paths');
const { getRunInputFor } = require('../src/web-routes');
const store = require('../src/run-input-store');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('US-INPUT-01 web: QA opens input of an answer → exact run input, no wrapper', () => {
  const wd = userWorkDir('qa');
  fs.mkdirSync(path.join(wd, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(wd, 'sessions', 's_web.json'), JSON.stringify({
    id: 's_web', messages: [
      { role: 'user', content: 'задача', at: 1000 }, { role: 'assistant', content: 'ответ 1', at: 1500 },
      { role: 'user', content: 'ещё', at: 2000 }, { role: 'assistant', content: 'ответ 2', at: 2600 },
    ],
  }));
  store.writeInput(wd, 'qa-web-r1', 'SYS\n\nзадача', { sessionId: 's_web', at: 1100 });
  store.writeInput(wd, 'qa-web-r2', 'SYS\n\nещё', { sessionId: 's_web', at: 2100 });

  const first = getRunInputFor('qa', 's_web', '1500');
  assert.deepEqual(first, { ok: true, taskId: 'qa-web-r1', at: 1100, input: 'SYS\n\nзадача' });
  assert.equal(getRunInputFor('qa', 's_web', 2600).input, 'SYS\n\nещё');
  assert.equal(getRunInputFor('qa', 's_web', 2600).input, store.readInput(wd, 'qa-web-r2'), 'byte-for-byte with .run-inputs');
});

test('US-INPUT-01 web: no snapshot / foreign or bad session → honest error, never a retelling', () => {
  assert.deepEqual(getRunInputFor('qa', 's_web', 900), { ok: false, error: 'no-input' });
  assert.deepEqual(getRunInputFor('qa', 's_missing', null), { ok: false, error: 'session not found' });
  assert.deepEqual(getRunInputFor('other', 's_web', null), { ok: false, error: 'session not found' });
  assert.equal(getRunInputFor('qa', '../x', null).error, 'invalid session id');
});

test('US-INPUT-01 web: runner tags the snapshot with the session; cookie + bearer twins exist', () => {
  assert.match(read('src/runner/index.js'), /buildDocument\(\{[\s\S]{0,200}\}\), \{ sessionId: activeSessionId/);
  assert.match(read('src/web-routes.js'), /\\\/input\$/);
  assert.match(read('src/handlers/web.js'), /'\/web\/session-input'/);
  assert.match(read('src/server.js'), /'\/web\/session-input'/);
});
