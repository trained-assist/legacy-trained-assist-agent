// A wait condition the wait environment can never satisfy must NOT park silently.
//
// Prod incident: a durable step parked on
//   until: {command_exit_zero: "gh api 'repos/…/commits' --jq '.[0].sha' …"}
// The poll child inherits the engine env, which holds no service credentials
// (secrets live in the credential store), so `gh` failed with "gh auth login"
// on every poll: the step re-parked every ~10 min for 3 h, its 12th execution
// was still spinning, and the parent epic (waiting on task_done) sat at 11/17.
// decidePoll already honours `evidence.final` — this suite pins that an
// unauthenticated / missing-command command is reported as final, and that a
// genuine "not yet" failure is not.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getDefaultRegistry, classifyUnsatisfiable } = require('../../src/playbook-validators');
const { decidePoll } = require('../../src/durable-wait');

const registry = getDefaultRegistry();
const cmd = (c) => registry.command_exit_zero({ validation: c });

describe('command_exit_zero: unsatisfiable conditions are final', () => {
  it('marks an unauthenticated API call final (the prod case)', async () => {
    // Hermetic, NOT a live `gh api` call: inside GitHub Actions gh IS
    // authenticated, so a real invocation passes there and the case proves
    // nothing (it failed CI in PR #1999 for exactly that reason). We emit the
    // stderr the prod poll captured and exit non-zero.
    const r = await cmd(
      'bash -c \'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; '
      + 'echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2; exit 4\'');
    expect(r.status).toBe('fail');
    expect(r.evidence.final).toBe(true);
    expect(r.evidence.unsatisfiable).toBe('unauthenticated');
    expect(r.evidence.hint).toMatch(/issue_pr_merged|ci_green/);
  });

  it('does NOT mark an authenticated, working API call final', async () => {
    // A command that exits 0 is a pass, and a non-zero exit without an
    // environment signature stays a plain, retryable fail.
    const r = await cmd('bash -c \'exit 0\'');
    expect(r.status).toBe('pass');
    expect(r.evidence.final).toBeUndefined();
  });

  it('classifies the exact stderr the prod poll captured', () => {
    const stderr = 'To get started with GitHub CLI, please run:  gh auth login\n'
      + 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n';
    const hit = classifyUnsatisfiable({ exit_code: 4, stderr });
    expect(hit).toBeTruthy();
    expect(hit.reason).toBe('unauthenticated');
  });

  it('marks a missing command final', async () => {
    const r = await cmd('this-binary-does-not-exist-xyz --version');
    expect(r.status).toBe('fail');
    expect(r.evidence.final).toBe(true);
    expect(r.evidence.unsatisfiable).toBe('command-missing');
  });

  it('leaves a genuine "not yet" failure non-final', async () => {
    const r = await cmd('grep -q __never_matches__ /etc/hostname');
    expect(r.status).toBe('fail');
    expect(r.evidence.final).toBeUndefined();
  });

  it('passes a real command', async () => {
    const r = await cmd('true');
    expect(r.status).toBe('pass');
  });
});

describe('decidePoll: a final fail resolves the wait instead of re-parking', () => {
  const wait = {
    then: 'rerun', until: { command_exit_zero: 'gh api …' },
    started_at: 1000, deadline_at: 1000 + 3600_000, last_poll_at: 2000,
  };

  it('wakes the step when the failure is final, before the deadline', () => {
    expect(decidePoll(wait, [{ key: 'command_exit_zero', status: 'fail', evidence: { final: true } }], 5000)).toBe('failed');
  });

  it('keeps waiting when the condition is simply not satisfied yet', () => {
    expect(decidePoll(wait, [{ key: 'command_exit_zero', status: 'fail', evidence: { exit_code: 1 } }], 5000)).toBe('keep');
  });

  it('completes when it passes', () => {
    expect(decidePoll(wait, [{ key: 'command_exit_zero', status: 'pass', evidence: {} }], 5000)).toBe('satisfied');
  });
});

describe('file_exists: an absolute path needs no project dir', () => {
  it('passes on an absolute path with projectDir unset', async () => {
    const r = await registry.file_exists({ validation: '/etc/hostname' });
    expect(r.status).toBe('pass');
  });

  it('is inconclusive for a relative path with no project dir (needs one)', async () => {
    const r = await registry.file_exists({ validation: 'docs/inventory/repo-coverage.md' });
    expect(r.status).toBe('inconclusive');
    expect(r.evidence.reason).toBe('no-project-dir');
  });

  it('fails on a missing absolute path', async () => {
    const r = await registry.file_exists({ validation: '/etc/__not_a_file__' });
    expect(r.status).toBe('fail');
    expect(r.evidence.reason).toBe('missing');
  });
});
