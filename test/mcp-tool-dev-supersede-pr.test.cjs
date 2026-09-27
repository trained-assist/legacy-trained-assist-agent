// Contract tests for dev_supersede_pr tool (src/mcp-skills/tools/61-dev.js).
// Stubs global fetch and a fake GH_TOKEN — hermetic, no network or real token.
// Covers the immutable-PR supersede protocol (trained-assist-engineering#27):
// comment → ensure label → add label → close, optional issue log line, and
// idempotency (already closed / already labelled superseded → skipped, no
// side effects).
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// getToken() reads env at call time; without this the test only passed on
// machines that happen to have a real token.
process.env.GH_TOKEN = 'test-token';
delete process.env.GITHUB_TOKEN;

const { tools } = require('../src/mcp-skills/tools/61-dev.js');

const OPEN_PR = { number: 42, state: 'open', labels: [], head: { sha: 'abc123' }, html_url: 'https://github.com/owner/repo/pull/42' };
const OPEN_SUPERSEDED = { ...OPEN_PR, labels: [{ name: 'superseded' }] };
const CLOSED_PR = { ...OPEN_PR, state: 'closed' };

// What GitHub returns when a label with this name already exists (422).
const LABEL_EXISTS = { ok: false, status: 422, message: 'Validation Failed', errors: [{ message: 'name is already taken' }] };

function withFetch(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const [prefix, handler] of routes) {
      if (String(url).includes(prefix)) {
        const body = typeof handler === 'function' ? handler(url, method, opts) : handler;
        if (body instanceof Error) return { ok: false, status: body.status || 500, statusText: 'Err', json: async () => ({ message: body.message }) };
        if (body && body.ok === false) return { ok: false, status: body.status, statusText: body.message, json: async () => ({ message: body.message, errors: body.errors }) };
        return { ok: true, status: 200, statusText: 'OK', json: async () => body };
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return fn().finally(() => { globalThis.fetch = real; });
}

(async () => {
  const h = args => tools.dev_supersede_pr.handler({ repo: 'owner/repo', ...args });

  // 1. Full supersede: comment → ensure label (exists → 422 ignored) → add
  //    label → close → issue log line.
  let commented = false, labelAddAttempted = false, closed = false, issueLogged = null;
  const supersedeRoutes = [
    [`/pulls/42`, (url, method) => method === 'PATCH' ? (closed = true, { ...OPEN_PR, state: 'closed' }) : OPEN_PR],
    [`/issues/42/comments`, () => (commented = true, { id: 1 })],
    [`/issues/42/labels`, () => (labelAddAttempted = true, [{ name: 'superseded' }])],
    [`/labels`, () => LABEL_EXISTS],
    [`/issues/7/comments`, (url, method, opts) => (issueLogged = JSON.parse(opts.body).body, { id: 2 })],
  ];
  await withFetch(supersedeRoutes, async () => {
    const r = await h({ pr_number: 42, new_pr_number: 55, issue_number: 7, attempt: '3' });
    ok(r.status === 'superseded' && r.new_pr === 55, `superseded (got ${r.status})`);
    ok(commented, 'comment posted on old PR');
    ok(labelAddAttempted, 'superseded label added');
    ok(closed, 'old PR closed');
    ok(issueLogged === 'attempt 3 → PR #55', `issue log line (got ${issueLogged})`);
  });

  // 2. Idempotent: already closed → skipped, no side effects.
  await withFetch([[`/pulls/42`, CLOSED_PR]], async () => {
    const r = await h({ pr_number: 42, new_pr_number: 55 });
    ok(r.status === 'skipped' && /already closed/.test(r.reason), `closed → skipped (got ${r.status})`);
  });

  // 3. Idempotent: already labelled superseded → skipped, no side effects.
  await withFetch([[`/pulls/42`, OPEN_SUPERSEDED]], async () => {
    const r = await h({ pr_number: 42, new_pr_number: 55 });
    ok(r.status === 'skipped' && /superseded label/.test(r.reason), `already superseded → skipped (got ${r.status})`);
  });

  if (fail > 0) { console.error(`TEST FAILED: ${fail} check(s)`); process.exit(1); }
  console.log(`PASS: ${pass} checks`);
  process.exit(0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });