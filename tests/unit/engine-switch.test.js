/**
 * /switch2klod, /switch2codex — per-chat CLI engine override.
 * See src/profiles.js (getEngine/setEngine) and ENGINE_SWITCH_INTENT in src/runner.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getQuickAnswer, shouldAttemptQuickAnswer } = require('../../src/runner');
const { ENGINE_SWITCH_INTENT } = require('../../src/runner')._intents;
const profiles = require('../../src/profiles.js');

describe('ENGINE_SWITCH_INTENT regex', () => {
  it.each([
    '/switch2klod',
    '/switch2codex',
    'switch2klod',
    'switch to codex',
    'switch to klod',
    'switch to claude',
    'переключись на кодекс',
    'переключи на клод',
  ])('matches: "%s"', (t) => expect(ENGINE_SWITCH_INTENT.test(t)).toBe(true));

  it.each([
    'switch to dark mode',
    'какой движок сейчас',
    'проверь код',
    '/usage klod',
  ])('does NOT match: "%s"', (t) => expect(ENGINE_SWITCH_INTENT.test(t)).toBe(false));
});

describe('profiles.getEngine / setEngine', () => {
  let workDir;
  // tests/setup-isolation.mjs pins AGENT_DEFAULT_ENGINE=claude for runner fixtures — unset it here
  // so these assertions see the real production default.
  let prevDefault;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'engine-switch-test-')); prevDefault = process.env.AGENT_DEFAULT_ENGINE; delete process.env.AGENT_DEFAULT_ENGINE; });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); if (prevDefault !== undefined) process.env.AGENT_DEFAULT_ENGINE = prevDefault; });

  it('defaults to opencode (Go) with no profile.json since 2026-09-27', () => {
    expect(profiles.getEngine(workDir)).toBe('opencode');
  });

  it('setEngine without chatId sets the profile-wide default', () => {
    profiles.setEngine(workDir, 'codex');
    expect(profiles.getEngine(workDir)).toBe('codex');
  });

  it('setEngine with chatId overrides only that chat, others keep the default', () => {
    profiles.setEngine(workDir, 'codex', 'chat-1');
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('codex');
    expect(profiles.getEngine(workDir, 'chat-2')).toBe('opencode');
    expect(profiles.getEngine(workDir)).toBe('opencode');
  });
});

describe('getQuickAnswer handles /switch2klod, /switch2codex end-to-end', () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'engine-switch-e2e-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('/switch2codex sets the engine for this chat and confirms', () => {
    const reply = getQuickAnswer('/switch2codex', 'user1', workDir, false, 'chat-1');
    expect(reply).toMatch(/Codex CLI/);
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('codex');
  });

  it('/switch2klod switches back for that chat without touching another chat', () => {
    profiles.setEngine(workDir, 'codex', 'chat-1');
    profiles.setEngine(workDir, 'codex', 'chat-2');
    const reply = getQuickAnswer('/switch2klod', 'user1', workDir, false, 'chat-1');
    expect(reply).toMatch(/Claude Code/);
    expect(profiles.getEngine(workDir, 'chat-1')).toBe('claude');
    expect(profiles.getEngine(workDir, 'chat-2')).toBe('codex');
  });
});

// Regression: forceClaude must not swallow slash commands. server.js resumePendingTasks()
// re-runs a task interrupted by a restart with forceClaude=true; before this guard an
// interrupted `/switch2klod` was replayed straight to the LLM, which answered
// «не распознал команду» instead of switching the engine (live 2026-09-22).
describe('shouldAttemptQuickAnswer (forceClaude vs slash commands)', () => {
  it('skips quick answers for free-form prose when forceClaude is set', () => {
    expect(shouldAttemptQuickAnswer(true, 'сделай нормальный отчёт по выручке')).toBe(false);
  });

  it('ALWAYS attempts quick answers for a slash command, even with forceClaude', () => {
    expect(shouldAttemptQuickAnswer(true, '/switch2klod')).toBe(true);
    expect(shouldAttemptQuickAnswer(true, '/switch2klod@super_personal_assistant_bot')).toBe(true);
    expect(shouldAttemptQuickAnswer(true, '  /persona роль')).toBe(true);
  });

  it('attempts quick answers on the normal path (forceClaude unset)', () => {
    expect(shouldAttemptQuickAnswer(undefined, 'привет')).toBe(true);
    expect(shouldAttemptQuickAnswer(false, '/agent_info')).toBe(true);
  });
});
