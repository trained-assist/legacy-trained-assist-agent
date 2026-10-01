'use strict';

// OpenRouter app attribution — the class guard for the "Unknown" defect (owner 01.10.2026:
// 540 из 571 запросов в аналитике OpenRouter приходили как «Unknown», то есть трафик нельзя было
// разложить по инструментам и посчитать, кто сколько жжёт).
//
// Two parts:
//   1. unit — the header set src/or-attribution.js builds (the analytics "Application" identity
//      is the HTTP-Referer URL, the title is only its display name);
//   2. class — NO file under src/ may call openrouter.ai with hand-written headers. The only way
//      to reach OpenRouter is through orHeaders() (direct) or the ladder client (src/service-llm.js,
//      which forwards x-ladder-app). A new direct call site without attribution fails here instead
//      of silently becoming the next "Unknown" bucket.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  orHeaders,
  sanitizeAppSlug,
  sanitizeAppTitle,
  APP_REFERER_BASE,
  DEFAULT_APP_SLUG,
} = require('../src/or-attribution');

test('orHeaders builds the attribution triple OpenRouter groups by', () => {
  const h = orHeaders({ apiKey: 'sk-test', app: 'session-summary' });
  assert.equal(h['Authorization'], 'Bearer sk-test');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['HTTP-Referer'], `${APP_REFERER_BASE}/session-summary`);
  assert.equal(h['X-OpenRouter-Title'], 'Trained Assist session-summary');
  assert.equal(h['X-OpenRouter-App-Visibility'], 'hidden');
});

test('orHeaders keeps extra headers (Content-Length for https.request)', () => {
  const h = orHeaders({ apiKey: 'k', app: 'hermes-run', extra: { 'Content-Length': 42 } });
  assert.equal(h['Content-Length'], 42);
  assert.equal(h['HTTP-Referer'], `${APP_REFERER_BASE}/hermes-run`);
});

test('orHeaders accepts an explicit title', () => {
  const h = orHeaders({ apiKey: 'k', app: 'media-vision', title: 'Vision OCR' });
  assert.equal(h['X-OpenRouter-Title'], 'Vision OCR');
});

test('a non-slug app falls back to the repo default instead of being half-repaired', () => {
  // A silently "cleaned" slug would become a DIFFERENT application upstream — the exact confusion
  // this module removes — so anything that is not already a slug becomes the default identity.
  for (const bad of ['Сводка сессии', 'has space', '../../etc', 'x'.repeat(65), '', null, undefined]) {
    assert.equal(sanitizeAppSlug(bad), DEFAULT_APP_SLUG, `slug fallback for ${JSON.stringify(bad)}`);
  }
  assert.equal(sanitizeAppSlug('Intake-Gate'), 'intake-gate', 'a real slug is lowercased and kept');
  assert.equal(sanitizeAppSlug('a'), 'a');
  assert.equal(sanitizeAppSlug(42), '42', 'digits are a legal slug segment');
});

test('title is header-safe: control characters stripped, length capped, blank → default', () => {
  assert.equal(sanitizeAppTitle('badtitle', 'x'), 'badtitle');
  assert.equal(sanitizeAppTitle('y'.repeat(200), 'x').length, 64);
  assert.equal(sanitizeAppTitle('', 'media-vision'), 'Trained Assist media-vision');
  assert.equal(sanitizeAppTitle('   ', 'media-vision'), 'Trained Assist media-vision');
});

test('a missing apiKey still produces the attribution headers (fail loudly at the provider, not silently)', () => {
  const h = orHeaders({ app: 'intake-gate' });
  assert.equal(h['Authorization'], 'Bearer ');
  assert.equal(h['HTTP-Referer'], `${APP_REFERER_BASE}/intake-gate`);
});

test('CLASS GUARD: every direct openrouter.ai call site attributes itself', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(root);

  const offenders = [];
  for (const file of files) {
    if (file.endsWith(path.join('src', 'or-attribution.js'))) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('openrouter.ai')) continue; // no OpenRouter traffic in this file
    if (text.includes('orHeaders(')) continue;     // attributed through the single helper
    offenders.push(path.relative(root, file));
  }
  assert.deepEqual(
    offenders, [],
    `OpenRouter call sites without attribution (build headers via orHeaders() from src/or-attribution.js): ${offenders.join(', ')}`,
  );
});

test('CLASS GUARD: the ladder client always names the calling tool (x-ladder-app)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'service-llm.js'), 'utf8');
  assert.ok(
    /put\('x-ladder-app',\s*\(ctx && ctx\.app\) \|\| source\)/.test(text),
    'service-llm must send x-ladder-app even without ctx — otherwise every ladder call is anonymous',
  );
});
