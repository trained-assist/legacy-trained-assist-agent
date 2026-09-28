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
// Research / presentation / vision calls deliberately stay on their own Gemini path (owner:
// «gemini для рисеча и для презентаций он прямо гуд») — this is only for mechanical calls.

const LADDER = 'deepseek';
const LADDER_URL = () => (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');

function _ladderToken() {
  if (process.env.LLM_LADDER_TOKEN) return process.env.LLM_LADDER_TOKEN.trim();
  try {
    const { TOKENS_ROOT } = require('./data-paths');
    const { readCredentialFile } = require('./credential-store');
    return readCredentialFile(require('path').join(TOKENS_ROOT, 'llm-ladder', 'token')).trim() || null;
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

// Fenced or prose-wrapped JSON is common from small models. undefined = not JSON.
function _parseJson(content) {
  const raw = _stripFences(content);
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON */ } }
  return undefined;
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
 * @returns {Promise<{content:string, value?:any, usage?:object, model:string}|null>} null = no answer
 */
async function serviceChat({ messages, maxTokens = 800, temperature = 0, json = false, timeoutMs = 20000, totalTimeoutMs = null, source = 'service-llm', fetchImpl = null } = {}) {
  const token = _ladderToken();
  if (!token) return null;
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
    console.warn(`[${source}] llm-ladder unreachable: ${e.message}`);
    return null;
  }
  if (!res) return null;
  const data = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const attempts = data?.error?.attempts ? ` ${JSON.stringify(data.error.attempts).slice(0, 400)}` : '';
    console.warn(`[${source}] llm-ladder HTTP ${res.status}: ${data?.error?.message || ''}${attempts}`);
    return null;
  }
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) return null;
  if (json) {
    const value = _parseJson(content);
    if (value === undefined) return null;
    return { content, value, usage: data?.usage || null, model: data?.model || null };
  }
  return { content, usage: data?.usage || null, model: data?.model || null };
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
