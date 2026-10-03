// Playbook executor resolver (issue #1372 P3b): item contract → engine/profile/role.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveStepExecution, DEFAULT_LEVEL_MAP, ROLE_TO_OC } = require('../../src/playbook-executor');

const agent = (over = {}) => ({
  execution_kind: 'agent', executor_role: 'developer',
  minimum_model_level: 'master', current_model_level: 'master',
  context_budget: 'medium', ...over,
});

describe('resolveStepExecution', () => {
  it('programmatic steps resolve to no engine (objective, no model)', () => {
    const r = resolveStepExecution({ execution_kind: 'programmatic' });
    expect(r).toMatchObject({ executionKind: 'programmatic', engine: null, ocProfile: null, ocRole: null, reason: 'programmatic' });
  });

  it('legacy/contract-less items keep the default engine and no override', () => {
    const r = resolveStepExecution({ execution_kind: 'agent' }, { defaultEngine: 'claude' });
    expect(r).toMatchObject({ executionKind: 'agent', engine: 'claude', ocProfile: null, ocRole: null, reason: 'no-contract' });
  });

  // 2026-10-01: researcher is no longer pinned to the Go `research` subscription (weekly cap
  // exhausted → silent hang); it goes through the llm-ladder like every level.
  it('researcher goes through the llm-ladder (deepseek), explore role', () => {
    expect(resolveStepExecution(agent({ executor_role: 'researcher', minimum_model_level: 'bachelor', current_model_level: 'bachelor' })))
      .toMatchObject({ engine: 'opencode', ocProfile: 'service', ocRole: 'explore', modelLevel: 'bachelor' });
  });

  it('master → opencode Go deepseek too (owner 2026-09-27: value/max leaked to OpenRouter); developer maps to build', () => {
    expect(resolveStepExecution(agent())).toMatchObject({ engine: 'opencode', ocProfile: 'service', ocRole: 'build' });
  });

  it('doctor → claude, no opencode override', () => {
    expect(resolveStepExecution(agent({ executor_role: 'developer', minimum_model_level: 'doctor', current_model_level: 'doctor' })))
      .toMatchObject({ engine: 'claude', ocProfile: null, ocRole: null, modelLevel: 'doctor' });
  });

  it('reviewer@doctor = independent review: codex, then opencode doctor, never claude (owner 2026-09-30)', () => {
    const r = resolveStepExecution(agent({ executor_role: 'reviewer', minimum_model_level: 'doctor', current_model_level: 'doctor' }));
    expect(r).toMatchObject({ engine: 'codex', ocProfile: null, ocRole: null, modelLevel: 'doctor' });
    expect(r.fallbacks).toEqual([{ engine: 'opencode', ocProfile: 'doctor', ocRole: 'review' }]);
    expect([r.engine, ...r.fallbacks.map(f => f.engine)]).not.toContain('claude');
  });

  it('reviewer@doctor without role routing (plan pins its own level_map) keeps the level map', () => {
    expect(resolveStepExecution(agent({ executor_role: 'reviewer', minimum_model_level: 'doctor', current_model_level: 'doctor' }), { useRoleMap: false }).engine)
      .toBe('claude');
  });

  it('reviewer below doctor stays on opencode review', () => {
    expect(resolveStepExecution(agent({ executor_role: 'reviewer' }))).toMatchObject({ engine: 'opencode', ocRole: 'review' });
  });

  it('verifier maps to the review OC role', () => {
    expect(resolveStepExecution(agent({ executor_role: 'verifier', minimum_model_level: 'master', current_model_level: 'master' })).ocRole).toBe('review');
  });

  it('an escalated current_model_level wins over the minimum (no downgrade)', () => {
    const r = resolveStepExecution(agent({ minimum_model_level: 'bachelor', current_model_level: 'doctor' }));
    expect(r).toMatchObject({ engine: 'claude', modelLevel: 'doctor' });
  });

  it('levelMap override is data, not code', () => {
    const r = resolveStepExecution(agent({ minimum_model_level: 'bachelor', current_model_level: 'bachelor' }), {
      levelMap: { ...DEFAULT_LEVEL_MAP, bachelor: { engine: 'opencode', ocProfile: 'free' } },
    });
    expect(r.ocProfile).toBe('free');
  });

  it('researcher uses the level map by default and role map can override it', () => {
    expect(resolveStepExecution(agent({ executor_role: 'researcher', minimum_model_level: 'master', current_model_level: 'master' })))
      .toMatchObject({ engine: 'opencode', ocProfile: 'service', ocRole: 'explore' });
    expect(resolveStepExecution(agent({ executor_role: 'researcher' }), {
      roleMap: { researcher: { engine: 'opencode', ocProfile: 'free' } },
    })).toMatchObject({ engine: 'opencode', ocProfile: 'free' });
    expect(resolveStepExecution(agent({ executor_role: 'researcher', minimum_model_level: 'master', current_model_level: 'doctor' })))
      .toMatchObject({ engine: 'claude', ocProfile: null });
  });

  it('exposes the mapping tables', () => {
    expect(DEFAULT_LEVEL_MAP.doctor.engine).toBe('claude');
    expect(ROLE_TO_OC.researcher).toBe('explore');
  });
});
