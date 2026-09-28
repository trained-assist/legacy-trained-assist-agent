'use strict';
// Issue #1687 wiring: an OpenCode run gets the llm-ladder `ladder` provider in its per-run
// OPENCODE_CONFIG and the worker token as OPENCODE_LADDER_TOKEN, and a worker-unreachable error
// event comes back as codexErrorMsg in the text classifyWorkerFailure recognises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runEngineProcess } = require('../src/runner/claude-runner');
const ocLadder = require('../src/opencode-ladder-provider');

test('opencode run: ladder provider + token reach the engine; unreachable worker is categorised', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-ladder-run-'));
  const dump = path.join(tmp, 'seen.json');
  const bin = path.join(tmp, 'fake-opencode');
  fs.writeFileSync(bin, `#!/usr/bin/env sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ cfg: require("fs").readFileSync(process.env.OPENCODE_CONFIG, "utf8"), token: process.env.OPENCODE_LADDER_TOKEN || null }))' "${dump}"
echo '{"type":"error","error":{"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?"}}}'
exit 1
`);
  fs.chmodSync(bin, 0o755);

  const r = await runEngineProcess({
    engine: 'opencode', taskId: 't-oc-ladder', chatId: '42', thinkingStart: Date.now(),
    msgId: null, BOT_TOKEN: 'tok', secrets: { BOT_TOKEN: 'tok' },
    user: { username: 'smoke', workDir: tmp, name: 'Smoke' },
    cleanEnv: { PATH: process.env.PATH }, userTokens: {}, sessionFilePath: '',
    restartShutdown: () => false, activeTimers: new Map(),
    tgEdit: async () => ({ ok: true }), tgSend: async () => ({ ok: true }), outputCallback: null,
    engineBin: bin, engineArgs: [], cwd: tmp, mcpConfig: null,
    ocProfileOverrides: ocLadder.buildOcProfileOverrides('doctor'),
  });

  const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
  const cfg = JSON.parse(seen.cfg);
  assert.equal(cfg.model, 'ladder/doctor:build');
  assert.equal(cfg.agent.review.model, 'ladder/doctor:review');
  assert.equal(cfg.provider.ladder.options.apiKey, '{env:OPENCODE_LADDER_TOKEN}');
  assert.equal(seen.token, process.env.LLM_LADDER_TOKEN, 'worker token injected as OPENCODE_LADDER_TOKEN');
  assert.equal(r.terminalSuccess, false);
  assert.equal(ocLadder.classifyWorkerFailure(r.codexErrorMsg), 'worker_unreachable');
  fs.rmSync(tmp, { recursive: true, force: true });
});
