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

test('core entry modules load without the hh-skill sibling', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./src/handlers/hh');require('./src/runner/intent-engine');"], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HH_SKILL_DIR: path.join(os.tmpdir(), 'no-such-hh-skill-' + process.pid) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[hh-lib\] hh-\S+ unavailable/);
});
