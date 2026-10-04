// #143/#136 — periodic durable save checkpoints. The contract: an end-of-run check
// cannot help a crash, so the last known save-state must already be on disk, deduped,
// append-only, and never able to take a run down.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  checkpointState, recordCheckpoint, readCheckpoints, lastCheckpoint, startCheckpointLoop, MAX_LINES,
} = require('../../src/run-checkpoint.js');

let root;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');
  return dir;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ckpt-')); });
afterEach(() => { vi.useRealTimers(); try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('checkpointState', () => {
  it('reads the code cwd when there is no plan', () => {
    const code = initRepo(join(root, 'code'));
    writeFileSync(join(code, 'a.txt'), 'dirty\n');
    const st = checkpointState({ profileId: 'u1', codeCwd: code });
    expect(st.kind).toBe('cwd');
    expect(st.isRepo).toBe(true);
    expect(st.modifiedCount).toBe(1);
  });

  it('prefers the plan workspace when the run is a durable step', () => {
    const code = join(root, 'u1', 'acme', 'ws-1', 'code');
    initRepo(code);
    git(code, 'checkout', '-qb', 'eng/u1-plan-abcdef12');
    const st = checkpointState({ profileId: 'u1', planTaskId: 'abcdef12-0000', workspacesDir: join(root, 'u1'), codeCwd: '/nope' });
    expect(st.kind).toBe('plan-workspace');
    expect(st.branch).toBe('eng/u1-plan-abcdef12');
  });
});

describe('recordCheckpoint', () => {
  it('writes a line, dedupes an unchanged state, and records a changed one', () => {
    const code = initRepo(join(root, 'code'));
    const st1 = checkpointState({ profileId: 'u1', codeCwd: code });
    expect(recordCheckpoint({ profileId: 'u1', taskId: 't1', state: st1, root })).toBeTruthy();
    expect(recordCheckpoint({ profileId: 'u1', taskId: 't1', state: st1, root })).toBeNull(); // same → skipped
    expect(readCheckpoints('u1', { root, taskId: 't1' })).toHaveLength(1);
    writeFileSync(join(code, 'a.txt'), 'dirty\n');
    const st2 = checkpointState({ profileId: 'u1', codeCwd: code });
    expect(recordCheckpoint({ profileId: 'u1', taskId: 't1', state: st2, root })).toBeTruthy();
    const list = readCheckpoints('u1', { root, taskId: 't1' });
    expect(list).toHaveLength(2);
    expect(list[1].modifiedCount).toBe(1);
  });

  it('never records a non-repo state', () => {
    const st = checkpointState({ profileId: 'u1', codeCwd: join(root, 'nope') });
    expect(st.isRepo).toBe(false);
    expect(recordCheckpoint({ profileId: 'u1', taskId: 't1', state: st, root })).toBeNull();
    expect(readCheckpoints('u1', { root })).toHaveLength(0);
  });

  it('filters by taskId and survives a torn tail line', () => {
    const code = initRepo(join(root, 'code'));
    const st = checkpointState({ profileId: 'u1', codeCwd: code });
    recordCheckpoint({ profileId: 'u1', taskId: 't1', state: st, root });
    writeFileSync(join(code, 'a.txt'), 'd2\n');
    recordCheckpoint({ profileId: 'u1', taskId: 't2', state: checkpointState({ profileId: 'u1', codeCwd: code }), root });
    // simulate a crash mid-append
    const { checkpointFile } = require('../../src/run-checkpoint.js');
    const f = checkpointFile('u1', root);
    writeFileSync(f, readFileSync(f, 'utf8') + '{"at":1,"taskId":"t1"'); // truncated JSON
    expect(readCheckpoints('u1', { root, taskId: 't1' })).toHaveLength(1);
    expect(readCheckpoints('u1', { root })).toHaveLength(2);
    expect(lastCheckpoint('u1', 't2', { root }).taskId).toBe('t2');
  });
});

describe('startCheckpointLoop', () => {
  it('takes a baseline immediately, then on every interval, and stops cleanly', () => {
    vi.useFakeTimers();
    let n = 0;
    const stateFn = () => ({ isRepo: true, kind: 'cwd', dir: '/ws', branch: 'b', head: `h${n}`, modifiedCount: n++, ahead: 0, hasUpstream: true, unsaved: true });
    const loop = startCheckpointLoop({ profileId: 'u1', taskId: 't1', root, intervalMs: 1000, stateFn });
    expect(readCheckpoints('u1', { root, taskId: 't1' })).toHaveLength(1); // baseline
    vi.advanceTimersByTime(3000);
    expect(readCheckpoints('u1', { root, taskId: 't1' })).toHaveLength(4);
    loop.stop();
    vi.advanceTimersByTime(5000);
    expect(readCheckpoints('u1', { root, taskId: 't1' })).toHaveLength(4); // stopped
  });
});
