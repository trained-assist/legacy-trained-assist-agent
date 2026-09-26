import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSourceRuntime, mergeAdapterServers, hasEnabledSources } = require('../src/mcp-source-runtime');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { ActionExecutions } = require('../src/action-executions');
const { ActionBrokerClient } = require('../src/mcp-action-broker');
const { stableStringify, digest } = require('../src/mcp-skill-generation');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-runtime-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeRegistry() {
  const reg = new ActionProviderRegistry();
  reg.register({ version: 1, providerId: 'fake', actions: [
    { name: 'marker_read', inputSchema: { type: 'object' }, allowedTriggers: ['user'],
      effect: 'read', requiresApproval: false, retrySafety: 'read_only' },
  ] });
  return reg;
}

function fakeGeneration({ profiles = ['alice'] } = {}) {
  const source = {
    id: 'fake', providerId: 'fake', mcpServerId: 'fake-skills',
    repository: 'trained-assist/fake', revision: 'a'.repeat(40), manifestVersion: 1,
    artifactDir: 'releases/fake', entrypoint: 'repo/index.js', manifest: 'repo/provider-manifest.json',
    artifactDigest: 'b'.repeat(64), enabled: true, profiles, artifactStatus: 'available',
    approvedManifest: { version: 1, providerId: 'fake',
      actions: [{ name: 'marker_read', inputSchema: { type: 'object' } }] },
  };
  const snapshot = {
    version: 1, generationId: 'gen-src', sources: [source], diagnostics: [],
    adapter: { command: process.execPath, entry: '/opt/adapter.js' },
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64), reservedServerIds: [],
    core: { servers: [], providerIds: [], actionNames: [] },
  };
  return {
    version: 1, generationId: 'gen-src', snapshot, snapshotDigest: digest(stableStringify(snapshot)),
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64),
    policy: { root: '/tmp' }, actions: fakeRegistry(), diagnostics: [],
  };
}

function hostBinding(overrides = {}) {
  return { engineRunId: 'run-1', rootTaskId: 'task-1', attemptId: null, profileId: 'alice',
    projectId: null, trigger: 'user', origin: 'mcp', channel: null, resourceBindingVersion: 'v1', ...overrides };
}

async function runtimeWith({ generation, executions, envPolicy, hostEnv } = {}) {
  const root = tmpDir();
  const ex = executions || new ActionExecutions(path.join(root, 'ops.db'));
  if (!executions) cleanups.push(() => ex.db.close());
  const runtime = createSourceRuntime({ generation: generation || fakeGeneration(), executions: ex,
    runtimeRoot: root, socketPath: path.join(root, 'broker.sock'),
    envPolicy: envPolicy ?? { version: 1, providers: {} }, hostEnv });
  cleanups.push(() => runtime.close());
  return { runtime, ex, root };
}

describe('source runtime host wiring', () => {
  it('is disabled when the approved config has no enabled sources', async () => {
    const runtime = createSourceRuntime({ config: { version: 1, sources: [] } });
    expect(runtime.enabled).toBe(false);
    expect(await runtime.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: tmpDir() })).toBe(null);
    expect(hasEnabledSources({ sources: [{ enabled: false }] })).toBe(false);
  });

  it('materializes adapter descriptors and registers a revocable capability for a run', async () => {
    const { runtime } = await runtimeWith();
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: path.join(tmpDir(), 'run-1') });
    expect(run).not.toBe(null);
    expect(Object.keys(run.servers)).toEqual(['fake-skills']);
    expect(run.servers['fake-skills'].args).toContain('/opt/adapter.js');
    expect(run.servers['fake-skills'].args.join(' ')).toContain('run-binding.json');
    run.release();
    expect(runtime.broker.size).toBe(0);
  });

  it('returns null when the profile is not eligible for the source', async () => {
    const { runtime } = await runtimeWith({ generation: fakeGeneration({ profiles: ['someone-else'] }) });
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding({ profileId: 'alice' }), runtimeDir: path.join(tmpDir(), 'run-x') });
    expect(run).toBe(null);
  });

  it('exposes a working capability to an adapter-style broker client', async () => {
    const { runtime } = await runtimeWith();
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: path.join(tmpDir(), 'run-2') });
    const binding = JSON.parse(fs.readFileSync(path.join(run.runtimeDir, 'fake-skills', 'run-binding.json'), 'utf8'));
    const client = await ActionBrokerClient.connect(binding.brokerEndpoint, {
      capability: binding.brokerCapability,
      onProvider: async ({ action, arguments: args }) => ({ tool: action, q: args.q }),
    });
    cleanups.push(() => client.close());
    const result = await client.call('marker_read', { q: 'host' });
    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ tool: 'marker_read', q: 'host' });
    run.release();
  });

  it('hands the provider a host-built env over the capability, never via the binding file (#1470 P0.1a)', async () => {
    const { runtime } = await runtimeWith({
      envPolicy: { version: 1, providers: { fake: { identity: ['USER_ID'], passthrough: ['AGENT_SECRET'] } } },
      hostEnv: { PATH: '/bin', AGENT_SECRET: 'host-secret-value', OTHER_SECRET: 'nope' },
    });
    const run = await runtime.prepareRun({ hostRunBinding: hostBinding(), runtimeDir: path.join(tmpDir(), 'run-env') });
    const bindingText = fs.readFileSync(path.join(run.runtimeDir, 'fake-skills', 'run-binding.json'), 'utf8');
    expect(bindingText).not.toContain('host-secret-value');
    const binding = JSON.parse(bindingText);
    const client = await ActionBrokerClient.connect(binding.brokerEndpoint, {
      capability: binding.brokerCapability, onProvider: async () => null });
    cleanups.push(() => client.close());
    expect(await client.providerEnv('fake')).toEqual({ PATH: '/bin', USER_ID: 'alice', AGENT_SECRET: 'host-secret-value' });
    run.release();
    await expect(client.providerEnv('fake')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never shadows an existing core server name', () => {
    const { merged, skipped } = mergeAdapterServers({ playwright: { command: 'x' } }, { playwright: { command: 'y' }, 'fake-skills': { command: 'z' } });
    expect(merged.playwright.command).toBe('x');
    expect(skipped).toEqual(['playwright']);
    expect(merged['fake-skills'].command).toBe('z');
  });
});
