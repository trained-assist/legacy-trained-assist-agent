/**
 * buildSpawnEnv — the env a /action MCP server is spawned with (src/mcp-action.js).
 *
 * Regression test for #2049. The failure it guards is silent from the outside: the
 * platform keys (DEEPGRAM_API_KEY, CLOUDFLARE_API_TOKEN, HH_CLIENT_*) are loaded into
 * memory by secrets.js and never land in process.env, so a /action tool that needs one
 * answers `key_missing` — speech_transcribe did exactly that for every profile without a
 * personal key file (all but 4), which is what blocked the gateway migration
 * (trained-assist-tg-bot#319). The session path gets the same keys via browser.js →
 * toolPlatformEnv(); the /action path did not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
const secrets = require('../src/secrets.js');
const { buildSpawnEnv } = require('../src/mcp-action.js');

const PLATFORM_ENV = ['DEEPGRAM_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HH_CLIENT_ID', 'HH_CLIENT_SECRET', 'AGENT_BOT_TOKEN'];
const saved = {};

describe('buildSpawnEnv on /action', () => {
  beforeEach(() => {
    for (const k of PLATFORM_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    secrets.setLoadedSecrets(null);
    for (const k of PLATFORM_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('carries every platform key the MCP tool servers need', () => {
    secrets.setLoadedSecrets({
      DEEPGRAM_API_KEY: 'dg-platform', CF_API_TOKEN: 'cf-platform',
      HH_CLIENT_ID: 'hh-id', HH_CLIENT_SECRET: 'hh-secret', BOT_TOKEN: 'bot-platform',
    });
    const env = buildSpawnEnv({ username: 'vova', workDir: '/tmp/w', hostAction: false });
    expect(env.DEEPGRAM_API_KEY).toBe('dg-platform');
    expect(env.CLOUDFLARE_API_TOKEN).toBe('cf-platform');
    expect(env.HH_CLIENT_ID).toBe('hh-id');
    expect(env.HH_CLIENT_SECRET).toBe('hh-secret');
    expect(env.AGENT_BOT_TOKEN).toBe('bot-platform');
  });

  it('carries no platform key when nothing is loaded (tests, cron without secrets)', () => {
    secrets.setLoadedSecrets(null);
    const env = buildSpawnEnv({ username: 'vova', workDir: '', hostAction: false });
    for (const k of PLATFORM_ENV) expect(env[k]).toBeUndefined();
  });

  it('passes only the explicit allowlist — not every loaded secret', () => {
    secrets.setLoadedSecrets({ DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or-secret', AGENT_SECRET: 'core-secret' });
    const env = buildSpawnEnv({ username: 'vova', workDir: '', hostAction: false });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.AGENT_SECRET).toBeUndefined();
  });

  it('still sets the per-call routing env (USER_ID / WORK_DIR / MCP_HOST_ACTION)', () => {
    secrets.setLoadedSecrets({ DEEPGRAM_API_KEY: 'dg' });
    const env = buildSpawnEnv({ username: 'u-42', workDir: '/home/vova/users/u-42', hostAction: true });
    expect(env.USER_ID).toBe('u-42');
    expect(env.WORK_DIR).toBe('/home/vova/users/u-42');
    expect(env.MCP_HOST_ACTION).toBe('1');
    expect(buildSpawnEnv({ username: 'u-42' }).MCP_HOST_ACTION).toBe('');
  });

  it('is actually the env spawnToolCall passes to the child (no drift back to a bare process.env)', () => {
    const src = readFileSync(new URL('../src/mcp-action.js', import.meta.url), 'utf8');
    expect(src).toMatch(/env:\s*buildSpawnEnv\(/);
  });
});
