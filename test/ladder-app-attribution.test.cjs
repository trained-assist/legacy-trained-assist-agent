'use strict';
// Issue #1917 — the "Application" slice: AGENT_LADDER_APP is the run-type slug the engine
// stamps onto every llm-ladder call as x-ladder-app ({env:AGENT_LADDER_APP} in TRACE_HEADERS,
// src/opencode-ladder-provider.js), which the worker forwards to OpenRouter as
// HTTP-Referer/X-OpenRouter-Title (llm-ladder#33).
//
//   background-playbooks — a durable plan step / an internal GTD turn (the main consumer)
//   opencode-chat        — everything else (an ordinary chat run)
//
// The hermes-research slice is gone with the nested research engine (2026-10-05):
// research no longer runs as its own engine, so it carries the caller run's slug.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runEngineProcess, resolveLadderApp, LADDER_APP } = require('../src/runner/claude-runner');

test('run type → slug (resolveLadderApp)', () => {
  assert.equal(resolveLadderApp({}), LADDER_APP.chat, 'an ordinary chat run');
  assert.equal(resolveLadderApp({ internalGtd: true }), LADDER_APP.durable, 'an internal GTD turn is background work');
  assert.equal(resolveLadderApp({ resumeSink: { kind: 'durable', taskId: 'plan-1' } }), LADDER_APP.durable, 'a durable step');
  assert.equal(resolveLadderApp({ internalGtd: true, resumeSink: { kind: 'durable' } }), LADDER_APP.durable);
  assert.equal(resolveLadderApp({ resumeSink: { kind: 'web' } }), LADDER_APP.chat, 'only kind === durable counts');
  assert.equal(resolveLadderApp({ ladderApp: 'some-explicit-slug' }), 'some-explicit-slug', 'an explicit ladderApp wins');
  assert.deepEqual(Object.keys(LADDER_APP).sort(), ['chat', 'durable'], 'no slice is left without a producer');
  assert.equal(LADDER_APP.durable, 'background-playbooks');
  assert.equal(LADDER_APP.chat, 'opencode-chat');
});

test('the spawned engine process gets AGENT_LADDER_APP for its run type', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-app-'));
  const dump = path.join(tmp, 'seen.json');
  const bin = path.join(tmp, 'fake-env-engine');
  fs.writeFileSync(bin, `#!/usr/bin/env sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ app: process.env.AGENT_LADDER_APP || null, taskId: process.env.AGENT_TASK_ID || null, runId: process.env.AGENT_RUN_ID || null }))' "${dump}"
echo '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  fs.chmodSync(bin, 0o755);

  const base = {
    engine: 'claude', chatId: '42', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
    user: { username: 'smoke', workDir: tmp, name: 'Smoke' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: bin, engineArgs: [], cwd: tmp, mcpConfig: null, ocProfileOverrides: null,
  };

  const cases = [
    { label: 'chat run', opts: {}, want: 'opencode-chat' },
    { label: 'internal GTD turn', opts: { internalGtd: true }, want: 'background-playbooks' },
    { label: 'durable plan step', opts: { resumeSink: { kind: 'durable', taskId: 'plan-abc', itemId: 'i-1', executionId: 'exec-1' } }, want: 'background-playbooks' },
    { label: 'non-durable resume sink', opts: { resumeSink: { kind: 'web' } }, want: 'opencode-chat' },
    { label: 'an explicit slice', opts: { ladderApp: 'some-explicit-slug' }, want: 'some-explicit-slug' },
  ];

  for (const [i, c] of cases.entries()) {
    const taskId = `t-ladder-app-${i}`;
    const r = await runEngineProcess({ ...base, ...c.opts, taskId });
    assert.equal(r.terminalSuccess, true, `${c.label}: fake engine completes`);
    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    assert.equal(seen.app, c.want, `${c.label}: AGENT_LADDER_APP`);
    assert.equal(seen.taskId, taskId, `${c.label}: the run identity env still reaches the engine`);
    assert.ok(seen.runId, `${c.label}: AGENT_RUN_ID still fresh per spawn`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});
