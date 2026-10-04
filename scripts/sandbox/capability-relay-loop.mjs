#!/usr/bin/env node
// Sandbox for issue #2034 (PR2 of #2061) — the communication capability closed loop, no network.
//
// initialize → tools/list → tools/call (success + correlation) → wrong credential →
// duplicate operationId → deadline → foreign handler version → toggle off → dead
// method → unknown capability. Every failure must fail FOR THE RIGHT REASON: the
// typed code the contract promises, on a server that stays alive. The mock serves
// the door the live Worker serves (POST /v1/dialogs/next-message, raw arguments,
// bearer token, x-contract-version), so this loop is the same shape a machine can
// repeat anywhere (staging forbids non-loopback outbound).
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
const ARGS = {
  goal: { instruction: 'написать следующий ход' },
  communication_style: { instructions: 'коротко и по делу' },
  language: 'ru',
  conversation_history: { format: 'messages', messages: [{ speaker: 'sender', text: 'Здравствуйте, Екатерина!' }] },
};
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
  return { child, request, close: () => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.on('exit', done);
    child.stdin.end();
    setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000).unref();
  }) };
}

// Схема второго инструмента берётся из контракта, а не дублируется строкой:
// смоук обязан проверять то, что реально опубликовано, иначе он проверяет свою
// же копию и зеленеет при расхождении.
const INTENT_INPUT_SCHEMA = (() => {
  const t = loadContract().tools.find((x) => x.name === 'resolve_user_intent');
  return t ? t.inputSchema : null;
})();

async function main() {
  const contract = loadContract();
  const tool = contract.tools[0];
  const worker = await startMockWorker({ token: TOKEN });
  const env = {
    CAPABILITY_RELAY_COMMUNICATION: '1',
    COMMUNICATION_API_URL: worker.url,
    COMMUNICATION_TOKEN: TOKEN,
    CAPABILITY_RELAY_CONTRACT_VERSION: String(contract.version),
  };
  const relay = startRelay(env);
  process.stdout.write(`communication capability sandbox · mock worker ${worker.url}${worker.door}\n`);

  try {
    const init = await relay.request('initialize', { protocolVersion: '2024-11-05' });
    check('initialize → protocolVersion 2024-11-05', init.result?.protocolVersion === '2024-11-05');
    check('initialize → contract version', init.result?.capabilities?.contract?.version === contract.version);

    const list = await relay.request('tools/list', {});
    // Инструментов теперь два (writer + resolve_user_intent, issue #10). Проверяем
    // не количество, а то, что каждый несёт СВОЁ имя и СВОЮ схему дословно:
    // аддитивное расширение контракта не должно менять ни порядок, ни содержимое
    // уже опубликованного инструмента.
    const listed = list.result?.tools || [];
    const byName = new Map(listed.map((t) => [t.name, t]));
    const canonical = byName.get(tool.name);
    check('tools/list → канонический инструмент с дословным именем и схемой',
      listed.length >= 1 && !!canonical
        && JSON.stringify(canonical.inputSchema) === JSON.stringify(tool.inputSchema),
      `saw ${JSON.stringify(listed.map((t) => t.name))}`);
    check('tools/list → второй инструмент resolve_user_intent с дословной схемой',
      byName.has('resolve_user_intent')
        && JSON.stringify(byName.get('resolve_user_intent').inputSchema) === JSON.stringify(INTENT_INPUT_SCHEMA),
      `saw ${JSON.stringify(listed.map((t) => t.name))}`);

    const call = await relay.request('tools/call', {
      name: tool.name,
      arguments: ARGS,
      _meta: { authContext: { profileId: 'sandbox', runId: 'sandbox-run', operationId: 'sandbox-op' } },
    });
    const body = call.error ? null : JSON.parse(call.result.content[0].text);
    check('tools/call → handler result (status generated)', body?.status === 'generated');
    check('tools/call → host correlation travelled', body?.echo?.correlation?.runId === 'sandbox-run'
      && body?.echo?.correlation?.operationId === 'sandbox-op');

    const repeat = await relay.request('tools/call', {
      name: tool.name,
      arguments: ARGS,
      _meta: { authContext: { operationId: 'sandbox-op' } },
    });
    check('repeated operationId → typed conflict -32014', repeat.error?.code === -32014,
      `got ${repeat.error?.code}`);

    const wrongCred = startRelay({ ...env, COMMUNICATION_TOKEN: 'not-the-credential' });
    try {
      const denied = await wrongCred.request('tools/call', { name: tool.name, arguments: ARGS });
      check('wrong credential → typed unauthorized -32011, server alive',
        denied.error?.code === -32011 && wrongCred.child.exitCode === null, `got ${denied.error?.code}`);
    } finally {
      await wrongCred.close();
    }

    const slowWorker = await startMockWorker({ token: TOKEN, delayMs: 1500 });
    const impatient = startRelay({ ...env, COMMUNICATION_API_URL: slowWorker.url, CAPABILITY_RELAY_TIMEOUT_MS: '200' });
    try {
      const late = await impatient.request('tools/call', { name: tool.name, arguments: ARGS });
      check('deadline exceeded → typed timeout -32017 (no hang, no fake success)',
        late.error?.code === -32017, `got ${late.error?.code}`);
    } finally {
      await impatient.close();
      await slowWorker.close();
    }

    const foreignWorker = await startMockWorker({ token: TOKEN, version: 'v2' });
    const foreign = startRelay({ ...env, COMMUNICATION_API_URL: foreignWorker.url });
    try {
      const mismatch = await foreign.request('tools/call', { name: tool.name, arguments: ARGS });
      check('foreign handler version → explicit version_mismatch -32015',
        mismatch.error?.code === -32015, `got ${mismatch.error?.code}`);
    } finally {
      await foreign.close();
      await foreignWorker.close();
    }

    const off = startRelay({ COMMUNICATION_API_URL: worker.url, COMMUNICATION_TOKEN: TOKEN });
    try {
      const offList = await off.request('tools/list', {});
      check('toggle off → tools/list carries nothing (no readiness claim)',
        Array.isArray(offList.result?.tools) && offList.result.tools.length === 0);
      const offCall = await off.request('tools/call', { name: tool.name, arguments: ARGS });
      check('toggle off → misconfigured -32010, server alive',
        offCall.error?.code === -32010 && off.child.exitCode === null, `got ${offCall.error?.code}`);
    } finally {
      await off.close();
    }

    const dead = await relay.request('tools/nope', {});
    check('unknown method → -32601', dead.error?.code === -32601);

    const unknownTool = await relay.request('tools/call', { name: 'no_such_capability', arguments: {} });
    check('unknown capability → typed not_found -32012', unknownTool.error?.code === -32012);
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
  process.stdout.write('\ngreen: the capability closed the loop, and every failure failed for the right reason\n');
  process.exit(0);
}

main();
