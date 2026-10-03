'use strict';
// Regression test for the leaked tool-call markup (2026-10-04).
//
// Bug: a free model on the OpenCode ladder emits the tool call twice — once as a
// native call whose JSON args are truncated (OpenCode records tool "invalid", so
// the tool never runs) and once in the legacy XML dialect it was trained on. The
// XML copy arrives as an ordinary text part, so `<tool_call><function=…><parameter=…>`
// streamed into Telegram, into the web SSE stream and into the persisted
// transcript (the OpenCode engine snapshots the whole scratchpad as the answer).
//
// Fix: stream-noise-filter.js at the single ingestion chokepoint in
// claude-runner.js — must hold across chunk boundaries (the block arrives in
// deltas and can end mid-tag) and drop a never-terminated block instead of
// buffering without bound.
const assert = require('node:assert/strict');
const { StreamNoiseFilter, stripLeakedToolMarkup } = require('../src/runner/stream-noise-filter');

const ZWSP = '\u200b';
const leaked =
  `<${ZWSP}tool_call><function=engineering-skills_repo_map>` +
  '<parameter=repo>/home/vova/trained-assist-agent</parameter>' +
  '<parameter=level>1</parameter>' +
  '<parameter=focus>["test-mode", "telegram.js", "run-outbox.js"]</parameter>' +
  `</function></${ZWSP}tool_call>`;

// Feeds text in fixed-size slices — the way a stream actually delivers it.
function pump(filter, text, slice = 7) {
  let out = '';
  for (let i = 0; i < text.length; i += slice) out += filter.push(text.slice(i, i + slice));
  return out + filter.flush();
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

// 1) whole block, one delta → gone
assert.equal(pump(new StreamNoiseFilter(), leaked), ''); pass++;
assert.ok(!pump(new StreamNoiseFilter(), leaked).includes('repo_map')); pass++;

// 2) every slice size drops it — including splits INSIDE a tag name
for (const slice of [1, 2, 3, 5, 7, 13, 64, 4096]) {
  assert.equal(pump(new StreamNoiseFilter(), leaked, slice), '', `slice=${slice} leaked markup`);
  pass++;
}

// 3) split exactly at the marker start, the ZWSP and the close tag
for (const at of [1, 2, 6, leaked.length - 1, leaked.length - 3, leaked.length - 12]) {
  const f = new StreamNoiseFilter();
  assert.equal(f.push(leaked.slice(0, at)) + f.push(leaked.slice(at)) + f.flush(), '',
    `split at ${at} leaked`);
  pass++;
}

// 4) prose around the block survives, block does not
const mixed = `Смотрю карту репозитория.\n${leaked}\nДальше читаю файл.`;
const mixedOut = pump(new StreamNoiseFilter(), mixed);
assert.ok(mixedOut.includes('Смотрю карту репозитория.'), 'prose before survives');
assert.ok(mixedOut.includes('Дальше читаю файл.'), 'prose after survives');
assert.ok(!mixedOut.includes('tool_call'), 'markup dropped from mixed output');
assert.ok(!mixedOut.includes('repo_map'), 'tool name dropped');
pass++;

// 5) several blocks in a row + a real answer after them
const many = `${leaked}${leaked}Готово, PR открыт.`;
const manyOut = pump(new StreamNoiseFilter(), many);
assert.equal(manyOut, 'Готово, PR открыт.'); pass++;

// 6) never-terminated block (part ended mid-tag) → dropped, not buffered forever
const truncated = 'Думаю… ' + `<${ZWSP}tool_call><function=repo_map><parameter=level>`;
assert.equal(pump(new StreamNoiseFilter(), truncated), 'Думаю… '); pass++;

// 7) runaway SUSPECT with no close tag → the suspect run is dropped at MAX_SUSPECT
//    instead of being buffered/emitted forever (a stream can't know that text
//    arriving AFTER the drop is still junk — so the invariant is bounded output).
const runaway = `<${ZWSP}tool_call><function=repo_map>` + 'y'.repeat(70 * 1024);
const runawayOut = pump(new StreamNoiseFilter(), runaway);
assert.ok(!runawayOut.includes('tool_call'), 'runaway suspect leaked the marker');
assert.ok(runawayOut.length < 10 * 1024, `runaway suspect leaked ${runawayOut.length} chars`);
pass++;
assert.ok(pump(new StreamNoiseFilter(), 'z'.repeat(70 * 1024)).length > 70000, 'long clean text must survive'); pass++;

// 8) bare function/parameter without the tool_call envelope (double-emit variant)
const bare = '<function=repo_map><parameter=level>1</parameter></function>';
assert.equal(pump(new StreamNoiseFilter(), bare), ''); pass++;

// 9) FALSE POSITIVES — ordinary text with angle brackets, code, URLs, XML the
//    user actually asked about. Must pass through byte-for-byte.
const innocent = [
  'Сравнение: a < b и c > d, тег <b>жирный</b>.',
  'См. https://example.com/a?b=1&c=2 — там параметры.',
  'JSON: {"repo": "x", "level": 1}',
  'Код: if (a <= b) { return c >= d; }',
  '',
  '   ',
].join('\n');
assert.equal(pump(new StreamNoiseFilter(), innocent), innocent); pass++;
assert.equal(stripLeakedToolMarkup(innocent), innocent); pass++;

// 10) one-shot helper (final-answer paths)
assert.equal(stripLeakedToolMarkup(`Готово.${leaked}`), 'Готово.'); pass++;
assert.equal(stripLeakedToolMarkup(leaked), ''); pass++;
assert.equal(stripLeakedToolMarkup(null), ''); pass++;
assert.equal(stripLeakedToolMarkup('обычный ответ'), 'обычный ответ'); pass++;

// 11) idempotent: filtering filtered text changes nothing
assert.equal(stripLeakedToolMarkup(stripLeakedToolMarkup(mixed)), mixedOut); pass++;

// 12) REGRESSION: a short final message must survive a single push() with NO flush.
// Codex/Claude snapshot lastAssistantMsg per delta, so withholding ordinary chars
// (a blind tail) lost the answer — CI e2e "requires Codex turn completion" caught it.
for (const msg of ['Ответ Codex', 'Готово: PR открыт.', 'x', 'a < b', 'см. <https://x.y>']) {
  assert.equal(new StreamNoiseFilter().push(msg), msg, `short message withheld: ${msg}`);
  pass++;
}

console.log(`stream-noise-filter: ${pass} assertions passed`);