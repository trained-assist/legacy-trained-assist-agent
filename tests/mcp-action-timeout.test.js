/**
 * timeoutForTool — the per-tool budget for /action calls (src/mcp-action.js).
 *
 * Regression test for #2043. The failure it guards is silent: speech_transcribe
 * inherited DEFAULT_TIMEOUT_MS (45s) while the Telegram gateway itself allows 120s
 * of transcription (trained-assist-tg-bot/src/media-jobs.js: AbortSignal.timeout(120000)),
 * so any long voice note would be killed on the agent side while the gateway was
 * still waiting — and only after the gateway PR swapped the calls over.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { timeoutForTool, TOOL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = require('../src/mcp-action.js');

describe('timeoutForTool', () => {
  it('gives a tool with its own budget that budget, not DEFAULT_TIMEOUT_MS', () => {
    expect(timeoutForTool('speech_transcribe')).toBe(TOOL_TIMEOUT_MS.speech_transcribe);
    expect(TOOL_TIMEOUT_MS.speech_transcribe).not.toBe(DEFAULT_TIMEOUT_MS);
  });

  it('never undercuts the gateway transcription budget (120s)', () => {
    expect(TOOL_TIMEOUT_MS.speech_transcribe).toBeGreaterThanOrEqual(120_000);
  });

  it('keeps the default for tools without their own budget', () => {
    expect(timeoutForTool('hh_list_responses')).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutForTool('some_future_tool')).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('lets an explicit caller timeout win — the caller knows its own deadline', () => {
    expect(timeoutForTool('speech_transcribe', 5_000)).toBe(5_000);
    expect(timeoutForTool('hh_list_responses', 90_000)).toBe(90_000);
  });

  it('holds only positive integer budgets', () => {
    for (const [tool, ms] of Object.entries(TOOL_TIMEOUT_MS)) {
      expect(Number.isInteger(ms) && ms > 0, `${tool} has a non-positive budget`).toBe(true);
    }
  });
});