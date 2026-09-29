// Issue #1885 п.2 / п.4 — платформенные ключи должны доезжать до тулов (R5-repro).
//
// (a) hh_sync_messages (trained-assist-hh-skill 91c-hh-sync.js) пробрасывает
//     process.env.HH_CLIENT_ID/HH_CLIENT_SECRET в refreshHhToken, чтобы обновить
//     просроченный OAuth-токен HH. Окружение MCP-процесса — ровно mcpToolEnv из
//     buildMcpConfig (src/browser.js): без HH_CLIENT_* там токен не обновляется
//     и sync молча умирает.
// (b) hermesRunWithTools передаёт runEngineProcess `secrets: {}`
//     (src/hermes-tools-run.js:179), поэтому движок внутри hermes_run получает
//     AGENT_BOT_TOKEN / DEEPGRAM_API_KEY / CLOUDFLARE_API_TOKEN только если они
//     случайно унаследованы из окружения родителя. Явный канал (mcpToolEnv)
//     их не несёт — site_deploy/tg_send_file/транскрибация внутри hermes_run
//     работают по наследству, а не по контракту.
//
// Регрессионный контракт — окружение, которое получает MCP-сервер: оно обязано
// явно нести все платформенные ключи (как уже несёт INN_*/SERPER/AGENT_SECRET).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildMcpConfig } = require('../../src/browser.js');

function freshWorkDir() {
  return mkdtempSync(join(tmpdir(), 'pkeys-mcp-'));
}

function withEnv(env) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

describe('platform keys reach the MCP env (issue #1885)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('(a) HH OAuth client credentials', () => {
    it('HH_CLIENT_ID and HH_CLIENT_SECRET travel in the MCP server env so hh_sync_messages can refresh an expired token', () => {
      const restore = withEnv({
        HH_CLIENT_ID: 'test-hh-client-id',
        HH_CLIENT_SECRET: 'test-hh-client-secret',
      });
      const workDir = freshWorkDir();
      try {
        const config = buildMcpConfig(workDir, 'u1', {});
        const env = config.mcpServers['trained-skills'].env;
        expect(env.HH_CLIENT_ID).toBe('test-hh-client-id');
        expect(env.HH_CLIENT_SECRET).toBe('test-hh-client-secret');
        if (config.mcpServers['hh-skills']) {
          const hhEnv = config.mcpServers['hh-skills'].env;
          expect(hhEnv.HH_CLIENT_ID).toBe('test-hh-client-id');
          expect(hhEnv.HH_CLIENT_SECRET).toBe('test-hh-client-secret');
        }
      } finally {
        restore();
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  describe('(b) bot / Deepgram / Cloudflare tokens', () => {
    it('AGENT_BOT_TOKEN, DEEPGRAM_API_KEY and CLOUDFLARE_API_TOKEN travel in the MCP server env (hermes_run tools: site_deploy, tg_send_file, transcription)', () => {
      const restore = withEnv({
        TELEGRAM_BOT_TOKEN: 'test-bot-token',
        DEEPGRAM_API_KEY: 'test-deepgram-key',
        CF_API_TOKEN: 'test-cf-token',
      });
      const workDir = freshWorkDir();
      try {
        const config = buildMcpConfig(workDir, 'u1', {});
        const env = config.mcpServers['trained-skills'].env;
        expect(env.AGENT_BOT_TOKEN).toBe('test-bot-token');
        expect(env.DEEPGRAM_API_KEY).toBe('test-deepgram-key');
        expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
      } finally {
        restore();
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});