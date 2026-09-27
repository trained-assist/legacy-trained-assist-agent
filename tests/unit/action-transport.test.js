// Default invokeAction transport: scope mapping (profile→username, project→workDir)
// and result parsing, plus end-to-end composition with the invoker.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMcpTransport, resolveWorkDir } = require('../../src/action-transport');
const { createActionInvoker } = require('../../src/action-invoke');
const { ActionExecutions } = require('../../src/action-executions');
const { ActionProviderRegistry } = require('../../src/action-provider-registry');
const { userWorkDir, projectDir } = require('../../src/data-paths');

describe('createMcpTransport', () => {
  it('maps profile→username and project→project workDir, passing action/args through', async () => {
    const seen = [];
    const transport = createMcpTransport({ runTool: async payload => { seen.push(payload); return '{"ok":true}'; } });
    await transport({ action: 'read_items', arguments: { limit: 2 }, profileId: 'alice', projectId: 'vacancy-1' });
    expect(seen[0]).toEqual({
      tool: 'read_items', params: { limit: 2 }, username: 'alice',
      workDir: projectDir('alice', 'vacancy-1'), trigger: 'user', origin: 'api',
    });

    await transport({ action: 'read_items', arguments: {}, profileId: 'alice', projectId: null });
    expect(seen[1].workDir).toBe(userWorkDir('alice'));
  });

  it('forwards the invocation trigger so an approved source sees the caller policy (cron)', async () => {
    const seen = [];
    const transport = createMcpTransport({ runTool: async payload => { seen.push(payload); return '{}'; } });
    await transport({ action: 'a', arguments: {}, profileId: 'alice', projectId: null, trigger: 'cron' });
    expect(seen[0].trigger).toBe('cron');
    expect(seen[0].origin).toBe('cron-service');
  });

  it('parses JSON output and passes non-JSON text through', async () => {
    const json = createMcpTransport({ runTool: async () => '{"count":3}' });
    expect(await json({ action: 'a', arguments: {}, profileId: 'p' })).toEqual({ count: 3 });

    const text = createMcpTransport({ runTool: async () => 'done' });
    expect(await text({ action: 'a', arguments: {}, profileId: 'p' })).toBe('done');

    const empty = createMcpTransport({ runTool: async () => '' });
    expect(await empty({ action: 'a', arguments: {}, profileId: 'p' })).toBeNull();
  });

  it('propagates the tool error code so invokeAction can map it', async () => {
    const transport = createMcpTransport({ runTool: async () => { throw Object.assign(new Error('nope'), { code: 'timeout' }); } });
    await expect(transport({ action: 'a', arguments: {}, profileId: 'p' })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('resolveWorkDir picks the project dir only when a projectId is present', () => {
    expect(resolveWorkDir('bob', 'x')).toBe(projectDir('bob', 'x'));
    expect(resolveWorkDir('bob')).toBe(userWorkDir('bob'));
  });

  it('composes with the invoker end-to-end', async () => {
    const registry = new ActionProviderRegistry();
    registry.register({ version: 1, providerId: 'recruiting', actions: [{
      name: 'read_items', inputSchema: { type: 'object' }, allowedTriggers: ['user'],
      effect: 'read', requiresApproval: false, retrySafety: 'read_only',
    }] });
    const executions = new ActionExecutions(':memory:');
    const { invokeAction } = createActionInvoker({
      registry, executions,
      transport: createMcpTransport({ runTool: async ({ tool, username, workDir }) => JSON.stringify({ tool, username, workDir }) }),
    });
    const res = await invokeAction({
      version: 1, profileId: 'alice', projectId: 'vacancy-1', action: 'read_items',
      arguments: {}, trigger: 'user', idempotencyKey: 'k1', origin: 'web',
    });
    expect(res.status).toBe('succeeded');
    expect(res.output).toEqual({ tool: 'read_items', username: 'alice', workDir: projectDir('alice', 'vacancy-1') });
    expect(executions.get(res.executionId).origin).toBe('web');
  });
});
