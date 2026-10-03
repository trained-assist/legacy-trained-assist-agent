// #106 / R1: a required (registry) check is deterministic — an inconclusive
// verdict on it is missing evidence, never a pass. The LLM judge must not
// upgrade a required key; it still applies to semantic keys (not in the
// registry). Concrete live hole this closes: `ci_and_staging_green` returns
// inconclusive('staging-unverified') whenever CI is green and staging is not
// verifiable, and the judge used to turn that into `pass`.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { evaluateItemValidationsModeAware } = require('../../src/playbook-validators.js');

const inconclusive = (reason) => async () => ({ status: 'inconclusive', subject: null, evidence: { reason } });

describe('required validation keys are not upgraded by the LLM judge', () => {
  it('keeps a required key inconclusive even when the judge says pass', async () => {
    const calls = [];
    const registry = { pr_opened: inconclusive('no-pr-reference') };
    const results = await evaluateItemValidationsModeAware(
      { validation: { pr_opened: true } },
      { registry, mode: 'programmatic+llm', llmValidate: async (ctx) => { calls.push(ctx.key); return { status: 'pass', reason: 'looks done' }; } },
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('inconclusive');
    expect(calls).toEqual([]); // the judge was never consulted for a required key
  });

  it('does not let the judge turn staging-unverified into a pass', async () => {
    const registry = { ci_and_staging_green: inconclusive('staging-unverified') };
    const results = await evaluateItemValidationsModeAware(
      { validation: { ci_and_staging_green: true } },
      { registry, mode: 'programmatic+llm-fastpass', llmValidate: async () => ({ status: 'pass' }) },
    );
    expect(results[0].status).toBe('inconclusive');
    expect(results[0].evidence.reason).toBe('staging-unverified');
  });

  it('still lets the judge decide a semantic key (not in the registry)', async () => {
    const calls = [];
    const registry = {}; // no keys registered -> the semantic key is not required
    const results = await evaluateItemValidationsModeAware(
      { validation: { implementation_complete_and_sandbox_green: true } },
      { registry, mode: 'programmatic+llm', llmValidate: async (ctx) => { calls.push(ctx.key); return { status: 'pass', reason: 'evidence present' }; } },
    );
    expect(results[0].status).toBe('pass');
    expect(calls).toEqual(['implementation_complete_and_sandbox_green']);
  });

  it('programmatic mode never calls the judge at all', async () => {
    const calls = [];
    const registry = {};
    const results = await evaluateItemValidationsModeAware(
      { validation: { implementation_complete_and_sandbox_green: true } },
      { registry, mode: 'programmatic', llmValidate: async (ctx) => { calls.push(ctx.key); return { status: 'pass' }; } },
    );
    expect(results[0].status).toBe('inconclusive');
    expect(calls).toEqual([]);
  });
});
