// Contract of the agent's half of the gateway test mode
// (trained-assist-tg-bot#329, design docs/test-mode/DESIGN.md §2.3).
//
// The gateway sends `delivery: "log"` for chats listed in TEST_CHAT_IDS instead
// of delivering the run into the chat. The agent must then (a) touch no Telegram
// API at all for that run and (b) hand the final answer back as an OPTIONAL
// `answer` field of the existing run-finished callback, so the auto-test reads it
// from the gateway log instead of from a live chat.
//
// Two optional fields on the wire, both backwards compatible: an old gateway
// ignores `answer`, an old agent ignores `delivery` (the gateway's dead-chatId
// backstop then keeps the live chat clean).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── A1: POST /run maps the wire flag onto runTask opts ───────────────────────

describe('runDeliveryFromPayload (/run → runTask)', () => {
  const { runDeliveryFromPayload } = require('../../src/bot-delivery');

  it('carries the flag through only for the exact "log" value', () => {
    expect(runDeliveryFromPayload({ delivery: 'log' })).toBe('log');
  });

  it('leaves every other shape at the default (null = normal delivery)', () => {
    // A missing/garbage flag must never be able to silently mute a REAL chat.
    expect(runDeliveryFromPayload({})).toBeNull();
    expect(runDeliveryFromPayload(undefined)).toBeNull();
    expect(runDeliveryFromPayload(null)).toBeNull();
    expect(runDeliveryFromPayload({ delivery: 'telegram' })).toBeNull();
    expect(runDeliveryFromPayload({ delivery: 'Log' })).toBeNull();
    expect(runDeliveryFromPayload({ delivery: ' log' })).toBeNull();
    expect(runDeliveryFromPayload({ delivery: 1 })).toBeNull();
    expect(runDeliveryFromPayload({ delivery: true })).toBeNull();
  });
});

// ── A2: tg-stream is the single chokepoint that must go quiet ────────────────

describe('tg-stream log delivery gate', () => {
  const tg = require('../../src/runner/tg-stream');
  const TEST_CHAT = -100000000000099;
  const LIVE_CHAT = 555111;

  let fetchMock;
  let logs;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }));
    vi.stubGlobal('fetch', fetchMock);
    tg.markLogChat(LIVE_CHAT); // unique per test: the marker set is process-wide
    tg.markLogChat(TEST_CHAT);
  });

  afterEach(() => {
    tg.unmarkLogChat(LIVE_CHAT);
    tg.unmarkLogChat(TEST_CHAT);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks and reads back only the marked chat', () => {
    expect(tg.isLogChat(TEST_CHAT)).toBe(true);
    expect(tg.isLogChat(LIVE_CHAT)).toBe(true);
    expect(tg.isLogChat(424242)).toBe(false);
  });

  it('never treats a chatless run (0/null) as a log chat', () => {
    tg.markLogChat(0);
    tg.markLogChat(null);
    expect(tg.isLogChat(0)).toBe(false);
    expect(tg.isLogChat(null)).toBe(false);
  });

  it('tgSend on a marked chat: no network, sentinel result, one log line', async () => {
    const res = await tg.tgSend('tok', TEST_CHAT, 'привет');
    expect(fetchMock, 'a log-delivery run must not call the Telegram API').not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: 'test-mode', result: null });
    expect(logs.some(l => l.includes('[test-mode] agent-suppress') && l.includes('kind=send') && l.includes(`chat=${TEST_CHAT}`))).toBe(true);
  });

  it('tgEdit on a marked chat: no network, sentinel result, one log line', async () => {
    const res = await tg.tgEdit('tok', TEST_CHAT, 42, '🧠 ответ');
    expect(fetchMock, 'a log-delivery run must not call the Telegram API').not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, skipped: 'test-mode', result: null });
    expect(logs.some(l => l.includes('[test-mode] agent-suppress') && l.includes('kind=edit') && l.includes(`chat=${TEST_CHAT}`))).toBe(true);
  });

  it('an unmarked chat keeps its normal Telegram delivery', async () => {
    const sent = await tg.tgSend('tok', 424242, 'обычный ответ');
    const edited = await tg.tgEdit('tok', 424242, 42, 'правка');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent.skipped).toBeUndefined();
    expect(edited.skipped).toBeUndefined();
    expect(logs.some(l => l.includes('[test-mode]'))).toBe(false);
  });
});

// ── A3a: the answer store the run-finished callback reads ────────────────────

describe('run answer store (delivery:"log")', () => {
  const { _testMode } = require('../../src/runner');
  const { recordRunAnswer, takeRunAnswer } = _testMode;

  afterEach(() => { takeRunAnswer('unit-stale-1'); takeRunAnswer('unit-stale-2'); });

  it('hands the recorded answer back exactly once', () => {
    recordRunAnswer('unit-once', 'Итог рана');
    expect(takeRunAnswer('unit-once')).toBe('Итог рана');
    expect(takeRunAnswer('unit-once'), 'a second callback must not replay the answer').toBeNull();
  });

  it('returns null for a run that never recorded one (error/stop outcomes)', () => {
    expect(takeRunAnswer('unit-never-recorded')).toBeNull();
    expect(takeRunAnswer(null)).toBeNull();
  });

  it('ignores an empty answer instead of shipping a blank field', () => {
    recordRunAnswer('unit-empty', '');
    expect(takeRunAnswer('unit-empty')).toBeNull();
    recordRunAnswer('unit-missing', null);
    expect(takeRunAnswer('unit-missing')).toBeNull();
  });

  it('stays bounded so a long-lived process cannot grow it forever', () => {
    for (let i = 0; i < 200; i++) recordRunAnswer(`unit-cap-${i}`, `a${i}`);
    for (let i = 0; i < 200; i++) takeRunAnswer(`unit-cap-${i}`);
    expect(_testMode.runAnswers.size).toBeLessThanOrEqual(64);
  });
});

// ── A3b: the callback body ───────────────────────────────────────────────────

describe('notifyRunFinished answer field', () => {
  const { notifyRunFinished } = require('../../src/gateway-callback');
  const CHAT = -100000000000099;

  let fetchMock;
  let origGateway;
  let body;

  beforeEach(() => {
    body = null;
    fetchMock = vi.fn(async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    origGateway = process.env.MEDIA_GATEWAY_URL;
    process.env.MEDIA_GATEWAY_URL = 'https://gateway.invalid';
  });

  afterEach(() => {
    if (origGateway === undefined) delete process.env.MEDIA_GATEWAY_URL;
    else process.env.MEDIA_GATEWAY_URL = origGateway;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('carries the answer when the run had one', async () => {
    await notifyRunFinished({ chatId: CHAT, requestId: 'r1', taskId: 't1', outcome: 'done', answer: 'Финальный ответ', secret: 's' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/internal/run-finished');
    expect(body.answer).toBe('Финальный ответ');
    // The pre-existing fields are untouched — the gateway contract still holds.
    expect(body).toMatchObject({ chatId: CHAT, requestId: 'r1', taskId: 't1', outcome: 'done' });
  });

  it('omits the field entirely for a normal run (no gateway that understands it)', async () => {
    await notifyRunFinished({ chatId: CHAT, requestId: 'r2', taskId: 't2', outcome: 'done', secret: 's' });
    expect('answer' in body).toBe(false);
  });

  it('truncates a runaway answer before it hits the wire', async () => {
    await notifyRunFinished({ chatId: CHAT, requestId: 'r3', answer: 'я'.repeat(50_000), secret: 's' });
    expect(body.answer.length).toBe(8000);
  });

  it('omits an empty answer', async () => {
    await notifyRunFinished({ chatId: CHAT, requestId: 'r4', answer: '', secret: 's' });
    expect('answer' in body).toBe(false);
  });

  it('ignores a non-string answer rather than stringifying it', async () => {
    await notifyRunFinished({ chatId: CHAT, requestId: 'r5', answer: { text: 'no' }, secret: 's' });
    expect('answer' in body).toBe(false);
  });
});
