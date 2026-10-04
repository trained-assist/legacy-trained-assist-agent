// #143 slice 4 — the coding baseline must reach EVERY coding run, including a run whose
// turn intent narrowed the mount onto a different section (the misclassification case
// where the `engineering` domain used to disappear from the prompt).
//
// The mechanism that makes this possible: `hidden.domains` is computed from the
// promptDomains a SECTION declares, so a core domain that no section declares can never
// be hidden. These tests pin both halves of that contract.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildDomainBlock, loadDomains, parseDomainFile } = require('../../src/prompt-domains/index.js');
const catalog = require('../../config/skill-catalog.json');

const DOMAIN_FILE = join(__dirname, '..', '..', 'src', 'prompt-domains', 'engineering-baseline.md');
let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'baseline-domain-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

function mcpConfig({ hiddenDomains = null } = {}) {
  const file = join(root, 'mcp.json');
  const env = {};
  if (hiddenDomains) {
    const resolved = join(root, 'skills-resolved.json');
    writeFileSync(resolved, JSON.stringify({ hidden: { domains: hiddenDomains, modules: [], siblings: [] } }));
    env.SKILLS_RESOLVED = resolved;
  }
  writeFileSync(file, JSON.stringify({
    mcpServers: { 'trained-skills': { command: 'node', args: ['/x/src/mcp-skills/index.js'] }, 'engineering-skills': { command: 'node', args: ['/y/src/mcp-skills/index.js'] } },
  }));
  return file;
}
const PROBE = { 'trained-skills': { '00-meta.js': true }, 'engineering-skills': { '20-workspace.js': true } };

describe('engineering-baseline core domain', () => {
  it('parses as a core, always-present domain', () => {
    const doc = parseDomainFile(DOMAIN_FILE);
    expect(doc).toBeTruthy();
    expect(doc.server).toBe('trained-skills');
    expect(doc.module).toBe('00-meta.js'); // always shipped by the core registry
    expect(doc.when).toBe('present');
  });

  it('carries every rule the issue asks for', () => {
    const body = readFileSync(DOMAIN_FILE, 'utf8');
    for (const marker of ['issue', 'engineering_spawn_workspace', 'git diff', 'draft PR', 'engineering_change_find',
      'partial/blocked', 'read-only', 'secrets']) {
      expect(body).toContain(marker);
    }
  });

  it('is NOT declared by any section — that is what makes it unhideable', () => {
    const declared = new Set(Object.values(catalog.sections).flatMap(s => s.promptDomains || []));
    expect(declared.has('engineering-baseline')).toBe(false);
  });

  it('loads as a domain', () => {
    const names = loadDomains().map(d => d.name);
    expect(names).toContain('engineering-baseline');
  });
});

describe('buildDomainBlock keeps the baseline when the engineering domain is hidden', () => {
  it('the misclassified coding turn: intent narrowed onto another section', () => {
    const file = mcpConfig({ hiddenDomains: ['engineering', 'github.setup', 'spec-generation'] });
    const block = buildDomainBlock(file, { probe: PROBE });
    expect(block).toContain('Coding discipline');
    expect(block).toContain('draft PR');
    // the section-specific domain is still gone — the baseline does not resurrect it
    expect(block).not.toContain('repo_map');
  });

  it('a legacy run with no skills plan keeps it too', () => {
    const block = buildDomainBlock(mcpConfig(), { probe: PROBE });
    expect(block).toContain('Coding discipline');
  });
});
