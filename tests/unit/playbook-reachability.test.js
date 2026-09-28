// Playbook reachability check (issue #1756): the route from a plain request to
// playbook_run(<id>) is gated, not only the file. Hermetic: store, catalog, prompt
// domains, audience map, tool dirs and profile skills are all injected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PlaybookStore } = require('../../src/playbook-store.js');
const { checkPlaybookReachability, formatReport } = require('../../src/playbook-reachability.js');

let root;

function playbook(id) {
  return {
    id, version: 1, scope: 'system', title: 'Sample', goal_template: 'Do {goal}',
    stages: [{
      id: 'stage-one', title: 'Stage one',
      steps: [{
        title: 'Step one', execution_kind: 'agent', executor_role: 'researcher',
        minimum_model_level: 'bachelor', context_budget: 'small', validation: { done: true },
      }],
    }],
  };
}

function write(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(playbook(id)));
}

const catalog = {
  servers: { 'trained-skills': { kind: 'local' }, 'sales-skills': { kind: 'sibling', repo: 'trained-assist-sales-skill' } },
  sections: {
    core: { always: true, modules: ['00-meta.js'] },
    'flexi-expo': { modules: ['sales-skills/85-expo.js'], promptDomains: ['expo'] },
    company: { modules: ['sales-skills/90-company.js'] },
  },
  domains: { expo: { server: 'sales-skills', module: '85-expo.js' } },
};
const readiness = { 'sales-skills': true, 'sales-skills/*': null };
const pointer = { name: 'expo', body: 'Крупная задача → `playbook_run(playbook_id: "demo-pb", goal: ...)`' };

function run(id, over = {}) {
  const sibling = join(root, 'trained-assist-sales-skill');
  return checkPlaybookReachability(id, {
    store: new PlaybookStore({ profileId: null, systemDir: join(root, 'system'), siblingRoots: [sibling] }),
    catalog, domains: [], audienceMap: {}, devFamily: [], toolDirs: [],
    siblingRepos: ['trained-assist-sales-skill'],
    ...over,
  });
}

const status = (report, gate) => (report.rows.find(r => r.gate === gate) || {}).status;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pb-reach-'));
  write(join(root, 'trained-assist-sales-skill', 'playbooks'), 'demo-pb');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('checkPlaybookReachability', () => {
  it('fails dispatch when nothing leads to the playbook (the 2026-09-28 exhibition gap)', () => {
    const r = run('demo-pb');
    expect(status(r, 'resolve')).toBe('pass');
    expect(status(r, 'compile')).toBe('pass');
    expect(status(r, 'sibling-registration')).toBe('pass');
    expect(status(r, 'dispatch')).toBe('fail');
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/FAIL \(dispatch\)/);
  });

  it('passes with a playbook_run pointer in a prompt domain', () => {
    const r = run('demo-pb', { domains: [pointer] });
    expect(status(r, 'dispatch')).toBe('pass');
    expect(r.ok).toBe(true);
  });

  it('weak routes (audience map, dev auto-offer) pass with a warning', () => {
    expect(status(run('demo-pb', { audienceMap: { exhibition: 'demo-pb' } }), 'dispatch')).toBe('warn');
    expect(status(run('demo-pb', { devFamily: ['demo-pb'] }), 'dispatch')).toBe('warn');
  });

  it('fails an unknown id', () => {
    const r = run('nope');
    expect(status(r, 'resolve')).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails a sibling missing from DEFAULT_SIBLING_REPOS', () => {
    expect(status(run('demo-pb', { domains: [pointer], siblingRepos: [] }), 'sibling-registration')).toBe('fail');
  });

  it('warns when the same id shadows a copy on a lower level', () => {
    write(join(root, 'system'), 'demo-pb');
    const r = run('demo-pb', { domains: [pointer] });
    expect(status(r, 'no-shadow')).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('per profile: pointer carrier section off → not visible, even if another section owns the same sibling', () => {
    const r = run('demo-pb', {
      domains: [pointer], profileId: 'someone', readiness,
      profileSkills: { enabled: ['company'], disabled: [] },
    });
    expect(status(r, 'sibling-mounted')).toBe('pass');
    expect(status(r, 'section-enabled')).toBe('fail');
    expect(status(r, 'pointer-in-prompt')).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('per profile: carrier section on → whole chain closes', () => {
    const r = run('demo-pb', {
      domains: [pointer], profileId: 'someone', readiness,
      profileSkills: { enabled: ['flexi-expo'], disabled: [] },
    });
    expect(r.rows.filter(x => x.status === 'fail')).toEqual([]);
    expect(status(r, 'pointer-in-prompt')).toBe('pass');
  });

  it('audience gate checks the asked audience', () => {
    expect(status(run('demo-pb', { domains: [pointer], audience: 'exhibition', audienceMap: { exhibition: 'demo-pb' } }), 'audience-map')).toBe('pass');
    expect(status(run('demo-pb', { domains: [pointer], audience: 'freelance' }), 'audience-map')).toBe('fail');
  });
});
