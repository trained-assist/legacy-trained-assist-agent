// L1 contract (hermetic): manifest conformance + tool-name parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpServer, assertManifestConforms, artifactDigest } from '@trained-assist/mcp-skill-testkit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'mcp.manifest.json');
const entrypoint = join(root, 'src', 'mcp-skills', 'index.js');

test('manifest conforms to contracts/mcp-skill-sources.schema.json', () => {
  assertManifestConforms(manifestPath);
});

test('artifactDigest matches the recomputed digest', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.sources[0].artifactDigest, artifactDigest(join(root, 'src', 'mcp-skills')));
});

test('tool names in the manifest equal tools/list (no extra, no missing)', async () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = new Set((manifest.sources[0].approvedManifest.actions || []).map((a) => a.name));
  const server = await startMcpServer({ entrypoint, workDir: root });
  try {
    const { tools } = await server.call('tools/list');
    assert.deepEqual(new Set(tools.map((t) => t.name)), expected);
  } finally {
    await server.stop();
  }
});
