'use strict';
// Enforcement gate for domain-skill repos (issue #1440): the CLI must pass a
// conforming repo and fail a non-conforming one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../scripts/check-domain-skill-repo.mjs');

function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-conformance-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  write('src/mcp-skills/index.js', "'use strict';\n");
  write('docs/user-scenarios/demo/01-overview.md', '# demo\n');
  write('scenarios/demo/steps.json', '[]\n');
  write('fixtures/.gitkeep', '');
  write('staging/suites.json', JSON.stringify({ node: ['test/behavior.test.cjs'] }));
  write('.github/workflows/ci.yml', 'name: CI\n');
  write('checklist.md', '- [ ] CI green\n');
  write('mcp.manifest.json', JSON.stringify({
    version: 1,
    sources: [{
      id: 'demo', providerId: 'demo', mcpServerId: 'demo-skills', repository: 'org/demo-skill',
      revision: 'a'.repeat(40), manifestVersion: 1, artifactDir: 'dist',
      entrypoint: 'src/mcp-skills/index.js', manifest: 'mcp.manifest.json',
      artifactDigest: 'b'.repeat(64), approvedManifest: {}, enabled: false, profiles: ['p'],
    }],
  }));
  return { repo, write };
}

function runCli(repo) {
  return spawnSync(process.execPath, [CLI, repo], { encoding: 'utf8', timeout: 20000 });
}

test('conformance CLI passes a fully-provisioned domain repo', (t) => {
  const { repo } = makeRepo(t);
  const r = runCli(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS/m);
});

test('conformance CLI fails on missing artifacts and a non-conformant manifest', (t) => {
  const { repo, write } = makeRepo(t);
  fs.rmSync(path.join(repo, 'checklist.md'));
  write('mcp.manifest.json', JSON.stringify({ version: 1, sources: [{ id: 'demo' }] }));
  const r = runCli(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL/);
  assert.match(r.stdout, /checklist\.md/);
  assert.match(r.stdout, /manifest-conformance/);
});

test('conformance CLI flags L3 guard violations', (t) => {
  const { repo, write } = makeRepo(t);
  write('src/mcp-skills/tools/10-demo.js', "'use strict';\nconst { spawn } = require('child_process');\nspawn('claude', []);\n");
  const r = runCli(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /spawns Claude or requires the core runner/);
});
