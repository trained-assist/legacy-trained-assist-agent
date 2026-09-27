'use strict';
// V2 smoke for issue #942 P1.3 (claude-runner extraction).
// (1) End-to-end: a fake engine binary emits stream-json → module must stream
//     and return terminalSuccess=true + claudeResult.
// (2) Crash: fake engine exits 1 quickly with no JSON → module must NOT hang,
//     return exitCode!=0, no throw.
// (3) Inactivity/timeout machinery present.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { runEngineProcess, buildEngineCommand, editLanded, runningControls, _const, computeEngineTimeoutMs } = require('../src/runner/claude-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-'));
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-mcp-'));

function writeFake(binPath, script) {
  fs.writeFileSync(binPath, script);
  fs.chmodSync(binPath, 0o755);
}

const okBin = path.join(tmp, 'fake-claude-ok');
writeFake(okBin, `#!/usr/bin/env sh
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Привет"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":" мир"}]}}'
echo '{"type":"result","result":"Привет мир","usage":{"input_tokens":10,"output_tokens":5}}'
`);

const crashBin = path.join(tmp, 'fake-claude-crash');
writeFake(crashBin, `#!/usr/bin/env sh
echo "boom" >&2
exit 1
`);

// Codex names its cache usage fields differently from Claude's `result` event
// (cached_input_tokens/cache_write_input_tokens vs. cache_read_input_tokens/
// cache_creation_input_tokens) — regression for the bug where those fields were
// silently read under Claude's names and always came out 0 for Codex tasks.
const codexBin = path.join(tmp, 'fake-codex-ok');
writeFake(codexBin, `#!/usr/bin/env sh
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Готово"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":80,"cache_write_input_tokens":15}}'
`);

const baseOpts = {
  engine: 'claude', taskId: 't-smoke', chatId: '42', thinkingStart: Date.now(),
  msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
  user: { username: 'smoke', workDir: tmp, name: 'Smoke' },
  cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
  restartShutdown: () => false,
  activeTimers: new Map(),
  tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }),
  outputCallback: null,
  engineBin: okBin, engineArgs: ['--print', 'test'], cwd: tmp,
};

(async () => {
  // (0) P3a: per-step engine budget clamping. No option keeps the fixed pair;
  // a step budget shortens the hard cap with its warning 2 min before it, and
  // can never extend past the global cap.
  assert.deepEqual(computeEngineTimeoutMs(null), { hardTimeoutMs: _const.CLAUDE_TIMEOUT_MS, warnTimeoutMs: _const.WARN_TIMEOUT_MS });
  assert.deepEqual(computeEngineTimeoutMs(600_000), { hardTimeoutMs: 600_000, warnTimeoutMs: 480_000 });
  assert.equal(computeEngineTimeoutMs(99 * 60 * 1000).hardTimeoutMs, _const.CLAUDE_TIMEOUT_MS, 'step budget never extends past the cap');
  assert.equal(computeEngineTimeoutMs(30_000).warnTimeoutMs, 30_000, 'very short budget floors the warning at 30s');

  // (1) happy path
  let streamed = '';
  const r1 = await runEngineProcess({ ...baseOpts, outputCallback: (t) => { streamed += t; } });
  assert.equal(r1.terminalSuccess, true, 'terminalSuccess on result event');
  assert.equal(r1.claudeResult, 'Привет мир');
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.processError, null);
  assert.equal(r1.timedOut, false);
  assert.equal(r1.sessionState.userStopped, false);
  assert.ok(r1.claudeUsage && r1.claudeUsage.input_tokens === 10, 'usage captured');
  assert.ok(streamed.includes('Привет'), 'outputCallback streamed text');
  assert.ok(r1.fullOutput.text.includes('Привет мир'), 'fullOutput accumulated');

  // (2) crash — no hang, exitCode set, no throw
  const started = Date.now();
  const r2 = await runEngineProcess({ ...baseOpts, engineBin: crashBin });
  const elapsed = Date.now() - started;
  assert.notEqual(r2.exitCode, 0, 'crash exit code non-zero');
  assert.equal(r2.terminalSuccess, false);
  assert.equal(r2.timedOut, false);
  assert.ok(elapsed < 5000, `crash returns promptly (${elapsed}ms)`);
  assert.equal(r2.fullOutput.text.trim(), '', 'no streamed text on crash');

  // (3) activeTimers registration + cleanup
  assert.equal(baseOpts.activeTimers.has('t-smoke'), false, 'timer cleaned up');

  // (2.5) codex usage normalization — cache fields land under Claude's field names
  const r2b = await runEngineProcess({ ...baseOpts, engine: 'codex', engineBin: codexBin });
  assert.equal(r2b.terminalSuccess, true, 'codex terminalSuccess on turn.completed');
  assert.ok(r2b.claudeUsage, 'codex usage captured');
  assert.equal(r2b.claudeUsage.cache_read_input_tokens, 80, 'codex cached_input_tokens normalized to cache_read_input_tokens');
  assert.equal(r2b.claudeUsage.cache_creation_input_tokens, 15, 'codex cache_write_input_tokens normalized to cache_creation_input_tokens');

  // (4) buildEngineCommand — claude path uses stream-json + mcp-config
  const [bin, args] = buildEngineCommand({
    engine: 'claude', prompt: 'P', systemPromptText: null, ocSystemPrompt: null,
    opencodeModel: null, mcpConfig: '/tmp/mcp.json', systemPromptFile: null,
    user: { cwd: '/tmp' },
  });
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'claude args stream-json');
  assert.ok(args.includes('--mcp-config'), 'claude args mcp-config');
  assert.equal(args[args.length - 1], 'P');

  // (5) codex/opencode MCP wiring — regression for the gap where codex/opencode had no
  // MCP tools at all (agent_store_artifact, hermes_run, etc. were invisible to them).
  const mcpFixture = path.join(tmp2, '.mcp.json');
  fs.writeFileSync(mcpFixture, JSON.stringify({
    mcpServers: {
      'trained-skills': { command: 'node', args: ['/opt/mcp-skills/index.js'], env: { USER_ID: '99', HOME: '/home/x' } },
    },
  }));

  const { codexMcpArgs, writeOpencodeMcpConfig } = require('../src/runner/claude-runner');
  const [, codexArgs] = buildEngineCommand({
    engine: 'codex', prompt: 'P', systemPromptText: null, mcpConfig: mcpFixture, user: { cwd: tmp2 },
  });
  assert.ok(codexArgs.includes('-c'), 'codex args include -c overrides');
  assert.ok(codexArgs.some(a => a === 'mcp_servers.trained-skills.command="node"'), 'codex mcp command override');
  assert.ok(codexArgs.some(a => a.startsWith('mcp_servers.trained-skills.env=') && a.includes('USER_ID="99"')), 'codex mcp env override');
  assert.ok(codexArgs.includes('tool_output_token_limit=4000'), 'codex args cap tool-output tokens (validated 2026-09-23, ~40% uncached-token cut)');
  assert.deepEqual(codexMcpArgs(mcpFixture), codexArgs.slice(8, -1), 'codexMcpArgs matches what buildEngineCommand spliced in');

  const ocConfigPath = writeOpencodeMcpConfig(tmp2, mcpFixture);
  const ocConfig = JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
  assert.deepEqual(ocConfig.mcp['trained-skills'].command, ['node', '/opt/mcp-skills/index.js'], 'opencode mcp command array');
  assert.deepEqual(ocConfig.mcp['trained-skills'].environment, { USER_ID: '99', HOME: '/home/x' }, 'opencode mcp environment');
  assert.equal(ocConfig.mcp['trained-skills'].type, 'local', 'opencode mcp type=local');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  console.log('V2 PASS: happy path + crash-no-hang + timers cleanup + command build + codex/opencode mcp wiring');

  // (6) editLanded — pins the ⛔/➕ button delivery contract. progressEdit is
  // best-effort+coalesced (tg-stream.js), so a real Telegram success, a 429
  // drop, and a coalesce-skip are three different shapes; only the first one
  // means the buttons actually reached the chat.
  assert.equal(editLanded({ ok: true, message_id: 1 }), true, 'real Telegram success lands');
  assert.equal(editLanded({ ok: false, flooded: true }), false, '429 best-effort drop does not land');
  assert.equal(editLanded({ ok: true, skipped: true }), false, 'coalesce-skip does not land (text/markup unchanged)');
  assert.equal(editLanded(undefined), false, 'no response (thrown+caught) does not land');
  assert.deepEqual(
    runningControls('t-x').reply_markup.inline_keyboard[0].map(b => b.callback_data),
    ['stop|t-x', 'sup|t-x'],
    'runningControls pairs ⛔ Стоп with ➕ Дополнить on the same row'
  );
  assert.deepEqual(runningControls('t-x', 123).reply_markup.inline_keyboard[1].map(b => b.callback_data),
    ['input_run|123', 'input_journal|123'], 'input controls stay bound to the exact launch message');
  // Telegram rejects callback_data > 64 bytes (400 BUTTON_DATA_INVALID) and
  // with it the whole progress edit. Real tg taskIds are `<user>-tg-<64hex>`.
  {
    const longId = 'trained-assist-product-owner-tg-' + 'a'.repeat(64);
    const keys = runningControls(longId).reply_markup.inline_keyboard[0].map(b => b.callback_data);
    for (const k of keys) {
      const key = k.slice(k.indexOf('|') + 1);
      for (const prefix of ['stop|', 'sup|', 'stopok|', 'stopno|', 'supok|', 'supno|']) {
        assert.ok(Buffer.byteLength(prefix + key) <= 64, `${prefix}<key> fits Telegram's 64-byte callback_data (${Buffer.byteLength(prefix + key)})`);
      }
    }
    assert.deepEqual(runningControls(longId), runningControls(longId), 'long-id key is deterministic across ticks');
    assert.notEqual(runningControls(longId + 'b').reply_markup.inline_keyboard[0][0].callback_data, keys[0], 'distinct tasks get distinct keys');
  }

  // (7) Regression for the bug this fixes: a heartbeat tick that hits STOP_BUTTON_
  // AFTER_SECS but gets its edit dropped (429/coalesce) used to still mark the
  // buttons "shown" and never retry — ⛔/➕ silently never appeared for the rest
  // of the task. Fake engine stays quiet past STOP_BUTTON_AFTER_SECS so the
  // heartbeat (not the stream) timer drives this; injected tgEdit drops exactly
  // the first button-carrying edit, then succeeds.
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-buttons-'));
  const quietBin = path.join(tmp3, 'fake-claude-quiet');
  writeFake(quietBin, `#!/usr/bin/env sh
sleep 17
echo '{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const buttonEdits = [];
  const flakyTgEdit = async (token, chatId, messageId, text, extra) => {
    if (extra?.reply_markup) {
      buttonEdits.push(extra);
      if (buttonEdits.length === 1) return { ok: false, flooded: true }; // simulate a dropped 429
    }
    return { ok: true, message_id: messageId };
  };
  await runEngineProcess({
    ...baseOpts, engineBin: quietBin, cwd: tmp3, msgId: 'm-1', taskId: 't-retry',
    thinkingStart: Date.now(), user: { username: 'smoke', workDir: tmp3, name: 'Smoke' },
    tgEdit: flakyTgEdit,
  });
  assert.ok(buttonEdits.length >= 2, `expected a dropped attempt + a landed retry, got ${buttonEdits.length} button-carrying edits`);
  assert.deepEqual(
    buttonEdits[0].reply_markup.inline_keyboard[0].map(b => b.callback_data),
    ['stop|t-retry', 'sup|t-retry'],
    'the dropped attempt still carried both buttons (not silently downgraded to Стоп-only)'
  );
  fs.rmSync(tmp3, { recursive: true, force: true });
  console.log('V2b PASS: editLanded gate + dropped button edit retries instead of being marked shown');

  // (8) Regression for the "buttons visible for 1 second then vanish" bug:
  // editMessageText WITHOUT reply_markup clears the keyboard. The old code sent
  // markup only on the first landing and bare text on every later tick, so the
  // next progress edit erased ⛔/➕. Every landed progress edit past the
  // threshold must carry the running-controls markup.
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-persist-'));
  const quietBin2 = path.join(tmp4, 'fake-claude-quiet2');
  writeFake(quietBin2, `#!/usr/bin/env sh
sleep 17
echo '{"type":"result","result":"done","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const landedEdits = [];
  const persistTgEdit = async (token, chatId, messageId, text, extra) => {
    if (!extra?.reply_markup) landedEdits.push({ bare: true, text });
    else landedEdits.push({ bare: false, keys: extra.reply_markup.inline_keyboard[0].map(b => b.callback_data) });
    return { ok: true, message_id: messageId };
  };
  await runEngineProcess({
    ...baseOpts, engineBin: quietBin2, cwd: tmp4, msgId: 'm-1', taskId: 't-persist',
    thinkingStart: Date.now(), user: { username: 'smoke', workDir: tmp4, name: 'Smoke' },
    tgEdit: persistTgEdit,
  });
  const postThreshold = landedEdits.filter(e => !e.bare);
  assert.ok(postThreshold.length >= 3, `expected several button-carrying edits across ticks, got ${postThreshold.length}`);
  for (const e of postThreshold) {
    assert.deepEqual(e.keys, ['stop|t-persist', 'sup|t-persist'], 'every post-threshold edit carries ⛔/➕ markup (no bare edits after buttons appear)');
  }
  assert.ok(!landedEdits.some(e => e.bare && landedEdits.indexOf(e) > landedEdits.indexOf(postThreshold[0])), 'no bare (button-stripping) edit after the first button-carrying one');
  fs.rmSync(tmp4, { recursive: true, force: true });
  console.log('V2c PASS: buttons persist across consecutive progress edits (no button-stripping edits)');

  // (9) Zombie timer regression: codex spawns a codex-code-mode-host that inherits
  // the stdout pipe, so proc.on('close') can stall forever after the engine dies.
  // The exitWatcher must force-finish the run and the progress timers must stop
  // re-arming — otherwise the "Думаю… (742с)" message keeps being edited by the
  // dead run while a successor session edits its own ("742с + 3с in one chat").
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-zombie-'));
  const zombieBin = path.join(tmp5, 'fake-zombie');
  writeFake(zombieBin, `#!/usr/bin/env sh
(sleep 100) &
sleep 2
echo "boom" >&2
exit 1
`);
  const zombieT0 = Date.now();
  const zombieEdits = [];
  const zombieTgEdit = async (token, chatId, messageId, text, extra) => {
    zombieEdits.push(Math.round(Date.now() - zombieT0));
    return { ok: true };
  };
  // Must NOT hang forever: the watcher force-finishes ~3s after the engine dies.
  const zombieResult = await Promise.race([
    runEngineProcess({
      ...baseOpts, engineBin: zombieBin, cwd: tmp5, msgId: 'm-1', taskId: 't-zombie',
      thinkingStart: zombieT0, user: { username: 'smoke', workDir: tmp5, name: 'Smoke' },
      tgEdit: zombieTgEdit,
    }).catch(e => ({ forceFinished: /stalled/.test(e.message) })),
    new Promise(r => setTimeout(() => r({ hung: true }), 10_000)),
  ]);
  assert.ok(!zombieResult?.hung, 'zombie: runEngineProcess must force-finish instead of hanging');
  // All edits must have landed before the engine died (~2s), never after.
  const lastEdit = zombieEdits.length ? zombieEdits[zombieEdits.length - 1] : 0;
  assert.ok(zombieEdits.length > 0, 'zombie: expected at least one progress edit before engine death');
  assert.ok(lastEdit <= 3000, `zombie: no progress edit after engine death (~2s), last was ${lastEdit}ms`);
  // Kill the fake "host" (it inherited our stdout pipe — leaving it would block
  // the test runner's own EOF). exec() here is a syscall, not a command runner.
  try { require('node:child_process').spawnSync('pkill', ['-f', 'sleep 100']); } catch {}
  fs.rmSync(tmp5, { recursive: true, force: true });
  console.log('V2d PASS: zombie engine force-finishes; progress timers die with the engine (no 742с+3с overlap)');

  // (10) Silent-progress-failure regression (2026-09-24 freeze): a progress edit
  // that THROWS a non-429 error ("message to edit not found", timeout, 4xx/5xx)
  // must NOT be swallowed — it must be logged, and after MAX_PROGRESS_HARD_FAILS
  // consecutive hard failures the heartbeat must fall back to a fresh sendMessage
  // so the user sees a live message instead of a frozen "(2с)" forever. A resolved
  // drop ({ok:false,flooded}/{skipped}) is intentional backpressure and must NOT
  // count toward the fallback.
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-hardfail-'));
  const hardBin = path.join(tmp6, 'fake-slow');
  // Emit nothing for ~8s so only heartbeat (not stream) edits fire, then finish.
  writeFake(hardBin, `#!/usr/bin/env sh
sleep 8
echo '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const hardT0 = Date.now();
  let hardEditCalls = 0;
  let hardSendCalls = 0;
  let hardFellBackAt = -1;
  const hardEdit = async () => { hardEditCalls++; throw new Error('Bad Request: message to edit not found'); };
  const hardSend = async (_token, _chat, _text, extra) => {
    assert.deepEqual(extra.reply_markup.inline_keyboard[1].map(b => b.callback_data),
      ['input_run|m-hf', 'input_journal|m-hf'], 'replacement status retains the original snapshot identity');
    hardSendCalls++; if (hardFellBackAt < 0) hardFellBackAt = hardEditCalls; return { ok: true }; };
  const origErr = console.error;
  const errLines = [];
  console.error = (...a) => { errLines.push(a.join(' ')); };
  try {
    await runEngineProcess({
      ...baseOpts, engineBin: hardBin, cwd: tmp6, msgId: 'm-hf', taskId: 't-hardfail',
      thinkingStart: hardT0, user: { username: 'smoke', workDir: tmp6, name: 'Smoke' },
      tgEdit: hardEdit, tgSend: hardSend,
    });
  } finally { console.error = origErr; }
  assert.ok(hardEditCalls >= 3, `hardfail: expected >=3 progress edits, got ${hardEditCalls}`);
  assert.ok(errLines.some(l => /progress edit failed/.test(l) && /message to edit not found/.test(l)),
    'hardfail: a thrown progress edit must be logged, not swallowed');
  assert.ok(hardSendCalls >= 1, `hardfail: after ${hardEditCalls} hard fails must fall back to sendMessage, got ${hardSendCalls}`);
  assert.ok(hardFellBackAt >= 3, `hardfail: fallback must not fire before MAX_PROGRESS_HARD_FAILS (fired after ${hardFellBackAt})`);
  fs.rmSync(tmp6, { recursive: true, force: true });
  console.log('V2e PASS: hard progress-edit failures are logged + fall back to sendMessage (no silent freeze)');

  // (11) onProgress (2026-09-27): live activity for the web SSE stream. The
  // runner must emit the initial "Думаю…" at spawn and the tool label the moment
  // a tool_use arrives — even with msgId=null (chatless web run, no heartbeat).
  const tmp7 = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-smoke-progress-'));
  const toolBin = path.join(tmp7, 'fake-claude-tool');
  writeFake(toolBin, `#!/usr/bin/env sh
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Готово"}]}}'
echo '{"type":"result","result":"Готово","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  const progressLabels = [];
  const rP = await runEngineProcess({
    ...baseOpts, engineBin: toolBin, cwd: tmp7, taskId: 't-progress',
    onProgress: (label) => progressLabels.push(label),
  });
  assert.equal(rP.terminalSuccess, true, 'tool_use + result still completes normally');
  assert.equal(progressLabels[0], 'Думаю…', 'initial progress emitted at spawn');
  assert.ok(progressLabels.some(l => l === '💻 ls -la'), `tool label surfaced to onProgress, got ${JSON.stringify(progressLabels)}`);
  assert.ok(progressLabels.length >= 2, `expected spawn + tool events, got ${progressLabels.length}`);
  fs.rmSync(tmp7, { recursive: true, force: true });
  console.log('V2f PASS: onProgress surfaces spawn + tool activity without a Telegram message');
})();