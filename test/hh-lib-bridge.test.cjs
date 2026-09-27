'use strict';
// src/domains/hh/lib.js — core's single path to HH domain code in trained-assist-hh-skill
// (epic #1470). A missing sibling degrades only HH calls; it must never crash core at load.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'domains', 'hh', 'lib.js');

function freshLib(env) {
  const saved = process.env.HH_SKILL_DIR;
  if (env === undefined) delete process.env.HH_SKILL_DIR; else process.env.HH_SKILL_DIR = env;
  delete require.cache[require.resolve(LIB)];
  const lib = require(LIB);
  return { lib, restore: () => { if (saved === undefined) delete process.env.HH_SKILL_DIR; else process.env.HH_SKILL_DIR = saved; } };
}

test('resolves hh-skill two levels above the release dir (deploy.sh links it there)', () => {
  const { lib, restore } = freshLib(undefined);
  try {
    assert.equal(lib.hhSkillDir(), path.join(ROOT, '..', 'trained-assist-hh-skill'));
    assert.equal(lib.hhModulePath('hh-utils'), path.join(ROOT, '..', 'trained-assist-hh-skill', 'src', 'hh-utils'));
  } finally { restore(); }
});

test('only hh-* module names are accepted', () => {
  const { lib, restore } = freshLib(undefined);
  try { assert.throws(() => lib.hhModulePath('../secrets'), /not an hh-skill module/); } finally { restore(); }
});

test('loads a module from HH_SKILL_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-lib-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'hh-fake.js'), "module.exports = { ping: () => 'pong', K: 1 };");
  const { lib, restore } = freshLib(dir);
  try {
    const m = lib.hhLib('hh-fake');
    assert.equal(m.ping(), 'pong');
    assert.equal(m.K, 1);
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing sibling: exports throw a clear error instead of crashing at require time', () => {
  const { lib, restore } = freshLib(path.join(os.tmpdir(), 'no-such-hh-skill-' + process.pid));
  const origError = console.error; console.error = () => {};
  try {
    const { refreshHhToken } = lib.hhLib('hh-utils');
    assert.throws(() => refreshHhToken('u'), /hh-skill module hh-utils unavailable/);
  } finally { console.error = origError; restore(); }
});

test('server starts and serves core routes without the hh-skill sibling; only /hh/* fails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-lib-server-'));
  const port = 13000 + (process.pid % 2000);
  const { spawn } = require('child_process');
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SECRETS_SOURCE: 'env', TELEGRAM_BOT_TOKEN: 'test-tg', AGENT_SECRET: 's3cret',
      USERS_DIR: path.join(tmp, 'users'), AGENT_DATA_DIR: path.join(tmp, 'data'), AGENT_TOKENS_DIR: path.join(tmp, 'tokens'),
      NODE_ENV: 'test', HH_SKILL_DIR: path.join(tmp, 'no-such-hh-skill') },
  });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const onData = c => { out += c; if (out.includes('listening on')) resolve(); };
      proc.stdout.on('data', onData); proc.stderr.on('data', onData);
      proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
      setTimeout(() => reject(new Error(`server did not start in 20s\n${out}`)), 20_000);
    });
    assert.match(out, /\[hh-lib\] hh-\S+ unavailable/);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const hh = await fetch(`http://127.0.0.1:${port}/hh/review?username=u`);
    assert.ok(hh.status >= 500, `expected HH route to fail, got ${hh.status}`);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, 'server survives a failed HH request');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('quick answers keep working without the hh-skill sibling (HH intents never match)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-lib-qa-'));
  const script = "require('./src/runner/intent-engine').runQuickAnswer('/hh_status', 'u', process.env.WD, null)" +
    ".then(r => { console.log('RESULT', JSON.stringify(r)); }, e => { console.error('THROWN', e.message); process.exit(1); })";
  try {
    const r = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: tmp, WD: tmp, USERS_DIR: tmp, AGENT_DATA_DIR: tmp, AGENT_TOKENS_DIR: tmp,
        HH_SKILL_DIR: path.join(tmp, 'no-such-hh-skill') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RESULT/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
