'use strict';
// S1a (#1851, issue #1878): the [buttons] audit line stays backward-compatible while
// gaining the additive `callbacks=` key the qa_trace block reads.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatButtonsAuditLine } = require('../src/runner/buttons-audit');

const markup = {
  inline_keyboard: [
    [{ text: 'Проверка', callback_data: 'cb:demo' }],
    [{ text: 'Стоп', callback_data: 'stop|s-1' }],
  ],
};

test('legacy keys are unchanged and in the same order', () => {
  const line = formatButtonsAuditLine({ sessionId: 's-1', internalGtd: false, reason: 'actions:run', textLen: 42, markup });
  assert.match(line, /^\[buttons\] session=s-1 internalGtd=false reason=actions:run textLen=42 attached=\["Проверка","Стоп"\] callbacks=/);
});

test('callbacks= carries {t,c} for every button', () => {
  const line = formatButtonsAuditLine({ sessionId: 's-1', internalGtd: false, reason: 'none', textLen: 1, markup });
  const callbacks = JSON.parse(line.slice(line.indexOf('callbacks=') + 'callbacks='.length));
  assert.deepEqual(callbacks, [
    { t: 'Проверка', c: 'cb:demo' },
    { t: 'Стоп', c: 'stop|s-1' },
  ]);
});

test('no markup / empty markup still emits every key', () => {
  for (const m of [null, undefined, { inline_keyboard: [] }]) {
    const line = formatButtonsAuditLine({ sessionId: null, internalGtd: true, reason: 'internalGtd-suppressed', textLen: 0, markup: m });
    assert.match(line, /^\[buttons\] session=- internalGtd=true reason=internalGtd-suppressed textLen=0 attached=\[\] callbacks=\[\]$/);
  }
});
