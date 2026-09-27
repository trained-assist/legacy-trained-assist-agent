'use strict';

// Ladder observability log (owner 2026-09-27: «писать логи какая по счёту модель вызвалась,
// дошло ли до платной, и отдельно — про лимиты, если столкнёмся»).
//
// Two append-only JSONL files, one writer for every ladder in the process:
//   calls.jsonl  — one line per ladder call: which rung (1-based) answered, of how many,
//                  its billing tier, whether the call reached a PAID rung, every attempt.
//                  Written by the free-ladder gateway (src/llm-gateway.js) and by the runner's
//                  OpenCode ladder (src/runner/index.js) — source field tells them apart.
//   limits.jsonl — SEPARATE file for limit hits: 429 rate limits, daily/free quotas, credits
//                  exhausted, auth/config dead ends. Fed from the single choke point
//                  model-health.recordFailure (non-transient classes) plus the gateway's
//                  same-rung 429 retry, so no ladder can hit a limit silently.
//
// Tier (billing) of a model key:
//   subscription — opencode-go/* (flat paid subscription, no marginal cost per call)
//   free         — openrouter/*:free
//   paid         — everything else (per-token billed: openrouter non-:free, gigachat, …)
// reachedPaid = at least one attempted rung was tier 'paid' (money may have been spent).
//
// Dir: LADDER_LOG_DIR, else a ladder-log/ folder NEXT TO the model-health state file
// (~/.config/opencode/ladder-log in prod) — tests that point OPENCODE_MODEL_HEALTH_FILE at a tmpdir
// therefore never write into the production log. Size-capped rotation (one .1 file)
// so the log never grows unbounded. A logging error never breaks a model call.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 5 * 1024 * 1024;

function logDir() {
  if (process.env.LADDER_LOG_DIR) return process.env.LADDER_LOG_DIR;
  const healthFile = process.env.OPENCODE_MODEL_HEALTH_FILE ||
    path.join(os.homedir(), '.config', 'opencode', 'model-health.json');
  return path.join(path.dirname(healthFile), 'ladder-log');
}
function callsFile() { return path.join(logDir(), 'calls.jsonl'); }
function limitsFile() { return path.join(logDir(), 'limits.jsonl'); }

function modelTier(key, explicit) {
  if (explicit) return explicit;
  const k = String(key || '');
  if (k.startsWith('opencode-go/')) return 'subscription';
  if (k.startsWith('openrouter/') && k.endsWith(':free')) return 'free';
  return 'paid';
}

// Limit kind from the error text — what exactly we ran into.
function limitKind(errorText, cls) {
  const t = String(errorText || '');
  if (/free-models-per-day|per[- ]day|daily|RPD|quota/i.test(t)) return 'daily_quota';
  if (/\b402\b|insufficient|credits?|balance|payment/i.test(t)) return 'credits';
  if (/\b429\b|rate[- ]?limit|too many requests|RPM/i.test(t)) return 'rate_limit';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid.*key/i.test(t)) return 'auth';
  if (/\b404\b|not found|gone from|catalog/i.test(t)) return 'model_gone';
  if (cls === 'config') return 'config';
  if (cls === 'force') return 'forced_advance';
  return 'other';
}

function append(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.warn('[ladder-log] write failed:', e.message);
  }
}

// evt: { source, ladder, attempts:[{model, rung, outcome, error?}], outcome, latencyMs, ... }
// rung/rungsTotal are 1-based positions in the configured ladder.
function logCall(evt) {
  const attempts = (evt.attempts || []).map(a => ({ ...a, tier: modelTier(a.model, a.tier) }));
  const winner = attempts.find(a => a.outcome === 'ok') || null;
  const line = {
    ts: new Date().toISOString(),
    source: evt.source || 'unknown',
    ladder: evt.ladder || null,
    outcome: evt.outcome || (winner ? 'ok' : 'failed'),
    rung: winner ? winner.rung : null,
    rungsTotal: evt.rungsTotal ?? null,
    model: winner ? winner.model : null,
    tier: winner ? winner.tier : null,
    reachedPaid: attempts.some(a => a.tier === 'paid'),
    attempts,
    ...(evt.latencyMs != null ? { latencyMs: evt.latencyMs } : {}),
    ...(evt.extra || {}),
  };
  append(callsFile(), line);
  if (line.reachedPaid) {
    console.warn(`[ladder-log] PAID rung reached: ${line.source}/${line.ladder} → ${attempts.filter(a => a.tier === 'paid').map(a => a.model).join(',')}`);
  }
  return line;
}

// evt: { source, model, class, status?, retryAfterMs?, errorText? }
function logLimit(evt) {
  const line = {
    ts: new Date().toISOString(),
    source: evt.source || 'unknown',
    model: evt.model || null,
    tier: modelTier(evt.model),
    kind: evt.kind || limitKind(evt.errorText, evt.class),
    class: evt.class || null,
    ...(evt.status != null ? { status: evt.status } : {}),
    ...(Number.isFinite(evt.retryAfterMs) ? { retryAfterMs: evt.retryAfterMs } : {}),
    ...(evt.errorText ? { error: String(evt.errorText).slice(0, 300) } : {}),
  };
  append(limitsFile(), line);
  console.warn(`[ladder-log] LIMIT ${line.kind} on ${line.model} (${line.source})`);
  return line;
}

function readJsonl(file) {
  const out = [];
  for (const f of [file + '.1', file]) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of raw.split('\n')) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* torn line */ }
    }
  }
  return out;
}

// Aggregate for the last `sinceMs` (default 24h): rung distribution, paid share, limit hits.
function summary(sinceMs = 24 * 3600 * 1000, now = Date.now()) {
  const cutoff = now - sinceMs;
  const inWindow = r => Date.parse(r.ts) >= cutoff;
  const calls = readJsonl(callsFile()).filter(inWindow);
  const limits = readJsonl(limitsFile()).filter(inWindow);
  const byRung = {};
  const byTier = {};
  let failed = 0;
  let paid = 0;
  for (const c of calls) {
    if (c.outcome !== 'ok') failed++;
    if (c.reachedPaid) paid++;
    const k = c.rung == null ? 'none' : `${c.source}#${c.rung}`;
    byRung[k] = (byRung[k] || 0) + 1;
    if (c.tier) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  }
  const limitsByModel = {};
  for (const l of limits) {
    const k = `${l.model} ${l.kind}`;
    limitsByModel[k] = (limitsByModel[k] || 0) + 1;
  }
  return {
    windowHours: Math.round(sinceMs / 3600000),
    calls: calls.length,
    failed,
    reachedPaid: paid,
    byRung,
    byTier,
    limits: limits.length,
    limitsByModel,
    lastLimit: limits[limits.length - 1] || null,
    files: { calls: callsFile(), limits: limitsFile() },
  };
}

module.exports = { logDir, callsFile, limitsFile, modelTier, limitKind, logCall, logLimit, summary };
