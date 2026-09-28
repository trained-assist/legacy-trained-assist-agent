'use strict';
// site_deploy (issue #1774): the Cloudflare token stays server-side; the profile's own
// token wins over the shared default; on the shared account one profile cannot
// overwrite another profile's (or an unrecorded) Pages project; only folders inside
// the caller's profile can be shipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deploySite, deployStatus, resolveCredential } = require('../src/cf-pages');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-pages-'));
  const tokensRoot = path.join(root, 'tokens');
  const dataRoot = path.join(root, 'data');
  const work = (u) => {
    const w = path.join(root, 'users', u);
    fs.mkdirSync(path.join(w, 'site'), { recursive: true });
    fs.writeFileSync(path.join(w, 'site', 'index.html'), '<h1>x</h1>');
    return w;
  };
  return { root, tokensRoot, dataRoot, work };
}

// Fake Cloudflare API: projects = Set of existing names in the account.
function fakeCf(projects, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, method: opts.method, auth: opts.headers?.Authorization });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
    if (url.endsWith('/accounts?per_page=5')) return ok([{ id: 'acc1' }]);
    const m = url.match(/\/pages\/projects\/([^/]+)$/);
    if (m && opts.method === 'GET') {
      return projects.has(m[1]) ? ok({ name: m[1] }) : { ok: false, status: 404, json: async () => ({ success: false, errors: [{ code: 8000007, message: 'not found' }] }) };
    }
    if (url.endsWith('/pages/projects') && opts.method === 'POST') {
      projects.add(JSON.parse(opts.body).name);
      return ok({});
    }
    throw new Error('unexpected ' + url);
  };
}

const okWrangler = (seen) => async (args, env) => {
  seen.push({ args, env });
  return { code: 0, stdout: 'Deployment complete! https://abc123.demo-site.pages.dev', stderr: '' };
};

test('shared default: creates the project, records the owner, token only in the wrangler child env', async () => {
  const s = sandbox(); const w = s.work('alice'); const projects = new Set(); const seen = [];
  const r = await deploySite({ username: 'alice', dir: 'site', project: 'demo-site' }, {
    env: { CF_API_TOKEN: 'shared-tok', PATH: process.env.PATH }, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w,
    fetchImpl: fakeCf(projects), runWranglerImpl: okWrangler(seen),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.token_source, 'shared');
  assert.equal(r.created, true);
  assert.equal(r.url, 'https://demo-site.pages.dev');
  assert.equal(seen[0].env.CLOUDFLARE_API_TOKEN, 'shared-tok');
  assert.equal(seen[0].env.CLOUDFLARE_ACCOUNT_ID, 'acc1');
  assert.ok(!JSON.stringify(r).includes('shared-tok'), 'token never in the tool result');
  const ledger = JSON.parse(fs.readFileSync(path.join(s.dataRoot, 'cf-pages-owners.json'), 'utf8'));
  assert.equal(ledger['acc1/demo-site'].owner, 'alice');
});

test('shared default: another profile cannot overwrite an owned project; owner can redeploy', async () => {
  const s = sandbox(); const wa = s.work('alice'); const wb = s.work('bob'); const projects = new Set();
  const deps = (w) => ({ env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acc1' }, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w, fetchImpl: fakeCf(projects), runWranglerImpl: okWrangler([]) });
  assert.equal((await deploySite({ username: 'alice', dir: 'site', project: 'demo-site' }, deps(wa))).ok, true);
  const bob = await deploySite({ username: 'bob', dir: 'site', project: 'demo-site' }, deps(wb));
  assert.equal(bob.ok, false);
  assert.match(bob.error, /другому профилю/);
  const again = await deploySite({ username: 'alice', dir: 'site', project: 'demo-site' }, deps(wa));
  assert.equal(again.ok, true); assert.equal(again.created, false);
});

test('shared default: pre-existing unrecorded project is refused unless the profile is an admin', async () => {
  const s = sandbox(); const w = s.work('carol'); const projects = new Set(['legacy-expo']);
  const mk = (env) => ({ env, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w, fetchImpl: fakeCf(projects), runWranglerImpl: okWrangler([]) });
  const r = await deploySite({ username: 'carol', dir: 'site', project: 'legacy-expo' }, mk({ CF_API_TOKEN: 't' }));
  assert.equal(r.ok, false); assert.match(r.error, /ни за кем не закреплён/);
  const a = await deploySite({ username: 'carol', dir: 'site', project: 'legacy-expo' }, mk({ CF_API_TOKEN: 't', CF_PAGES_ADMIN_USERS: 'carol' }));
  assert.equal(a.ok, true);
});

test('own token wins over shared and skips the shared ownership ledger', async () => {
  const s = sandbox(); const w = s.work('dave'); const projects = new Set(['my-site']); const seen = []; const calls = [];
  fs.mkdirSync(path.join(s.tokensRoot, 'dave'), { recursive: true });
  fs.writeFileSync(path.join(s.tokensRoot, 'dave', 'cloudflare'), JSON.stringify({ value: 'own-tok', account_id: 'acc-own' }));
  const r = await deploySite({ username: 'dave', dir: 'site', project: 'my-site' }, {
    env: { CF_API_TOKEN: 'shared-tok' }, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w,
    fetchImpl: fakeCf(projects, calls), runWranglerImpl: okWrangler(seen),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.token_source, 'own');
  assert.equal(seen[0].env.CLOUDFLARE_API_TOKEN, 'own-tok');
  assert.equal(seen[0].env.CLOUDFLARE_ACCOUNT_ID, 'acc-own');
  assert.ok(calls.every(c => c.auth === 'Bearer own-tok'));
  assert.equal(fs.existsSync(path.join(s.dataRoot, 'cf-pages-owners.json')), false);
});

test('source folder must be inside the profile and contain index.html', async () => {
  const s = sandbox(); const w = s.work('erin'); s.work('frank');
  const deps = { env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w, fetchImpl: fakeCf(new Set()), runWranglerImpl: okWrangler([]) };
  const other = path.join(s.root, 'users', 'frank', 'site');
  assert.match((await deploySite({ username: 'erin', dir: other, project: 'x-site' }, deps)).error, /внутри рабочей папки/);
  assert.match((await deploySite({ username: 'erin', dir: '../frank/site', project: 'x-site' }, deps)).error, /внутри рабочей папки/);
  fs.symlinkSync(other, path.join(w, 'link'));
  assert.match((await deploySite({ username: 'erin', dir: 'link', project: 'x-site' }, deps)).error, /внутри рабочей папки/);
  fs.mkdirSync(path.join(w, 'empty'));
  assert.match((await deploySite({ username: 'erin', dir: 'empty', project: 'x-site' }, deps)).error, /index\.html/);
  assert.match((await deploySite({ username: 'erin', dir: 'site', project: 'Bad Name' }, deps)).error, /имя проекта/);
});

test('no credential at all → clear error with the connect hint; status never leaks the token', async () => {
  const s = sandbox(); const w = s.work('gina');
  const r = await deploySite({ username: 'gina', dir: 'site', project: 'g-site' }, { env: {}, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w });
  assert.equal(r.ok, false); assert.match(r.hint, /cloudflare/);
  assert.equal(resolveCredential('gina', { env: {}, tokensRoot: s.tokensRoot }), null);
  const st = await deployStatus('gina', { env: { CF_API_TOKEN: 'secret-x' }, tokensRoot: s.tokensRoot, fetchImpl: fakeCf(new Set()) });
  assert.deepEqual(st, { ok: true, token_source: 'shared', account_id: 'acc1' });
});

test('wrangler failure output is returned with the token masked', async () => {
  const s = sandbox(); const w = s.work('hank');
  const r = await deploySite({ username: 'hank', dir: 'site', project: 'h-site' }, {
    env: { CF_API_TOKEN: 'tok-123', CF_ACCOUNT_ID: 'a' }, tokensRoot: s.tokensRoot, dataRoot: s.dataRoot, workDir: w,
    fetchImpl: fakeCf(new Set()), runWranglerImpl: async () => ({ code: 1, stdout: '', stderr: 'auth failed for tok-123' }),
  });
  assert.equal(r.ok, false);
  assert.ok(!r.output.includes('tok-123'));
});

test('a profile\'s own cloudflare token file is not exported into the engine env', () => {
  const s = sandbox();
  process.env.AGENT_TOKENS_ROOT = s.tokensRoot;
  delete require.cache[require.resolve('../src/user-tokens')];
  const { loadUserTokens } = require('../src/user-tokens');
  fs.mkdirSync(path.join(s.tokensRoot, 'ivan'), { recursive: true });
  fs.writeFileSync(path.join(s.tokensRoot, 'ivan', 'cloudflare'), JSON.stringify({ value: 'own' }));
  const env = loadUserTokens('ivan', 'ivan');
  assert.ok(!Object.values(env).includes('own') && !Object.values(env).some(v => String(v).includes('"own"')), JSON.stringify(env));
});
