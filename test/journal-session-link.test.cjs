// «📜 Журнал» must open the dialog the agent actually ran on, and the web
// session-get must serve any of the profile's sessions — not only the 50 most
// recent (older ones failed in the web app with "Failed to load session").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// getSessionFor is async since #1916 PR-C: an ARCHIVED session is served from
// GCS in memory, so the reader can reject as well as return null.
test('getSessionFor serves sessions beyond the 50-entry recency index, opens non-default-audience sessions by id', async () => {
  const oldHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-session-'));
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(data-paths|web-routes|session-store)\.js$/.test(key)) delete require.cache[key];
  }
  try {
    const { userWorkDir } = require('../src/data-paths');
    const sessions = require('../src/session-store');
    const { getSessionFor } = require('../src/web-routes');
    const workDir = userWorkDir('alice');
    fs.mkdirSync(workDir, { recursive: true });
    sessions.createSession(workDir, { task: 'old dialog', id: 's-1-1000', chatId: 1 });
    for (let i = 0; i < 60; i++) sessions.createSession(workDir, { task: `newer ${i}`, id: `s-1-${2000 + i}`, chatId: 1 });
    assert.equal(sessions.listSessions(workDir, 100).some(s => s.id === 's-1-1000'), false, 'precondition: evicted from index');
    const old = await getSessionFor('alice', 's-1-1000');
    assert.equal(old?.id, 's-1-1000');
    assert.equal(old.messages[0].content, 'old dialog');
    // Journal from a freelance/recruiter bot group chat (negative chat id) links to
    // that bot's session — it must open, not 404 (was "Failed to load session").
    sessions.createSession(workDir, { task: 'freelance group', id: 's-1003093394558-9000', chatId: -1003093394558, audience: 'freelance' });
    const fl = await getSessionFor('alice', 's-1003093394558-9000');
    assert.equal(fl?.id, 's-1003093394558-9000');
    assert.equal(fl.audience, 'freelance');
    assert.equal(fl.messages[0].content, 'freelance group');
    assert.equal(sessions.listSessions(workDir, 100).some(s => s.id === 's-1003093394558-9000'), false, 'list stays default-audience');
    assert.equal(await getSessionFor('alice', 's-missing'), null);
  } finally { process.env.HOME = oldHome; }
});

test('journal button carries the resolved session id, falls back when it would overflow 64 bytes', () => {
  const { inputInspectionRows } = require('../src/runner/claude-runner');
  const journal = (m, s) => inputInspectionRows(m, s)[0][1].callback_data;
  assert.equal(journal(123, 's-1004371070440-1790321880069'), 'input_journal|123|s-1004371070440-1790321880069');
  assert.equal(journal(123), 'input_journal|123');
  assert.equal(journal(123, 'x'.repeat(60)), 'input_journal|123');
  assert.equal(journal(123, 'bad|id'), 'input_journal|123');
  assert.deepEqual(inputInspectionRows(null, 's-1'), []);
});
