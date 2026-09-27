'use strict';

// Free-ladder LLM gateway (issue #1526, scope B — owner decision 2026-09-26).
//
// OpenAI-compatible endpoint for opencode:
//   POST /v1/chat/completions   — sequential quality-ladder failover (GO first,
//                                 OpenRouter free as fallback), short timeouts,
//                                 answer guard, SSE relay for streaming clients.
//   GET  /v1/models             — the single public model id ("free-ladder").
//   GET  /v1/ladder-stats       — call/limit log summary (?hours=24): which rung answered,
//                                 paid share, limit hits (src/ladder-log.js).
//
// Auth: ONE external bearer token (LLM_GATEWAY_TOKEN env, else
// $AGENT_TOKENS_DIR/llm-gateway/token). No token configured ⇒ 503 — we never
// expose an open proxy.
//
// Design decisions (issue #1526):
//   * Scope B: tools/tool_calls pass through untouched; weak models breaking on
//     tools is acceptable — no hybrid paid-tools model, no response merging.
//   * Sequential ladder by quality (config/llm-gateway.json), never parallel
//     (free tier: a fan-out creates its own 429s; take-first-valid would poison
//     quality with the fastest junk model).
//   * Timeout ladder: 15s to first token, 30s between tokens, 180s total —
//     instead of a flat 60s, dead rungs fail fast.
//   * Guard (non-stream only): empty answer / refusal prose / invalid JSON when
//     response_format was requested ⇒ next rung. Stream commits on the first
//     content token — no failover after that (spec).
//   * Health: shared per-model store src/model-health.js — same keys the runner
//     uses (opencode-go/<m>, openrouter/<m>) — one client, one health.
//   * 429: one same-rung retry with short backoff (Retry-After ≤3s honored),
//     then degrade to the next rung. rf-400 (response_format/stream_options
//     rejected): one same-rung retry with those fields stripped.
//   * Health-sweep: every 60s, rungs with no traffic ≥30min get a tiny ping;
//     404/401 ⇒ skipped until the next sweep window. Catalog sync every 12h:
//     rungs gone from /models are skipped (7d), new :free ids land in a
//     candidates file (never auto-promoted — needs a bench).
//
// Client wiring (opencode): provider baseURL = AGENT_PUBLIC_URL + "/agent/v1",
// model id = "free-ladder", api key = the gateway token.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const modelHealth = require('./model-health');
const ladderLog = require('./ladder-log');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config', 'llm-gateway.json');

function configFile() {
  return process.env.LLM_GATEWAY_CONFIG || DEFAULT_CONFIG_FILE;
}

function stateFile() {
  return process.env.LLM_GATEWAY_STATE_FILE ||
    path.join(os.homedir(), '.config', 'opencode', 'llm-gateway-state.json');
}

function tokenFile() {
  const root = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  return path.join(root, 'llm-gateway', 'token');
}

// ── Config (lazy, mtime-cached — an edited config is picked up without restart) ─
let _cfgCache = { path: null, mtimeMs: -1, value: null };
function loadConfig() {
  const p = configFile();
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { return null; }
  if (_cfgCache.path === p && _cfgCache.mtimeMs === mtimeMs) return _cfgCache.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.warn('[llm-gateway] config load failed:', e.message);
  }
  _cfgCache = { path: p, mtimeMs, value };
  return value;
}

function getToken() {
  if (process.env.LLM_GATEWAY_TOKEN) return process.env.LLM_GATEWAY_TOKEN.trim();
  try {
    const t = fs.readFileSync(tokenFile(), 'utf8').trim();
    return t || null;
  } catch { return null; }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authOk(req) {
  const token = getToken();
  if (!token) return false;
  const hdr = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (!m) return false;
  return timingSafeEqual(m[1].trim(), token);
}

// Shared with the runner's ladders — one physical model, one health record.
function healthKey(rung) {
  return rung.provider === 'go' ? `opencode-go/${rung.model}` : `openrouter/${rung.model}`;
}

// ── Per-rung runtime state (in-memory: traffic/sweep bookkeeping) ──────────────
const rungTraffic = new Map(); // healthKey -> lastActivityAt
const rungLastPing = new Map(); // healthKey -> lastSweepPingAt

function noteTraffic(rung) { rungTraffic.set(healthKey(rung), Date.now()); }

function recordRungFailure(rung, errorText) {
  const verdict = require('./opencode-ladder').classifyError(errorText);
  const key = healthKey(rung);
  if (!verdict) {
    modelHealth.recordFailure(key, { class: 'transient', errorText });
    return { class: 'transient' };
  }
  modelHealth.recordFailure(key, {
    source: 'gateway',
    class: verdict.class,
    retryAfterMs: verdict.ttlMs === null ? undefined : verdict.ttlMs,
    errorText,
  });
  return verdict;
}

function recordRungSuccess(rung) {
  modelHealth.recordSuccess(healthKey(rung));
}

// ── Guard: is this a "normal answer"? (non-stream, after full aggregation) ─────
const REFUSAL_RE = /^(?:i'?m sorry|i am sorry|i cannot|i can't|i won't|sorry[,!. ])|^(?:извините|к сожалению|я не могу|не могу помочь|увы[, ])/i;

function looksLikeRefusal(content) {
  const t = (content || '').trim();
  if (!t || t.length > 400) return false;
  return REFUSAL_RE.test(t);
}

// Tolerant JSON: raw → fences → first balanced {...} / [...] slice.
function tryParseJson(text) {
  if (!text) return false;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { JSON.parse(t); return true; } catch { /* continue */ }
  for (const open of ['{', '[']) {
    const start = t.indexOf(open);
    if (start < 0) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === open) depth++;
      else if (t[i] === close) {
        depth--;
        if (depth === 0) {
          try { JSON.parse(t.slice(start, i + 1)); return true; } catch { break; }
        }
      }
    }
  }
  return false;
}

// Returns null (ok) or a reason string (fail rung).
function guardAnswer(body, message) {
  if (message.tool_calls && message.tool_calls.length) return null; // tools pass-through
  const content = message.content;
  if (!content || !String(content).trim()) return 'empty';
  if (looksLikeRefusal(content)) return 'refusal';
  const rf = body.response_format;
  if (rf && (rf.type === 'json_object' || rf.type === 'json_schema') && !tryParseJson(content)) {
    return 'bad-json';
  }
  return null;
}

// ── Upstream auth ──────────────────────────────────────────────────────────────
function goKey() {
  try {
    const keys = require('./opencode-go-keys');
    const pool = keys.readPool();
    if (!pool.length) return null;
    const idx = keys.currentIndex();
    return pool[idx >= 0 ? idx : 0];
  } catch { return null; }
}

function orKey() {
  return process.env.OPENROUTER_API_KEY || null;
}

function upstreamAuth(rung) {
  if (rung.provider === 'go') {
    const k = goKey();
    if (!k) return null;
    return { url: `${rung.cfg.go.baseURL}/chat/completions`, headers: {
      Authorization: `Bearer ${k}`,
      // The Go gateway 400s (MissingSessionID) without a session header.
      'x-opencode-session': `gw-${crypto.randomUUID()}`,
    } };
  }
  const k = orKey();
  if (!k) return null;
  return { url: `${rung.cfg.openrouter.baseURL}/chat/completions`, headers: {
    Authorization: `Bearer ${k}`,
  } };
}

// ── SSE parsing helpers ────────────────────────────────────────────────────────
function applyDelta(agg, data) {
  const choice = data.choices && data.choices[0];
  if (choice) {
    const delta = choice.delta || {};
    if (delta.content) agg.content += delta.content;
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index != null ? tc.index : agg.tool_calls.length - 1;
        if (!agg.tool_calls[i]) {
          agg.tool_calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        const dst = agg.tool_calls[i];
        if (tc.id) dst.id = tc.id;
        if (tc.type) dst.type = tc.type;
        if (tc.function) {
          if (tc.function.name) dst.function.name += tc.function.name;
          if (tc.function.arguments) dst.function.arguments += tc.function.arguments;
        }
      }
    }
    if (choice.finish_reason) agg.finish_reason = choice.finish_reason;
  }
  if (data.usage) agg.usage = data.usage;
}

function isEmptyDelta(data) {
  const c = data.choices && data.choices[0];
  if (!c) return false;
  const d = c.delta || {};
  const hasContent = d.content && String(d.content).length > 0;
  const hasTools = d.tool_calls && d.tool_calls.length > 0;
  const hasFinish = !!c.finish_reason;
  return !hasContent && !hasTools && !hasFinish;
}

function readWithTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`gateway-timeout after ${ms}ms`)), ms);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

// ── Single rung attempt ────────────────────────────────────────────────────────
// Returns:
//   { ok:false, error, status? }                     — rung failed, try next
//   { ok:true, relayed:true }                        — stream committed & piped to client
//   { ok:true, message, finish_reason, usage }       — aggregated complete (guard NOT yet applied)
async function attemptRung(rung, body, opts) {
  const cfg = rung.cfg;
  const auth = upstreamAuth(rung);
  if (!auth) return { ok: false, error: `no key for provider ${rung.provider}` };

  const wantStream = !!body.stream;
  let ac = new AbortController();
  if (opts.req) opts.req.on('close', () => { if (ac && !ac.signal.aborted) ac.abort(); });

  // TTFB covers the WHOLE path to the first token: connect + headers + first
  // SSE byte. A provider that never even flushes headers (writeHead without a
  // write) would otherwise hang fetch() indefinitely — this was a real bug the
  // silent-rung test caught.
  let timedOut = false;
  let ttfbTimer = null;
  const armTtfb = () => {
    timedOut = false;
    clearTimeout(ttfbTimer);
    ttfbTimer = setTimeout(() => { timedOut = true; if (ac) ac.abort(); }, cfg.ttfbTimeoutMs);
  };
  const disarmTtfb = () => { clearTimeout(ttfbTimer); timedOut = false; };

  const upBody = { ...body, model: rung.model, stream: true };
  // usage accounting on OpenRouter only — the Go gateway may reject the field.
  if (rung.provider === 'openrouter' && !body.stream_options) {
    upBody.stream_options = { include_usage: true };
  }

  let retryStripped = false;   // rf-400 / stream_options-400: retry same rung once, fields stripped
  let retry429 = false;        // one same-rung retry after short backoff

  for (let attempt = 0; ; attempt++) {
    const payload = retryStripped ? stripFragileFields(upBody) : upBody;

    // Fresh controller per attempt: a 429 backoff sleep or rf-400 retry must
    // not inherit an aborted/armed signal from the previous round.
    disarmTtfb();
    ac = new AbortController();
    let res;
    armTtfb();
    try {
      res = await fetch(auth.url, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (e) {
      const wasTtfbTimeout = timedOut;
      disarmTtfb();
      if (wasTtfbTimeout) {
        recordRungFailure(rung, `gateway-timeout: ttfb ${cfg.ttfbTimeoutMs}ms (no headers)`);
        return { ok: false, error: 'gateway-timeout ttfb' };
      }
      if (ac.signal.aborted) return { ok: false, error: 'client-disconnected' };
      return { ok: false, error: `upstream fetch failed: ${e.message}` };
    }
    disarmTtfb(); // headers arrived — first-byte clock takes over in the read loop

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // rf-400: provider rejects response_format / stream_options — strip and
      // retry the SAME rung once (established pattern from pr-autofix v1.3.1).
      const fragile = /structured[-_ ]outputs?|response[_ ]?format|stream_options|json_object/i.test(errText);
      if (res.status === 400 && fragile && !retryStripped) {
        retryStripped = true;
        continue;
      }
      // 429: one same-rung retry with short backoff (Retry-After honored ≤3s).
      if (res.status === 429 && !retry429 && attempt < 1) {
        retry429 = true;
        ladderLog.logLimit({ source: 'gateway', model: healthKey(rung), class: 'rate_limit_retry', status: 429, errorText: `HTTP 429: ${errText.slice(0, 200)}` });
        const ra = Number(res.headers.get('retry-after')) || 0;
        const waitMs = Math.min(Math.max(ra * 1000, 1500), 3000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      const error = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
      recordRungFailure(rung, error);
      return { ok: false, error, status: res.status };
    }

    // ── Upstream is streaming. Read events with the timeout ladder. ──────────
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const agg = { content: '', tool_calls: [], finish_reason: null, usage: null };
    const started = Date.now();
    let committed = wantStream ? false : null; // non-stream: no commit concept
    let ttfbLeft = cfg.ttfbTimeoutMs;
    let firstTokenAt = null;

    const readPhase = async (ms) => {
      const r = await readWithTimeout(reader, ms);
      if (r.done) return { done: true };
      return { chunk: dec.decode(r.value, { stream: true }) };
    };

    for (;;) {
      const now = Date.now();
      if (now - started > cfg.totalTimeoutMs) {
        ac.abort();
        recordRungFailure(rung, `gateway-timeout: total ${cfg.totalTimeoutMs}ms`);
        return { ok: false, error: 'gateway-timeout total' };
      }
      const phaseMs = firstTokenAt ? cfg.interChunkTimeoutMs
        : Math.max(500, Math.min(ttfbLeft - (now - started), cfg.ttfbTimeoutMs));
      let step;
      try {
        step = await readPhase(phaseMs);
      } catch (e) {
        ac.abort();
        if (timedOut || String(e.message).includes('gateway-timeout')) {
          recordRungFailure(rung, `gateway-timeout: no token in ${cfg.ttfbTimeoutMs}ms`);
          return { ok: false, error: 'gateway-timeout ttfb' };
        }
        if (opts.res.destroyed) return { ok: false, error: 'client-disconnected' };
        // Upstream died mid-read — degrade to the next rung.
        recordRungFailure(rung, `upstream stream error: ${e.message}`);
        return { ok: false, error: `upstream stream error: ${e.message}` };
      }
      if (step.done) break;
      buf += step.chunk;
      if (!firstTokenAt) disarmTtfb(); // headers + bytes flowing: switch to inter-chunk clock

      // Process complete SSE events (\n\n-delimited).
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const payloadStr = dataLine.slice(5).trim();
        if (payloadStr === '[DONE]') {
          if (wantStream && committed) {
            opts.res.write('data: [DONE]\n\n');
            opts.res.end();
          }
          return wantStream
            ? { ok: true, relayed: committed === true }
            : { ok: true, message: finalizeMessage(agg), finish_reason: agg.finish_reason || 'stop', usage: agg.usage };
        }
        let data;
        try { data = JSON.parse(payloadStr); } catch { continue; }

        if (wantStream && !committed) {
          if (!isEmptyDelta(data)) {
            // First real token ⇒ commit this rung, flush, then pipe verbatim.
            committed = true;
            firstTokenAt = Date.now();
            noteTraffic(rung);
            recordRungSuccess(rung);
            opts.res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              // nginx: do not buffer SSE (works on both relay and CF tunnel).
              'X-Accel-Buffering': 'no',
              'X-Ladder-Rung': healthKey(rung),
            });
            opts.res.write(rawEvent + '\n\n');
          }
          continue; // still uncommitted — keep buffering/reading
        }

        if (wantStream && committed) {
          opts.res.write(rawEvent + '\n\n');
        }
        applyDelta(agg, data);
        if (!firstTokenAt && !isEmptyDelta(data)) firstTokenAt = Date.now();
      }
      if (firstTokenAt) { /* phase clock resets via firstTokenAt */ }
    }

    if (wantStream) {
      if (committed) {
        // Some upstreams close without an explicit [DONE] — terminate the SSE
        // properly for the client anyway.
        if (!opts.res.writableEnded) opts.res.write('data: [DONE]\n\n');
        opts.res.end();
        return { ok: true, relayed: true };
      }
      // Stream ended without a single real token — dead rung, try next.
      recordRungFailure(rung, 'stream ended before first token');
      return { ok: false, error: 'no first token' };
    }
    noteTraffic(rung);
    recordRungSuccess(rung);
    return { ok: true, message: finalizeMessage(agg), finish_reason: agg.finish_reason || 'stop', usage: agg.usage };
  }
}

function stripFragileFields(body) {
  const out = { ...body };
  delete out.response_format;
  delete out.stream_options;
  return out;
}

function finalizeMessage(agg) {
  const msg = { role: 'assistant', content: agg.content || '' };
  const tools = (agg.tool_calls || []).filter(Boolean);
  if (tools.length) msg.tool_calls = tools;
  if (!msg.content && !tools.length) msg.content = '';
  return msg;
}

// ── Ladder orchestration ───────────────────────────────────────────────────────
function activeRungs(cfg) {
  const all = cfg.rungs
    .map(r => ({ ...r, cfg }))
    .filter(r => providerConfigured(r));
  const usable = all.filter(r => !modelHealth.isSkipped(healthKey(r)));
  // Every rung currently skipped ⇒ use them all anyway (some answer beats none;
  // the retry-count cap in the loop prevents hammering forever).
  return usable.length ? usable : all;
}

function providerConfigured(rung) {
  return rung.provider === 'go' ? !!goKey() : !!orKey();
}

async function runLadder(body, opts) {
  const cfg = loadConfig();
  if (!cfg || !Array.isArray(cfg.rungs) || !cfg.rungs.length) {
    return { fatal: { status: 503, message: 'gateway not configured' } };
  }
  const rungs = activeRungs(cfg);
  if (!rungs.length) return { fatal: { status: 503, message: 'no provider keys configured' } };

  const errors = [];
  // Call log (src/ladder-log.js): which configured rung (1-based) answered, every attempt,
  // whether a paid rung was touched. Written once per request, whatever the outcome.
  const startedAt = Date.now();
  const attempts = [];
  const rungNo = r => cfg.rungs.findIndex(c => c.provider === r.provider && c.model === r.model) + 1;
  const logged = (outcome, ret) => {
    ladderLog.logCall({
      source: 'gateway', ladder: cfg.modelId, rungsTotal: cfg.rungs.length, outcome, attempts,
      latencyMs: Date.now() - startedAt, extra: { stream: !!body.stream, tools: Array.isArray(body.tools) && body.tools.length > 0 },
    });
    return ret;
  };
  for (const rung of rungs) {
    const label = healthKey(rung);
    const attempt = { model: label, rung: rungNo(rung), tier: rung.tier };
    attempts.push(attempt);
    const result = await attemptRung(rung, body, opts);
    if (result.ok) {
      if (result.relayed) { attempt.outcome = 'ok'; return logged('ok', { relayed: true, rung: label }); }
      const reason = guardAnswer(body, result.message);
      if (reason) {
        // Quality failure, not quota — short transient backoff so the rung is
        // not hammered by every subsequent request either.
        modelHealth.recordFailure(label, { class: 'transient', errorText: `guard: ${reason}`, source: 'gateway' });
        errors.push(`${label}: guard:${reason}`);
        attempt.outcome = `guard:${reason}`;
        continue;
      }
      attempt.outcome = 'ok';
      return logged('ok', { rung: label, rungIndex: attempt.rung, message: result.message, finish_reason: result.finish_reason, usage: result.usage });
    }
    attempt.outcome = 'error';
    attempt.error = String(result.error || '').slice(0, 200);
    if (result.status) attempt.status = result.status;
    if (result.error === 'client-disconnected') return logged('client-disconnected', { aborted: true });
    errors.push(`${label}: ${result.error}`);
    if (result.status === 404 || result.status === 401) {
      // Provider/model endpoint is dead — park it until the next sweep window.
      modelHealth.recordFailure(label, {
        class: 'quota',
        retryAfterMs: cfg.sweepIdleMs || 1800000,
        errorText: result.error,
        source: 'gateway',
      });
    }
  }
  return logged('all_failed', { fatal: { status: 502, message: `all rungs failed: ${errors.slice(-4).join(' | ')}` } });
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────────
function readBody(req, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function openaiError(res, status, message, type, code) {
  json(res, status, { error: { message, type, code } });
}

async function handleChatCompletions(req, res) {
  if (!getToken()) {
    return openaiError(res, 503, 'gateway token not configured', 'server_error', 'not_configured');
  }
  if (!authOk(req)) {
    return openaiError(res, 401, 'invalid gateway token', 'invalid_request_error', 'invalid_api_key');
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return openaiError(res, 400, `bad json: ${e.message}`, 'invalid_request_error', 'invalid_body');
  }
  const cfg = loadConfig();
  if (!cfg) return openaiError(res, 503, 'gateway not configured', 'server_error', 'not_configured');
  if (body.model !== cfg.modelId) {
    return openaiError(res, 404, `model '${body.model}' not found — use '${cfg.modelId}'`, 'invalid_request_error', 'model_not_found');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return openaiError(res, 400, 'messages is required', 'invalid_request_error', 'invalid_body');
  }

  const result = await runLadder(body, { req, res });
  if (result.aborted || res.writableEnded || res.destroyed) return;
  if (result.fatal) {
    return openaiError(res, result.fatal.status, result.fatal.message, 'server_error', 'all_rungs_failed');
  }
  if (result.relayed) return; // SSE already piped & ended

  json(res, 200, {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: cfg.modelId,
    choices: [{
      index: 0,
      message: result.message,
      finish_reason: result.finish_reason,
    }],
    usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    // Non-standard but harmless observability aids:
    'x-ladder-rung': result.rung,
    'x-ladder-rung-index': result.rungIndex,
  });
}

function handleModels(req, res) {
  if (!authOk(req)) {
    return openaiError(res, 401, 'invalid gateway token', 'invalid_request_error', 'invalid_api_key');
  }
  const cfg = loadConfig() || { modelId: 'free-ladder' };
  json(res, 200, {
    object: 'list',
    data: [{
      id: cfg.modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'trained-assist',
    }],
  });
}

// Server-facing entry: returns true if handled (server `return`s after).
async function route(req, res, url) {
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    ensureTimers();
    await handleChatCompletions(req, res);
    return true;
  }
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    ensureTimers();
    handleModels(req, res);
    return true;
  }
  if (url.pathname === '/v1/ladder-stats' && req.method === 'GET') {
    // Ladder observability (src/ladder-log.js): rung distribution, paid share, limit hits.
    if (!authOk(req)) {
      return openaiError(res, 401, 'invalid gateway token', 'invalid_request_error', 'invalid_api_key'), true;
    }
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 24, 1), 24 * 30);
    json(res, 200, ladderLog.summary(hours * 3600 * 1000));
    return true;
  }
  if (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/models') {
    ensureTimers();
    openaiError(res, 405, 'method not allowed', 'invalid_request_error', 'method_not_allowed');
    return true;
  }
  return false;
}

// ── Health sweep + catalog sync ────────────────────────────────────────────────
let timersStarted = false;

function ensureTimers() {
  if (timersStarted) return;
  if (process.env.LLM_GATEWAY_NO_TIMERS === '1') return;
  timersStarted = true;
  const tick = setInterval(() => {
    sweepIdleRungs().catch(e => console.warn('[llm-gateway] sweep failed:', e.message));
  }, 60_000);
  tick.unref();
  const catalog = setInterval(() => {
    syncCatalog().catch(e => console.warn('[llm-gateway] catalog sync failed:', e.message));
  }, 12 * 3600_000);
  catalog.unref();
  // Kick once shortly after boot so a dead rung is known before real traffic.
  const boot = setTimeout(() => {
    sweepIdleRungs().catch(() => {});
    syncCatalog().catch(() => {});
  }, 60_000);
  boot.unref();
}

async function pingRung(rung) {
  const key = healthKey(rung);
  rungLastPing.set(key, Date.now());
  const cfg = rung.cfg;
  const auth = upstreamAuth(rung);
  if (!auth) return;
  try {
    const res = await fetch(auth.url, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: rung.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      modelHealth.recordSuccess(key);
      try { await res.arrayBuffer(); } catch { /* drain */ }
    } else {
      const text = await res.text().catch(() => '');
      modelHealth.recordFailure(key, {
        source: 'gateway-sweep',
        class: 'quota',
        retryAfterMs: cfg.sweepIdleMs || 1800000, // dead until the next sweep window
        errorText: `sweep HTTP ${res.status}: ${text.slice(0, 200)}`,
      });
      console.warn(`[llm-gateway] sweep parked ${key}: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[llm-gateway] sweep ping ${key} failed: ${e.message}`);
  }
}

async function sweepIdleRungs() {
  const cfg = loadConfig();
  if (!cfg) return;
  const now = Date.now();
  const idleMs = cfg.sweepIdleMs || 1800000;
  const rungs = cfg.rungs.map(r => ({ ...r, cfg })).filter(providerConfigured);
  const targets = rungs.filter(r => {
    const key = healthKey(r);
    const last = rungTraffic.get(key) || 0;
    const lastPing = rungLastPing.get(key) || 0;
    return now - last >= idleMs && now - lastPing >= idleMs;
  });
  if (!targets.length) return;
  console.log(`[llm-gateway] sweep: pinging ${targets.length} idle rung(s)`);
  for (const r of targets) await pingRung(r);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  } catch (e) { console.warn('[llm-gateway] state write failed:', e.message); }
}

// Catalog sync: drop rungs whose model vanished from /models; collect new :free
// ids as candidates (never auto-promoted — a bench decides promotion).
async function syncCatalog() {
  const cfg = loadConfig();
  if (!cfg) return;
  const state = readState();
  const now = Date.now();
  if (state.lastCatalogAt && now - Number(state.lastCatalogAt) < (cfg.catalogIntervalMs || 43200000)) return;

  // OpenRouter catalog (public endpoint, no key required).
  try {
    const res = await fetch(`${cfg.openrouter.baseURL}/models`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const data = await res.json();
      const ids = new Set((data.data || []).map(m => m.id));
      const orRungs = cfg.rungs.filter(r => r.provider === 'openrouter');
      for (const r of orRungs) {
        if (!ids.has(r.model)) {
          const key = healthKey(r);
          modelHealth.recordFailure(key, {
            source: 'gateway-catalog',
            class: 'quota',
            retryAfterMs: 7 * 24 * 3600_000,
            errorText: 'gone from OpenRouter catalog (weekly rotation)',
          });
          console.warn(`[llm-gateway] catalog dropped ${key}`);
        }
      }
      const known = new Set(orRungs.map(r => r.model));
      const candidates = state.candidates && typeof state.candidates === 'object' ? state.candidates : {};
      for (const id of ids) {
        if (id.endsWith(':free') && !known.has(id)) {
          if (!candidates[id]) candidates[id] = new Date().toISOString();
        }
      }
      // Cap the candidate list so the file cannot grow without bound.
      const entries = Object.entries(candidates).sort((a, b) => a[1].localeCompare(b[1]));
      state.candidates = Object.fromEntries(entries.slice(-200));
      state.lastCatalogOkAt = new Date().toISOString();
    }
  } catch (e) {
    state.lastCatalogError = `${e.message} @ ${new Date().toISOString()}`;
  }

  // Go catalog best-effort (endpoint may not exist — never fail the sync on it).
  try {
    const k = goKey();
    if (k) {
      const res = await fetch(`${cfg.go.baseURL}/models`, {
        headers: { Authorization: `Bearer ${k}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = await res.json();
        const ids = new Set((data.data || []).map(m => m.id));
        if (ids.size) {
          for (const r of cfg.rungs.filter(x => x.provider === 'go')) {
            if (!ids.has(r.model)) {
              modelHealth.recordFailure(healthKey(r), {
                source: 'gateway-catalog',
                class: 'quota',
                retryAfterMs: 7 * 24 * 3600_000,
                errorText: 'gone from OpenCode Go catalog',
              });
            }
          }
        }
      }
    }
  } catch { /* best-effort */ }

  state.lastCatalogAt = now;
  writeState(state);
}

// ── Test/injection surface ─────────────────────────────────────────────────────
module.exports = {
  route,
  loadConfig,
  getToken,
  authOk,
  healthKey,
  guardAnswer,
  tryParseJson,
  looksLikeRefusal,
  activeRungs,
  runLadder,
  sweepIdleRungs,
  syncCatalog,
  stripFragileFields,
  ensureTimers,
  _internal: { rungTraffic, rungLastPing },
};
