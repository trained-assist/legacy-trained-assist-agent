import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PR2b host wiring (issue #1358/#1374): runner/index.js and hermes-tools-run.js call
// sourceRuntime.prepareRun() and pass its `servers` into writeMcpConfig()'s extraServers,
// which merges them into the SAME .mcp.json every engine already reads. This test proves
// that merge is faithful all the way through each engine's own config translation layer
// (claude reads .mcp.json directly, codex via codexMcpArgs, opencode via
// writeOpencodeMcpConfig) — not just that prepareRun() returns a plausible-looking object
// (already covered by tests/mcp-source-runtime.test.js).
const require = createRequire(import.meta.url);
const { createSourceRuntime } = require('../src/mcp-source-runtime');
const { ActionExecutions } = require('../src/action-executions');
const { writeMcpConfig } = require('../src/browser');
const { codexMcpArgs, writeOpencodeMcpConfig, _const } = require('../src/runner/claude-runner');
const { stableStringify, digest } = require('../src/mcp-skill-generation');

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) { try { await fn(); } catch { /* ignore */ } }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-wiring-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake source generation with a single read-only action (marker_read) — same shape as
// mcp-source-runtime.test.js's fixture, kept local so this file stays a self-contained smoke
// check of the wiring rather than depending on another test file's helper.
function fakeGeneration() {
  const source = {
    id: 'fake', providerId: 'fake', mcpServerId: 'fake-skills',
    repository: 'trained-assist/fake', revision: 'a'.repeat(40), manifestVersion: 1,
    artifactDir: 'releases/fake', entrypoint: 'repo/index.js', manifest: 'repo/provider-manifest.json',
    artifactDigest: 'b'.repeat(64), enabled: true, profiles: ['alice'], artifactStatus: 'available',
    approvedManifest: { version: 1, providerId: 'fake',
      actions: [{ name: 'marker_read', inputSchema: { type: 'object' } }] },
  };
  const snapshot = {
    version: 1, generationId: 'gen-wiring', sources: [source], diagnostics: [],
    adapter: { command: process.execPath, entry: '/opt/adapter.js' },
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64), reservedServerIds: [],
    core: { servers: [], providerIds: [], actionNames: [] },
  };
  return {
    version: 1, generationId: 'gen-wiring', snapshot, snapshotDigest: digest(stableStringify(snapshot)),
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64),
    policy: { root: '/tmp' }, actions: { list: () => [] }, diagnostics: [],
  };
}

describe('PR2b host wiring reaches every engine config translator', () => {
  it('claude (.mcp.json), codex (-c overrides) and opencode (OPENCODE_CONFIG) all see the adapter server, core names untouched', async () => {
    const root = tmpDir();
    const executions = new ActionExecutions(path.join(root, 'ops.db'));
    cleanups.push(() => executions.db.close());
    const runtime = createSourceRuntime({
      generation: fakeGeneration(), executions, runtimeRoot: root,
      socketPath: path.join(root, 'broker.sock'),
    });
    cleanups.push(() => runtime.close());
    expect(runtime.enabled).toBe(true);

    const run = await runtime.prepareRun({
      hostRunBinding: {
        engineRunId: 'run-1', rootTaskId: 'task-1', profileId: 'alice', projectId: null,
        trigger: 'user', origin: 'telegram', resourceBindingVersion: 'v1',
      },
      runtimeDir: path.join(root, 'run-1'),
    });
    expect(run).not.toBe(null);
    expect(Object.keys(run.servers)).toEqual(['fake-skills']);

    // Same call runner/index.js and hermes-tools-run.js make: extraServers merged into the
    // one per-profile .mcp.json every engine reads.
    const workDir = tmpDir();
    const configPath = writeMcpConfig(workDir, 'alice', { userName: 'Alice', userHandle: 'alice', extraServers: run.servers });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Core servers untouched, adapter server present alongside them.
    expect(config.mcpServers.playwright).toBeTruthy();
    expect(config.mcpServers['trained-skills']).toBeTruthy();
    expect(config.mcpServers['fake-skills'].command).toBe(process.execPath);
    expect(config.mcpServers['fake-skills'].args).toContain('/opt/adapter.js');
    expect(config.mcpServers['fake-skills'].args.join(' ')).toContain('run-binding.json');

    // codex: -c mcp_servers.fake-skills.command/... overrides present, alongside core servers.
    const codexArgs = codexMcpArgs(configPath).join(' ');
    expect(codexArgs).toContain('mcp_servers.fake-skills.command=');
    expect(codexArgs).toContain('mcp_servers.playwright.command=');

    // opencode: OPENCODE_CONFIG's `mcp` map gets the SAME translation as core servers —
    // this is the piece the checklist called out as missing before this wiring landed.
    const ocConfigPath = writeOpencodeMcpConfig(workDir, configPath, null);
    const ocConfig = JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
    expect(ocConfig.mcp.playwright.type).toBe('local');
    expect(ocConfig.mcp['fake-skills']).toEqual({
      type: 'local',
      command: [process.execPath, ...config.mcpServers['fake-skills'].args],
      timeout: _const.MCP_TOOL_TIMEOUT_MS, // long-tool ceiling (hermes_research, #1582)
    });

    run.release();
    expect(runtime.broker.size).toBe(0);
  });

  it('disabled runtime (no enabled sources) leaves every engine config exactly as before — no extraServers key needed', async () => {
    const runtime = createSourceRuntime({ config: { version: 1, sources: [] } });
    expect(runtime.enabled).toBe(false);
    const run = await runtime.prepareRun({
      hostRunBinding: { engineRunId: 'r', rootTaskId: 'r', profileId: 'alice', projectId: null, trigger: 'user', origin: 'telegram' },
      runtimeDir: tmpDir(),
    });
    expect(run).toBe(null);

    const workDir = tmpDir();
    const before = JSON.parse(fs.readFileSync(writeMcpConfig(workDir, 'alice', { userName: 'Alice', userHandle: 'alice' }), 'utf8'));
    const after = JSON.parse(fs.readFileSync(writeMcpConfig(workDir, 'alice', { userName: 'Alice', userHandle: 'alice', extraServers: run?.servers }), 'utf8'));
    expect(after).toEqual(before);
  });
});
