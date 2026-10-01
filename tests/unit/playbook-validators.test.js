// Playbook validator registry (issue #1372 P3d-1): key → verdict. Unknown keys
// must be inconclusive (never a silent pass); GitHub checks reuse the checklist
// pre-check shape and are driven by injected fakes.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createDefaultRegistry, evaluateValidation, evaluateItemValidations, parseValidation, checkRunsGreen,
} = require('../../src/playbook-validators');

const item = (over = {}) => ({
  id: 'item-1', title: 'Open PR', instructions: 'see https://github.com/acme/widgets/pull/7',
  evidence_json: null, validation: {}, ...over,
});

describe('playbook-validators', () => {
  it('unknown key → inconclusive with reason no-validator', async () => {
    const r = await evaluateValidation('mystery_check', { item: item(), validation: true }, {});
    expect(r).toMatchObject({ status: 'inconclusive' });
    expect(r.evidence.reason).toBe('no-validator');
  });

  it('an empty registry makes every key inconclusive', async () => {
    const results = await evaluateItemValidations(
      item({ validation: { user_value_written: true } }), { registry: {} });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: 'user_value_written', status: 'inconclusive' });
  });

  it('parseValidation accepts a JSON string (as stored in the DB) and rejects junk', () => {
    expect(parseValidation('{"file_exists":"a.txt"}')).toEqual({ file_exists: 'a.txt' });
    expect(parseValidation('not json')).toEqual({});
    expect(parseValidation(null)).toEqual({});
  });

  it('file_exists passes for an existing file and fails for a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pv-'));
    try {
      writeFileSync(join(dir, 'dist.js'), 'x');
      const pass = await evaluateValidation('file_exists', { validation: 'dist.js', projectDir: dir }, createDefaultRegistry());
      expect(pass.status).toBe('pass');
      expect(pass.subject.relative).toBe('dist.js');

      const fail = await evaluateValidation('file_exists', { validation: 'missing.js', projectDir: dir }, createDefaultRegistry());
      expect(fail.status).toBe('fail');
      expect(fail.evidence.reason).toBe('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file_exists without a project dir is inconclusive, not a pass', async () => {
    const r = await evaluateValidation('file_exists', { validation: 'a.txt', projectDir: null }, createDefaultRegistry());
    expect(r.status).toBe('inconclusive');
    expect(r.evidence.reason).toBe('no-project-dir');
  });

  it('command_exit_zero reflects the exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pv-'));
    try {
      const registry = createDefaultRegistry();
      const pass = await evaluateValidation('command_exit_zero',
        { validation: 'node -e "process.exit(0)"', projectDir: dir }, registry);
      expect(pass.status).toBe('pass');
      expect(pass.evidence.exit_code).toBe(0);

      const fail = await evaluateValidation('command_exit_zero',
        { validation: 'node -e "process.exit(3)"', projectDir: dir }, registry);
      expect(fail.status).toBe('fail');
      expect(fail.evidence.exit_code).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ci_green passes only when every check-run is completed+success', async () => {
    const registry = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => {
        if (url.endsWith('/pulls/7')) return { head: { sha: 'abc' } };
        if (url.endsWith('/commits/abc/check-runs')) {
          return { check_runs: [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'lint', status: 'completed', conclusion: 'success' },
          ] };
        }
        return null;
      },
    });
    const r = await evaluateValidation('ci_green', { item: item(), profileId: 'u1', validation: true }, registry);
    expect(r.status).toBe('pass');
    expect(r.subject.sha).toBe('abc');
  });

  it('ci_green fails when a check-run is red and is inconclusive with no runs', async () => {
    const red = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => url.endsWith('/pulls/7')
        ? { head: { sha: 'abc' } }
        : { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] },
    });
    const fail = await evaluateValidation('ci_green', { item: item(), profileId: 'u1' }, red);
    expect(fail.status).toBe('fail');
    expect(fail.evidence.failing).toContain('ci');
    expect(fail.evidence.final).toBe(true); // finished red — a durable wait wakes on it

    const running = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => url.endsWith('/pulls/7')
        ? { head: { sha: 'abc' } }
        : { check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }] },
    });
    const pending = await evaluateValidation('ci_green', { item: item(), profileId: 'u1' }, running);
    expect(pending.status).toBe('fail');
    expect(pending.evidence.final).toBe(false); // still running — keep waiting

    const empty = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => url.endsWith('/pulls/7') ? { head: { sha: 'abc' } } : { check_runs: [] },
    });
    const inconclusive = await evaluateValidation('ci_green', { item: item(), profileId: 'u1' }, empty);
    expect(inconclusive.status).toBe('inconclusive');
    expect(inconclusive.evidence.reason).toBe('no-check-runs');
  });

  it('ci_green treats conditionally-skipped jobs as green, not as failures', async () => {
    // autofix runs only on a red PR, notify-merge-queue only on a push to main,
    // close-original only on autofix PRs — every PR in the repo carries them as
    // skipped, and counting them as red made ci_green fail on a fully green PR.
    const registry = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => {
        if (url.endsWith('/pulls/7')) return { head: { sha: 'abc' } };
        if (url.endsWith('/commits/abc/check-runs')) {
          return { check_runs: [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'staging-gate', status: 'completed', conclusion: 'success' },
            { name: 'merge', status: 'completed', conclusion: 'success' },
            { name: 'deploy-gcp', status: 'completed', conclusion: 'success' },
            { name: 'autofix', status: 'completed', conclusion: 'skipped' },
            { name: 'notify-merge-queue', status: 'completed', conclusion: 'skipped' },
            { name: 'close-original', status: 'completed', conclusion: 'skipped' },
          ] };
        }
        return null;
      },
    });
    const r = await evaluateValidation('ci_green', { item: item(), profileId: 'u1', validation: true }, registry);
    expect(r.status).toBe('pass');
    expect(r.evidence.failing).toBeUndefined();
  });

  it('ci_green keeps a red run red next to skips, and never passes on skips alone', async () => {
    const red = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => url.endsWith('/pulls/7')
        ? { head: { sha: 'abc' } }
        : { check_runs: [
            { name: 'ci', status: 'completed', conclusion: 'failure' },
            { name: 'autofix', status: 'completed', conclusion: 'skipped' },
          ] },
    });
    const fail = await evaluateValidation('ci_green', { item: item(), profileId: 'u1' }, red);
    expect(fail.status).toBe('fail');
    expect(fail.evidence.failing).toEqual(['ci']); // the skip is not "failing"
    expect(fail.evidence.final).toBe(true);

    const allSkipped = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async (url) => url.endsWith('/pulls/7')
        ? { head: { sha: 'abc' } }
        : { check_runs: [
            { name: 'autofix', status: 'completed', conclusion: 'skipped' },
            { name: 'notify-merge-queue', status: 'completed', conclusion: 'skipped' },
          ] },
    });
    const inconclusive = await evaluateValidation('ci_green', { item: item(), profileId: 'u1' }, allSkipped);
    expect(inconclusive.status).toBe('inconclusive'); // no evidence is not green
    expect(inconclusive.evidence.reason).toBe('all-runs-skipped');
  });

  it('checkRunsGreen: shared verdict for the validator and the checklist precheck', () => {
    const run = (conclusion, status = 'completed') => ({ name: conclusion, status, conclusion });
    expect(checkRunsGreen([run('success'), run('skipped')])).toBe(true);
    expect(checkRunsGreen([run('success'), run('neutral')])).toBe(true);
    expect(checkRunsGreen([run('failure'), run('skipped')])).toBe(false);
    expect(checkRunsGreen([run(null, 'in_progress')])).toBe(false);
    expect(checkRunsGreen([run('skipped'), run('skipped')])).toBe(null);
    expect(checkRunsGreen([])).toBe(null);
    expect(checkRunsGreen(null)).toBe(null);
  });

  it('ci_green is inconclusive without a PR url or without a github token', async () => {
    const registry = createDefaultRegistry({ ghToken: () => null, ghFetch: async () => null });
    const noPr = await evaluateValidation('ci_green', { item: item({ instructions: 'no link' }), profileId: 'u1' }, registry);
    expect(noPr.evidence.reason).toBe('no-pr-url');
    const noToken = await evaluateValidation('ci_green', { item: item(), profileId: null }, registry);
    expect(noToken.evidence.reason).toBe('no-github-token');
  });

  it('merged passes on merged:true, fails on an open PR', async () => {
    const merged = createDefaultRegistry({
      ghToken: () => 'token',
      ghFetch: async () => ({ merged: true, merged_at: '2026-09-26T00:00:00Z', merge_commit_sha: 'deadbeef' }),
    });
    const pass = await evaluateValidation('merged', { item: item(), profileId: 'u1' }, merged);
    expect(pass.status).toBe('pass');

    const open = createDefaultRegistry({
      ghToken: () => 'token', ghFetch: async () => ({ merged: false, state: 'open' }),
    });
    const fail = await evaluateValidation('merged', { item: item(), profileId: 'u1' }, open);
    expect(fail.status).toBe('fail');
    // an open PR keeps the durable wait polling — the fail is not final
    expect(fail.evidence.final).toBeUndefined();
  });

  it('merged marks a closed-unmerged PR as a final fail so the wait wakes at once (#1959)', async () => {
    const closed = createDefaultRegistry({
      ghToken: () => 'token', ghFetch: async () => ({ merged: false, state: 'closed' }),
    });
    const r = await evaluateValidation('merged', { item: item(), profileId: 'u1' }, closed);
    expect(r.status).toBe('fail');
    expect(r.evidence.final).toBe(true);
    expect(r.evidence.reason).toBe('pr-closed-unmerged');
  });

  it('merged_and_deployed passes the merge but stays inconclusive on deploy', async () => {
    const registry = createDefaultRegistry({
      ghToken: () => 'token', ghFetch: async () => ({ merged: true }),
    });
    const r = await evaluateValidation('merged_and_deployed', { item: item(), profileId: 'u1' }, registry);
    expect(r.status).toBe('inconclusive');
    expect(r.evidence.reason).toBe('deploy-unverified');
  });

  describe('pr_opened (#1449)', () => {
    const prBody = {
      state: 'open', merged: false, number: 7,
      html_url: 'https://github.com/acme/widgets/pull/7', head: { ref: 'fix/x' },
    };

    it('passes on a referenced PR that exists', async () => {
      const registry = createDefaultRegistry({
        ghToken: () => 'token',
        ghFetch: async url => (url.endsWith('/pulls/7') ? prBody : null),
      });
      const r = await evaluateValidation('pr_opened', { item: item(), profileId: 'u1' }, registry);
      expect(r.status).toBe('pass');
      expect(r.subject.number).toBe('7');
    });

    it('is inconclusive when the referenced PR does not exist', async () => {
      const registry = createDefaultRegistry({ ghToken: () => 'token', ghFetch: async () => null });
      const r = await evaluateValidation('pr_opened', { item: item(), profileId: 'u1' }, registry);
      expect(r.status).toBe('inconclusive');
      expect(r.evidence.reason).toBe('pr-not-found');
    });

    it('fails on a closed PR — "a PR is open" is not true, so the step must run (#1959)', async () => {
      const registry = createDefaultRegistry({
        ghToken: () => 'token',
        ghFetch: async url => (url.endsWith('/pulls/7') ? { ...prBody, state: 'closed' } : null),
      });
      const r = await evaluateValidation('pr_opened', { item: item(), profileId: 'u1' }, registry);
      expect(r.status).toBe('fail');
      expect(r.evidence.reason).toBe('pr-closed');
    });

    it('finds a PR by repo + head branch when the validation names them', async () => {
      const seen = [];
      const registry = createDefaultRegistry({
        ghToken: () => 'token',
        ghFetch: async url => { seen.push(url); return [prBody]; },
      });
      const r = await evaluateValidation('pr_opened', {
        item: item({ instructions: 'no link here' }), profileId: 'u1',
        validation: { repo: 'acme/widgets', branch: 'fix/x' },
      }, registry);
      expect(r.status).toBe('pass');
      expect(r.subject).toMatchObject({ repo: 'acme/widgets', branch: 'fix/x' });
      expect(seen[0]).toContain('/pulls?head=acme%3Afix%2Fx');
    });

    it('discovers repo + branch from the git checkout via the injected gitInfo', async () => {
      const registry = createDefaultRegistry({
        ghToken: () => 'token',
        ghFetch: async () => [prBody],
        gitInfo: dir => (dir === '/repo' ? { repo: 'acme/widgets', branch: 'feature/y' } : null),
      });
      const r = await evaluateValidation('pr_opened', {
        item: item({ instructions: 'no link here' }), profileId: 'u1', projectDir: '/repo', validation: true,
      }, registry);
      expect(r.status).toBe('pass');
      expect(r.subject.branch).toBe('feature/y');
    });

    it('fails when no PR exists for the discovered branch', async () => {
      const registry = createDefaultRegistry({
        ghToken: () => 'token', ghFetch: async () => [],
        gitInfo: () => ({ repo: 'acme/widgets', branch: 'feature/y' }),
      });
      const r = await evaluateValidation('pr_opened', {
        item: item({ instructions: 'no link here' }), profileId: 'u1', projectDir: '/repo', validation: true,
      }, registry);
      expect(r.status).toBe('fail');
      expect(r.evidence.reason).toBe('no-pr-for-branch');
    });

    it('is inconclusive without a token or without a reference', async () => {
      const noToken = await evaluateValidation('pr_opened', { item: item(), profileId: null }, createDefaultRegistry({ ghToken: () => null, ghFetch: async () => null }));
      expect(noToken.evidence.reason).toBe('no-github-token');

      const noRef = await evaluateValidation('pr_opened', {
        item: item({ instructions: 'no link here' }), profileId: 'u1', validation: true,
      }, createDefaultRegistry({ ghToken: () => 'token', ghFetch: async () => null, gitInfo: () => null }));
      expect(noRef.status).toBe('inconclusive');
      expect(noRef.evidence.reason).toBe('no-pr-reference');
    });
  });

  // ci_run_green — the durable-wait key of the «прогон тестов в облаке» flow
  // (ci-run playbook): wait on one workflow_dispatch run the agent dispatched
  // itself. Registered → task_item_wait's `until` accepts it (an unknown key is
  // rejected there by normalizeAgentWait).
  describe('ci_run_green (ci-run playbook)', () => {
    const spec = { repo: 'acme/widgets', run_id: 123456 };
    const ctx = (validation = spec, profileId = 'u1') => ({ item: item({ instructions: 'no link here' }), profileId, validation });
    const withRun = run => createDefaultRegistry({ ghToken: () => 'token', ghFetch: async () => run });
    const green = { status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/actions/runs/123456' };

    it('is a registered key (a plan may wait on it)', () => {
      expect(Object.keys(createDefaultRegistry())).toContain('ci_run_green');
    });

    it('passes when the dispatched run completed green', async () => {
      const r = await evaluateValidation('ci_run_green', ctx(), withRun(green));
      expect(r.status).toBe('pass');
      expect(r.subject).toMatchObject({ repo: 'acme/widgets', run_id: 123456 });
      expect(r.subject.url).toContain('/actions/runs/123456');
      expect(r.evidence.conclusion).toBe('success');
    });

    it('fails FINALLY on a red or cancelled run so the wait wakes immediately', async () => {
      for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
        const r = await evaluateValidation('ci_run_green', ctx(), withRun({ ...green, conclusion }));
        expect(r.status, conclusion).toBe('fail');
        expect(r.evidence.final, conclusion).toBe(true); // waiting longer is pointless
        expect(r.evidence.conclusion).toBe(conclusion);
      }
    });

    it('stays inconclusive while the run is still going', async () => {
      const r = await evaluateValidation('ci_run_green', ctx(),
        withRun({ status: 'in_progress', conclusion: null }));
      expect(r.status).toBe('inconclusive');
      expect(r.evidence.reason).toBe('run-not-finished');
    });

    it('never guesses: missing inputs, no token, unknown run or a dead API are inconclusive', async () => {
      const noRun = await evaluateValidation('ci_run_green', ctx({ repo: 'acme/widgets' }),
        withRun(green));
      expect(noRun.evidence.reason).toBe('no-run-id');

      const noRepo = await evaluateValidation('ci_run_green', ctx(true), withRun(green));
      expect(noRepo.evidence.reason).toBe('no-repo');

      const noToken = await evaluateValidation('ci_run_green', ctx(spec, null),
        createDefaultRegistry({ ghToken: () => null, ghFetch: async () => { throw new Error('must not be called'); } }));
      expect(noToken.evidence.reason).toBe('no-github-token');

      const missing = await evaluateValidation('ci_run_green', ctx(), withRun(null));
      expect(missing.evidence.reason).toBe('run-not-found');

      let called = 0;
      const down = await evaluateValidation('ci_run_green', ctx(), createDefaultRegistry({
        ghToken: () => 'token', ghFetch: async () => { called++; throw new Error('ECONNRESET'); },
      }));
      expect(down.status).toBe('inconclusive');
      expect(down.evidence.reason).toBe('github-unreachable');
      expect(called).toBe(1);
    });
  });
});
