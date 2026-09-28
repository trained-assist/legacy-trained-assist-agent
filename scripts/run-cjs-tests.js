#!/usr/bin/env node
'use strict';
// Runs every test/*.cjs — discovered, not listed. The old hand-written chain in
// package.json "test:cjs" had two failure modes: (1) every PR appended to the same
// line, so parallel PRs always conflicted in package.json and auto-merge failed;
// (2) a test file nobody appended silently never ran (6 files on 2026-09-27).
// Files using node:test run under `node --test`, the rest (process.exit-style
// runners) under plain `node`. Sequential, one process per file, so tests keep the
// isolation they had; all files run, failures are summarised at the end.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'test');
const only = process.argv.slice(2);
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.cjs'))
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();

// Tests must never touch the LIVE OpenCode state under ~/.config/opencode and ~/.local/share/opencode.
// 2026-09-27 incident: test/oc-profile-pin.test.cjs sent '/oc_openrouter' through getQuickAnswer
// with no isolation, and every `npm test` run by an agent session ON THE VM flipped production's
// (since removed) go/openrouter toggle to a sticky OpenRouter — which drained the balance. The
// same class of leak still applies to the ladder log.
const os = require('os');
const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjs-oc-state-'));
const isoEnv = {
  LADDER_LOG_DIR: path.join(isoDir, 'ladder-log'),
  // Server-side state (pending-tasks, execution-history, stop-trace tombstones) —
  // same reasoning as LADDER_LOG_DIR: a test must never write into the live
  // ~/agent-data, least of all a «Стоп» tombstone that would then block real runs.
  // A test file may still point this at its own temp dir (see line below).
  AGENT_DATA_DIR: path.join(isoDir, 'agent-data'),
  // Runner RAM watchdog off in tests (see tests/setup-isolation.mjs).
  MIN_FREE_RAM_MB: '0',
};
// A test file may still point these at its own temp dir; it just can't fall through to $HOME.
const childEnv = { ...isoEnv, ...process.env };
// Provider keys from the developer's shell must not leak into tests (CI has none).
for (const k of ['OPENROUTER_API_KEY', 'OPENCODE_GO_API_KEYS', 'OPENCODE_GO_API_KEY', 'LLM_LADDER_TOKEN']) delete childEnv[k];
// …nor may they call the live llm-ladder worker: point service-llm at an unroutable host with a
// dummy token — tests that mock fetch see the worker's OpenAI-shaped protocol, anything unmocked
// fails soft instead of reaching production.
childEnv.LLM_LADDER_URL = 'http://llm-ladder.invalid';
childEnv.LLM_LADDER_TOKEN = 'test-ladder-token';
for (const k of Object.keys(isoEnv)) {
  if (process.env[k] && process.env[k].startsWith(os.homedir())) childEnv[k] = isoEnv[k];
}

const failed = [];
for (const f of files) {
  const file = path.join('test', f);
  const usesNodeTest = /require\(['"]node:test['"]\)/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
  const args = usesNodeTest ? ['--test', file] : [file];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: childEnv });
  const ok = r.status === 0;
  console.log(`[cjs] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - t0}ms)`);
  if (!ok) failed.push(file);
}
console.log(`[cjs] ${files.length - failed.length}/${files.length} files passed`);
fs.rmSync(isoDir, { recursive: true, force: true });
if (failed.length) {
  console.log(`[cjs] FAILED:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
