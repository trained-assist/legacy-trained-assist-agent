/**
 * Unit tests for src/classify-message.js
 *
 * Tests cover:
 *  - confidence degradation for stale sessions (>1h → 'medium', fresh → 'high')
 *  - sessionAge is returned in successful matches
 *  - sessions older than 4h are filtered out entirely
 *  - ambiguous answer from model → { sessionId: null, confidence: 'low' }
 *  - model returns unknown id → { sessionId: null, confidence: 'low' }
 *  - sessions that ended with a completion reply are excluded
 *  - session age appears in the prompt sent to the model
 *  - missing API key throws
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyMessage, CLASSIFY_MAX_AGE_MS, CLASSIFY_STALE_MS } from '../../src/classify-message.js';

const OPENROUTER_KEY = 'test-key';

function makeSession(overrides = {}) {
  return {
    id: 's-default-001',
    topic: 'тестовый диалог',
    lastAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago — fresh
    lastUserMessage: 'последнее сообщение',
    lastMessageRole: 'user',
    lastAssistantSnippet: null,
    ...overrides,
  };
}

function mockFetchWithAnswer(answer) {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => '',
    json: async () => ({
      choices: [{ message: { content: answer } }],
    }),
  });
}

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

// ── confidence level ───────────────────────────────────────────────────────────

describe('confidence: fresh session (<1h)', () => {
  it('returns high when session is recent', async () => {
    const session = makeSession({ id: 's-fresh-001', lastAt: Date.now() - 10 * 60 * 1000 });
    global.fetch = mockFetchWithAnswer('s-fresh-001');

    const result = await classifyMessage('продолжим про HH', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBe('s-fresh-001');
    expect(result.confidence).toBe('high');
    expect(result.sessionAge).toBeLessThan(CLASSIFY_STALE_MS);
  });
});

describe('confidence: stale session (>1h)', () => {
  it('returns medium when session is older than 1h', async () => {
    const session = makeSession({ id: 's-stale-001', lastAt: Date.now() - 90 * 60 * 1000 });
    global.fetch = mockFetchWithAnswer('s-stale-001');

    const result = await classifyMessage('покажи что мы делали', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBe('s-stale-001');
    expect(result.confidence).toBe('medium');
    expect(result.sessionAge).toBeGreaterThanOrEqual(CLASSIFY_STALE_MS);
  });

  it('returns medium at exactly CLASSIFY_STALE_MS + 1ms', async () => {
    const session = makeSession({ id: 's-edge-001', lastAt: Date.now() - CLASSIFY_STALE_MS - 1 });
    global.fetch = mockFetchWithAnswer('s-edge-001');

    const result = await classifyMessage('продолжим', [session], OPENROUTER_KEY);

    expect(result.confidence).toBe('medium');
  });
});

// ── sessionAge field ───────────────────────────────────────────────────────────

describe('sessionAge in result', () => {
  it('is present and approximately correct for a fresh session', async () => {
    const ageMs = 30 * 60 * 1000; // 30 minutes
    const session = makeSession({ id: 's-age-001', lastAt: Date.now() - ageMs });
    global.fetch = mockFetchWithAnswer('s-age-001');

    const result = await classifyMessage('привет', [session], OPENROUTER_KEY);

    expect(result.sessionAge).toBeGreaterThanOrEqual(ageMs - 100);
    expect(result.sessionAge).toBeLessThanOrEqual(ageMs + 2000);
  });
});

// ── TTL filtering ──────────────────────────────────────────────────────────────

describe('sessions older than 4h are excluded', () => {
  it('returns low confidence when only session is >4h old', async () => {
    const session = makeSession({ id: 's-old-001', lastAt: Date.now() - CLASSIFY_MAX_AGE_MS - 1 });
    global.fetch = vi.fn(); // should never be called

    const result = await classifyMessage('что-то делали давно', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('low');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── completion-reply filtering ─────────────────────────────────────────────────

describe('sessions that ended with a completion reply are excluded', () => {
  it('filters out session whose last assistant reply is a done phrase', async () => {
    const session = makeSession({
      id: 's-done-001',
      lastMessageRole: 'assistant',
      lastAssistantSnippet: 'Готово, вакансия опубликована',
    });
    global.fetch = vi.fn();

    const result = await classifyMessage('опубликуй вакансию', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('low');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── model returns ambiguous ────────────────────────────────────────────────────

describe('model returns ambiguous', () => {
  it('maps to { sessionId: null, confidence: low }', async () => {
    const session = makeSession({ id: 's-amb-001' });
    global.fetch = mockFetchWithAnswer('ambiguous');

    const result = await classifyMessage('непонятное сообщение', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ── model returns unknown id ───────────────────────────────────────────────────

describe('model returns unknown session id', () => {
  it('maps to { sessionId: null, confidence: low }', async () => {
    const session = makeSession({ id: 's-real-001' });
    global.fetch = mockFetchWithAnswer('s-hallucinated-999');

    const result = await classifyMessage('что-то', [session], OPENROUTER_KEY);

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ── prompt includes session age ────────────────────────────────────────────────

describe('prompt content', () => {
  it('includes human-readable age for sessions', async () => {
    const session = makeSession({ id: 's-prompt-001', lastAt: Date.now() - 2 * 60 * 60 * 1000 });
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 's-prompt-001' } }] }),
      };
    });

    await classifyMessage('что делали?', [session], OPENROUTER_KEY);

    const promptText = capturedBody.messages[0].content;
    expect(promptText).toMatch(/ч назад/); // "2 ч назад" or similar
    expect(promptText).toMatch(/2\+ часа.*ambiguous/s); // rule about 2+ hours
  });

  it('includes session topic', async () => {
    const session = makeSession({ id: 's-topic-001', topic: 'резюме Иванова' });
    let capturedBody;
    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 's-topic-001' } }] }),
      };
    });

    await classifyMessage('покажи резюме', [session], OPENROUTER_KEY);

    const promptText = capturedBody.messages[0].content;
    expect(promptText).toContain('резюме Иванова');
  });
});

// ── missing API key ────────────────────────────────────────────────────────────

describe('missing openrouterKey', () => {
  it('throws an error', async () => {
    const session = makeSession();
    global.fetch = vi.fn();
    const saved = process.env.LLM_LADDER_TOKEN; delete process.env.LLM_LADDER_TOKEN; // no ladder token
    try {
      await expect(classifyMessage('test', [session], null)).rejects.toThrow(
        'No API key configured'
      );
      expect(global.fetch).not.toHaveBeenCalled();
    } finally { if (saved !== undefined) process.env.LLM_LADDER_TOKEN = saved; }
  });
});

// ── multiple sessions — picks the right one ────────────────────────────────────

describe('multiple sessions', () => {
  it('returns the matched session with correct age', async () => {
    const old = makeSession({ id: 's-multi-old', lastAt: Date.now() - 2 * 60 * 60 * 1000 });
    const fresh = makeSession({ id: 's-multi-fresh', lastAt: Date.now() - 5 * 60 * 1000 });
    global.fetch = mockFetchWithAnswer('s-multi-fresh');

    const result = await classifyMessage('быстрый вопрос', [old, fresh], OPENROUTER_KEY);

    expect(result.sessionId).toBe('s-multi-fresh');
    expect(result.confidence).toBe('high');
  });
});
