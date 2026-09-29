// Issue #1885 п.2 / п.4 (plan #1892) — платформенные ключи должны доезжать до тулов.
//
// (a) hh_sync_messages (trained-assist-hh-skill 91c-hh-sync.js) берёт
//     process.env.HH_CLIENT_ID/HH_CLIENT_SECRET, чтобы обновить просроченный
//     OAuth-токен HH. Без них в env MCP-сервера sync молча умирает.
// (b) hermes_run передавал runEngineProcess `secrets: {}` → у его MCP-серверов
//     не было AGENT_BOT_TOKEN / DEEPGRAM_API_KEY / CLOUDFLARE_API_TOKEN.
//
// На проде эти ключи НЕ лежат в process.env сервера: они грузятся из GCP Secret
// Manager и живут только в объекте secrets. Поэтому тест держит process.env
// чистым и кладёт ключи через secrets.setLoadedSecrets — тот же канал, что прод.
// Контракт — env, который MCP-сервер получает через мост (bridged, in-memory);
// движок и .mcp.json на диске ключей видеть не должны.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const secrets = require('../../src/secrets.js');
const { writeRunMcpConfig, writeMcpConfig } = require('../../src/browser.js');
const { buildAgentEnv } = require('../../src/agent-isolation.js');

const ENV_NAMES = [
  'HH_CLIENT_ID', 'HH_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'AGENT_BOT_TOKEN',
  'DEEPGRAM_API_KEY', 'CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN',
];
const LOADED = {
  BOT_TOKEN: 'test-bot-token',
  DEEPGRAM_API_KEY: 'test-deepgram-key',
  CF_API_TOKEN: 'test-cf-token',
  HH_CLIENT_ID: 'test-hh-client-id',
  HH_CLIENT_SECRET: 'test-hh-client-secret',
  OPENROUTER_API_KEY: 'test-not-a-tool-key',
};
const SECRET_VALUES = ['test-bot-token', 'test-deepgram-key', 'test-cf-token', 'test-hh-client-secret'];

describe('platform keys reach the MCP env (issue #1885 / #1892)', () => {
  let saved;
  let workDir;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_NAMES) { saved[k] = process.env[k]; delete process.env[k]; }
    secrets.setLoadedSecrets(LOADED);
    workDir = mkdtempSync(join(tmpdir(), 'pkeys-mcp-'));
  });
  afterEach(() => {
    secrets.setLoadedSecrets(null);
    for (const k of ENV_NAMES) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  function bridgedServers() {
    const { servers } = writeRunMcpConfig(workDir, 'u1', {}, { bridged: true });
    return servers;
  }

  it('(a) HH_CLIENT_ID/HH_CLIENT_SECRET travel in the MCP server env so hh_sync_messages can refresh an expired token', () => {
    const servers = bridgedServers();
    for (const id of ['trained-skills', 'hh-skills']) {
      if (!servers[id]) continue;
      expect(servers[id].env.HH_CLIENT_ID).toBe('test-hh-client-id');
      expect(servers[id].env.HH_CLIENT_SECRET).toBe('test-hh-client-secret');
    }
  });

  it('(b) AGENT_BOT_TOKEN, DEEPGRAM_API_KEY, CLOUDFLARE_API_TOKEN travel in the MCP server env (site_deploy, tg_send_file, transcription)', () => {
    const env = bridgedServers()['trained-skills'].env;
    expect(env.AGENT_BOT_TOKEN).toBe('test-bot-token');
    expect(env.DEEPGRAM_API_KEY).toBe('test-deepgram-key');
    expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
    // Only the explicit list — not every loaded secret.
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('(c) no key value lands in the .mcp.json the engine reads (bridged or not)', () => {
    const { mcpConfig } = writeRunMcpConfig(workDir, 'u1', {}, { bridged: true });
    const onDiskBridged = readFileSync(mcpConfig, 'utf8');
    const onDiskPlain = readFileSync(writeMcpConfig(workDir, 'u1', {}), 'utf8');
    for (const v of SECRET_VALUES) {
      expect(onDiskBridged).not.toContain(v);
      expect(onDiskPlain).not.toContain(v);
    }
  });

  it('(d) the engine env never carries HH_CLIENT_SECRET / CF / Deepgram', () => {
    const engineEnv = buildAgentEnv({
      PATH: '/usr/bin', HH_CLIENT_SECRET: 'x', CLOUDFLARE_API_TOKEN: 'x', CF_API_TOKEN: 'x', DEEPGRAM_API_KEY: 'x',
    });
    expect(engineEnv.HH_CLIENT_SECRET).toBeUndefined();
    expect(engineEnv.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(engineEnv.CF_API_TOKEN).toBeUndefined();
    expect(engineEnv.DEEPGRAM_API_KEY).toBeUndefined();
  });

  it('toolPlatformEnv maps loaded secrets to tool env names and drops empty values', () => {
    expect(secrets.toolPlatformEnv({ BOT_TOKEN: 'b', CF_API_TOKEN: '', HH_CLIENT_ID: null })).toEqual({ AGENT_BOT_TOKEN: 'b' });
    secrets.setLoadedSecrets(null);
    expect(secrets.toolPlatformEnv()).toEqual({});
  });
});

describe('hermes_run passes the loaded secrets to its engine run (#1892 п.4)', () => {
  afterEach(() => secrets.setLoadedSecrets(null));
  it('hermesEngineSecrets() is the loaded secrets object, not {}', () => {
    const { hermesEngineSecrets } = require('../../src/hermes-tools-run.js');
    const loaded = { BOT_TOKEN: 'b', CF_API_TOKEN: 'c', DEEPGRAM_API_KEY: 'd' };
    secrets.setLoadedSecrets(loaded);
    expect(hermesEngineSecrets()).toBe(loaded);
    secrets.setLoadedSecrets(null);
    expect(hermesEngineSecrets()).toEqual({});
  });
});
