'use strict';

// Retro-checkable audit line for outgoing reply buttons (2026-09-15, extended #1851 S1).
// One line per outgoing answer: session / why the buttons were chosen / what was really
// attached. Kept as a tiny pure module so it can be unit-tested without booting the runner.
//
// `callbacks=` is an ADDITIVE key added for the live-bot QA trace (#1878): the qa_trace
// block parses it to show the agent the real callback_data of the buttons it produced.
// The pre-existing keys (session/internalGtd/reason/textLen/attached) are byte-for-byte
// unchanged, so existing greps/parsers keep working.
function flattenButtons(markup) {
  return (markup && markup.inline_keyboard ? markup.inline_keyboard : []).flat();
}

function formatButtonsAuditLine({ sessionId, internalGtd, reason, textLen, markup }) {
  const buttons = flattenButtons(markup);
  const labels = buttons.map((b) => b && b.text);
  const callbacks = buttons.map((b) => ({ t: b && b.text, c: b && b.callback_data }));
  return `[buttons] session=${sessionId || '-'} internalGtd=${internalGtd} reason=${reason} textLen=${textLen} attached=${JSON.stringify(labels)} callbacks=${JSON.stringify(callbacks)}`;
}

module.exports = { formatButtonsAuditLine, flattenButtons };
