'use strict';

// Issue #1533: the headless transport (/action + cron) must resolve the tool
// source through the SAME rule as the session path — an enabled + eligible
// approved source executes through the core adapter/broker, the sibling is the
// fallback, core is the last resort. Removing the sibling checkout must not
// turn an approved action into "Unknown tool"; duplicates across active sources
// stay a CONFLICT.
//
// Hermetic: fake adapter and fake sibling scripts in a temp dir, a real
// source runtime over a hand-built generation snapshot — no config, no
// checkout, no network.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildToolCatalog } = require('../src/action-tool-catalog');
const { createSourceRuntime } = require('../src/mcp-source-runtime');
const { ActionProviderRegistry } = require('../src/action-provider-registry');
const { ActionExecutions } = require('../src/action-executions');
const { stableStringify, digest } = require('../src/mcp-skill-generation');
const { runMcpTool, listActionTools } = require('../src/mcp-action');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'action-approved-'));

const FAKE_ADAPTER = path.join(TMP, 'fake-adapter.js');
fs.writeFileSync(FAKE_ADAPTER, `
const fs = require('fs');
const argv = process.argv.slice(2);
const binding = JSON.parse(fs.readFileSync(argv[argv.indexOf('--binding-file') + 1], 'utf8'));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method !== 'tools/call') continue;
    const text = JSON.stringify({ via: 'adapter', tool: req.params.name, profile: binding.profileId, providerId: binding.providerId });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: text }] } }) + '\\n');
    process.exit(0);
  }
});
`);

const FAKE_SIBLING = path.join(TMP, 'fake-sibling.js');
fs.writeFileSync(FAKE_SIBLING, `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.env.WORK_DIR || '.', 'sibling-ran.marker'), 'yes');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method !== 'tools/call') continue;
    const text = JSON.stringify({ via: 'sibling', tool: req.params.name });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: text }] } }) + '\\n');
    process.exit(0);
  }
});
`);

const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0).reverse()) { try { await fn(); } catch { /* ignore */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

function workDir(name) {
  const dir = fs.mkdtempSync(path.join(TMP, name + '-'));
  return dir;
}

function fakeSibling({ id = 'hh', mcpServerId = 'hh-skills', toolName = 'hh_status' } = {}) {
  return {
    id, mcpServerId, indexPath: FAKE_SIBLING,
    registry: { listAllTools: () => [{ name: toolName }] },
  };
}

function fakeGeneration({ profiles = ['alice'], enabled = true, mcpServerId = 'hh-skills', actionName = 'hh_status' } = {}) {
  const actions = new ActionProviderRegistry();
  actions.register({ version: 1, providerId: 'hh', actions: [{
    name: actionName, inputSchema: { type: 'object' }, allowedTriggers: ['user', 'cron'],
    effect: 'read', requiresApproval: false, retrySafety: 'read_only',
  }] });
  const source = {
    id: 'hh', providerId: 'hh', mcpServerId,
    repository: 'trained-assist/trained-assist-hh-skill', revision: 'a'.repeat(40), manifestVersion: 1,
    artifactDir: 'releases/hh', entrypoint: 'repo/src/mcp-skills/index.js', manifest: 'repo/action-provider-manifest.json',
    artifactDigest: 'b'.repeat(64), enabled, profiles, artifactStatus: 'available',
    approvedManifest: { version: 1, providerId: 'hh',
      actions: [{ name: actionName, inputSchema: { type: 'object' } }] },
  };
  const snapshot = {
    version: 1, generationId: 'gen-hh', sources: [source], diagnostics: [],
    adapter: { command: process.execPath, entry: FAKE_ADAPTER },
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64), reservedServerIds: [],
    core: { servers: [], providerIds: [], actionNames: [] },
  };
  return {
    version: 1, generationId: 'gen-hh', snapshot, snapshotDigest: digest(stableStringify(snapshot)),
    configDigest: 'c'.repeat(64), coreCatalogDigest: 'd'.repeat(64), coreRevision: 'r',
    deploymentPolicyDigest: 'e'.repeat(64),
    policy: { root: TMP }, actions, diagnostics: [],
  };
}

function runtimeWith(generation) {
  const root = fs.mkdtempSync(path.join(TMP, 'rt-'));
  const executions = new ActionExecutions(path.join(root, 'ops.db'));
  cleanups.push(() => executions.db.close());
  const runtime = createSourceRuntime({
    generation, executions, runtimeRoot: root, socketPath: path.join(root, 'broker.sock'),
    envPolicy: { version: 1, providers: {} },
  });
  cleanups.push(() => runtime.close());
  return runtime;
}

// ── pure catalog ────────────────────────────────────────────────────────────

test('buildToolCatalog: approved source suppresses the sibling with the same mcpServerId', () => {
  const { owners } = buildToolCatalog({
    coreTools: [{ name: 'context_get' }],
    siblings: [{ id: 'hh', mcpServerId: 'hh-skills', tools: [{ name: 'hh_status' }, { name: 'hh_quick_answer' }] }],
    approvedSources: [{ id: 'hh', providerId: 'hh', mcpServerId: 'hh-skills', actions: [{ name: 'hh_status' }] }],
  });
  assert.equal(owners.get('hh_status').kind, 'approved');
  assert.equal(owners.get('context_get').kind, 'local');
  // The suppressed sibling's other actions are gone too, exactly like the session mount.
  assert.equal(owners.get('hh_quick_answer'), undefined);
});

test('buildToolCatalog: duplicate across core/approved is CONFLICT', () => {
  assert.throws(() => buildToolCatalog({
    coreTools: [{ name: 'x' }],
    approvedSources: [{ id: 'a', providerId: 'a', mcpServerId: 'a-skills', actions: [{ name: 'x' }] }],
  }), (e) => e.code === 'CONFLICT');
});

test('buildToolCatalog: duplicate across sibling/approved with a DIFFERENT server id is CONFLICT', () => {
  assert.throws(() => buildToolCatalog({
    siblings: [{ id: 'hh', mcpServerId: 'hh-skills', tools: [{ name: 'x' }] }],
    approvedSources: [{ id: 'a', providerId: 'a', mcpServerId: 'a-skills', actions: [{ name: 'x' }] }],
  }), (e) => e.code === 'CONFLICT' && /Duplicate action: x/.test(e.message));
});

// ── end-to-end transport ────────────────────────────────────────────────────

test('enabled + eligible approved source: /action executes via the adapter, sibling never runs', async () => {
  const runtime = runtimeWith(fakeGeneration({ profiles: ['alice'] }));
  const dir = workDir('alice');
  const text = await runMcpTool({
    tool: 'hh_status', params: { q: 1 }, username: 'alice', workDir: dir,
    sourceRuntime: runtime, siblings: [fakeSibling()],
  });
  const result = JSON.parse(text);
  assert.equal(result.via, 'adapter');
  assert.equal(result.profile, 'alice');
  assert.equal(result.providerId, 'hh');
  assert.equal(fs.existsSync(path.join(dir, 'sibling-ran.marker')), false);
});

test('ineligible profile falls back to the sibling', async () => {
  const runtime = runtimeWith(fakeGeneration({ profiles: ['someone-else'] }));
  const dir = workDir('bob');
  const text = await runMcpTool({
    tool: 'hh_status', params: {}, username: 'bob', workDir: dir,
    sourceRuntime: runtime, siblings: [fakeSibling()],
  });
  assert.equal(JSON.parse(text).via, 'sibling');
  assert.equal(fs.existsSync(path.join(dir, 'sibling-ran.marker')), true);
});

test('disabled source falls back to the sibling', async () => {
  const runtime = runtimeWith(fakeGeneration({ enabled: false }));
  const dir = workDir('alice-disabled');
  const text = await runMcpTool({
    tool: 'hh_status', params: {}, username: 'alice', workDir: dir,
    sourceRuntime: runtime, siblings: [fakeSibling()],
  });
  assert.equal(JSON.parse(text).via, 'sibling');
});

test('removing the sibling checkout does not make an approved action Unknown tool', async () => {
  const runtime = runtimeWith(fakeGeneration({ profiles: ['alice'] }));
  const dir = workDir('alice-nosib');
  const names = listActionTools('alice', { sourceRuntime: runtime, siblings: [] }).map(t => t.name);
  assert.ok(names.includes('hh_status'), 'approved action must be in the static name gate');
  const text = await runMcpTool({
    tool: 'hh_status', params: {}, username: 'alice', workDir: dir,
    sourceRuntime: runtime, siblings: [],
  });
  assert.equal(JSON.parse(text).via, 'adapter');
});

test('duplicate action across sibling/approved different server id -> CONFLICT, no spawn', async () => {
  const runtime = runtimeWith(fakeGeneration({ profiles: ['alice'], mcpServerId: 'other-skills' }));
  await assert.rejects(
    runMcpTool({
      tool: 'hh_status', params: {}, username: 'alice', workDir: workDir('alice-conflict'),
      sourceRuntime: runtime, siblings: [fakeSibling()],
    }),
    (e) => e.code === 'CONFLICT',
  );
});

test('runtime disabled (no enabled sources) keeps sibling then core behaviour', async () => {
  const runtime = createSourceRuntime({ config: { version: 1, sources: [] } });
  cleanups.push(() => runtime.close());
  const dir = workDir('alice-off');
  const text = await runMcpTool({
    tool: 'hh_status', params: {}, username: 'alice', workDir: dir,
    sourceRuntime: runtime, siblings: [fakeSibling()],
  });
  assert.equal(JSON.parse(text).via, 'sibling');
});
