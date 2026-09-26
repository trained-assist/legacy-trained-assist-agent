import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Issue #1470 P0.1c / #1511 acceptance: the HH serving toggle is a pure admin
// config change and is reversible. This is the runtime -> browser.js seam the
// runner actually uses: `prepareRun()` materializes the sealed adapter server
// for an eligible profile and `writeMcpConfig()` must then serve hh from that
// adapter, not the sibling checkout. Roll the config back (or have an ineligible
// profile) and the sibling is the core fallback — no redeploy, no code change.
const require = createRequire(import.meta.url);
const { createSourceRuntime } = require('../src/mcp-source-runtime');
const { ActionExecutions } = require('../src/action-executions');
const { writeMcpConfig } = require('../src/browser');
const { stableStringify, digest } = require('../src/mcp-skill-generation');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-toggle-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hhGeneration({ profiles = ['alice'] } = {}) {
  const source = {
    id: 'hh', providerId: 'hh', mcpServerId: 'hh-skills',
    repository: 'trained-assist/trained-assist-hh-skill', revision: 'a'.repeat(40), manifestVersion: 1,
    artifactDir: 'releases/hh', entrypoint: 'repo/src/mcp-skills/index.js', manifest: 'repo/action-provider-manifest.json',
    artifactDigest: 'b'.repeat(64), enabled: true, profiles, artifactStatus: 'available',
    approvedManifest: { version: 1, providerId: 'hh',
      actions: [{ name: 'hh_list_vacancies', inputSchema: { type: 'object' } }] },
  };
  const snapshot = {
    version: 1, generationId: 'gen-hh', sources: [source], diagnostics: [],
    adapter: { command: process.execPath, entry: '/opt/mcp-provider-adapter.js' },
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64), reservedServerIds: [],
    core: { servers: [], providerIds: [], actionNames: [] },
  };
  return {
    version: 1, generationId: 'gen-hh', snapshot, snapshotDigest: digest(stableStringify(snapshot)),
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64),
    policy: { root: '/tmp' }, actions: { list: () => [] }, diagnostics: [],
  };
}

function hostBinding(overrides = {}) {
  return { engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice',
    projectId: null, trigger: 'user', origin: 'telegram', resourceBindingVersion: 'v1', ...overrides };
}

async function runtimeWith({ generation }) {
  const root = tmpDir();
  const executions = new ActionExecutions(path.join(root, 'ops.db'));
  cleanups.push(() => executions.db.close());
  const runtime = createSourceRuntime({ generation, executions,
    runtimeRoot: root, socketPath: path.join(root, 'broker.sock') });
  cleanups.push(() => runtime.close());
  return runtime;
}

async function hhServerFrom(configPath, { extraServers }) {
  const config = JSON.parse(fs.readFileSync(writeMcpConfig(tmpDir(), 'alice', {
    extraServers,
    // Hermetic sibling: a temp file, never the real checkout.
    siblingPaths: { 'hh-skills': configPath },
  }), 'utf8'));
  return config.mcpServers['hh-skills'];
}

describe('hh sealed-source toggle (runtime -> .mcp.json)', () => {
  it('enabled + eligible profile: hh comes from the sealed adapter, sibling suppressed', async () => {
    const runtime = await runtimeWith({ generation: hhGeneration({ profiles: ['alice'] }) });
    const siblingIndex = path.join(tmpDir(), 'sibling-hh-index.js');
    fs.writeFileSync(siblingIndex, '// sibling');
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: path.join(tmpDir(), 'run-1') });

    expect(Object.keys(run.servers)).toEqual(['hh-skills']);
    const hh = await hhServerFrom(siblingIndex, { extraServers: run.servers });
    expect(hh.args[0]).toBe('/opt/mcp-provider-adapter.js');
    expect(hh.args[0]).not.toBe(siblingIndex);
    run.release();
  });

  it('rolled back (no enabled sources): prepareRun is null and hh falls back to the sibling', async () => {
    const disabled = createSourceRuntime({ config: { version: 1, sources: [] } });
    expect(disabled.enabled).toBe(false);
    const run = await disabled.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: tmpDir() });
    expect(run).toBe(null);

    const siblingIndex = path.join(tmpDir(), 'sibling-hh-index.js');
    fs.writeFileSync(siblingIndex, '// sibling');
    const hh = await hhServerFrom(siblingIndex, { extraServers: run?.servers });
    expect(hh.command).toBe('node');
    expect(hh.args[0]).toBe(siblingIndex);
  });

  it('ineligible profile: no sealed server for the run, sibling (core) still serves', async () => {
    const runtime = await runtimeWith({ generation: hhGeneration({ profiles: ['someone-else'] }) });
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding({ profileId: 'alice' }), runtimeDir: tmpDir() });
    expect(run).toBe(null);

    const siblingIndex = path.join(tmpDir(), 'sibling-hh-index.js');
    fs.writeFileSync(siblingIndex, '// sibling');
    const hh = await hhServerFrom(siblingIndex, { extraServers: run?.servers });
    expect(hh.args[0]).toBe(siblingIndex);
  });
});
