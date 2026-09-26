'use strict';
// Tests for @trained-assist/mcp-skill-testkit (Phase 2, issue #1440).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const kit = require('../packages/mcp-skill-testkit');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('startMcpServer boots a real server and answers tools/list', async (t) => {
  const provider = kit.fakeProvider();
  const server = await provider.start();
  t.after(() => server.stop());
  const { tools } = await server.call('tools/list');
  assert.deepEqual(tools.map((x) => x.name), ['marker_read']);
});

test('expectToolContract passes a conforming tool and rejects a bad envelope', async (t) => {
  const server = await kit.fakeProvider().start();
  t.after(() => server.stop());
  const { tools } = await server.call('tools/list');

  const ok = await kit.expectToolContract(server.call, tools, [
    { name: 'marker_read', validArgs: { q: 'x' }, expectedEnvelope: { marker: 'x', tool: 'marker_read' } },
  ]);
  assert.equal(ok.length, 1);

  await assert.rejects(
    kit.expectToolContract(server.call, tools, [
      { name: 'marker_read', validArgs: { q: 'x' }, expectedEnvelope: { marker: 'nope' } },
      { name: 'does_not_exist', validArgs: {} },
    ]),
    (e) => e.code === 'TOOL_CONTRACT_VIOLATION' && e.failures.length === 2,
  );
});

test('expectToolContract accepts isError envelopes, not crashes', async (t) => {
  const server = await kit.fakeProvider({ flags: ['--fail-tool'] }).start();
  t.after(() => server.stop());
  const { tools } = await server.call('tools/list');
  const res = await kit.expectToolContract(server.call, tools, [
    { name: 'marker_read', validArgs: {}, expectError: true },
  ]);
  assert.equal(res[0].result.isError, true);
});

test('assertManifestConforms accepts a valid manifest and rejects an invalid one', (t) => {
  const dir = tmp(t, 'testkit-manifest-');
  const valid = {
    version: 1,
    sources: [{
      id: 'x', providerId: 'x', mcpServerId: 'x', repository: 'org/repo',
      revision: 'a'.repeat(40), manifestVersion: 1, artifactDir: 'dist',
      entrypoint: 'src/index.js', manifest: 'mcp.manifest.json',
      artifactDigest: 'b'.repeat(64), approvedManifest: {}, enabled: false, profiles: ['p'],
    }],
  };
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify(valid));
  assert.equal(kit.assertManifestConforms(good).ok, true);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ version: 1, sources: [{ id: 'x' }] }));
  assert.throws(() => kit.assertManifestConforms(bad), (e) => e.code === 'MANIFEST_NONCONFORMANT');
});

test('replayFixtures serves recorded responses and blocks unrecorded hosts', async (t) => {
  const dir = tmp(t, 'testkit-fixtures-');
  fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({
    host: 'api.example.test', method: 'get', path: '/ok', status: 200, response: { hello: 'world' },
  }));
  const replay = kit.replayFixtures(dir);
  t.after(() => replay.restore());

  const body = await new Promise((resolve, reject) => {
    require('https').get('https://api.example.test/ok', (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.deepEqual(JSON.parse(body.d), { hello: 'world' });
  replay.assertDone();

  await assert.rejects(new Promise((resolve, reject) => {
    http.get('http://other.invalid/nope', (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  }));
});

test('fakeProvider exposes a spawn-safe descriptor and custom tools', async (t) => {
  const provider = kit.fakeProvider({ tools: [{ name: 'custom', inputSchema: { type: 'object' } }], flags: ['--echo-env'] });
  assert.equal(provider.argv[0], kit.FAKE_PROVIDER_ENTRYPOINT);
  assert.ok(provider.argv.includes('--echo-env'));
  const server = await provider.start();
  t.after(() => server.stop());
  const { tools } = await server.call('tools/list');
  assert.deepEqual(tools.map((x) => x.name), ['custom']);
});

test('checkDomainSkillRepo passes a clean repo and flags missing artifacts', (t) => {
  const repo = tmp(t, 'testkit-domain-');
  const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
  mkdirp(path.join(repo, 'src', 'mcp-skills', 'tools'));
  mkdirp(path.join(repo, 'docs', 'user-scenarios', 'demo'));
  mkdirp(path.join(repo, 'scenarios', 'demo'));
  mkdirp(path.join(repo, 'fixtures'));
  mkdirp(path.join(repo, 'staging'));
  mkdirp(path.join(repo, '.github', 'workflows'));
  fs.writeFileSync(path.join(repo, 'src', 'mcp-skills', 'index.js'), "'use strict';\n");
  fs.writeFileSync(path.join(repo, 'docs', 'user-scenarios', 'demo', '01.md'), '# demo\n');
  fs.writeFileSync(path.join(repo, 'staging', 'suites.json'), JSON.stringify({ node: ['test/behavior.test.cjs'] }));
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  fs.writeFileSync(path.join(repo, 'checklist.md'), '- [ ] CI green\n');
  fs.writeFileSync(path.join(repo, 'mcp.manifest.json'), JSON.stringify({
    version: 1,
    sources: [{
      id: 'demo', providerId: 'demo', mcpServerId: 'demo-skills', repository: 'org/repo',
      revision: 'a'.repeat(40), manifestVersion: 1, artifactDir: 'dist',
      entrypoint: 'src/mcp-skills/index.js', manifest: 'mcp.manifest.json',
      artifactDigest: 'b'.repeat(64), approvedManifest: {}, enabled: false, profiles: ['p'],
    }],
  }));

  const clean = kit.checkDomainSkillRepo(repo);
  assert.equal(clean.ok, true, JSON.stringify(clean.checks));

  fs.rmSync(path.join(repo, 'checklist.md'));
  const dirty = kit.checkDomainSkillRepo(repo);
  assert.equal(dirty.ok, false);
  assert.match(dirty.checks.find((c) => c.name === 'required-artifacts').detail, /checklist\.md/);
});

test('core thin re-exports resolve to the kit implementation', () => {
  const guard = require('../scripts/staging/isolation-guard.cjs');
  assert.equal(typeof guard.checkRoots, 'function');
  assert.equal(typeof guard.isLoopback, 'function');
  assert.equal(
    path.resolve(require.resolve('../packages/mcp-skill-testkit/isolation-guard.cjs')),
    path.resolve(path.join(__dirname, '..', 'packages', 'mcp-skill-testkit', 'isolation-guard.cjs')),
  );
});
