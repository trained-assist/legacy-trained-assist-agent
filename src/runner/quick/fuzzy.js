'use strict';
// Fuzzy natural-language info intents (HELP/USAGE/SECRETS_*/CONTEXT_*/MODEL_INFO) are
// unanchored: they exist for a SHORT standalone question («что ты умеешь», «сколько я
// потратил»). Inside a real task the same words are just prose and used to swallow the
// whole task with a canned reply (#1479). Slash commands keep matching; prose must be a
// single short message to count as an info question.
const FUZZY_INFO_MAX_CHARS = 100;
function isShortStandaloneQuestion(task) {
  const raw = String(task || '').trim();
  if ((raw.match(/\[Сообщение \d+\]/g) || []).length > 1) return false;
  const text = raw.replace(/^\[Сообщение \d+\]\s*/, '').replace(/^@\w+\s*/, '').trim();
  return text.length <= FUZZY_INFO_MAX_CHARS;
}
function fuzzyInfoIntent(re, task) {
  if (!re.test(task)) return false;
  const text = String(task || '').trim().replace(/^\[Сообщение \d+\]\s*/, '').replace(/^@\w+\s*/, '');
  return /^\//.test(text) || isShortStandaloneQuestion(task);
}

module.exports = { isShortStandaloneQuestion, fuzzyInfoIntent, FUZZY_INFO_MAX_CHARS };
