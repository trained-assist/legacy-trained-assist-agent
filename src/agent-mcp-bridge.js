'use strict';

// MCP bridge for isolated engine runs (issue #1649).
//
// With AGENT_RUN_AS_USERS the engine runs as an unprivileged slot user, but the
// MCP servers (trained-skills, sibling domain servers, playwright) need the
// service user's env and files (server secrets, profile token files, host
// browser). They therefore keep running as the service user, spawned HERE, and
// the engine reaches them through src/agent-mcp-bridge-client.js over a unix
// socket. The first line on a connection is {"token","server"}; the token is
// the run-scoped AGENT_RUN_TOKEN (src/agent-run-tokens.js), so a slot can only
// open the MCP servers registered for its own, still-running run.
//
// Per process, lazily: a nested Hermes run started from inside an MCP server
// process gets its own bridge socket in that process.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { verifyRunToken } = require('./agent-run-tokens');

// Must be readable by the slot users; override to place it outside the service home.
const CLIENT_PATH = process.env.AGENT_MCP_BRIDGE_CLIENT || path.join(__dirname, 'agent-mcp-bridge-client.js');
const HANDSHAKE_MAX = 4096;

const runs = new Map(); // token → { servers, env, cwd, children:Set }
let server = null;
let socketPath = null;

function bridgedMcpConfig(realConfig, { nodeBin = process.execPath } = {}) {
  const mcpServers = {};
  for (const id of Object.keys(realConfig?.mcpServers || {})) {
    mcpServers[id] = { command: nodeBin, args: [CLIENT_PATH, id] };
  }
  return { mcpServers };
}

function registerRun(token, { servers, env, cwd }) {
  runs.set(token, { servers: servers || {}, env: env || {}, cwd, children: new Set() });
}

function unregisterRun(token) {
  const run = runs.get(token);
  runs.delete(token);
  if (!run) return;
  for (const child of run.children) killChild(child);
}

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
  t.unref();
}

function handleConnection(sock) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > HANDSHAKE_MAX) sock.destroy();
      return;
    }
    sock.off('data', onData);
    sock.pause();
    let hello = null;
    try { hello = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { /* bad */ }
    const rest = buf.subarray(nl + 1);
    const run = hello && verifyRunToken(hello.token) ? runs.get(hello.token) : null;
    const spec = run && typeof hello.server === 'string' ? run.servers[hello.server] : null;
    if (!spec || !spec.command) {
      sock.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'mcp bridge: unauthorized' } }) + '\n');
      return;
    }
    let child;
    try {
      child = spawn(spec.command, spec.args || [], {
        cwd: run.cwd,
        env: { ...run.env, ...(spec.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.error(`[mcp-bridge] spawn ${hello.server}: ${e.message}`);
      sock.destroy();
      return;
    }
    run.children.add(child);
    child.on('error', (e) => { console.error(`[mcp-bridge] ${hello.server}: ${e.message}`); sock.destroy(); });
    child.on('exit', () => { run.children.delete(child); sock.end(); });
    child.stderr.on('data', () => { /* MCP servers log to stderr; the engine never saw it either */ });
    child.stdout.pipe(sock);
    if (rest.length) child.stdin.write(rest);
    sock.pipe(child.stdin, { end: false });
    sock.on('end', () => { try { child.stdin.end(); } catch { /* gone */ } });
    sock.on('close', () => killChild(child));
    sock.on('error', () => killChild(child));
    child.stdin.on('error', () => { /* child gone */ });
    sock.resume();
  };
  sock.on('data', onData);
  sock.on('error', () => { /* client gone */ });
}

/**
 * Start (once per process) the bridge socket and return its path. The socket
 * dir must be traversable (x) by the slot users — the ops script grants that.
 */
async function ensureBridge(dir) {
  if (server && socketPath) return socketPath;
  fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
  const p = path.join(dir, `b-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sock`);
  // allowHalfOpen: the client closing its stdin must not cut the server's replies short.
  const srv = net.createServer({ allowHalfOpen: true }, handleConnection);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, () => { srv.off('error', reject); resolve(); });
  });
  fs.chmodSync(p, 0o666); // the run token is the auth; the path only has to be reachable
  srv.unref();
  const cleanup = () => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } };
  process.once('exit', cleanup);
  server = srv;
  socketPath = p;
  return p;
}

async function closeBridge() {
  if (!server) return;
  const srv = server, p = socketPath;
  server = null; socketPath = null;
  for (const token of [...runs.keys()]) unregisterRun(token);
  await new Promise(r => srv.close(() => r()));
  try { fs.rmSync(p, { force: true }); } catch { /* gone */ }
}

module.exports = { bridgedMcpConfig, registerRun, unregisterRun, ensureBridge, closeBridge, CLIENT_PATH };
