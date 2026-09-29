'use strict';
// S1c (#1851, issue #1878): the 103-qa-live tools talk to /web/qa-bearer over
// AGENT_PUBLIC_URL, derive caller from ctx.userId, assemble the SSE answer, and never
// leak AGENT_SECRET into a result.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const SECRET = 'qa-live-tools-secret';
const USER = 'tooluser';

test('prod_status / qa_user_send / qa_trace hit /web/qa-bearer, derive caller, leak no secret', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ path: req.url, auth: req.headers.authorization, body });
      if (body.op === 'status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ agent: { commit: 'a'.repeat(40) }, gateway: { buildSha: 'b'.repeat(40) }, expected: { reached: true }, errors: { count: 0 } }));
      }
      if (body.op === 'send') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const sid = 's-web-tool-1';
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId: sid })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: 'Ответ бота' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done', sessionId: sid })}\n\n`);
        return res.end();
      }
      if (body.op === 'trace') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ session: { id: body.sessionId, messageCount: 2 }, messages: [], buttons: { labels: ['Проверка'], callbacks: [{ t: 'Проверка', c: 'cb:1' }] }, journal: [], executions: [] }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad op"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.AGENT_PUBLIC_URL = base;
  process.env.AGENT_SECRET = SECRET;
  process.env.USER_ID = USER;
  delete require.cache[require.resolve('../src/mcp-skills/tools/103-qa-live')];
  const { tools } = require('../src/mcp-skills/tools/103-qa-live');
  const ctx = { userId: USER };

  const status = await tools.prod_status.handler({ expectSha: 'a'.repeat(40) }, ctx);
  assert.equal(status.ok, true);
  assert.equal(status.expected.reached, true);

  const send = await tools.qa_user_send.handler({ text: 'проверка' }, ctx);
  assert.equal(send.ok, true);
  assert.equal(send.sessionId, 's-web-tool-1');
  assert.equal(send.text, 'Ответ бота');
  assert.deepEqual(send.buttons.labels, ['Проверка']);

  const trace = await tools.qa_trace.handler({ sessionId: 's-web-tool-1' }, ctx);
  assert.equal(trace.ok, true);
  assert.deepEqual(trace.buttons.callbacks, [{ t: 'Проверка', c: 'cb:1' }]);

  // Every call went to the bearer route, with the secret only in the header.
  assert.ok(requests.length >= 3);
  for (const r of requests) {
    assert.equal(r.path, '/web/qa-bearer');
    assert.equal(r.auth, `Bearer ${SECRET}`);
    assert.equal(r.body.caller, USER);
    assert.equal('username' in r.body, false, 'username must never be sent');
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
  }
  const out = JSON.stringify(status) + JSON.stringify(send) + JSON.stringify(trace);
  assert.ok(!out.includes(SECRET), 'AGENT_SECRET leaked into a tool result');

  await new Promise((r) => server.close(r));
});

test('tools refuse without a derivable caller and never fabricate a rate-limit pass', async () => {
  process.env.USER_ID = '';
  delete require.cache[require.resolve('../src/mcp-skills/tools/103-qa-live')];
  const { tools } = require('../src/mcp-skills/tools/103-qa-live');
  const send = await tools.qa_user_send.handler({ text: 'x' }, {});
  assert.equal(send.ok, false);
  assert.match(send.error, /caller/);
});
