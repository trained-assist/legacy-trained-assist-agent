'use strict';
// Spawn helper for the relay's stdio server (issue #2061 PR1, T3/T4).
//
// The child gets ONLY what the test hands it plus PATH — same rule the real mount
// uses (src/capability-relay/env.js), so a test cannot accidentally prove parity with
// an inherited service env.

const path = require('path');
const { spawn } = require('child_process');

const RELAY_INDEX = path.resolve(__dirname, '..', '..', 'src', 'capability-relay', 'index.js');

function startRelay(env = {}) {
  // Staging isolation: when the gate preloads its guard (NODE_OPTIONS), the child must
  // see the same data roots as its parent or the guard refuses to run — hence these
  // pass through by name, everything else (provider keys, service env) stays out.
  const STAGING_KEYS = ['NODE_OPTIONS', 'STAGING_ISOLATION', 'STAGING_ROOT', 'STAGING_BLOCKED_LOG',
    'STAGING_RUNNER_PID', 'HOME', 'TMPDIR', 'USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_ROOT'];
  const inherited = {};
  for (const key of STAGING_KEYS) if (process.env[key]) inherited[key] = process.env[key];
  const child = spawn(process.execPath, [RELAY_INDEX], {
    env: { PATH: process.env.PATH, ...inherited, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let seq = 0;
  const pending = new Map();
  const stderrChunks = [];
  let stdoutBuffer = '';

  child.stderr.on('data', d => stderrChunks.push(d.toString('utf8')));
  child.stdout.on('data', d => {
    stdoutBuffer += d.toString('utf8');
    let idx;
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter.resolve(msg); }
    }
  });

  function request(method, params, { timeoutMs = 10000 } = {}) {
    const id = `req-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`relay did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: msg => { clearTimeout(timer); resolve(msg); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  return {
    child,
    request,
    stderr: () => stderrChunks.join(''),
    alive: () => child.exitCode === null && !child.killed,
    close: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', () => resolve());
      child.stdin.end();
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } resolve(); }, 2000);
    }),
  };
}

module.exports = { startRelay, RELAY_INDEX };