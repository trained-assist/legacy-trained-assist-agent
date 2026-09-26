/**
 * resolveToolSource — the local-vs-hh-skills routing decision from src/mcp-action.js.
 *
 * Extracted as a pure function so the fallback branch (tool name that only exists in
 * the extracted hh-skills repo) can be exercised without deleting local code or waiting
 * for a live soak period. This is a regression test on the *decision logic*, not a live
 * end-to-end smoke test — issue #942 step 11b still needs a real call against the running
 * hh-skills MCP server before the extraction is considered proven in production.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveToolSource } = require('../src/mcp-action.js');

describe('resolveToolSource', () => {
  it('routes a local-only tool to local', () => {
    const local = new Set(['context_get', 'list_skills']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('context_get', local, { hh })).toBe('local');
  });

  it('rejects a name shared by both providers under contract v1', () => {
    const local = new Set(['hh_status', 'context_get']);
    const hh = new Set(['hh_status']);
    expect(() => resolveToolSource('hh_status', local, { hh })).toThrow('Duplicate action');
  });

  it('falls through to hh-skills for a tool that only exists there (post-deletion state)', () => {
    const local = new Set(['context_get']);
    const hh = new Set(['hh_status']);
    expect(resolveToolSource('hh_status', local, { hh })).toBe('hh');
  });

  it('rejects an unknown tool', () => {
    const local = new Set(['context_get']);
    const hh = new Set(['hh_status']);
    expect(() => resolveToolSource('not_a_real_tool', local, { hh })).toThrow('Action is not registered');
  });

  it('rejects a missing external action when the provider is absent', () => {
    const local = new Set(['context_get']);
    expect(() => resolveToolSource('hh_status', local, {})).toThrow('Action is not registered');
  });

  it('routes a tool to whichever sibling owns it (freelance, engineering — S3.4)', () => {
    const local = new Set(['context_get']);
    const siblings = { hh: new Set(['hh_status']), freelance: new Set(['freelance_list']), engineering: new Set(['engineering_repo_context']) };
    expect(resolveToolSource('freelance_list', local, siblings)).toBe('freelance');
    expect(resolveToolSource('engineering_repo_context', local, siblings)).toBe('engineering');
  });

  it('rejects a name shared by two siblings', () => {
    const siblings = { hh: new Set(['x_tool']), freelance: new Set(['x_tool']) };
    expect(() => resolveToolSource('x_tool', new Set(), siblings)).toThrow('Duplicate action');
  });
});
