/**
 * src/media-vision.js — image OCR/description for engines with no vision input
 * of their own (OpenCode's minimax/GigaChat/DeepSeek profiles). Claude Code needs
 * none of this: its own Read tool already hands images to the model natively.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractImageText, isRefusal } = require('../../src/media-vision.js');

// Прямого обращения к openrouter.ai больше нет (#2092): весь LLM идёт через llm-ladder,
// поэтому мокаем serviceChat, а не fetch.
function stubServiceChat(mod, impl) {
  const real = mod.serviceChat;
  mod.serviceChat = impl;
  return () => { mod.serviceChat = real; };
}
function ladderOk(content) {
  return async () => ({ content });
}

describe('isRefusal', () => {
  it.each([
    ['I\'m sorry, but I cannot view images.', true],
    ['Извините, я не могу распознать это изображение.', true],
    ['К сожалению, не могу прочитать текст на фото.', true],
    ['Вывеска магазина: "Продукты 24 часа"', false],
    ['', true],
    [null, true],
  ])('%s -> %s', (text, expected) => expect(isRefusal(text)).toBe(expected));
});

describe('extractImageText', () => {
  let dir, filePath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'media-vision-test-'));
    filePath = join(dir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal jpeg-ish bytes
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns ok:false when the file cannot be read', async () => {
    const r = await extractImageText({ filePath: join(dir, 'missing.jpg'), mimeType: 'image/jpeg' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('read_error');
  });

  it('extracts text from a successful ladder response', async () => {
    const restore = stubServiceChat(require('../../src/service-llm.js'), ladderOk('Вывеска: "Кофейня Утро"'));
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
      expect(r.ok).toBe(true);
      expect(r.text).toContain('Кофейня Утро');
    } finally { restore(); }
  });

  it('sends the image as a base64 data URL with the given mime type', async () => {
    let sent;
    const restore = stubServiceChat(require('../../src/service-llm.js'), async (args) => {
      sent = args; return { content: 'text' };
    });
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/png' });
      expect(r.ok).toBe(true);
      const imagePart = sent.messages[0].content.find(c => c.type === 'image_url');
      expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(sent.maxTokens).toBe(8192); // bounded output (#1844)
    } finally { restore(); }
  });

  it('treats a refusal sentence as no extraction, not as content', async () => {
    const restore = stubServiceChat(require('../../src/service-llm.js'),
      ladderOk('Извините, я не могу проанализировать это изображение.'));
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('refusal');
    } finally { restore(); }
  });

  it('reports a ladder failure as network_error and retries once', async () => {
    let calls = 0;
    const restore = stubServiceChat(require('../../src/service-llm.js'),
      async () => { calls++; throw new Error('429'); });
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('network_error');
      expect(calls).toBe(2); // transient → exactly one retry (#1844)
    } finally { restore(); }
  });

  it('retries once when fetch itself throws (network error)', async () => {
    let calls = 0;
    const restore = stubServiceChat(require('../../src/service-llm.js'), async () => { calls++; throw new Error('boom'); });
    try {
    const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('network_error');
    expect(calls).toBe(2);
    } finally { restore(); }
  });

  it('recovers when the first attempt fails transiently and the retry succeeds', async () => {
    let calls = 0;
    const restore = stubServiceChat(require('../../src/service-llm.js'), async () => {
      if (++calls === 1) throw new Error('socket reset');
      return { content: 'Текст: 123' };
    });
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
      expect(r.ok).toBe(true);
      expect(r.text).toContain('123');
      expect(calls).toBe(2);
    } finally { restore(); }
  });

  it('does NOT retry a timeout — the call runs inline in the /run accept path', async () => {
    let calls = 0;
    const restore = stubServiceChat(require('../../src/service-llm.js'), async () => {
      calls++;
      const e = new Error('aborted'); e.name = 'TimeoutError'; throw e;
    });
    try {
      const r = await extractImageText({ filePath, mimeType: 'image/jpeg' });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('timeout');
      expect(calls).toBe(1);
    } finally { restore(); }
  });
});
