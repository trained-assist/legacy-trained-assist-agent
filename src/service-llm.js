'use strict';

// Small "service" LLM calls — answer buttons, paragraph formatting, classifiers, summaries,
// routing (owner 2026-09-27: «такую же лестницу туда — контекст маленький, косты низкие, важна
// надёжность»). A thin client of the trained-assist-llm-ladder Cloudflare Worker
// (https://llm-ladder.trainedassist.store, repo trained-assist/trained-assist-llm-ladder), which
// owns the ladder (OpenCode Go rungs → paid OpenRouter last), model health, Go key rotation and
// the JSON guard. The in-process copy of the ladder was removed (owner: «перенесёшь вызовы на
// него и из прода выпилишь») — one implementation, in the worker.
//
// Token: LLM_LADDER_TOKEN, else $AGENT_TOKENS_DIR/llm-ladder/token (GCP SM: LLM_LADDER_TOKEN).
// Every caller is fail-soft: null here = "no LLM answer", callers keep their legacy path.
//
// Visibility: every null return is logged (why: no token / unreachable / HTTP status /
// empty content / JSON parse error) and reported to the optional onDiagnose callback —
// a silent null used to hide a whole class of failures behind "the caller's fallback"
// (mainstream-tester fed the agent 12 identical fallback steps before this, 2026-09-28).
//
// Research / presentation / vision calls deliberately stay on their own Gemini path (owner:
// «gemini для рисеча и для презентаций он прямо гуд») — this is only for mechanical calls.

const LADDER = 'deepseek';
const LADDER_URL = () => (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');

function _ladderToken() {
  if (process.env.LLM_LADDER_TOKEN) return process.env.LLM_LADDER_TOKEN.trim();
  try {
    const { TOKENS_ROOT } = require('./data-paths');
    return require('fs').readFileSync(require('path').join(TOKENS_ROOT, 'llm-ladder', 'token'), 'utf8').trim() || null;
  } catch { return null; }
}

// True when the ladder worker is configured — callers use it where they used to check for an
// OpenRouter key. (An apiKey argument is accepted for call-site compatibility and ignored.)
function available() {
  return !!_ladderToken();
}

function _stripFences(s) {
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// Fenced or prose-wrapped JSON is common from small models.
// Returns {value} on success, {error, raw} when the content is not JSON — the caller
// logs/reports the error instead of silently turning it into a null answer.
function _parseJsonDetailed(content) {
  const raw = _stripFences(content);
  try { return { value: JSON.parse(raw) }; } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return { value: JSON.parse(m[0]) }; } catch (e) { return { error: e.message, raw }; } }
  return { error: 'no JSON object found in content', raw };
}

/**
 * @param {object} o
 * @param {Array}  o.messages       OpenAI-style messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature=0]
 * @param {boolean}[o.json=false]   request JSON and parse it (→ result.value)
 * @param {number} [o.timeoutMs=20000] per rung (worker-side)
 * @param {number} [o.totalTimeoutMs]  whole-ladder budget (latency-sensitive callers)
 * @param {string} [o.source]       caller tag for logs
 * @param {Function}[o.fetchImpl]   injectable fetch (tests)
 * @param {Function}[o.onDiagnose]  called with {reason, source, ...} on EVERY outcome —
 *                                  'ok' | 'no_token' | 'fetch_error' | 'http_error' |
 *                                  'empty_content' | 'json_parse_error'. Lets a caller
 *                                  log why it is about to fall back.
 * @returns {Promise<{content:string, value?:any, usage?:object, model:string}|null>} null = no answer
 */
async function serviceChat({ messages, maxTokens = 800, temperature = 0, json = false, timeoutMs = 20000, totalTimeoutMs = null, source = 'service-llm', fetchImpl = null, onDiagnose = null } = {}) {
  const diag = (reason, info = {}) => {
    if (typeof onDiagnose !== 'function') return;
    try { onDiagnose({ reason, source, ...info }); } catch { /* diagnostics must never break the call */ }
  };
  const token = _ladderToken();
  if (!token) {
    diag('no_token', { message: 'LLM_LADDER_TOKEN env / $AGENT_TOKENS_DIR/llm-ladder/token not found' });
    console.warn(`[${source}] llm-ladder: no token (LLM_LADDER_TOKEN or $AGENT_TOKENS_DIR/llm-ladder/token) → null`);
    return null;
  }
  const body = {
    model: LADDER, messages, temperature, max_tokens: maxTokens,
    ladder_timeout_ms: timeoutMs,
    ...(totalTimeoutMs ? { ladder_total_timeout_ms: totalTimeoutMs } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  let res;
  try {
    res = await (fetchImpl || fetch)(`${LADDER_URL()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((totalTimeoutMs || timeoutMs * 4) + 3000),
    });
  } catch (e) {
    diag('fetch_error', { error: e.message });
    console.warn(`[${source}] llm-ladder unreachable: ${e.message}`);
    return null;
  }
  if (!res) { diag('fetch_error', { error: 'fetchImpl returned nothing' }); return null; }
  let data = null;
  let bodyError = null;
  if (typeof res.json === 'function') {
    try { data = await res.json(); } catch (e) { bodyError = e.message; }
  }
  if (!res.ok) {
    const attempts = data?.error?.attempts ? JSON.stringify(data.error.attempts).slice(0, 400) : null;
    diag('http_error', { status: res.status, message: data?.error?.message || '', attempts });
    console.warn(`[${source}] llm-ladder HTTP ${res.status}: ${data?.error?.message || ''}${data?.error?.attempts ? ` ${JSON.stringify(data.error.attempts).slice(0, 400)}` : ''}`);
    return null;
  }
  if (bodyError) {
    diag('fetch_error', { status: res.status, error: `body read failed: ${bodyError}` });
    console.warn(`[${source}] llm-ladder body read failed (HTTP ${res.status}): ${bodyError}`);
    return null;
  }
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  const model = data?.model || null;
  const finishReason = data?.choices?.[0]?.finish_reason || null;
  if (!content) {
    diag('empty_content', { model, finishReason });
    console.warn(`[${source}] llm-ladder empty content (rung=${model || '?'} finish=${finishReason || '?'}) → null`);
    return null;
  }
  if (json) {
    const parsed = _parseJsonDetailed(content);
    if (!('value' in parsed)) {
      diag('json_parse_error', { model, error: parsed.error, raw: parsed.raw });
      console.warn(`[${source}] llm-ladder JSON parse failed (rung=${model || '?'}): ${parsed.error} | raw=${JSON.stringify(String(parsed.raw).slice(0, 300))} → null`);
      return null;
    }
    diag('ok', { model });
    return { content, value: parsed.value, usage: data?.usage || null, model };
  }
  diag('ok', { model });
  return { content, usage: data?.usage || null, model };
}

// Convenience: system + user prompt → parsed JSON (or null).
async function serviceJson({ system, user, ...rest }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const r = await serviceChat({ ...rest, messages, json: true });
  return r ? r.value : null;
}

// Convenience: system + user prompt → text (or null).
async function serviceText({ system, user, ...rest }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const r = await serviceChat({ ...rest, messages });
  return r ? r.content : null;
}

module.exports = { serviceChat, serviceJson, serviceText, available, LADDER, LADDER_URL, ladderToken: _ladderToken };
