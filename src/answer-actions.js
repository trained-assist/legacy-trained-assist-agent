'use strict';

// #1542 P3 — post-processing of the agent's final answer.
//
// 1. extractAnswerActions: ONE cheap-LLM call replaces the old pair
//    detectPlanInAnswer (yes/no → generic «Действуй дальше по плану») +
//    detectMenuInAnswer (2-4 alternatives). It returns the concrete actions the
//    answer itself proposes («Создать PR», «Задеплоить на RU»), each backed by a
//    verbatim quote from the answer.
//
//    Label policy (owner decision, incident 2026-09-28 second round): the label is a SHORT
//    FORMULATION of the step (≤ MAX_LABEL chars), not a verbatim copy of the answer's phrasing.
//    The previous rule required the label to appear in the text verbatim — buttons then read as
//    awkward word-for-word echoes of the prose («жёстко», per the owner). The tap itself only
//    sends the button index (act|sid|n) and the session re-reads its own answer, so the label is
//    display-only: free wording is safe.
//
//    What stays grounded is the ACTION: quote must be a verbatim fragment of the answer, so a
//    button can only ever be extracted from a step the answer really proposed — never invented.
// 2. paragraphize: a wall of text (long, almost no blank lines) is re-split into
//    paragraphs/lists by the LLM; the result is accepted only if it kept the
//    words of the original (coverage guard), otherwise the original goes out.
//
// Both are fail-soft: no key / timeout / bad JSON → null, caller keeps legacy path. Both run on
// the service-LLM ladder (src/service-llm.js).

const serviceLlm = require('./service-llm');
const MAX_ACTIONS = 3;
const MAX_LABEL = 40;

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Truncate to `max` chars on a word boundary (a cut half-word reads as a typo on a button).
function cutWords(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 10 ? cut.slice(0, sp) : cut).trim();
}

// Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last) — throws when every rung
// failed so callers keep their existing fail-soft catch.
async function callJson({ apiKey, system, user, maxTokens, timeoutMs, source, ctx = null }) {
  const value = await serviceLlm.serviceJson({ system, user, maxTokens, timeoutMs, apiKey, source, ctx });
  if (value == null) throw new Error('service-llm: no rung answered');
  return value;
}

const ACTIONS_SYSTEM = [
  'Ты читаешь финальный ответ ассистента пользователю. Если ассистент предлагает следующие',
  'шаги или выбор — верни их списком.',
  `Каждый ярлык — КРАТКАЯ формулировка шага, до ${MAX_LABEL} символов, по-русски, своими словами;`,
  'не копируй дословно фразы ответа.',
  'Если ответ — план из нескольких шагов, это ОДНО действие с ярлыком про суть плана.',
  'Если ответ предлагает выбор из альтернатив — по ярлыку на каждую альтернативу.',
  'НЕ действия: итог уже сделанного, факты, вопрос без предложения, общие фразы,',
  'служебные /команды и управление чеклистом.',
  'Для каждого действия дай quote — ДОСЛОВНЫЙ фрагмент ответа (5-15 слов), где оно предложено:',
  'кнопка ставится только на реально предложенный шаг.',
  'Ответь СТРОГО JSON: {"kind":"plan"|"menu"|"actions"|"none","actions":[{"label":"…","quote":"…"}]}.',
  'Сомневаешься → {"kind":"none","actions":[]}.',
].join(' ');

// → { kind, actions: [{label, quote}] } | null (null = LLM unavailable → caller uses legacy)
async function extractAnswerActions(text, apiKey, { timeoutMs = 10000, ctx = null } = {}) {
  const t = String(text || '').trim();
  if (t.length < 100) return { kind: 'none', actions: [] };
  if (!serviceLlm.available(apiKey)) return null;
  let obj;
  try {
    obj = await callJson({
      apiKey, source: 'answer-actions', ctx,
      system: ACTIONS_SYSTEM,
      user: t.slice(-6000),
      maxTokens: 400,
      timeoutMs,
    });
  } catch (e) {
    console.warn('[answer-actions]', e.message);
    return null;
  }
  return validateActions(obj, t);
}

// Pure: keep only actions grounded in the answer text. Exported for tests.
function validateActions(obj, text) {
  const kinds = new Set(['plan', 'menu', 'actions', 'none']);
  const kind = kinds.has(obj?.kind) ? obj.kind : 'none';
  if (kind === 'none' || !Array.isArray(obj?.actions)) return { kind: 'none', actions: [] };
  const hay = norm(text);
  const seen = new Set();
  const actions = [];
  for (const a of obj.actions) {
    const rawLabel = String(a?.label || '').replace(/^[\d.)\s]+/, '').replace(/[«»"“”]/g, '').trim();
    const rawQuote = String(a?.quote || '').trim();
    if (/^\/|чеклист/i.test(rawLabel)) continue;
    // Grounding: the quote (or, if the model trimmed it, most of its words) must be in the text.
    const quote = norm(rawQuote);
    if (!quote || quote.split(' ').length < 2) continue;
    if (!hay.includes(quote)) {
      const words = quote.split(' ').filter(w => w.length > 3);
      const hit = words.filter(w => hay.includes(w)).length;
      if (!words.length || hit / words.length < 0.8) continue;
    }
    // The action must be grounded (quote in the text) — that is the «never invent a button»
    // invariant. The label itself is free wording (short formulation), see header.
    const label = cutWords(rawLabel, MAX_LABEL);
    if (!label) continue;
    const k = norm(label);
    if (seen.has(k)) continue;
    seen.add(k);
    actions.push({ label, quote: a.quote });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return actions.length ? { kind, actions } : { kind: 'none', actions: [] };
}

function actionsMarkup(sessionId, actions) {
  return {
    inline_keyboard: actions.map((a, i) => [{ text: `▶️ ${a.label}`, callback_data: `act|${sessionId}|${i}`.slice(0, 64) }]),
  };
}

// ── paragraphize ────────────────────────────────────────────────────────────
// Wall of text = long and (almost) no paragraph breaks or list lines.
function isWallOfText(text) {
  const t = String(text || '').trim();
  if (t.length < 600) return false;
  if (/```/.test(t)) return false; // code blocks: never touch
  const breaks = (t.match(/\n\s*\n/g) || []).length;
  const listLines = (t.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) || []).length;
  return breaks + listLines < Math.floor(t.length / 500);
}

function wordBag(s) {
  const m = new Map();
  for (const w of norm(s).split(' ')) if (w) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

// Share of original words (with multiplicity) that survived in the candidate.
function coverage(orig, cand) {
  const a = wordBag(orig), b = wordBag(cand);
  let total = 0, kept = 0;
  for (const [w, n] of a) { total += n; kept += Math.min(n, b.get(w) || 0); }
  return total ? kept / total : 1;
}

const PARA_SYSTEM = [
  'Переформатируй текст для чтения в мессенджере: разбей на короткие абзацы (пустая строка между ними),',
  'перечисления оформи списком «- », шаги — «1. ». НЕ меняй, не добавляй и не удаляй слова, цифры, ссылки,',
  'имена, код — только переносы строк и маркеры списков. Ответь СТРОГО JSON: {"text":"…"}.',
].join(' ');

// → reformatted text, or the original when not needed / unsafe / unavailable.
async function paragraphize(text, apiKey, { timeoutMs = 12000, ctx = null } = {}) {
  const t = String(text || '');
  if (!isWallOfText(t) || t.length > 8000) return t;
  if (!serviceLlm.available(apiKey)) return t;
  try {
    const obj = await callJson({
      apiKey, source: 'answer-format', ctx,
      system: PARA_SYSTEM,
      user: t,
      maxTokens: Math.min(4000, Math.ceil(t.length / 2) + 200),
      timeoutMs,
    });
    const out = String(obj?.text || '').trim();
    if (!out) return t;
    if (coverage(t, out) < 0.97 || coverage(out, t) < 0.95) {
      console.warn('[answer-format] rejected: word coverage too low');
      return t;
    }
    return out;
  } catch (e) {
    console.warn('[answer-format]', e.message);
    return t;
  }
}

module.exports = { extractAnswerActions, validateActions, actionsMarkup, paragraphize, isWallOfText, coverage, ACTIONS_SYSTEM };
