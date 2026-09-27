// Regression tests for the intent-verification gate wrapping runQuickAnswer().
// getQuickAnswer()'s regex patterns are broad fuzzy-language matches — they can
// misfire on unrelated messages. The gate asks a cheap LLM to confirm the match
// before committing to it; a rejected match must fall through (return null) so
// Claude gets the message instead of the bot silently eating it.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import nock from 'nock';

const require = createRequire(import.meta.url);
const { runQuickAnswer } = require('../../src/runner');

const TEST_UID = 'quick-gate-test-0001';
let workDir;

// service-llm → llm-ladder worker (tests point LLM_LADDER_URL at http://llm-ladder.invalid).
function mockOr(content) {
  return nock(process.env.LLM_LADDER_URL || 'http://llm-ladder.invalid')
    .post('/v1/chat/completions')
    .reply(200, { choices: [{ message: { content } }] });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'quick-gate-workdir-'));
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => nock.cleanAll());

afterAll(() => {
  nock.enableNetConnect();
  rmSync(workDir, { recursive: true, force: true });
});

describe('quick-answer intent gate', () => {
  it('LLM says NO → falls through to Claude (returns null), not the matched quick-answer', async () => {
    mockOr('NO');
    const reply = await runQuickAnswer('ты живой', TEST_UID, workDir, 'fake-key');
    expect(reply).toBeNull();
  });

  it('LLM says YES → returns the matched quick-answer', async () => {
    mockOr('YES');
    const reply = await runQuickAnswer('ты живой', TEST_UID, workDir, 'fake-key');
    expect(reply).toBe('🟢 Онлайн. Готов к работе.');
  });

  it('LLM call errors → fails open, still returns the matched quick-answer', async () => {
    nock(process.env.LLM_LADDER_URL || 'http://llm-ladder.invalid').post('/v1/chat/completions').replyWithError('network down');
    const reply = await runQuickAnswer('ты живой', TEST_UID, workDir, 'fake-key');
    expect(reply).toBe('🟢 Онлайн. Готов к работе.');
  });

  it('no ladder token anywhere → skips the check with no network call, still returns the quick-answer', async () => {
    const saved = process.env.LLM_LADDER_TOKEN;
    delete process.env.LLM_LADDER_TOKEN;
    const scope = mockOr('NO'); // if called, would reject — but must not be called
    try {
      const reply = await runQuickAnswer('ты живой', TEST_UID, workDir, null);
      expect(reply).toBe('🟢 Онлайн. Готов к работе.');
      expect(scope.isDone()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved;
    }
  });

  it('slash commands bypass the gate entirely (no OpenRouter call made)', async () => {
    const scope = mockOr('NO'); // if called, would reject — but must not be called
    const reply = await runQuickAnswer('/ping', TEST_UID, workDir, 'fake-key');
    expect(reply).toBe('🟢 Онлайн. Готов к работе.');
    expect(scope.isDone()).toBe(false);
  });
});
