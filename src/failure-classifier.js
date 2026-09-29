'use strict';
// Stage A (deterministic) + Stage B (cheap-LLM fallback) failure classifier — issue #1175.
//
// Unifies the two taxonomies that already existed split across engines:
//   auth-flag.js       — 2 classes (AUTH_INVALID, QUOTA_EXCEEDED), all engines
//   opencode-ladder.js — 3 classes (config, quota, context), OpenCode only (removed in #1687)
// into the fixed FAILURE_CLASSES enum from failure-taxonomy.js, covering Claude/Codex/OpenCode
// alike. Does NOT replace either module — both keep their own state files (auth flag, ladder
// exhaustion) and callers; this gives a single "what happened" answer callers can share instead
// of inventing a fourth ad hoc regex table for the next engine.
//
// Classifier answers "what happened", never "what to do about it" — that split is deliberate
// (see recovery-policy.js) so an LLM never invents a recovery action, only ever picks a class
// from a fixed enum, validated before use.

const { FAILURE_CLASSES } = require('./failure-taxonomy');

// Stage A rule table. Order matters: first match wins, so more specific classes (CONFIG, AUTH)
// are listed before broader ones. Patterns are the union of auth-flag.js's AUTH_ERROR_PATTERNS
// and opencode-ladder.js's CLASSIFIERS, remapped onto the unified enum plus a few classes
// neither module covered (RATE_LIMIT split out from QUOTA, TRANSIENT, MODEL_ERROR, TOOL_ERROR).
const RULES = [
  // CONFIG — one-time account/setup problem an operator must fix; never resolves itself.
  { class: 'CONFIG', pattern: /subscription required/i },
  { class: 'CONFIG', pattern: /requires global regions/i },
  { class: 'CONFIG', pattern: /insufficient account funds/i },
  // The llm-ladder worker already tried every rung (all Go keys, paid OpenRouter tail) and all
  // refused — in practice Go weekly limit + OpenRouter credits at zero (2026-09-29). Retrying the
  // same engine cannot help until an operator tops up / the quota resets, so it is CONFIG: the
  // durable executor then skips OpenCode for this step and runs the level's fallback engine.
  { class: 'CONFIG', pattern: /every rung failed|ladder_exhausted|все ступени отказали/i },

  // AUTH — credentials/session invalid.
  { class: 'AUTH', pattern: /not logged in/i },
  { class: 'AUTH', pattern: /please run \/login/i },
  { class: 'AUTH', pattern: /invalid[_\s-]{0,5}api[_\s-]{0,5}key/i },
  { class: 'AUTH', pattern: /authentication[^.]{0,30}failed/i },

  // RATE_LIMIT — short-lived, provider is throttling this request rate specifically.
  { class: 'RATE_LIMIT', pattern: /rate[_\s-]{0,5}limit/i },
  { class: 'RATE_LIMIT', pattern: /\b429\b/ },

  // QUOTA — account/plan quota exhausted, longer-lived than a rate limit.
  { class: 'QUOTA', pattern: /quota[^.]{0,20}exceeded/i },
  { class: 'QUOTA', pattern: /usage limit/i },
  { class: 'QUOTA', pattern: /unavailable for free/i },
  { class: 'QUOTA', pattern: /model not found/i },
  { class: 'QUOTA', pattern: /no endpoints found/i },

  // CONTEXT — request didn't fit the model's context window.
  { class: 'CONTEXT', pattern: /context[_\s-]?length/i },
  { class: 'CONTEXT', pattern: /maximum context/i },
  { class: 'CONTEXT', pattern: /context window/i },
  { class: 'CONTEXT', pattern: /prompt is too long/i },
  { class: 'CONTEXT', pattern: /input (?:is )?too long/i },
  { class: 'CONTEXT', pattern: /too many tokens/i },

  // MODEL_ERROR — the model/provider itself errored on this request (not our tool call).
  { class: 'MODEL_ERROR', pattern: /internal server error/i },
  { class: 'MODEL_ERROR', pattern: /\b500\b/ },
  { class: 'MODEL_ERROR', pattern: /model[_\s-]?(error|failure)/i },

  // TRANSIENT — provider-side hiccup, likely to clear on its own within minutes.
  { class: 'TRANSIENT', pattern: /temporarily overloaded/i },
  { class: 'TRANSIENT', pattern: /\b503\b/ },
  { class: 'TRANSIENT', pattern: /\b502\b/ },
  { class: 'TRANSIENT', pattern: /econnreset|econnrefused|etimedout|socket hang up/i },
  // opencode keeps ALL runs of the VM in one SQLite file (~/.local/share/opencode/opencode.db).
  // Two concurrent runs (different chats/users) → "Unexpected error / database is locked"
  // for one of them. Reproduced on the sandbox smoke (#1311 C5): 1 of 4 parallel runs failed,
  // the same run alone succeeded. Local contention → retry, not a model/config failure.
  { class: 'TRANSIENT', pattern: /database is locked|SQLITE_BUSY/i },

  // TOOL_ERROR — the agent's own tool call failed, not the model/provider.
  { class: 'TOOL_ERROR', pattern: /tool[_\s-]?(call|use)[^.]{0,20}(failed|error)/i },
];

// Failure classes CONFIG/USER_STOP are not worth retrying the SAME target — recovery-policy.js
// still routes them to an alternate target or terminal, but the classifier itself should not
// claim they're blindly retryable.
const NOT_RETRYABLE_SAME_TARGET = new Set(['CONFIG', 'USER_STOP']);

// Explicit user-initiated stop always wins over any text match — must never be auto-retried.
function classifySignal({ userStop } = {}) {
  if (userStop) return { class: 'USER_STOP', retryable: false, source: 'rule', confidence: 1 };
  return null;
}

// Stage A: deterministic. Returns null if nothing matched (caller falls through to Stage B).
function classifyDeterministic(text, opts = {}) {
  const bySignal = classifySignal(opts);
  if (bySignal) return bySignal;
  const hit = RULES.find(r => r.pattern.test(text || ''));
  if (!hit) return null;
  return {
    class: hit.class,
    retryable: !NOT_RETRYABLE_SAME_TARGET.has(hit.class),
    source: 'rule',
    confidence: 1,
  };
}

// USER_STOP is signal-only (see classifySignal above) — text classification never produces it,
// so it's deliberately excluded from what Stage B's LLM is allowed to pick.
const LLM_VALID_CLASSES = new Set(FAILURE_CLASSES.filter(c => c !== 'USER_STOP'));

// Stage B: cheap-LLM fallback for text Stage A didn't recognize — on the service-LLM ladder
// (src/service-llm.js), safe fallback on any error/timeout. Only fires when Stage A found nothing: most failures are
// still resolved by the free, instant regex table above, matching the spec's "if rule uverenno
// opredelyaet class — LLM ne vyzyvaetsya".
async function classifyWithLLM(text, { apiKey, timeoutMs = 8000 } = {}) {
  const t = String(text || '').trim();
  const serviceLlm = require('./service-llm');
  if (!t || !serviceLlm.available(apiKey)) return { class: 'UNKNOWN', retryable: true, source: 'llm', confidence: 0 };
  try {
    // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
    const obj = await serviceLlm.serviceJson({
      system: 'Classify execution failure text into a fixed enum. Reply only with compact JSON.',
      user: `Error text from an AI coding agent execution:\n${t.slice(-2000)}\n\nJSON: {"class":"AUTH|QUOTA|RATE_LIMIT|CONTEXT|TRANSIENT|MODEL_ERROR|TOOL_ERROR|CONFIG|UNKNOWN","retryable":bool,"confidence":0..1}`,
      maxTokens: 40, timeoutMs, apiKey, source: 'failure-classifier',
    });
    if (!LLM_VALID_CLASSES.has(obj?.class)) {
      return { class: 'UNKNOWN', retryable: true, source: 'llm', confidence: 0 };
    }
    return {
      class: obj.class,
      retryable: typeof obj.retryable === 'boolean' ? obj.retryable : true,
      source: 'llm',
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.5,
    };
  } catch (e) {
    console.warn('[failure-classifier]', e.message);
    return { class: 'UNKNOWN', retryable: true, source: 'llm', confidence: 0 };
  }
}

// Full pipeline: Stage A first, Stage B only if Stage A found nothing.
async function classify(text, opts = {}) {
  return classifyDeterministic(text, opts) || classifyWithLLM(text, opts);
}

module.exports = { classifyDeterministic, classifyWithLLM, classify, RULES };
