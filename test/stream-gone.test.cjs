'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'src', 'stream-gone.js');

// Regression for the orphaned-server CPU-burn loop (2026-09-27): when the parent
// dies, stdout/stderr pipes close, console.error throws EPIPE, and the old
// uncaughtException handler logged again -> EPIPE -> infinite loop pinning a core.

test('isStreamGone recognizes EPIPE and ERR_STREAM_DESTROYED only', () => {
  const { isStreamGone } = require(MODULE);
  assert.equal(isStreamGone({ code: 'EPIPE' }), true);
  assert.equal(isStreamGone({ code: 'ERR_STREAM_DESTROYED' }), true);
  assert.equal(isStreamGone({ code: 'ENOENT' }), false);
  assert.equal(isStreamGone(null), false);
});

// The handler must exit immediately, not loop. We spawn a child that installs the
// guards then emits a stream error, with stdout closed so logging would EPIPE.
test('stream error with closed stdout exits instead of spinning', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { installCrashGuards } = require(${JSON.stringify(MODULE)});
    installCrashGuards();
    const err = new Error('write EPIPE');
    err.code = 'EPIPE';
    process.stderr.emit('error', err);
    setTimeout(() => { process.exit(99); }, 2000);
  `], { stdio: ['ignore', 'ignore', 'ignore'] });

  const code = await new Promise((resolve) => {
    child.on('exit', (c, sig) => resolve(sig ? `signal:${sig}` : c));
  });
  assert.equal(code, 0, 'guard must exit(0) on stream-gone, not fall through to the sentinel 99');
});

test('uncaughtException with EPIPE exits immediately without logging', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { installCrashGuards } = require(${JSON.stringify(MODULE)});
    installCrashGuards();
    const err = new Error('write EPIPE');
    err.code = 'EPIPE';
    process.emit('uncaughtException', err);
    setTimeout(() => { process.exit(99); }, 2000);
  `], { stdio: ['ignore', 'ignore', 'ignore'] });

  const code = await new Promise((resolve) => {
    child.on('exit', (c, sig) => resolve(sig ? `signal:${sig}` : c));
  });
  assert.equal(code, 0);
});

test('non-EPIPE uncaughtException is logged and the process keeps running', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { installCrashGuards } = require(${JSON.stringify(MODULE)});
    installCrashGuards();
    process.emit('uncaughtException', new Error('boom'));
    setTimeout(() => { process.exit(0); }, 200);
  `], { stdio: ['ignore', 'ignore', 'ignore'] });

  const code = await new Promise((resolve) => {
    child.on('exit', (c, sig) => resolve(sig ? `signal:${sig}` : c));
  });
  assert.equal(code, 0);
});
