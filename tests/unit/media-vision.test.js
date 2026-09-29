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

function fakeOpenRouter(content) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
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

  it('returns ok:false without an OpenRouter key (no network call)', async () => {
    let called = false;
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: null,
      fetchImpl: async () => { called = true; },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_key');
    expect(called).toBe(false);
  });

  it('returns ok:false when the file cannot be read', async () => {
    const r = await extractImageText({
      filePath: join(dir, 'missing.jpg'), mimeType: 'image/jpeg', openrouterKey: 'test-key',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('read_error');
  });

  it('extracts text on a successful OpenRouter response', async () => {
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: fakeOpenRouter('Вывеска: "Кофейня Утро"'),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Кофейня Утро');
  });

  it('sends the image as a base64 data URL with the given mime type', async () => {
    let sentBody;
    const r = await extractImageText({
      filePath, mimeType: 'image/png', openrouterKey: 'test-key',
      fetchImpl: async (url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'text' } }] }) }; },
    });
    expect(r.ok).toBe(true);
    const imagePart = sentBody.messages[0].content.find(c => c.type === 'image_url');
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(sentBody.max_tokens).toBe(8192); // bounded output (#1844)
  });

  it('treats a refusal sentence as no extraction, not as content', async () => {
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: fakeOpenRouter('Извините, я не могу проанализировать это изображение.'),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('refusal');
  });

  it('retries once on 429 and reports it after the retry fails too', async () => {
    let calls = 0;
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: async () => { calls++; return { ok: false, status: 429 }; },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('http_429');
    expect(calls).toBe(2); // transient → exactly one retry (#1844)
  });

  it('retries once when fetch itself throws (network error)', async () => {
    let calls = 0;
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: async () => { calls++; throw new Error('boom'); },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('network_error');
    expect(calls).toBe(2);
  });

  it('recovers when the first attempt fails transiently and the retry succeeds', async () => {
    let calls = 0;
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: async () => {
        if (++calls === 1) throw new Error('socket reset');
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Текст: 123' } }] }) };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('123');
    expect(calls).toBe(2);
  });

  it('does NOT retry a timeout — the call runs inline in the /run accept path', async () => {
    let calls = 0;
    const r = await extractImageText({
      filePath, mimeType: 'image/jpeg', openrouterKey: 'test-key',
      fetchImpl: async () => {
        calls++;
        const e = new Error('aborted'); e.name = 'TimeoutError'; throw e;
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(calls).toBe(1);
  });
});
