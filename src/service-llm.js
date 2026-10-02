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
// What the client keeps ON TOP of the worker's budget: enough to read the worker's answer (and its
// x-ladder-attempts header) after the worker has already given up walking rungs. The worker must
// stop first, otherwise we abort a request that is still being served.
const CLIENT_ABORT_HEADROOM_MS = 3000;

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
  return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// The worker already tells us, on EVERY response, which rungs it walked and what each one said
// (`x-ladder-attempts: model=outcome, model=outcome, …`). Until now we threw it away, so a dead
// call reached the operator as `fetch_error` with no rung named anywhere — the failure that started
// this. Read it on the failure paths and it rides along into journalctl AND the degradation alert.
// Defensive on purpose: injected fetchImpls (and a real `fetch` before the body arrives) may have
// no headers at all.
function attemptsHeader(res) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-ladder-attempts') : null;
    return v ? String(v).slice(0, 600) : null;
  } catch { return null; }
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

// D1 attribution (#1917): the worker reads x-ladder-* off the request and stores them in
// ladder_calls (trace_id / run_id / user_id / chat_id / session_id — query-trace.py presets),
// and x-ladder-app becomes the OpenRouter "Application" slice (for a service call that is the
// tool's own name: gtd-intent, hh-messages, session-summary, …).
//
// x-ladder-app is sent ALWAYS (owner 01.10.2026: 540 из 571 запросов в аналитике были
// «Unknown» — считать трафик по инструментам было нечем). Trace ids still require `ctx` —
// they only exist for a real run; a partial ctx never fabricates a row key, and an absent ctx
// simply omits them instead of sending "".
function traceHeadersFor(ctx, source) {
  const headers = {};
  const put = (name, value) => {
    if (value === undefined || value === null || String(value) === '') return;
    headers[name] = String(value);
  };
  if (ctx && typeof ctx === 'object') {
    put('x-ladder-trace', ctx.trace);
    put('x-ladder-run', ctx.run);
    put('x-ladder-user', ctx.user);
    put('x-ladder-chat', ctx.chat);
    put('x-ladder-session', ctx.session);
  }
  put('x-ladder-app', (ctx && ctx.app) || source);
  return Object.keys(headers).length ? headers : null;
}

/**
 * @param {object} o
 * @param {Array}  o.messages       OpenAI-style messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature=0]
 * @param {boolean}[o.json=false]   request JSON and parse it (→ result.value)
 * @param {number} [o.timeoutMs=20000] per rung (worker-side)
 * @param {number} [o.totalTimeoutMs]  whole-ladder budget; defaults to timeoutMs * 4. ALWAYS sent
 *                                  to the worker, so it stops walking before we abort (see below)
 * @param {string} [o.source]       caller tag for logs
 * @param {object}[o.ctx]           optional trace ids for the worker's D1 log (#1917):
 *                                  {trace, run, user, session, app} → x-ladder-* headers
 *                                  (x-ladder-app = app || source). No ctx → no headers,
 *                                  exactly as before #1917.
 * @param {Function}[o.fetchImpl]   injectable fetch (tests)
 * @param {Function}[o.onDiagnose]  called with {reason, source, ...} on EVERY outcome —
 *                                  'ok' | 'no_token' | 'fetch_error' | 'http_error' |
 *                                  'empty_content' | 'json_parse_error'. Lets a caller
 *                                  log why it is about to fall back.
 * @returns {Promise<{content:string, value?:any, usage?:object, model:string}|null>} null = no answer
 */
async function serviceChat({ messages, maxTokens = 800, temperature = 0, json = false, timeoutMs = 20000, totalTimeoutMs = null, source = 'service-llm', fetchImpl = null, onDiagnose = null, ctx = null } = {}) {
  const diag = (reason, info = {}) => {
    // #1912: every rung outcome feeds the degradation streak — N consecutive
    // failures alert the operator instead of hiding in journalctl (audit: 397
    // «every rung failed» lines over 2 days, noticed days later).
    try { require('./degrade-alert').ladderOutcome({ ok: reason === 'ok', reason, source, detail: info.message || info.error || info.attempts || null }); }
    catch { /* alerting must never break the call */ }
    if (typeof onDiagnose !== 'function') return;
    try { onDiagnose({ reason, source, ...info }); } catch { /* diagnostics must never break the call */ }
  };
  const token = _ladderToken();
  if (!token) {
    diag('no_token', { message: 'LLM_LADDER_TOKEN env / $AGENT_TOKENS_DIR/llm-ladder/token not found' });
    console.warn(`[${source}] llm-ladder: no token (LLM_LADDER_TOKEN or $AGENT_TOKENS_DIR/llm-ladder/token) → null`);
    return null;
  }
  // The worker owns the ladder, so it must ALWAYS know the deadline. Without one it keeps walking
  // rungs — up to ~90s for the 15-rung `service` ladder — while we hang up on it, and the call is
  // then booked as `fetch_error`, i.e. a CLIENT timeout, even though the worker answered it: over
  // 7 days 278 of 2509 service calls (11%) were thrown away that way, 200 of them under 40s
  // (2026-10-02, OpenCode Go incident). One budget, two consumers: the worker stops walking first
  // and returns a real `every rung failed` error, we keep a headroom to read that answer.
  const workerBudgetMs = totalTimeoutMs || timeoutMs * 4;
  const body = {
    model: LADDER, messages, temperature, max_tokens: maxTokens,
    ladder_timeout_ms: timeoutMs,
    ladder_total_timeout_ms: workerBudgetMs,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  let res;
  try {
    res = await (fetchImpl || fetch)(`${LADDER_URL()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(traceHeadersFor(ctx, source) || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(workerBudgetMs + CLIENT_ABORT_HEADROOM_MS),
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
    // Prefer the worker's own rung trace (compact, already normalised); fall back to the body's
    // raw attempts array for older workers that only sent the error payload.
    const attempts = attemptsHeader(res) || (data?.error?.attempts ? JSON.stringify(data.error.attempts).slice(0, 400) : null);
    diag('http_error', { status: res.status, message: data?.error?.message || '', attempts });
    console.warn(`[${source}] llm-ladder HTTP ${res.status}: ${data?.error?.message || ''}${attempts ? ` | rungs: ${attempts}` : ''}`);
    return null;
  }
  if (bodyError) {
    const attempts = attemptsHeader(res);
    diag('fetch_error', { status: res.status, error: `body read failed: ${bodyError}`, attempts });
    console.warn(`[${source}] llm-ladder body read failed (HTTP ${res.status}): ${bodyError}${attempts ? ` | rungs: ${attempts}` : ''}`);
    return null;
  }
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  const model = data?.model || null;
  const finishReason = data?.choices?.[0]?.finish_reason || null;
  if (!content) {
    const attempts = attemptsHeader(res);
    diag('empty_content', { model, finishReason, attempts });
    console.warn(`[${source}] llm-ladder empty content (rung=${model || '?'} finish=${finishReason || '?'})${attempts ? ` | rungs: ${attempts}` : ''} → null`);
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
