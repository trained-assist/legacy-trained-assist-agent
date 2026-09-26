'use strict';

// Spawn a real MCP server (stdio JSON-RPC 2.0) as a subprocess and talk to it
// over the wire. This is the L2 building block: handlers are never called in
// process, the server boundary is exercised for real.
//
//   const server = await startMcpServer({ entrypoint, env, workDir });
//   const { tools } = await server.call('tools/list');
//   await server.stop();

const { spawn } = require('child_process');
const { createInterface } = require('readline');

const DEFAULT_TIMEOUT_MS = 15000;

function startMcpServer({
  entrypoint,
  args = [],
  env = {},
  workDir = process.cwd(),
  protocolVersion = '2024-11-05',
  clientInfo = { name: 'mcp-skill-testkit', version: '1.0.0' },
  initialize = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stdio = ['pipe', 'pipe', 'pipe'],
} = {}) {
  if (!entrypoint) throw new Error('startMcpServer: `entrypoint` is required');

  const proc = spawn(process.execPath, [entrypoint, ...args], {
    cwd: workDir,
    env: { ...process.env, ...env },
    stdio,
  });

  const rl = createInterface({ input: proc.stdout, terminal: false });
  let seq = 0;
  const pending = new Map();

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const onStderr = (d) => process.stderr.write(d);
  if (proc.stderr) proc.stderr.on('data', onStderr);

  let exited = false;
  let exitError = null;
  proc.on('exit', (code, signal) => {
    exited = true;
    exitError = new Error(`MCP server exited (code=${code}, signal=${signal})`);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(exitError); }
    pending.clear();
  });

  function call(method, params = {}) {
    if (exited) return Promise.reject(exitError);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP call timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  const ready = initialize
    ? call('initialize', { protocolVersion, capabilities: {}, clientInfo })
    : Promise.resolve(null);

  return ready.then(() => ({
    call,
    proc,
    stop: () => new Promise((resolve) => {
      if (exited) return resolve();
      proc.once('close', () => resolve());
      proc.kill();
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 2000).unref?.();
    }),
  }));
}

module.exports = { startMcpServer, DEFAULT_TIMEOUT_MS };
