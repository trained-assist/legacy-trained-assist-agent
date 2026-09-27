// validation_mode + LLM validator layer (issue #1372 P3d-1b). Deterministic
// validators stay authoritative; the injectable LLM only fills an inconclusive
// gap, and never a blind pass (error / bad verdict -> inconclusive).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveValidationMode, evaluateItemValidationsModeAware,
  makeLlmValidate, buildLlmValidatorPrompt, collectDocExcerpts,
  parseFastpassSkip, FASTPASS_SKIP_MODE,
  VALIDATION_MODES, DEFAULT_VALIDATION_MODE,
} = require('../../src/playbook-validators');

const item = (over = {}) => ({
  id: 'item-1', title: 'step', instructions: '', evidence_json: null, validation: {}, ...over,
});
const byKey = results => Object.fromEntries(results.map(r => [r.key, r]));

describe('resolveValidationMode', () => {
  it('precidence: per-plan > env > default', () => {
    expect(resolveValidationMode({
      task: { execution_policy_json: JSON.stringify({ validation_mode: 'programmatic' }) },
      env: { PLAYBOOK_VALIDATION_MODE: 'programmatic+llm-fastpass' },
    })).toBe('programmatic');
    expect(resolveValidationMode({
      task: { execution_policy_json: '{}' },
      env: { PLAYBOOK_VALIDATION_MODE: 'programmatic' },
    })).toBe('programmatic');
    expect(resolveValidationMode({ task: null, env: {} })).toBe(DEFAULT_VALIDATION_MODE);
  });

  it('ignores invalid plan/env values and falls through', () => {
    expect(resolveValidationMode({
      task: { execution_policy_json: JSON.stringify({ validation_mode: 'nope' }) },
      env: { PLAYBOOK_VALIDATION_MODE: 'programmatic' },
    })).toBe('programmatic');
    expect(resolveValidationMode({ task: { execution_policy_json: 'not json' }, env: {} })).toBe(DEFAULT_VALIDATION_MODE);
    expect(resolveValidationMode({ task: {}, env: { PLAYBOOK_VALIDATION_MODE: 'bogus' } })).toBe(DEFAULT_VALIDATION_MODE);
  });

  it('exposes the selectable enum', () => {
    expect(VALIDATION_MODES).toEqual(['programmatic', 'programmatic+llm', 'programmatic+llm-fastpass']);
  });

  it('per-step override beats plan and env (P3d-1c)', () => {
    const task = { execution_policy_json: JSON.stringify({ validation_mode: 'programmatic' }) };
    const env = { PLAYBOOK_VALIDATION_MODE: 'programmatic+llm' };
    expect(resolveValidationMode({ task, item: { validation_mode: 'programmatic+llm-fastpass' }, env }))
      .toBe('programmatic+llm-fastpass');
    // a null/unknown per-step value falls through to the plan
    expect(resolveValidationMode({ task, item: { validation_mode: null }, env })).toBe('programmatic');
    expect(resolveValidationMode({ task, item: { validation_mode: 'bogus' }, env })).toBe('programmatic');
    // no item at all keeps the P3d-1b behaviour
    expect(resolveValidationMode({ task, env })).toBe('programmatic');
  });
});

describe('fastpass-skip marker (P3d-1c)', () => {
  it('parses the reason from a final marker line', () => {
    expect(parseFastpassSkip('did it.\nVALIDATION: fastpass-skip: urgent prod fix\nDURABLE: done'))
      .toBe('urgent prod fix');
    expect(parseFastpassSkip('DURABLE: done')).toBeNull();
    expect(parseFastpassSkip('VALIDATION: fastpass-skip:   ')).toBe('unspecified');
    expect(FASTPASS_SKIP_MODE).toBe('programmatic+llm-fastpass');
  });
});

describe('evaluateItemValidationsModeAware', () => {
  it('programmatic never calls the LLM', async () => {
    const llm = vi.fn(async () => ({ status: 'pass', reason: 'x' }));
    const results = await evaluateItemValidationsModeAware(
      item({ validation: { mystery_check: true } }),
      { mode: 'programmatic', registry: {}, llmValidate: llm });
    expect(llm).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ key: 'mystery_check', status: 'inconclusive' });
    expect(results[0].evidence.reason).toBe('no-validator');
  });

  it('+llm runs deterministic first and consults the LLM only for inconclusive keys', async () => {
    const llm = vi.fn(async (ctx) => ({ status: 'pass', reason: `judged ${ctx.key}` }));
    const registry = { known: async () => ({ status: 'pass', subject: null, evidence: {} }) };
    const results = await evaluateItemValidationsModeAware(
      item({ validation: { known: true, mystery: true } }),
      { mode: 'programmatic+llm', registry, llmValidate: llm });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].key).toBe('mystery');
    const out = byKey(results);
    expect(out.known.status).toBe('pass');
    expect(out.mystery.status).toBe('pass');
    expect(out.mystery.evidence.source).toBe('llm');
    expect(out.mystery.evidence.reason).toBe('judged mystery');
  });

  it('+llm keeps a deterministic fail and does not ask the LLM', async () => {
    const llm = vi.fn(async () => ({ status: 'pass', reason: 'should not be used' }));
    const registry = { bad: async () => ({ status: 'fail', subject: null, evidence: { reason: 'nope' } }) };
    const results = await evaluateItemValidationsModeAware(
      item({ validation: { bad: true } }),
      { mode: 'programmatic+llm', registry, llmValidate: llm });
    expect(llm).not.toHaveBeenCalled();
    expect(results[0].status).toBe('fail');
  });

  it('+llm: LLM throw and invalid verdict both become inconclusive', async () => {
    const throwing = await evaluateItemValidationsModeAware(
      item({ validation: { mystery: true } }),
      { mode: 'programmatic+llm', registry: {}, llmValidate: async () => { throw new Error('boom'); } });
    expect(throwing[0].status).toBe('inconclusive');
    expect(throwing[0].evidence.reason).toBe('llm-error');

    const garbage = await evaluateItemValidationsModeAware(
      item({ validation: { mystery: true } }),
      { mode: 'programmatic+llm', registry: {}, llmValidate: async () => 'not an object' });
    expect(garbage[0].status).toBe('inconclusive');
    expect(garbage[0].evidence.reason).toBe('llm-invalid-verdict');
  });

  it('fastpass is selectable and tags the mode for a forgiving prompt', async () => {
    const seen = [];
    await evaluateItemValidationsModeAware(
      item({ validation: { mystery: true } }),
      { mode: 'programmatic+llm-fastpass', registry: {}, llmValidate: async (ctx) => { seen.push(ctx.mode); return { status: 'pass', reason: 'ok' }; } });
    expect(seen).toEqual(['programmatic+llm-fastpass']);
  });

  it('softening: a missing-reference fail with a near-equivalent PR is not a hard fail', async () => {
    const results = await evaluateItemValidationsModeAware(
      item({
        title: 'open the PR',
        instructions: 'see https://github.com/acme/widgets/pull/7',
        validation: { pr_opened: true },
      }),
      {
        mode: 'programmatic+llm', registry: {},
        llmValidate: async () => ({ status: 'fail', reason: 'pr_opened not stated explicitly' }),
      });
    expect(results[0].status).toBe('inconclusive');
    expect(results[0].evidence.reason).toBe('softened-near-equivalent');
    expect(results[0].evidence.near_equivalent.number).toBe('7');
  });
});

let afterTokenRestore = () => {};
describe('default LLM validator (bounded service-LLM call)', () => {
  it('without an API key returns inconclusive and makes no request', async () => {
    const fetchImpl = vi.fn();
    const saved = process.env.LLM_LADDER_TOKEN; delete process.env.LLM_LADDER_TOKEN; // no ladder token
    afterTokenRestore = () => { if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved; };
    const fn = makeLlmValidate({ apiKey: '', fetchImpl });
    const r = await fn({ key: 'x', validation: true, mode: 'programmatic+llm' });
    afterTokenRestore();
    expect(r).toEqual({ status: 'inconclusive', reason: 'no-llm-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an unparseable model response is inconclusive, never a pass', async () => {
    const fn = makeLlmValidate({
      apiKey: 'k',
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) }),
    });
    // Service-LLM ladder JSON guard: non-JSON fails every rung → inconclusive (never a pass).
    expect(await fn({ key: 'x', validation: true })).toEqual({ status: 'inconclusive', reason: 'llm-unavailable' });
  });

  it('a non-ok response is inconclusive', async () => {
    const fn = makeLlmValidate({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) });
    expect(await fn({ key: 'x', validation: true })).toEqual({ status: 'inconclusive', reason: 'llm-unavailable' });
  });
});

describe('prompt/excerpt builders', () => {
  it('collectDocExcerpts reads bounded markdown, empty without a project dir', () => {
    expect(collectDocExcerpts(null)).toEqual([]);
  });

  it('prompt mentions the key, evidence and softening guidance', () => {
    const { system, user } = buildLlmValidatorPrompt({
      key: 'user_value_written',
      validation: true,
      mode: 'programmatic+llm',
      task: { goal: 'ship value' },
      item: { title: 'write scenario', evidence_json: '{"reply":"done"}' },
      excerpts: [{ path: 'docs/x.md', text: 'value + steps' }],
    });
    expect(system).toMatch(/STRICT JSON/);
    expect(system).toMatch(/SOFTENING/);
    expect(user).toContain('user_value_written');
    expect(user).toContain('docs/x.md');
  });
});
