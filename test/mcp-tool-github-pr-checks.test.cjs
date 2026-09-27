// Contract tests for github_pr_checks tool (src/mcp-skills/tools/60-github.js).
// Stubs global fetch and a fake GH_TOKEN — hermetic, no network or real token. Covers the status
// aggregation logic: success (incl. skipped post-merge jobs), failure,
// pending, commit-status fallback, no-checks, and 404 on missing PR.
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// getToken() reads env at call time; without this the test only passed on
// machines that happen to have a real token (failed in CI, #1577).
process.env.GH_TOKEN = 'test-token';
delete process.env.GITHUB_TOKEN;

const { tools } = require('../src/mcp-skills/tools/60-github.js');

const PR = { number: 42, title: 'T', state: 'open', draft: false, merged: false, mergeable: true, head: { sha: 'abc123' }, html_url: 'https://github.com/owner/repo/pull/42' };
const run = (name, status, conclusion) => ({ name, app: { name: 'GitHub Actions' }, status, conclusion, started_at: '2026-09-27T00:00:00Z', completed_at: '2026-09-27T00:01:00Z', html_url: `https://github.com/owner/repo/actions/runs/1/job/2` });

function withFetch(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [prefix, body] of routes) {
      if (String(url).includes(prefix)) {
        if (body instanceof Error) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'Not Found' }) };
        return { ok: true, status: 200, statusText: 'OK', json: async () => body };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return fn().finally(() => { globalThis.fetch = real; });
}

(async () => {
  const h = args => tools.github_pr_checks.handler({ repo: 'owner/repo', ...args });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [run('ci', 'completed', 'success'), run('staging', 'completed', 'success'), run('autofix', 'completed', 'skipped')] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'success', `success + skipped post-merge jobs → success (got ${r.ci.status})`);
    ok(r.ci.check_runs_total === 3, 'check_runs_total = 3');
    ok(r.summary.completed === 3, '3 completed');
    ok(r.pr.head_sha === 'abc123', 'pr.head_sha surfaced');
    ok(r.check_runs.length === 3, 'per-run list of 3');
  });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [run('ci', 'completed', 'success'), run('lint', 'completed', 'failure')] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'failure', `any failed run → failure (got ${r.ci.status})`);
    ok(r.ci.check_runs_failed.some(f => f.conclusion === 'failure' && f.count === 1), 'failed run reported in check_runs_failed');
  });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [run('ci', 'in_progress', null), run('staging', 'queued', null)] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'pending', `in_progress/queued → pending (got ${r.ci.status})`);
    ok(r.summary.pending === 2, 'pending = 2');
  });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [] }],
    [`/commits/abc123/status`, { state: 'pending', total_count: 1, statuses: [{ context: 'ci', state: 'pending' }] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'pending' && r.ci.commit_status_state === 'pending', `commit-status fallback → pending (got ${r.ci.status})`);
  });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [] }],
    [`/commits/abc123/status`, { state: 'success', total_count: 1, statuses: [] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'success' && r.ci.commit_status_state === 'success', `commit-status fallback → success (got ${r.ci.status})`);
  });

  await withFetch([
    [`/pulls/42`, PR],
    [`/commits/abc123/check-runs`, { check_runs: [] }],
    [`/commits/abc123/status`, { state: 'no-status', total_count: 0, statuses: [] }],
  ], async () => {
    const r = await h({ pr_number: 42 });
    ok(r.ci.status === 'no-checks', `no runs + no statuses → no-checks (got ${r.ci.status})`);
  });

  await withFetch([
    [`/pulls/999`, new Error('404')],
  ], async () => {
    let threw = false;
    try { await h({ pr_number: 999 }); } catch (e) { threw = String(e.message).includes('404'); }
    ok(threw, 'missing PR → throws 404');
  });

  console.log(`\nmcp-tool-github-pr-checks: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();