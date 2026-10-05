// playbook_check_reachability MCP tool (issue #1756, layer 2): the reachability check for the CALLER
// profile, inside the agent. Uses the live run record (.skills-resolved.json) when present.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const TOOL = '../../src/mcp-skills/tools/102-playbooks.js';
const RELOAD = [TOOL, '../../src/playbook-store.js', '../../src/data-paths.js', '../../src/playbook-reachability.js'];

let root;
let prevUsers;

function loadTool() {
  for (const m of RELOAD) delete require.cache[require.resolve(m)];
  return require(TOOL).tools.playbook_check_reachability;
}

function profilePlaybook(profile, id, extra = {}) {
  const dir = join(root, 'users', profile, 'playbooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, version: 1, scope: 'profile', title: 'T', goal_template: '{goal}',
    stages: [{ id: 's', title: 'S', steps: [{ title: 'x', execution_kind: 'agent', executor_role: 'researcher',
      minimum_model_level: 'bachelor', context_budget: 'small', validation: { done: true } }] }],
    ...extra,
  }));
}

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  root = mkdtempSync(join(tmpdir(), 'pb-health-'));
  process.env.USERS_DIR = join(root, 'users');
});
afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR; else process.env.USERS_DIR = prevUsers;
  rmSync(root, { recursive: true, force: true });
});

describe('playbook_check_reachability', () => {
  it('requires a caller profile', async () => {
    const res = await loadTool().handler({ id: 'x' }, {});
    expect(res.code).toBe('USER_REQUIRED');
  });

  it('reports a profile playbook with no route as not reachable', async () => {
    profilePlaybook('alice', 'my-private-flow');
    const res = await loadTool().handler({ id: 'my-private-flow', verbose: true }, { userId: 'alice' });
    expect(res.ok).toBe(false);
    expect(res.reports[0].id).toBe('my-private-flow');
    expect(res.reports[0].rows.find(r => r.gate === 'resolve').status).toBe('pass');
    expect(res.reports[0].rows.find(r => r.gate === 'dispatch').status).toBe('fail');
    expect(res.exposure_source).toMatch(/computed/);
  });

  it('uses the live run record when the profile has one', async () => {
    profilePlaybook('alice', 'my-private-flow');
    writeFileSync(join(root, 'users', 'alice', '.skills-resolved.json'), JSON.stringify({
      at: '2026-09-28T12:00:00Z',
      resolved: { sections: ['core'], modules: [], setupOnly: [], siblings: [], promptDomains: [] },
    }));
    const res = await loadTool().handler({ id: 'my-private-flow' }, { userId: 'alice' });
    expect(res.exposure_source).toMatch(/skills-resolved\.json \(2026-09-28T12:00:00Z\)/);
  });

  it('without id checks every playbook visible to the profile', async () => {
    profilePlaybook('alice', 'my-private-flow');
    const res = await loadTool().handler({}, { userId: 'alice' });
    expect(res.reports.map(r => r.id)).toContain('my-private-flow');
  });

  it('route P: a profile playbook with when_to_use is reachable from a plain request (#1851)', async () => {
    profilePlaybook('alice', 'my-private-flow', { when_to_use: 'когда нужно проверить фичу на проде' });
    const res = await loadTool().handler({ id: 'my-private-flow', verbose: true }, { userId: 'alice' });
    const dispatch = res.reports[0].rows.find(r => r.gate === 'dispatch');
    expect(dispatch.status).toBe('pass');
    expect(dispatch.detail).toMatch(/when_to_use/);
    expect(res.ok).toBe(true);
  });

  it('a profile playbook without when_to_use names the field in the dispatch hint', async () => {
    profilePlaybook('alice', 'my-private-flow');
    const res = await loadTool().handler({ id: 'my-private-flow' }, { userId: 'alice' });
    const dispatch = res.reports[0].issues.find(r => r.gate === 'dispatch');
    expect(dispatch.status).toBe('fail');
    expect(dispatch.detail).toMatch(/when_to_use/);
  });

  it('default output lists only non-pass rows so a compressor cannot hide failing gates', async () => {
    profilePlaybook('alice', 'my-private-flow');
    const res = await loadTool().handler({ id: 'my-private-flow' }, { userId: 'alice' });
    const r = res.reports[0];
    expect(r.rows).toBeUndefined();
    expect(r.passed).toBeGreaterThan(0);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every(x => x.status !== 'pass')).toBe(true);
    expect(r.issues.map(x => x.gate)).toContain('dispatch');
  });
});
