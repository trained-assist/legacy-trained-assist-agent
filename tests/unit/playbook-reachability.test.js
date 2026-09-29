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

function write(dir, id, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...playbook(id), ...extra }));
}

// A sibling tools dir defining expo_find_participants in 85-expo.js.
function toolsDir() {
  const d = join(root, 'trained-assist-sales-skill', 'src', 'mcp-skills', 'tools');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '85-expo.js'), 'module.exports = { tools: {\n  expo_find_participants: {\n    handler: async () => ({}) } } };\n');
  return [{ dir: d, server: 'sales-skills' }];
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
    catalog, domains: [], audienceMap: {}, devFamily: [], toolDirs: [], launcherDir: false,
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

  it('a programmatic launcher in the owning repo code is route F (warn)', () => {
    const src = join(root, 'trained-assist-sales-skill', 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'hub.js'), "const LAUNCH_PLAYBOOK_ID = 'demo-pb';\n");
    const r = run('demo-pb', { launcherDir: undefined });
    expect(status(r, 'dispatch')).toBe('warn');
    expect(r.rows.find(x => x.gate === 'dispatch').detail).toMatch(/F запуск из кода.*hub\.js/);
  });

  it('--strict: weak routes alone fail, A1 passes', () => {
    expect(status(run('demo-pb', { strict: true, audienceMap: { exhibition: 'demo-pb' } }), 'dispatch')).toBe('fail');
    expect(status(run('demo-pb', { strict: true, domains: [pointer] }), 'dispatch')).toBe('pass');
  });

  it('repoDir: a domain repo in its own CI is read from its checkout (playbooks + prompt domains)', () => {
    const repo = join(root, 'trained-assist-sales-skill');
    mkdirSync(join(repo, 'src', 'prompt-domains'), { recursive: true });
    writeFileSync(join(repo, 'src', 'prompt-domains', 'expo.md'),
      '---\nserver: sales-skills\nmodule: 85-expo.js\nwhen: ready\n---\n' + pointer.body + '\n');
    const r = checkPlaybookReachability('demo-pb', {
      repoDir: repo, catalog, audienceMap: {}, devFamily: [], launcherDir: false, strict: true,
      siblingRepos: ['trained-assist-sales-skill'],
    });
    expect(status(r, 'resolve')).toBe('pass');
    expect(status(r, 'dispatch')).toBe('pass');
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

  describe('requires {sections, tools}', () => {
    const declare = extra => write(join(root, 'trained-assist-sales-skill', 'playbooks'), 'demo-pb', extra);

    it('is valid in the schema and warns when not declared', () => {
      expect(status(run('demo-pb', { domains: [pointer] }), 'requires')).toBe('warn');
      declare({ requires: { sections: ['flexi-expo'], tools: ['expo_find_participants'] } });
      const r = run('demo-pb', { domains: [pointer], toolDirs: toolsDir() });
      expect(status(r, 'resolve')).toBe('pass');
      expect(status(r, 'requires')).toBe('pass');
      expect(r.rows.find(x => x.gate === 'requires').detail).toMatch(/expo_find_participants←sales-skills\/85-expo\.js/);
    });

    it('fails an unknown section or a tool no module defines', () => {
      declare({ requires: { sections: ['no-such-section'], tools: ['ghost_tool'] } });
      const r = run('demo-pb', { domains: [pointer], toolDirs: toolsDir() });
      expect(status(r, 'requires')).toBe('fail');
      expect(r.rows.find(x => x.gate === 'requires').detail).toMatch(/no-such-section.*ghost_tool/);
    });

    it('per profile: a declared section off is a hard FAIL even without a pointer', () => {
      declare({ requires: { sections: ['flexi-expo'], tools: ['expo_find_participants'] } });
      const r = run('demo-pb', {
        audienceMap: { exhibition: 'demo-pb' }, toolDirs: toolsDir(), profileId: 'someone', readiness,
        profileSkills: { enabled: ['company'], disabled: [] },
      });
      expect(status(r, 'section-enabled')).toBe('fail');
      expect(r.ok).toBe(false);
    });

    it('per profile: declared section on + tool module exposed → chain closes', () => {
      declare({ requires: { sections: ['flexi-expo'], tools: ['expo_find_participants'] } });
      const r = run('demo-pb', {
        domains: [pointer], toolDirs: toolsDir(), profileId: 'someone',
        resolved: { sections: ['core', 'flexi-expo'], modules: ['sales-skills/85-expo.js'], setupOnly: [], siblings: ['sales-skills'], promptDomains: ['expo'] },
      });
      expect(r.rows.filter(x => x.status === 'fail')).toEqual([]);
      expect(r.rows.find(x => x.gate === 'tools-visible').detail).toMatch(/1\/1/);
    });

    it('per profile: live resolved record with the tool module hidden → FAIL', () => {
      declare({ requires: { sections: ['flexi-expo'], tools: ['expo_find_participants'] } });
      const r = run('demo-pb', {
        domains: [pointer], toolDirs: toolsDir(), profileId: 'someone',
        resolved: { sections: ['core', 'flexi-expo'], modules: [], setupOnly: [], siblings: ['sales-skills'], promptDomains: ['expo'] },
      });
      expect(status(r, 'tools-visible')).toBe('fail');
    });
  });

  describe('route P: a profile playbook via when_to_use (#1851 D2)', () => {
    const profileStore = (extra = {}) => ({
      resolve: () => ({
        ...playbook('demo-pb'), scope: 'profile', source: 'profile',
        path: join(root, 'users', 'alice', 'playbooks', 'demo-pb.json'),
        ...extra,
      }),
      _levels: () => [],
    });

    it('passes dispatch with a non-empty when_to_use, even under --strict', () => {
      const r = run('demo-pb', { store: profileStore({ when_to_use: 'когда проверяют прод' }), strict: true });
      expect(status(r, 'dispatch')).toBe('pass');
      expect(r.rows.find(x => x.gate === 'dispatch').detail).toMatch(/when_to_use/);
    });

    it('fails dispatch without when_to_use and names the field', () => {
      const r = run('demo-pb', { store: profileStore() });
      expect(status(r, 'dispatch')).toBe('fail');
      expect(r.rows.find(x => x.gate === 'dispatch').detail).toMatch(/when_to_use/);
    });
  });
});

