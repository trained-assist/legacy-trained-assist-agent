// src/runner/quick/secrets.js — connected-services quick answers, split out of
// intent-engine (same replies; intent-engine keeps the check order).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const require = createRequire(import.meta.url);
// user-tokens reads AGENT_TOKENS_ROOT (not AGENT_TOKENS_DIR) at load time.
const TOKENS = process.env.AGENT_TOKENS_ROOT = process.env.AGENT_TOKENS_DIR;
const { secretsQuickAnswer } = require('../../src/runner/quick/secrets.js');

describe('secretsQuickAnswer', () => {
  it('does not apply to unrelated messages', () => {
    expect(secretsQuickAnswer('напиши скрипт для парсинга', { userId: 'u1' })).toBeUndefined();
  });
  it('/secrets_list with nothing connected', () => {
    expect(secretsQuickAnswer('/secrets_list', { userId: 'nobody-here' })).toMatch(/Нет подключённых сервисов/);
  });
  it('service status: connected vs not', () => {
    mkdirSync(join(TOKENS, 'qs1'), { recursive: true });
    writeFileSync(join(TOKENS, 'qs1', 'github'), 'ghp_x', { mode: 0o600 });
    expect(secretsQuickAnswer('github подключен?', { userId: 'qs1' })).toMatch(/✅ .*подключён/);
    expect(secretsQuickAnswer('tilda подключена?', { userId: 'qs1' })).toMatch(/❌ .*не подключён/);
  });
  it('revoke needs a service name', () => {
    expect(secretsQuickAnswer('отзови доступ', { userId: 'qs1' })).toMatch(/Укажи сервис/);
  });
});
