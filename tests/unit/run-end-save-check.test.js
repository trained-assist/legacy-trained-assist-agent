// #143 rule 6 — the read-only save checker. Real git, no mocks: the contract is about
// what git actually reports (modified TRACKED files, unpushed commits), and the whole
// point is that a local-only result must be visible instead of reading as saved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { gitSaveState, planWorkspaceSaveState, formatUnsaved } = require('../../src/run-end-save-check.js');

let root;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'save-check-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('gitSaveState', () => {
  it('a non-repo directory is reported as isRepo:false, never an error', () => {
    const dir = join(root, 'plain'); mkdirSync(dir);
    expect(gitSaveState(dir)).toMatchObject({ isRepo: false });
  });

  it('a clean repo is not unsaved', () => {
    const st = gitSaveState(initRepo(join(root, 'clean')));
    expect(st.isRepo).toBe(true);
    expect(st.unsaved).toBe(false);
    expect(st.modifiedCount).toBe(0);
  });

  it('a modified tracked file counts; an untracked file does NOT', () => {
    const dir = initRepo(join(root, 'dirty'));
    writeFileSync(join(dir, 'a.txt'), 'changed\n');   // tracked → counts
    writeFileSync(join(dir, 'notes.md'), 'scratch\n'); // untracked → ignored on purpose
    const st = gitSaveState(dir);
    expect(st.modified).toEqual(['a.txt']);
    expect(st.unsaved).toBe(true);
  });

  it('an unpushed commit is unsaved even with a clean tree', () => {
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const dir = initRepo(join(root, 'work'));
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-qu', 'origin', 'main');
    expect(gitSaveState(dir).unsaved).toBe(false);
    writeFileSync(join(dir, 'a.txt'), 'a2\n');
    git(dir, 'commit', '-qam', 'local only');
    const st = gitSaveState(dir);
    expect(st.hasUpstream).toBe(true);
    expect(st.ahead).toBe(1);
    expect(st.unsaved).toBe(true);
  });
});

describe('planWorkspaceSaveState', () => {
  it('finds the workspace whose branch carries plan-<id8> and reads its state', () => {
    const profile = 'u1';
    const taskId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const code = join(root, profile, 'acme', 'ws-1', 'code');
    initRepo(code);
    git(code, 'checkout', '-qb', `eng/${profile}-plan-${taskId.slice(0, 8)}`);
    writeFileSync(join(code, 'a.txt'), 'uncommitted\n');
    const st = planWorkspaceSaveState(profile, taskId, { workspacesDir: join(root, profile) });
    expect(st.isRepo).toBe(true);
    expect(st.unsaved).toBe(true);
    expect(st.branch).toBe(`eng/${profile}-plan-${taskId.slice(0, 8)}`);
  });

  it('returns null when the profile has no workspace for this plan', () => {
    const st = planWorkspaceSaveState('u1', 'deadbeef-0000', { workspacesDir: join(root, 'nobody') });
    expect(st).toBeNull();
  });
});

describe('formatUnsaved', () => {
  it('is null for a clean state and names the workspace otherwise', () => {
    expect(formatUnsaved({ isRepo: true, unsaved: false })).toBeNull();
    const msg = formatUnsaved({ isRepo: true, unsaved: true, modifiedCount: 2, ahead: 1, branch: 'eng/u1-plan-x', dir: '/ws/code' });
    expect(msg).toContain('2 изменённых');
    expect(msg).toContain('1 незапушенных');
    expect(msg).toContain('/ws/code');
  });
});
