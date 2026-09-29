// buildProfilePlaybookMenu (S4b, issue #1851 D2): the profile's personal
// playbooks become reachable from a plain request via when_to_use. Hermetic:
// USERS_DIR points at a temp dir, modules are reloaded so data-paths re-captures it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const MOD = '../../src/profile-playbook-menu.js';
const RELOAD = [MOD, '../../src/playbook-store.js', '../../src/data-paths.js', '../../src/playbook-validators.js'];

let root;
let prevUsers;

function loadMenu() {
  for (const m of RELOAD) delete require.cache[require.resolve(m)];
  return require(MOD).buildProfilePlaybookMenu;
}

function writeProfilePlaybook(profile, id, extra = {}) {
  const dir = join(root, 'users', profile, 'playbooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    id, version: 1, scope: 'profile', title: 'T', goal_template: '{input}',
    stages: [{ id: 's', title: 'S', steps: [{ title: 'x', execution_kind: 'agent', executor_role: 'researcher',
      minimum_model_level: 'bachelor', context_budget: 'small', validation: { done: true } }] }],
    ...extra,
  }));
}

beforeEach(() => {
  prevUsers = process.env.USERS_DIR;
  root = mkdtempSync(join(tmpdir(), 'pb-menu-'));
  process.env.USERS_DIR = join(root, 'users');
});
afterEach(() => {
  if (prevUsers === undefined) delete process.env.USERS_DIR; else process.env.USERS_DIR = prevUsers;
  rmSync(root, { recursive: true, force: true });
});

describe('buildProfilePlaybookMenu', () => {
  it('returns an empty string when the profile has no playbooks (prompt unchanged)', () => {
    expect(loadMenu()({ profileId: 'alice' })).toBe('');
  });

  it('returns an empty string for a profile playbook without when_to_use', () => {
    writeProfilePlaybook('alice', 'my-flow');
    expect(loadMenu()({ profileId: 'alice' })).toBe('');
  });

  it('lists a personal playbook with its id, when_to_use and the playbook_run hint', () => {
    writeProfilePlaybook('alice', 'prod-feature-check', { when_to_use: 'когда проверяют, доехала ли фича на прод' });
    const menu = loadMenu()({ profileId: 'alice' });
    expect(menu).toContain('[ТВОИ ПЛЕЙБУКИ]');
    expect(menu).toContain('prod-feature-check');
    expect(menu).toContain('когда проверяют, доехала ли фича на прод');
    expect(menu).toContain('playbook_run');
  });

  it('truncates a long when_to_use and counts the overflow', () => {
    for (let i = 0; i < 12; i++) {
      writeProfilePlaybook('alice', `flow-${String(i).padStart(2, '0')}`, { when_to_use: `когда ${i} ${'длинно '.repeat(40)}` });
    }
    const menu = loadMenu()({ profileId: 'alice' });
    expect(menu).toContain('ещё 2');
    expect((menu.match(/^- `flow-/gm) || []).length).toBe(10);
    expect(menu).toContain('…');
  });

  it('honours the PROFILE_PLAYBOOK_MENU=off kill-switch', () => {
    writeProfilePlaybook('alice', 'prod-feature-check', { when_to_use: 'когда проверяют прод' });
    expect(loadMenu()({ profileId: 'alice', env: { PROFILE_PLAYBOOK_MENU: 'off' } })).toBe('');
  });

  it('never throws — a broken store yields an empty string', () => {
    const broken = { list: () => { throw new Error('boom'); } };
    expect(loadMenu()({ profileId: 'alice', store: broken })).toBe('');
  });
});
