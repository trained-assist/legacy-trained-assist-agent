import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildProviderEnv, validatePolicy, loadProviderEnvPolicy, DEFAULT_POLICY_PATH } = require('../src/mcp-provider-env');

// Epic #1470 P0.1a — deploy-owned provider env policy (design §7.1).
describe('provider env policy', () => {
  const policy = validatePolicy({ version: 1, providers: { hh: {
    identity: ['USER_ID', 'AGENT_USER_ID'], hostPaths: ['HOME'], passthrough: ['AGENT_SECRET', 'HH_APP_CONTACT'] } } });

  it('identity comes only from the host profileId; absent host keys are omitted', () => {
    const env = buildProviderEnv({ policy, providerId: 'hh', profileId: 'recruiter',
      hostEnv: { PATH: '/bin', HOME: '/h', AGENT_SECRET: 's', USER_ID: 'host-user', OTHER: 'x' } });
    expect(env).toEqual({ PATH: '/bin', USER_ID: 'recruiter', AGENT_USER_ID: 'recruiter', HOME: '/h', AGENT_SECRET: 's' });
  });

  it('unknown provider gets PATH only', () => {
    expect(buildProviderEnv({ policy, providerId: 'expo', profileId: 'p', hostEnv: { PATH: '/bin', AGENT_SECRET: 's' } }))
      .toEqual({ PATH: '/bin' });
  });

  it('rejects an invalid profileId instead of forwarding it as identity', () => {
    expect(() => buildProviderEnv({ policy, providerId: 'hh', profileId: '../etc', hostEnv: {} })).toThrow(/profileId/);
  });

  it.each(['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'GIT_ASKPASS', 'GITHUB_TOKEN', 'PATH'])('policy may never forward %s', (k) => {
    expect(() => validatePolicy({ version: 1, providers: { hh: { passthrough: [k] } } })).toThrow(/not allowed/);
  });

  it('rejects unknown groups, bad keys and duplicates', () => {
    expect(() => validatePolicy({ version: 1, providers: { hh: { secrets: ['A'] } } })).toThrow(/Unknown/);
    expect(() => validatePolicy({ version: 1, providers: { hh: { passthrough: ['a-b'] } } })).toThrow(/Invalid env key/);
    expect(() => validatePolicy({ version: 1, providers: { hh: { hostPaths: ['HOME'], passthrough: ['HOME'] } } })).toThrow(/Duplicate/);
  });

  it('shipped config/mcp-provider-env.json is valid and gives hh its identity + token paths', () => {
    expect(fs.existsSync(DEFAULT_POLICY_PATH)).toBe(true);
    const shipped = loadProviderEnvPolicy(DEFAULT_POLICY_PATH);
    expect(shipped.providers.hh.identity).toEqual(['USER_ID', 'AGENT_USER_ID']);
    expect(shipped.providers.hh.hostPaths).toEqual(expect.arrayContaining(['HOME', 'AGENT_TOKENS_DIR', 'AGENT_DATA_DIR', 'USERS_DIR']));
  });

  it('missing policy file = no provider gets extra env', () => {
    expect(loadProviderEnvPolicy(path.join('/nonexistent', 'x.json'))).toEqual({ version: 1, providers: {} });
  });
});
