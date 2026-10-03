#!/usr/bin/env node
// Sandbox for issue #2061 PR1 — the capability-relay closed loop, no network.
//
// initialize → tools/list → tools/call (success) → tools/call (typed error) → dead method.
// Everything runs on 127.0.0.1 against the mock canonical handler, so this is the same
// loop a machine can repeat anywhere (staging forbids non-loopback outbound).
//
// Exit codes: 0 = green, 10 = harness alive but the loop is red, 1 = the harness itself broke.
//
//   node scripts/sandbox/capability-relay-loop.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startMockWorker } = require(path.join(root, 'test/fixtures/mock-capability-worker.cjs'));
const { loadContract } = require(path.join(root, 'src/capability-relay/contract.js'));
const relayIndex = path.join(root, 'src/capability-relay/index.js');

const TOKEN = 'sandbox-relay-credential';
let seq = 0;
let failures = 0;

function check(step, ok, detail = '') {
  if (ok) {
    process.stdout.write(`  ok   ${step}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${step}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function startRelay(env) {
  const child = spawn(process.execPath, [relayIndex], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', d => {
    buffer += d.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `sbx-${++seq}`;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
    pending.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request, close: () => new Promise(done => { child.on('exit', done); child.stdin.end(); }) };
}

async function main() {
  const contract = loadContract();
  const tool = contract.tools[0];
  const worker = await startMockWorker({ token: TOKEN });
  const env = {
    CAPABILITY_RELAY_ENDPOINT: worker.url,
    CAPABILITY_RELAY_TOKEN: TOKEN,
    CAPABILITY_RELAY_CONTRACT_VERSION: String(contract.version),
  };
  const relay = startRelay(env);
  process.stdout.write(`capability-relay sandbox · mock handler ${worker.url}\n`);

  try {
    const init = await relay.request('initialize', { protocolVersion: '2024-11-05' });
    check('initialize → protocolVersion 2024-11-05', init.result?.protocolVersion === '2024-11-05');
    check('initialize → contract version', init.result?.capabilities?.contract?.version === contract.version);

    const list = await relay.request('tools/list', {});
    const listed = list.result?.tools?.[0];
    check('tools/list → the contract tool, untranslated', listed?.name === tool.name
      && JSON.stringify(listed?.inputSchema) === JSON.stringify(tool.inputSchema));

    const call = await relay.request('tools/call', {
      name: tool.name,
      arguments: { channel: 'hh', candidateRef: 'sandbox-cand' },
      _meta: { authContext: { profileId: 'sandbox', runId: 'sandbox-run', operationId: 'sandbox-op' } },
    });
    const body = call.error ? null : JSON.parse(call.result.content[0].text);
    check('tools/call → handler result', body?.toolId === tool.toolId && body?.output?.channel === 'hh');
    check('tools/call → auth context travelled', body?.echo?.authorizationScheme === 'bearer');

    const repeat = await relay.request('tools/call', {
      name: tool.name,
      arguments: { channel: 'hh', candidateRef: 'sandbox-cand' },
      _meta: { authContext: { operationId: 'sandbox-op' } },
    });
    check('repeated operationId → typed conflict -32014', repeat.error?.code === -32014);

    const dead = await relay.request('tools/nope', {});
    check('unknown method → -32601', dead.error?.code === -32601);

    const unconfigured = startRelay({});
    try {
      const off = await unconfigured.request('tools/call', { name: tool.name, arguments: {} });
      check('feature off → misconfigured -32010, server alive', off.error?.code === -32010
        && unconfigured.child.exitCode === null);
    } finally {
      await unconfigured.close();
    }
  } catch (e) {
    process.stdout.write(`  FAIL harness: ${e.message}\n`);
    failures++;
  } finally {
    await relay.close();
    await worker.close();
  }

  if (failures) {
    process.stdout.write(`\nred: ${failures} check(s) failed\n`);
    process.exit(10); // harness alive, scenario red
  }
  process.stdout.write('\ngreen: the relay closed the loop (initialize → list → call → typed error)\n');
  process.exit(0);
}

main();