'use strict';
// Regression guards for #1583: a degraded opencode model that repeats the SAME
// assistant text part (or the same tool+input) over and over must be killed by the
// loop guard instead of burning the full 40-min budget. The fake engine streams N
// identical text/tool events; the guard should SIGTERM (run ends, loopKilled=true,
// codexErrorMsg set) rather than reach step_finish.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineProcess, _const } = require('../src/runner/claude-runner');

function mkdir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function writeFake(dir, name, script) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return p;
}
function baseOpts(dir, engineBin) {
  return {
    engine: 'opencode', taskId: 't-loop', chatId: '42', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
    user: { username: 'loop', workDir: dir, name: 'Loop' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }),
    outputCallback: null, engineBin, engineArgs: ['--print', 'x'], cwd: dir,
  };
}

function repeatEvents(events, n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(...events);
  return lines.map(l => `echo '${l}'`).join('\n');
}

test('loop guard: repeated identical text part kills the run with loopKilled=true', async () => {
  const dir = mkdir('loop-text-');
  // 12 identical text parts — far past LOOP_GUARD_REPEAT_LIMIT (6).
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
${repeatEvents([
  '{"type":"text","part":{"text":"Публикую доку через publish_page."}}',
], 12)}
echo '{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}'
`);
  const r = await runEngineProcess(baseOpts(dir, bin));
  assert.equal(r.loopKilled, true, 'loopKilled surfaced to the caller');
  assert.equal(r.timedOut, true, 'loop kill is treated like a timeout at the process level');
  assert.ok(r.codexErrorMsg && /зациклилась/.test(r.codexErrorMsg), `error message explains the loop, got: ${r.codexErrorMsg}`);
  assert.equal(r.terminalSuccess, false, 'must NOT be a success');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: repeated identical tool call kills the run', async () => {
  const dir = mkdir('loop-tool-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
${repeatEvents([
  '{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"echo \\"PUBLISHING\\""}}}}',
], 12)}
echo '{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}'
`);
  const r = await runEngineProcess(baseOpts(dir, bin));
  assert.equal(r.loopKilled, true, 'loopKilled surfaced for tool repetition');
  assert.ok(r.codexErrorMsg && /зациклилась/.test(r.codexErrorMsg), `error explains the loop, got: ${r.codexErrorMsg}`);
  assert.equal(r.terminalSuccess, false, 'must NOT be a success');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: distinct text parts are NOT a loop (no false positive)', async () => {
  const dir = mkdir('loop-ok-');
  const bin = writeFake(dir, 'fake', `#!/usr/bin/env sh
echo '{"type":"text","part":{"text":"Сначала соберу факты."}}'
echo '{"type":"text","part":{"text":"Эндпоинт живой: ok."}}'
echo '{"type":"text","part":{"text":"Пишу доку и публикую."}}'
echo '{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}'
`);
  const r = await runEngineProcess(baseOpts(dir, bin));
  assert.equal(r.loopKilled, false, 'distinct texts never trigger the guard');
  assert.equal(r.terminalSuccess, true, 'run completes normally');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard constants are exposed for tuning', async () => {
  assert.ok(_const.LOOP_GUARD_REPEAT_LIMIT >= 3, `repeat limit sane: ${_const.LOOP_GUARD_REPEAT_LIMIT}`);
  assert.ok(_const.LOOP_GUARD_TEXT_MIN_LEN >= 10, `min text len sane: ${_const.LOOP_GUARD_TEXT_MIN_LEN}`);
});
// 2026-09-29 regression: a DeepSeek run that could not emit the MCP call it wanted
// (trained-skills_playbook_get) spun ~5 min on bash placeholders that DIFFER from each
// other, so the identical-signature guard only fired much later. Replay of the real
// sequence from that session: any LOOP_GUARD_NOOP_LIMIT no-op calls in a row → kill.
function bashEvent(cmd) {
  return JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: cmd } } } })
    .replace(/'/g, `'"'"'`);
}
function fakeFromCommands(dir, cmds) {
  return writeFake(dir, 'fake', `#!/usr/bin/env sh
${cmds.map(c => `echo '${bashEvent(c)}'`).join('\n')}
echo '{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}'
`);
}

test('loop guard: streak of DIFFERENT no-op bash placeholders kills the run (real 2026-09-29 sequence)', async () => {
  const dir = mkdir('loop-noop-');
  const bin = fakeFromCommands(dir, [
    'gh issue view 17 --repo trained-assist/trained-assist-llm-ladder --json title,state 2>&1',
    'true', 'true', `node -e 'console.log("playbook check")' 2>&1`, 'echo "done"', 'echo ok',
    `python3 -c "print('x')" 2>&1`, 'true', 'true', 'true',
  ]);
  const r = await runEngineProcess(baseOpts(dir, bin));
  assert.equal(r.loopKilled, true, 'no-op streak must be treated as a loop');
  assert.ok(/пустых bash-вызовов/.test(r.codexErrorMsg || ''), `error explains the no-op loop, got: ${r.codexErrorMsg}`);
  assert.equal(r.terminalSuccess, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: no-op calls interleaved with real work are NOT a loop', async () => {
  const dir = mkdir('loop-noop-ok-');
  const cmds = [];
  for (let i = 0; i < 4; i++) cmds.push('true', 'echo ok', 'echo done', 'echo "---"', `ls /tmp/x${i}`);
  const bin = fakeFromCommands(dir, cmds);
  const r = await runEngineProcess(baseOpts(dir, bin));
  assert.equal(r.loopKilled, false, 'streak resets on every real command');
  assert.equal(r.terminalSuccess, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isNoopBash: placeholders yes, real commands no', () => {
  const { isNoopBash } = require('../src/runner/claude-runner');
  for (const c of ['true', ':', '', 'echo ok', 'echo "done"', `python3 -c "print('x')" 2>&1`, `node -e 'console.log("hi")'`]) {
    assert.equal(isNoopBash('bash', { command: c }), true, c);
  }
  for (const c of ['gh pr list', 'echo $HOME', 'echo ok > f', 'true && rm -rf x', 'echo a | tee f', 'python3 -c "import os;print(1)"']) {
    assert.equal(isNoopBash('bash', { command: c }), false, c);
  }
  assert.equal(isNoopBash('read', { command: 'true' }), false, 'only bash counts');
});
