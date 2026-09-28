// Prompt effectiveness instrumentation (issue: prompt-effectiveness analysis, 2026-09-27).
//
// Two cheap, deterministic inputs for the weekly prompt-KPI report:
//   §5.1  per-task section sizes of the assembled prompt (tokens), so the constant
//         heavy layer (AGENT NOTES / REQUIREMENTS LOG / persona / skills) can be tracked
//         and A/B'd against adherence and cost — not just guessed from usage.json.
//   §5.2  adherence flags computed on the FINAL answer text with pure string checks
//         (no LLM): quick_verbosity, has_html, long_reply_not_published,
//         clarify_question, forbidden_mentions.
//
// All flags are heuristics — they approximate the prose rules of the system prompt,
// never replace human review. They exist to catch systematic drift cheaply at scale.
//
// Output: one JSONL line per task appended to <workDir>/prompt-audit.jsonl.

const fs = require('fs');
const path = require('path');
const { atomicText } = require('./atomic-json');

const AUDIT_FILE = 'prompt-audit.jsonl';
const MAX_LOG_LINES = 2000;

// Rough tokens ≈ chars / 4 (mixed RU/EN text). Good enough for tracking the weight
// of prompt sections; exact tokenizers differ per model and don't change the ratios.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// sections: { name: text } → { name: tokens, total }
function computeSectionTokens(sections) {
  const out = { total: 0 };
  for (const [name, text] of Object.entries(sections || {})) {
    const t = estimateTokens(text);
    out[name] = t;
    out.total += t;
  }
  return out;
}

// Deterministic adherence flags on the final answer text.
// mode: effective mode of the turn ('deep' or anything else). Returns 0/1 flags.
function adherenceFlags(result, { mode = null } = {}) {
  const text = result || '';
  const chars = text.length;
  const sentenceCount = (text.match(/[.!?…]+/g) || []).length;
  const isDeep = mode === 'deep';
  return {
    // quick mode answer longer than ~800 chars / more than ~3 sentences (rule: ≤2-3).
    quick_verbosity: isDeep ? 0 : (chars > 800 || sentenceCount > 3) ? 1 : 0,
    // "Plain text only, no HTML" — any <tag> in the Telegram reply.
    has_html: /<[a-zA-Z][^>]*>/i.test(text) ? 1 : 0,
    // >800 chars and no URL → the long content likely wasn't published via
    // publish_page (heuristic: a published reply carries the link). The explicit
    // «напиши сюда» exception can't be detected here — flagged as candidate.
    long_reply_not_published: chars > 800 && !/https?:\/\//i.test(text) ? 1 : 0,
    // "Не задавай вопрос, если интент выводим" + "no A/B/C" — answer ends with
    // a question mark or offers an explicit option list.
    clarify_question: /\?\s*$/.test(text) || /(?:вариант|варианты|можешь выбрать|A\/B\/C|а\/б\/в)/i.test(text) ? 1 : 0,
    // Critical rules: never mention the operator email / "через Claude".
    forbidden_mentions: /через\s+Claude/i.test(text) || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) ? 1 : 0,
    // "The reader is not a developer" — internal refs leaked to the user: repo/home
    // paths with an extension (src/..., ~/...), PR/issue numbers, bare commit hashes.
    // Heuristic: published-URL slugs without a file extension don't match.
    internal_refs: /(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.[a-z0-9]{1,5}\b|~\/[\w./-]+|\b(?:PR|issue|MR)\s*#?\d+\b|\b[0-9a-f]{7}\b/i.test(text) ? 1 : 0,
  };
}

function auditPath(workDir) {
  return path.join(workDir, AUDIT_FILE);
}

function loadAudit(workDir) {
  try {
    const p = auditPath(workDir);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch { return []; }
}

// Append one JSONL line per task. Ring-buffer capped so the file can't grow unbounded.
function recordPromptAudit(workDir, entry) {
  try {
    if (!workDir || !entry) return;
    const lines = loadAudit(workDir);
    lines.push(JSON.stringify(entry));
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    atomicText(auditPath(workDir), lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  } catch (e) {
    console.error('[prompt-audit] recordPromptAudit error:', e.message);
  }
}

module.exports = {
  AUDIT_FILE,
  estimateTokens,
  computeSectionTokens,
  adherenceFlags,
  recordPromptAudit,
};