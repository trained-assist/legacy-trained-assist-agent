'use strict';

// Ladder observability log (owner 2026-09-27: «писать логи какая по счёту модель вызвалась,
// дошло ли до платной»).
//
// calls.jsonl — one line per OpenCode run (src/runner/index.js): which llm-ladder worker ladder and
// role ran (`ladder/<ladder>:<role>`) and the outcome. Rung order, failover, per-model health, Go
// key rotation and limit hits are the worker's (trained-assist-llm-ladder, issue #1687) — its own
// log / `x-ladder-model` header says which rung served. A direct (non-ladder) model is logged with
// its billing tier.
//
// Tier (billing) of a model key:
//   ladder       — ladder/* (decided per call inside the worker)
//   subscription — opencode-go/* (flat paid subscription, no marginal cost per call)
//   free         — openrouter/*:free
//   paid         — everything else (per-token billed)
// reachedPaid = at least one attempted model was tier 'paid' (money may have been spent).
//
// Dir: LADDER_LOG_DIR, else ~/.config/opencode/ladder-log. Size-capped rotation (one .1 file) so
// the log never grows unbounded. A logging error never breaks a model call.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 5 * 1024 * 1024;

function logDir() {
  return process.env.LADDER_LOG_DIR || path.join(os.homedir(), '.config', 'opencode', 'ladder-log');
}
function callsFile() { return path.join(logDir(), 'calls.jsonl'); }

function modelTier(key, explicit) {
  if (explicit) return explicit;
  const k = String(key || '');
  if (k.startsWith('ladder/')) return 'ladder';
  if (k.startsWith('opencode-go/')) return 'subscription';
  if (k.startsWith('openrouter/') && k.endsWith(':free')) return 'free';
  return 'paid';
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
    console.warn(`[ladder-log] PAID model reached: ${line.source}/${line.ladder} → ${attempts.filter(a => a.tier === 'paid').map(a => a.model).join(',')}`);
  }
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

// Aggregate for the last `sinceMs` (default 24h): per-ladder counts, tiers, paid share.
function summary(sinceMs = 24 * 3600 * 1000, now = Date.now()) {
  const cutoff = now - sinceMs;
  const calls = readJsonl(callsFile()).filter(r => Date.parse(r.ts) >= cutoff);
  const byLadder = {};
  const byTier = {};
  let failed = 0;
  let paid = 0;
  for (const c of calls) {
    if (c.outcome !== 'ok') failed++;
    if (c.reachedPaid) paid++;
    const k = `${c.source}#${c.ladder || 'none'}`;
    byLadder[k] = (byLadder[k] || 0) + 1;
    if (c.tier) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  }
  return {
    windowHours: Math.round(sinceMs / 3600000),
    calls: calls.length,
    failed,
    reachedPaid: paid,
    byLadder,
    byTier,
    files: { calls: callsFile() },
  };
}

module.exports = { logDir, callsFile, modelTier, logCall, summary };
