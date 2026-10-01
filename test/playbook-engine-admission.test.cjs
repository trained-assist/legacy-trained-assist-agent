'use strict';
// The durable level map sends the doctor rung to Claude, and quality escalation can land there too.
// With no Claude authorization both are a guaranteed wasted attempt: the engine dies on 401 before
// doing any work and the step loses one of its three tries (live 2026-10-01, host with the owner's
// credentials suspended). The rung must degrade to the fallback the level map already declares.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-admission-test-'));
  process.env.AGENT_DATA_DIR = dir;
  delete process.env.AGENT_CLAUDE_SWITCH;
  delete process.env.PLAYBOOK_LEVEL_MAP;
  delete process.env.PLAYBOOK_ROLE_MAP;
  for (const m of ['../src/auth-flag', '../src/engine-admission', '../src/playbook-executor']) {
    delete require.cache[require.resolve(m)];
  }
  return {
    flag: require('../src/auth-flag'),
    exec: require('../src/playbook-executor'),
    DEFAULT_LEVEL_MAP: require('../src/playbook-executor').DEFAULT_LEVEL_MAP,
  };
}

const ITEM = { executor_role: 'developer', minimum_model_level: 'doctor', current_model_level: 'doctor' };

test('doctor runs on Claude while Claude is admissible', () => {
  const { exec, DEFAULT_LEVEL_MAP } = fresh();
  const r = exec.resolveStepExecution(ITEM, { levelMap: DEFAULT_LEVEL_MAP });
  assert.equal(r.engine, 'claude');
});

test('a suspended Claude degrades doctor to the level map fallback, never to a dead engine', () => {
  const { flag, exec, DEFAULT_LEVEL_MAP } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'invalid_grant', engine: 'claude' });

  const r = exec.resolveStepExecution(ITEM, { levelMap: DEFAULT_LEVEL_MAP });
  assert.notEqual(r.engine, 'claude', 'doctor still targets a suspended engine');
  assert.equal(r.engine, 'codex', 'expected the level map first fallback');
  // The rung COUNT stays exactly what the level map declares — durable-recovery treats «no
  // fallbacks» as terminal, and reviewer@doctor is asserted as [codex → opencode doctor] exactly.
  const declared = DEFAULT_LEVEL_MAP.doctor.fallback;
  assert.equal(r.fallbacks.length, declared.length - 1, 'the promoted rung left the list — count must not grow');
  assert.deepEqual(r.fallbacks, declared.slice(1).map((fb) => ({
    engine: fb.engine,
    ocProfile: fb.engine === 'opencode' ? fb.ocProfile : null,
    ocRole: fb.engine === 'opencode' ? 'build' : null,
  })));
});

test('a level whose every rung is inadmissible keeps its original shape: no fallbacks', () => {
  const { flag, exec } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  const onlyClaude = { doctor: { engine: 'claude' } };
  const r = exec.resolveStepExecution(ITEM, { levelMap: onlyClaude });
  assert.equal(r.engine, 'opencode');
  // Adding a rung here would turn every terminal engine failure into an endless re-pend.
  assert.deepEqual(r.fallbacks, []);
});

test('every rung below stays free of claude while it is suspended', () => {
  const { flag, exec, DEFAULT_LEVEL_MAP } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  for (const level of ['bachelor', 'master', 'doctor']) {
    const r = exec.resolveStepExecution(
      { executor_role: 'developer', minimum_model_level: level, current_model_level: level },
      { levelMap: DEFAULT_LEVEL_MAP },
    );
    assert.notEqual(r.engine, 'claude', `${level} still targets claude`);
    assert.equal(r.fallbacks.some((f) => f.engine === 'claude'), false, `${level} keeps claude in its fallbacks`);
  }
});

test('a plan that pins its own level_map cannot overrule the machine-wide decision', () => {
  const { flag, exec } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  const pinned = {
    bachelor: { engine: 'claude' },
    master: { engine: 'claude' },
    doctor: { engine: 'claude' },
  };
  const r = exec.resolveStepExecution(ITEM, { levelMap: pinned, useRoleMap: false });
  assert.notEqual(r.engine, 'claude');
});

test('reviewer@doctor stays on the independent engine (codex), suspension or not', () => {
  const { flag, exec, DEFAULT_LEVEL_MAP } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  const r = exec.resolveStepExecution(
    { executor_role: 'reviewer', minimum_model_level: 'doctor', current_model_level: 'doctor' },
    { levelMap: DEFAULT_LEVEL_MAP },
  );
  assert.equal(r.engine, 'codex', 'a Claude review of Claude work is not independent — must not change');
});

test('programmatic steps are untouched — they never pick an engine', () => {
  const { flag, exec, DEFAULT_LEVEL_MAP } = fresh();
  flag.suspendAuthFailedFlag({ reason: 'AUTH_INVALID', error_text: 'x', engine: 'claude' });
  const r = exec.resolveStepExecution(
    { execution_kind: 'programmatic', executor_role: 'verifier', minimum_model_level: 'doctor' },
    { levelMap: DEFAULT_LEVEL_MAP },
  );
  assert.equal(r.engine, null);
});