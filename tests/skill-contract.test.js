/**
 * Runs scripts/check-skill-contract.js against the real sibling trained-assist-hh-skill
 * checkout — the "is this extracted skill repo still ready for integration" gate.
 * Skips (not fails) when the sibling isn't cloned, e.g. a CI runner that only checks out
 * this repo — matches the same existence-gated pattern writeMcpConfig()/mcp-action.js
 * already use for the hh-skills MCP server.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { checkSkillContract } = require('../scripts/check-skill-contract.js');
const { checkMcpConformance } = require('../scripts/check-mcp-conformance.js');

const HH_SKILL_REPO = path.join(__dirname, '..', '..', 'trained-assist-hh-skill');

describe.skipIf(!fs.existsSync(HH_SKILL_REPO))('checkSkillContract(trained-assist-hh-skill)', () => {
  it('passes with zero errors', () => {
    const { ok, errors } = checkSkillContract(HH_SKILL_REPO);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe('checkSkillContract', () => {
  it('fails a repo missing package.json/tools entirely', () => {
    const { ok, errors } = checkSkillContract('/nonexistent/skill/repo');
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// Behavioural contract (#1481): every MCP server the host mounts must turn an empty tool
// result into an explicit notice. The host's own server always runs; siblings run when
// checked out (on the VM; deploy.sh additionally gates each sibling's new revision).
describe('checkMcpConformance', () => {
  it('host trained-skills server conforms', async () => {
    const { ok, errors } = await checkMcpConformance(path.join(__dirname, '..'));
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  }, 30000);

  it('flags a boundary that passes empty results through', async () => {
    const { ok, errors } = await checkMcpConformance(path.join(__dirname, 'fixtures', 'mcp-bare-skill'));
    expect(ok).toBe(false);
    expect(errors.length).toBe(6);
  }, 30000);

  for (const sibling of ['trained-assist-hh-skill', 'trained-assist-freelance-skill', 'trained-assist-engineering']) {
    const repo = path.join(__dirname, '..', '..', sibling);
    it.skipIf(!fs.existsSync(path.join(repo, 'src', 'mcp-skills', 'index.js')))(`${sibling} conforms`, async () => {
      const { errors } = await checkMcpConformance(repo);
      expect(errors).toEqual([]);
    }, 30000);
  }
});
