'use strict';
// Фоновые лестничные вызовы тоже должны быть находимы в ladder_calls (продолжение #2037).
// Кросс-профильный крон, durable-вердикт, пересборка проектов, гейт issue-фиксера и
// форматирование под Telegram — у каждого своя естественная идентичность, и раньше она
// никуда не попадала: строка в ladder_calls была анонимной.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE = require.resolve('../src/service-llm');
const real = require(SERVICE);

// Swap the ladder client for one that records the ctx of every call, so a path can be
// checked without a network round trip. Restored after each use.
async function withRecordingClient(record, fn) {
  const spy = Object.create(real);
  spy.available = () => true;
  spy.serviceChat = async (o) => { record.push(o.ctx ?? null); return { content: '{"assignments":[]}' }; };
  spy.serviceJson = async (o) => { record.push(o.ctx ?? null); return { value: { verdict: 'done' } }; };
  spy.serviceText = async (o) => { record.push(o.ctx ?? null); return '{"title":"t","body":"b","kind":"bug"}'; };
  require.cache[SERVICE].exports = spy;
  try { await fn(); } finally { require.cache[SERVICE].exports = real; }
}

function fresh(rel) {
  const p = require.resolve(rel);
  delete require.cache[p];
  return require(p);
}

test('bugs-collector: the drafting call names the profile it collects for', async () => {
  const seen = [];
  await withRecordingClient(seen, async () => {
    const bc = fresh('../src/bugs-collector');
    await bc.llmIssue({
      entry: { id: 'rep-77' }, profile: 'kobzevvv', apiKey: 'k',
      input: { report: { summary: 'x', messages: [] }, transcript: '', attachments: [], evidence: [] },
    });
  });
  assert.equal(seen.length, 1, 'one ladder call');
  assert.deepEqual(seen[0], { trace: 'rep-77', user: 'kobzevvv' });
});

test('durable-marker-judge: no ctx → derived from the item, never fabricated; explicit ctx wins', async () => {
  const dmj = fresh('../src/durable-marker-judge');
  const long = 'x'.repeat(400); // above MIN_JUDGE_CHARS so the judge is actually consulted
  const seen = [];
  await withRecordingClient(seen, async () => {
    await dmj.judgeMarkerlessReply({ said: long, item: { id: 'item-abc123', text: 'step' }, task: 'do it' });
    await dmj.judgeMarkerlessReply({ said: long, item: { id: 'item-xyz' }, task: 't', ctx: { trace: 't9', user: 'kobzevvv' } });
  });
  assert.deepEqual(seen[0], { trace: 'item-abc123' },
    'the judge cannot see the profile, so it must not invent one — the item id is enough to find it');
  assert.equal('user' in seen[0], false, 'no fabricated user key');
  assert.deepEqual(seen[1], { trace: 't9', user: 'kobzevvv' }, 'an explicit ctx is used as given');
});

test('issue-fixer gate: the classification call names the issue number', async () => {
  const seen = [];
  await withRecordingClient(seen, async () => {
    const fix = fresh('../src/issue-fixer');
    await fix.openrouterClassify({ number: 42, title: 't', body: 'b' }, '', { apiKey: 'k' }).catch(() => null);
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { trace: 'issue#42' }, 'a number a human would quote, not a blob id');
});

test('reproject: ctx rides from the clustering opts into the ladder call', async () => {
  const seen = [];
  await withRecordingClient(seen, async () => {
    const rp = fresh('../src/reproject');
    await rp.clusterSessions([{ id: 's1', messageCount: 2, topic: 't', digest: 'd' }], null,
      { apiKey: 'k', ctx: { user: 'kobzevvv' } }).catch(() => null);
  });
  assert.equal(seen.length, 1, 'clusterSessions reached the client');
  assert.deepEqual(seen[0], { user: 'kobzevvv' });
});

test('tg-format fixer: identity is a PER-CALL argument, not baked into the cached factory', async () => {
  // tg-stream caches ONE fixer for the whole process, so a factory-level ctx would belong to
  // whichever chat formatted first. Two calls, two chats, one factory.
  const seen = [];
  await withRecordingClient(seen, async () => {
    const tf = fresh('../src/tg-format');
    const fixer = tf.makeLlmFixer('k');
    await fixer('<b>x', 'unclosed', { chat: -111 });
    await fixer('<b>y', 'unclosed', { chat: -222 });
  });
  assert.deepEqual(seen, [{ chat: -111 }, { chat: -222 }], 'each call carries ITS OWN chat');
});
