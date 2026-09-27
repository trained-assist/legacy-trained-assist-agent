'use strict';

// Small in-process "service" LLM calls — answer buttons, paragraph formatting, classifiers,
// summaries, routing (owner 2026-09-27: «такую же лестницу туда — контекст маленький, косты
// низкие, важна надёжность»). Walks the SAME `deepseek` ladder the OpenCode tasks use
// (config/model-routing.json: Go rungs → paid OpenRouter last), non-streaming:
//
//   * per-model health (src/model-health.js) — a flaky/limited rung is skipped for everyone;
//   * Go key pool (src/opencode-go-keys.js) — a key-level fault rotates to the spare key and the
//     rung is retried once; with every key parked, all Go rungs are skipped until one heals;
//   * guard — empty content, or non-JSON when json:true, fails the rung and moves on.
//
// Research / presentation / vision calls deliberately stay on their own Gemini path (owner:
// «gemini для рисеча и для презентаций он прямо гуд») — this is only for mechanical calls.

const crypto = require('crypto');
const modelHealth = require('./model-health');
const goKeys = require('./opencode-go-keys');
const opencodeLadder = require('./opencode-ladder');

const LADDER = 'deepseek';
const ROLE = 'build';
const GO_URL = (process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1') + '/chat/completions';
const OR_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1') + '/chat/completions';
// Go models reason before answering and max_tokens covers the reasoning too — a caller's tight
// budget (e.g. 50 tokens for a yes/no) would otherwise come back empty.
const MIN_TOKENS = 1500;

function _ladder() {
  const l = modelHealth.ladder(LADDER);
  return (l && l[ROLE]) || [];
}

function _goKey() {
  const pool = goKeys.readPool();
  if (!pool.length) return null;
  return pool[Math.max(0, goKeys.currentIndex())] || null;
}

function _orKey(apiKey) {
  return apiKey || process.env.OPENROUTER_API_KEY || null;
}

// True when at least one provider of the ladder has a key — callers use it where they used to
// check for OPENROUTER_API_KEY.
function available(apiKey) {
  return !!(_goKey() || _orKey(apiKey));
}

function _request(model, { messages, maxTokens, temperature, json }, apiKey) {
  const isGo = model.startsWith('opencode-go/');
  const key = isGo ? _goKey() : _orKey(apiKey);
  if (!key) return null;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (isGo) headers['x-opencode-session'] = `svc-${crypto.randomUUID()}`; // Go 400s without it
  const body = {
    model: model.replace(/^opencode-go\/|^openrouter\//, ''),
    messages, temperature, stream: false,
    max_tokens: Math.max(maxTokens || 0, MIN_TOKENS),
  };
  if (json) body.response_format = { type: 'json_object' };
  return { url: isGo ? GO_URL : OR_URL, headers, body };
}

function _stripFences(s) {
  return String(s || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// Fenced or prose-wrapped JSON is common from small models: strip fences, else take the first
// {...} block. undefined = not JSON.
function _parseJson(content) {
  const raw = _stripFences(content);
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* not JSON */ } }
  return undefined;
}

async function _attempt(model, opts, apiKey) {
  const req = _request(model, opts, apiKey);
  if (!req) return { ok: false, skip: true, error: 'no key' };
  let res;
  try {
    res = await (opts.fetchImpl || fetch)(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e.message}` };
  }
  if (!res.ok) {
    const errText = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    return { ok: false, error: `HTTP ${res.status}: ${String(errText).slice(0, 300)}` };
  }
  // json() first (real Response and minimal test stand-ins both have it), text() as a fallback.
  let data = null;
  if (typeof res.json === 'function') data = await res.json().catch(() => null);
  else if (typeof res.text === 'function') data = await res.text().then(t => JSON.parse(t)).catch(() => null);
  const content0 = data?.choices?.[0]?.message?.content || '';
  const usage = data?.usage || null;
  let content = content0;
  content = String(content).trim();
  if (!content) return { ok: false, error: 'empty answer' };
  if (opts.json) {
    const value = _parseJson(content);
    return value === undefined ? { ok: false, error: 'invalid JSON' } : { ok: true, content, value, usage };
  }
  return { ok: true, content, usage };
}

function _recordFailure(model, errorText, source) {
  const verdict = opencodeLadder.classifyError(errorText);
  if (verdict && verdict.class === 'quota') {
    modelHealth.recordFailure(model, { class: 'quota', retryAfterMs: verdict.ttlMs, errorText, source });
  } else if (verdict && verdict.class === 'config') {
    modelHealth.recordFailure(model, { class: 'config', errorText, source });
  } else {
    modelHealth.recordFailure(model, { class: 'transient', errorText, source });
  }
}

/**
 * @param {object} o
 * @param {Array}  o.messages       OpenAI-style messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature=0]
 * @param {boolean}[o.json=false]   request JSON and parse it (→ result.value)
 * @param {number} [o.timeoutMs=20000] per rung
 * @param {number} [o.totalTimeoutMs]  overall budget across rungs (latency-sensitive callers)
 * @param {string} [o.apiKey]       OpenRouter key override (per-user key)
 * @param {string} [o.source]       caller tag for logs / model-health
 * @param {Function}[o.fetchImpl]   injectable fetch (tests)
 * @returns {Promise<{content:string, value?:any, usage?:object, model:string}|null>} null = every rung failed
 */
async function serviceChat({ messages, maxTokens = 800, temperature = 0, json = false, timeoutMs = 20000, totalTimeoutMs = null, apiKey = null, source = 'service-llm', fetchImpl = null } = {}) {
  const opts = { messages, maxTokens, temperature, json, timeoutMs, fetchImpl };
  const deadline = totalTimeoutMs ? Date.now() + totalTimeoutMs : Infinity;
  // Only rungs whose provider has a key; if health skips every one of those, try them all anyway —
  // a stale skip must not black-hole the call.
  const ladder = _ladder().filter(m => (m.startsWith('opencode-go/') ? !!_goKey() : !!_orKey(apiKey)));
  const live = ladder.filter(m => !modelHealth.isSkipped(m));
  const rungs = live.length ? live : ladder;
  const errors = [];
  for (const model of rungs) {
    if (model.startsWith('opencode-go/') && modelHealth.isSkipped(model) && live.length) continue;
    const left = deadline - Date.now();
    if (left < 500) { errors.push('total time budget spent'); break; }
    opts.timeoutMs = Math.min(timeoutMs, left);
    let r = await _attempt(model, opts, apiKey);
    if (r.skip) continue;
    // Key-level fault on Go: rotate to the spare key and retry the same rung; once every key is
    // parked, park all Go rungs so the ladder goes straight to its non-Go rung.
    let parkedGo = false;
    for (let k = 0; !r.ok && model.startsWith('opencode-go/') && k < goKeys.readPool().length; k++) {
      const keyFault = goKeys.noteFailure(model, r.error);
      if (!keyFault) break;
      if (!keyFault.rotated) {
        opencodeLadder.parkProvider(LADDER, 'opencode-go/', keyFault.retryAt, r.error);
        parkedGo = true;
        break;
      }
      r = await _attempt(model, opts, apiKey);
    }
    if (parkedGo) { errors.push(`${model}: ${r.error}`); continue; }
    if (r.ok) {
      modelHealth.recordSuccess(model);
      if (errors.length) console.warn(`[${source}] answered by ${model} after: ${errors.join(' | ').slice(0, 400)}`);
      return { content: r.content, value: r.value, usage: r.usage, model };
    }
    errors.push(`${model}: ${r.error}`);
    _recordFailure(model, r.error, source);
  }
  console.warn(`[${source}] all rungs failed: ${errors.join(' | ').slice(0, 600)}`);
  return null;
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

module.exports = { serviceChat, serviceJson, serviceText, available, LADDER };
