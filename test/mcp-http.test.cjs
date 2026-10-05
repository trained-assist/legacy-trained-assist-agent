'use strict';
// POST /mcp — the trained-skills registry over HTTP JSON-RPC for engines that are not
// on this host (GitHub Actions, issue #73).
//
// Two layers, both covered:
//   handleRpc  — the protocol surface, tested with injected listTools/runTool so no
//                real tool process is spawned;
//   handleMcp  — the HTTP layer (auth, body parsing, notification 202, batch refusal),
//                tested with a mock req/res.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const fs = require('node:fs');
const path = require('node:path');
const { handleRpc, handleMcp, handleMcpToken, PROTOCOL_VERSION, SERVER_INFO } = require('../src/handlers/mcp-http');
const { issueRunToken, runTokenFromAuthHeader, mcpHostTokenFromAuthHeader } = require('../src/agent-run-tokens');

const listTools = () => [{ name: 'ping', description: 'p', inputSchema: { type: 'object', properties: {} } }];
const runTool = async () => 'pong';

// ── handleRpc ──────────────────────────────────────────────────────────────────

test('initialize answers protocolVersion, capabilities and serverInfo', async () => {
  const out = await handleRpc({ message: { jsonrpc: '2.0', id: 1, method: 'initialize' }, username: 'alice', listTools, runTool });
  assert.equal(out.jsonrpc, '2.0');
  assert.equal(out.id, 1);
  assert.equal(out.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(out.result.capabilities, { tools: {} });
  assert.deepEqual(out.result.serverInfo, SERVER_INFO);
});

test('ping is answered with an empty result', async () => {
  const out = await handleRpc({ message: { jsonrpc: '2.0', id: 2, method: 'ping' }, username: 'alice', listTools, runTool });
  assert.deepEqual(out.result, {});
});

test('a notification (no id) is not answered', async () => {
  for (const method of ['notifications/initialized', 'notifications/cancelled']) {
    const out = await handleRpc({ message: { jsonrpc: '2.0', method }, username: 'alice', listTools, runTool });
    assert.equal(out, null, `${method} must produce no reply`);
  }
});

test('a null id is treated as a notification', async () => {
  const out = await handleRpc({ message: { jsonrpc: '2.0', id: null, method: 'ping' }, username: 'alice', listTools, runTool });
  assert.equal(out, null);
});

test('tools/list returns the profile-scoped catalog', async () => {
  const seen = [];
  const out = await handleRpc({
    message: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    username: 'alice',
    listTools: (user, options) => { seen.push({ user, options }); return listTools(); },
    runTool,
  });
  assert.deepEqual(out.result.tools, listTools());
  assert.equal(seen[0].user, 'alice');
  assert.equal(typeof seen[0].options.workDir, 'string', 'the catalog must be scoped to the run profile');
});

test('tools/call returns the tool text as MCP content', async () => {
  const out = await handleRpc({
    message: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ping', arguments: { a: 1 } } },
    username: 'alice',
    listTools,
    runTool: async (opts) => {
      assert.equal(opts.tool, 'ping');
      assert.deepEqual(opts.params, { a: 1 });
      assert.equal(opts.username, 'alice');
      return 'pong';
    },
  });
  assert.deepEqual(out.result, { content: [{ type: 'text', text: 'pong' }] });
  assert.equal(out.result.isError, undefined);
});

test('tools/call without params.name is a JSON-RPC error, not a tool error', async () => {
  const out = await handleRpc({ message: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }, username: 'alice', listTools, runTool });
  assert.equal(out.error.code, -32600);
  assert.match(out.error.message, /params\.name/);
});

test('a failing tool is isError content, not a protocol error', async () => {
  // A JSON-RPC error here would make the client treat a broken tool as a broken
  // server and drop the whole session.
  const out = await handleRpc({
    message: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom' } },
    username: 'alice',
    listTools,
    runTool: async () => { throw new Error('tool exploded'); },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.result.isError, true);
  assert.equal(out.result.content[0].text, 'tool exploded');
});

test('an unknown method is -32601', async () => {
  const out = await handleRpc({ message: { jsonrpc: '2.0', id: 7, method: 'resources/list' }, username: 'alice', listTools, runTool });
  assert.equal(out.error.code, -32601);
});

// ── handleMcp (HTTP layer) ─────────────────────────────────────────────────────

function mockReqRes({ method = 'POST', path = '/mcp', headers = {}, body = '' } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = path;
  req.headers = headers;
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk) { this.body = chunk == null ? null : String(chunk); return this; },
  };
  queueMicrotask(() => {
    req.push(typeof body === 'string' ? body : JSON.stringify(body));
    req.push(null);
  });
  return { req, res };
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const ctx = { json: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); }, readBody, readBodyBuffer: (req) => new Promise((resolve, reject) => {
  const chunks = []; let total = 0;
  req.on('data', c => { total += c.length; if (total > 4 * 1024 * 1024) { req.destroy(); return reject(new Error('body too large')); } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
}) };

test('a valid run token reaches the protocol and gets a JSON-RPC reply', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  const handled = await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { jsonrpc: '2.0', id: 1, result: {} });
});

test('a notification is answered 202 with no body', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, null);
});

test('no token → 401', async () => {
  const { req, res } = mockReqRes({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 401);
});

test('AGENT_SECRET is deliberately NOT accepted on /mcp', async () => {
  // /mcp is the endpoint a public-CI job reaches. AGENT_SECRET is full-server
  // access, so accepting it here would turn a leaked CI secret into remote tool
  // execution. Mint a run token instead (POST /mcp/token).
  const { req, res } = mockReqRes({ headers: { authorization: 'Bearer sk-the-agent-secret' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 401);
});

test('a malformed body is a JSON-RPC Parse error, not a 500', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: '{not json' });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error.code, -32700);
});

test('a JSON-RPC batch is refused loudly', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error.code, -32600);
  assert.match(JSON.parse(res.body).error.message, /batch/);
});

test('a non-object message is an Invalid Request', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  // A JSON *string*: parses fine, is not an object → Invalid Request, not Parse error.
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: '"ping"' });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error.code, -32600);
  assert.match(JSON.parse(res.body).error.message, /Invalid Request/);
});

test('a body over 4 MB is refused before it is parsed', async () => {
  const token = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  const { req, res } = mockReqRes({ headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  await handleMcp(req, { pathname: '/mcp' }, res, ctx);
  assert.equal(res.statusCode, 400);
});

test('other paths fall through (returns false)', async () => {
  const { req, res } = mockReqRes({ path: '/nope' });
  assert.equal(await handleMcp(req, { pathname: '/nope' }, res, ctx), false);
});

// ── handleMcpToken ─────────────────────────────────────────────────────────────

test('POST /mcp/token mints a run token scoped to the profile', async () => {
  const { req, res } = mockReqRes({ path: '/mcp/token', body: { username: 'alice' } });
  const handled = await handleMcpToken(req, { pathname: '/mcp/token' }, res, ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.username, 'alice');
  assert.equal(out.url, '/mcp');
  assert.match(out.token, /^rt_[0-9a-f]{64}$/);
});

test('POST /mcp/token rejects a bad username', async () => {
  const { req, res } = mockReqRes({ path: '/mcp/token', body: { username: 'a b!' } });
  await handleMcpToken(req, { pathname: '/mcp/token' }, res, ctx);
  assert.equal(res.statusCode, 400);
});

test('POST /mcp/token on another path falls through', async () => {
  const { req, res } = mockReqRes({ path: '/nope' });
  assert.equal(await handleMcpToken(req, { pathname: '/nope' }, res, ctx), false);
});

// ── host tokens: the right to MINT from a remote engine host (#2114 trap #9) ────

const HOST_TOKEN = 'mcp_' + 'a'.repeat(48);

test('a configured host token is accepted', () => {
  const env = { MCP_HOST_TOKEN: HOST_TOKEN };
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN}`, env), true);
});

test('a host token list accepts every member and rejects the rest', () => {
  const other = 'mcp_' + 'b'.repeat(48);
  const env = { MCP_HOST_TOKEN: `${HOST_TOKEN}, ${other}` };
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${other}`, env), true, 'comma-separated list — a second host is added, not rotated');
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer mcp_${'c'.repeat(48)}`, env), false);
});

test('a host token of the wrong shape is refused, not trimmed into shape', () => {
  const env = { MCP_HOST_TOKEN: HOST_TOKEN };
  assert.equal(mcpHostTokenFromAuthHeader('Bearer not-a-host-token', env), false);
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN}x`, env), false, 'prefix must not make a near-miss valid');
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN.slice(0, 20)}`, env), false, 'too short to be a credential');
  assert.equal(mcpHostTokenFromAuthHeader('', env), false);
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN}`, {}), false, 'unset = nobody may mint');
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN}`, { MCP_HOST_TOKEN: '  ,  ' }), false, 'a blank list is not a wildcard');
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${HOST_TOKEN}`, { MCP_HOST_TOKEN: 'sk-the-agent-secret' }), false, 'AGENT_SECRET in this var must not work');
});

test('the two token kinds cannot be swapped', () => {
  const env = { MCP_HOST_TOKEN: HOST_TOKEN };
  // A host token must not pass as a run token: the run-token regex only matches
  // `rt_<64 hex>`, so /mcp can never be opened by a host credential.
  assert.equal(runTokenFromAuthHeader(`Bearer ${HOST_TOKEN}`), null);
  const runToken = issueRunToken({ taskId: 'mcp:alice', username: 'alice' });
  assert.equal(mcpHostTokenFromAuthHeader(`Bearer ${runToken}`, env), false, 'a run token must not be usable to mint');
});

test('the host-token exception in the gate covers /mcp/token and nothing else', () => {
  // The gate lives in server.js (not extractable), so this pins its shape: a host
  // token is a minting credential. Widening the path it unlocks would hand a
  // remote engine host a server route.
  const src = fs.readFileSync(path.resolve(__dirname, '../src/server.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('mintMcpTokenByHostToken ='));
  assert.ok(line, 'the gate exception must exist and be a named condition');
  assert.match(line, /url\.pathname === '\/mcp\/token'/, 'only the minting route may be opened by a host token');
  assert.match(line, /mcpHostTokenFromAuthHeader\(auth\)/, 'it must verify the host token, not accept the header shape');
  const uses = src.split('\n').filter(l => l.includes('mintMcpTokenByHostToken') && l.includes('if ('));
  assert.equal(uses.length, 1, 'the exception must be referenced by exactly one condition');
});
