// Tests for src/prompt-audit.js — prompt effectiveness instrumentation (§5.1–5.2).
// Pure functions: estimateTokens / computeSectionTokens / adherenceFlags, plus the
// JSONL ring-buffer writer recordPromptAudit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pa = require('../../src/prompt-audit.js');

describe('estimateTokens', () => {
  it('chars/4 rounded up, empty → 0', () => {
    expect(pa.estimateTokens('')).toBe(0);
    expect(pa.estimateTokens(null)).toBe(0);
    expect(pa.estimateTokens('abcd')).toBe(1);
    expect(pa.estimateTokens('abcdefgh')).toBe(2);
    expect(pa.estimateTokens('a'.repeat(10))).toBe(3);
  });
});

describe('computeSectionTokens', () => {
  it('sums per-section estimates into total', () => {
    const r = pa.computeSectionTokens({ base: 'abcd', notes: 'abcdefgh', reqlog: '' });
    expect(r).toEqual({ base: 1, notes: 2, reqlog: 0, total: 3 });
  });
  it('empty/missing sections → total 0', () => {
    expect(pa.computeSectionTokens({})).toEqual({ total: 0 });
    expect(pa.computeSectionTokens(null)).toEqual({ total: 0 });
  });
});

describe('adherenceFlags', () => {
  it('quick mode: long or multi-sentence reply → quick_verbosity 1; deep mode exempt', () => {
    expect(pa.adherenceFlags('Short.', {}).quick_verbosity).toBe(0);
    const long = 'Слово. '.repeat(30); // >800 chars, many sentences
    expect(pa.adherenceFlags(long, {}).quick_verbosity).toBe(1);
    expect(pa.adherenceFlags(long, { mode: 'deep' }).quick_verbosity).toBe(0);
  });

  it('has_html: any <tag> flagged', () => {
    expect(pa.adherenceFlags('<b>bold</b> text', {}).has_html).toBe(1);
    expect(pa.adherenceFlags('no tags here', {}).has_html).toBe(0);
  });

  it('long_reply_not_published: >800 chars without a URL', () => {
    const long = 'Длинный ответ без ссылки. '.repeat(40);
    expect(pa.adherenceFlags(long, {}).long_reply_not_published).toBe(1);
    expect(pa.adherenceFlags(long + ' https://example.com/x', {}).long_reply_not_published).toBe(0);
    expect(pa.adherenceFlags('short', {}).long_reply_not_published).toBe(0);
  });

  it('clarify_question: trailing question mark or option list', () => {
    expect(pa.adherenceFlags('Так сделать?', {}).clarify_question).toBe(1);
    expect(pa.adherenceFlags('Может выбрать вариант A/B/C', {}).clarify_question).toBe(1);
    expect(pa.adherenceFlags('Сделано.', {}).clarify_question).toBe(0);
  });

  it('forbidden_mentions: operator email / «через Claude»', () => {
    expect(pa.adherenceFlags('Пиши на operator@example.com', {}).forbidden_mentions).toBe(1);
    expect(pa.adherenceFlags('Сделано через Claude', {}).forbidden_mentions).toBe(1);
    expect(pa.adherenceFlags('Сделано через OpenCode', {}).forbidden_mentions).toBe(0);
  });
});

describe('recordPromptAudit', () => {
  let wd;
  let origCwd;

  beforeEach(() => {
    wd = mkdtempSync(join(tmpdir(), 'pa-'));
  });

  afterEach(() => {
    rmSync(wd, { recursive: true, force: true });
  });

  it('appends one JSONL line per task', () => {
    pa.recordPromptAudit(wd, { taskId: 't-1', mode: 'deep', section_tokens: { total: 5 } });
    pa.recordPromptAudit(wd, { taskId: 't-2', mode: 'oneshot' });
    const lines = readFileSync(join(wd, 'prompt-audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).taskId).toBe('t-1');
    expect(JSON.parse(lines[1]).taskId).toBe('t-2');
  });

  it('is a no-op on empty workDir and never throws', () => {
    pa.recordPromptAudit(null, { taskId: 'x' });
    pa.recordPromptAudit(wd, null);
    expect(existsSync(join(wd, 'prompt-audit.jsonl'))).toBe(false);
  });

  it('ring-buffers past MAX_LOG_LINES', () => {
    const N = pa.MAX_LOG_LINES || 2000;
    for (let i = 0; i < N + 5; i++) pa.recordPromptAudit(wd, { taskId: `t-${i}` });
    const lines = readFileSync(join(wd, 'prompt-audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(N);
    // oldest dropped, newest kept
    expect(JSON.parse(lines[0]).taskId).toBe('t-5');
    expect(JSON.parse(lines[N - 1]).taskId).toBe(`t-${N + 4}`);
  });
});