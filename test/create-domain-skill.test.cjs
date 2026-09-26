'use strict';
// create-domain-skill scaffold (issue #1440): the generated repo must already
// satisfy the domain-skill conformance gate and serve a working MCP server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDomainSkill } = require('../packages/create-domain-skill/lib/scaffold');
const kit = require('../packages/mcp-skill-testkit');

const EXPECTED = [
  'mcp.manifest.json',
  'package.json',
  'README.md',
  'checklist.md',
  '.gitignore',
  '.github/workflows/ci.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'src/mcp-skills/index.js',
  'src/mcp-skills/registry.js',
  'src/mcp-skills/tool-result.js',
  'src/mcp-skills/tools/01-example.js',
  'test/contract.test.mjs',
  'test/behavior.test.mjs',
  'scripts/sync-manifest.mjs',
  'staging/run.mjs',
  'staging/suites.json',
  'scenarios/example/steps.json',
  'fixtures/README.md',
  'docs/user-scenarios/demo/01-demo-overview.md',
];

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scaffold generates a repo that passes the conformance gate', async (t) => {
  const dir = tmp(t, 'create-domain-skill-');
  const target = path.join(dir, 'trained-assist-demo-skill');
  const result = createDomainSkill({ domain: 'demo', targetDir: target });

  for (const rel of EXPECTED) assert.ok(fs.existsSync(path.join(target, rel)), `missing ${rel}`);

  const { manifest } = kit.assertManifestConforms(path.join(target, 'mcp.manifest.json'));
  assert.equal(manifest.sources[0].repository, 'trained-assist/trained-assist-demo-skill');
  assert.equal(manifest.sources[0].artifactDigest, kit.artifactDigest(path.join(target, 'src', 'mcp-skills')));
  assert.equal(result.artifactDigest, manifest.sources[0].artifactDigest);

  const conf = kit.checkDomainSkillRepo(target);
  assert.equal(conf.ok, true, JSON.stringify(conf.checks));
});

test('generated server advertises and serves the example tool', async (t) => {
  const dir = tmp(t, 'create-domain-skill-run-');
  const target = path.join(dir, 'repo');
  createDomainSkill({ domain: 'demo', targetDir: target });

  const server = await kit.startMcpServer({ entrypoint: path.join(target, 'src', 'mcp-skills', 'index.js'), workDir: target });
  try {
    const { tools } = await server.call('tools/list');
    assert.deepEqual(tools.map((x) => x.name), ['example_status']);
    await kit.expectToolContract(server.call, tools, [
      { name: 'example_status', validArgs: {}, expectedEnvelope: { ok: true, domain: 'demo' } },
    ]);
  } finally {
    await server.stop();
  }
});

test('scaffold rejects an invalid domain and a non-empty target', (t) => {
  const dir = tmp(t, 'create-domain-skill-bad-');
  assert.throws(() => createDomainSkill({ domain: 'Bad Domain', targetDir: path.join(dir, 'x') }), /must match/);

  const target = path.join(dir, 'repo');
  createDomainSkill({ domain: 'demo', targetDir: target });
  assert.throws(() => createDomainSkill({ domain: 'demo', targetDir: target }), /refusing to overwrite/);
});
