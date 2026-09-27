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

const failed = [];
for (const f of files) {
  const file = path.join('test', f);
  const usesNodeTest = /require\(['"]node:test['"]\)/.test(fs.readFileSync(path.join(dir, f), 'utf8'));
  const args = usesNodeTest ? ['--test', file] : [file];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  const ok = r.status === 0;
  console.log(`[cjs] ${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - t0}ms)`);
  if (!ok) failed.push(file);
}
console.log(`[cjs] ${files.length - failed.length}/${files.length} files passed`);
if (failed.length) {
  console.log(`[cjs] FAILED:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
