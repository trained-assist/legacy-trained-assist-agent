'use strict';
// §5.2 adherence flag "internal_refs" — repo paths, PR numbers and commit hashes
// must not leak to the non-technical reader (system prompt §"The reader is not
// a developer"). Pure string heuristics, no LLM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { adherenceFlags } = require('../src/prompt-audit');

test('internal_refs: repo path, home path, PR number, commit sha → flagged', () => {
  const t = 'Всплыл устаревший src/prompt-domains/gdrive.md, PR #1736 merged → adcc74d, '
    + 'логи лежат в ~/users/efi/session.log — смотри test/sibling-wiring.test.cjs';
  assert.equal(adherenceFlags(t).internal_refs, 1);
});

test('internal_refs: plain answer and a published URL stay clean', () => {
  const t = 'Готово — отчёт опубликован: https://instant-publish.trainedassist.store/p/documents-done. '
    + 'Проверки перед слиянием зелёные, можно задеплоить.';
  assert.equal(adherenceFlags(t).internal_refs, 0);
});
