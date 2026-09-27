'use strict';

// ---------------------------------------------------------------------------
// Telegram message formatter — a degradation ladder so a message NEVER fails
// to send because of bad formatting. Claude answers in Markdown (**bold**,
// [text](url), `code`), but Telegram parses HTML — without conversion the
// markers show up raw. The ladder:
//
//   1. Deterministic Markdown -> Telegram-HTML converter that emits ONLY
//      whitelisted tags, balanced by construction. Handles the vast majority
//      with no LLM.
//   2. Validator: every tag closed + whitelist only. If invalid AND a cheap
//      LLM fixer is available -> one repair attempt.
//   3. If still invalid (or no LLM / oversized) -> strip to plain text and
//      send with no parse_mode. Always a deliverable message.
//
// The LLM is the MIDDLE rung, not the primary repair: the guarantee rests on
// the deterministic converter above and the plain-text floor below, so a
// message never depends on the LLM being alive.
// ---------------------------------------------------------------------------

const TG_MAX_LEN = 4096;

// Tags Telegram's HTML parser accepts (Bot API "HTML style").
const TG_WHITELIST = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span',
]);

const SENT = String.fromCharCode(0); // NUL sentinel — cannot appear in Telegram text.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Rung 1: deterministic converter -------------------------------------
function mdToTgHtml(md) {
  if (md == null) return '';
  const codeBlocks = [];
  const inlineCodes = [];

  // 1) Protect fenced code blocks ```lang\n...``` before anything else.
  let text = String(md).replace(/```([\w+\-.]*)[ \t]*\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.push({ lang: (lang || '').trim(), code }) - 1;
    return `${SENT}B${idx}${SENT}`;
  });

  // 2) Protect inline code `...`.
  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    const idx = inlineCodes.push(code) - 1;
    return `${SENT}C${idx}${SENT}`;
  });

  // 3) Escape HTML specials in the remaining prose (markdown markers survive).
  text = escapeHtml(text);

  // 4) Links [label](url) — only http(s)/tg/mailto targets, else leave literal.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:\/\/|tg:\/\/|mailto:)/i.test(url)) return m;
    const safeUrl = url.replace(/&amp;/g, '&').replace(/&/g, '&amp;').replace(/"/g, '%22');
    return `<a href="${safeUrl}">${label}</a>`;
  });

  // 5) Bold **...** / __...__ (run before italic so ** isn't eaten as *).
  text = text.replace(/\*\*(?=\S)([^\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(?=\S)([^\n]+?)__/g, '<b>$1</b>');

  // 6) Italic *...* / _..._ — require non-space edges, avoid leftover ** and __.
  text = text.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)_(?!_)/g, '$1<i>$2</i>');

  // 7) Strikethrough ~~...~~.
  text = text.replace(/~~(?=\S)([^\n]+?)~~/g, '<s>$1</s>');

  // 8) Line-level: headings -> bold line; blockquotes (merged runs).
  const lines = text.split('\n');
  const out = [];
  let quote = null;
  for (const line of lines) {
    const q = line.match(/^\s{0,3}&gt;\s?(.*)$/);
    if (q) { (quote || (quote = [])).push(q[1]); continue; }
    if (quote) { out.push(`<blockquote>${quote.join('\n')}</blockquote>`); quote = null; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*\S)\s*$/);
    if (h) { out.push(`<b>${h[2]}</b>`); continue; }
    out.push(line);
  }
  if (quote) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
  text = out.join('\n');

  // 9) Reinsert inline code (escaped).
  text = text.replace(new RegExp(`${SENT}C(\\d+)${SENT}`, 'g'),
    (m, i) => `<code>${escapeHtml(inlineCodes[+i])}</code>`);

  // 10) Reinsert fenced code blocks (escaped).
  text = text.replace(new RegExp(`${SENT}B(\\d+)${SENT}`, 'g'), (m, i) => {
    const { lang, code } = codeBlocks[+i];
    const inner = escapeHtml(code.replace(/\n$/, ''));
    return lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`
      : `<pre>${inner}</pre>`;
  });

  return text;
}

// --- Rung 2: validator -----------------------------------------------------
function validateTgHtml(html) {
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!TG_WHITELIST.has(name)) return { ok: false, reason: `tag not allowed: <${name}>` };
    if (closing) {
      if (!stack.length || stack[stack.length - 1] !== name) {
        return { ok: false, reason: `unbalanced </${name}>` };
      }
      stack.pop();
    } else {
      stack.push(name);
    }
  }
  if (stack.length) return { ok: false, reason: `unclosed: <${stack.join('>, <')}>` };
  return { ok: true };
}

// --- Rung 3: plain-text floor ----------------------------------------------
function stripToPlainText(input) {
  return String(input == null ? '' : input)
    .replace(/```[\w+\-.]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}&gt;\s?/gm, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// --- The ladder ------------------------------------------------------------
// Returns { text, parse_mode } ready to spread into a sendMessage/editMessageText
// body. parse_mode is 'HTML' when formatted, undefined for the plain-text floor.
async function formatForTelegram(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { text: raw, parse_mode: undefined };

  let html = mdToTgHtml(raw);
  let v = validateTgHtml(html);

  if (!v.ok && typeof opts.llmFix === 'function') {
    try {
      const fixed = await opts.llmFix(html, v.reason);
      if (fixed) { const fv = validateTgHtml(fixed); if (fv.ok) { html = fixed; v = fv; } }
    } catch { /* fall through to floor */ }
  }

  if (v.ok && html.length <= TG_MAX_LEN) return { text: html, parse_mode: 'HTML' };
  return { text: stripToPlainText(raw), parse_mode: undefined };
}

// Cheap LLM repair rung factory — runs on the service-LLM ladder (src/service-llm.js: Go rungs →
// OpenRouter last). Returns null when no provider key is configured so the ladder skips straight
// to the floor.
function makeLlmFixer(orKey) {
  const serviceLlm = require('./service-llm');
  if (!serviceLlm.available(orKey)) return null;
  return async (html, reason) => {
    let out = await serviceLlm.serviceText({
      system: 'You repair Telegram-flavored HTML. Output ONLY the corrected HTML, no commentary, no code fences. '
        + 'Allowed tags: b, i, u, s, a (with href), code, pre, blockquote, tg-spoiler. '
        + 'Close every tag, drop any disallowed tag while keeping its text, and escape stray < > & as &lt; &gt; &amp;.',
      user: `Problem: ${reason}\n\nHTML to fix:\n${html}`,
      maxTokens: 2048, timeoutMs: 8000, apiKey: orKey, source: 'tg-format',
    });
    if (!out) return null;
    out = out.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```$/i, '').trim();
    return out || null;
  };
}

module.exports = {
  formatForTelegram,
  mdToTgHtml,
  validateTgHtml,
  stripToPlainText,
  makeLlmFixer,
  TG_WHITELIST,
  TG_MAX_LEN,
};
