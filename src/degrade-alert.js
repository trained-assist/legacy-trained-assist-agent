'use strict';

// #1912 — a degraded ladder/engine must reach the operator IN MINUTES, not be
// discovered from the journal days later. The audit found 397 «every rung failed»
// lines in two days and codex `unavailable` (QUOTA) for 5 days — nobody noticed
// in the moment: every failure was only a warn-line in `journalctl`.
//
// Two event sources, one delivery:
//   • ladderFailure/ladderOk — wired into src/service-llm.js (every rung outcome);
//   • engineUnavailable      — wired into src/engine-health.js (status transition).
// Delivery is fail-soft: no secrets, no token, test env or a send error is a no-op.
// An alert is rate-limited per key (cooldown), and the ladder alert additionally
// needs a consecutive-failure streak — one flaky call is not an outage.

const { getLoadedSecrets } = require('./secrets');

const LADDER_STREAK_THRESHOLD = Number(process.env.DEGRADE_ALERT_STREAK) || 5;
const COOLDOWN_MS = Number(process.env.DEGRADE_ALERT_COOLDOWN_MS) || 30 * 60 * 1000;

// Consecutive failures PER SOURCE (source → streak). One counter for the whole process let a
// single flaky caller speak for the whole ladder: five failures of anyone alerted, and the text
// then named whichever caller happened to fail last — «5 отказов подряд (input-router)» during a
// provider incident that had nothing to do with the router (2026-10-02).
const ladderStreaks = new Map();
const STREAK_KEY_CAP = 200; // source is a literal at every call site; this is a leak valve only
const lastAlertAt = new Map(); // alert key → epoch ms

function _inTest() {
  return process.env.TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

// True once per cooldown window per key; records the send time.
function _due(key, now = Date.now()) {
  const last = lastAlertAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

async function send(text) {
  if (_inTest()) return false;
  try {
    const secrets = getLoadedSecrets() || {};
    const chatId = Number(secrets.OPERATOR_CHAT_ID || '1714048');
    if (!Number.isFinite(chatId)) return false;
    // Reuse the existing notifier (telegram-sender ratchet, epic #1365 §6):
    // this module introduces no new direct Bot-API send site.
    const { deliverySecrets } = require('./bot-delivery');
    const route = deliverySecrets(secrets, 'default');
    const token = route?.TELEGRAM_BOT_TOKEN || route?.BOT_TOKEN;
    if (!token) return false;
    const { _tgNotify } = require('./gtd-controller');
    const ok = await _tgNotify(token, chatId, String(text).slice(0, 900), null);
    return ok !== null && ok !== undefined;
  } catch (e) {
    console.warn('[degrade-alert]', e.message);
    return false;
  }
}

// A rung outcome from service-llm: failures build a consecutive streak, a success
// clears it. At the threshold one alert goes out (cooldown-suppressed afterwards).
// The streak is per source (see ladderStreaks); the COOLDOWN stays global — the ladder
// is one service, and one alert per window is enough no matter how many tools noticed.
function ladderOutcome({ ok, reason = null, source = null, detail = null } = {}) {
  const key = source || 'ladder';
  if (ok) { ladderStreaks.set(key, 0); return 0; }
  if (ladderStreaks.size >= STREAK_KEY_CAP) ladderStreaks.clear();
  const streak = (ladderStreaks.get(key) || 0) + 1;
  ladderStreaks.set(key, streak);
  if (streak >= LADDER_STREAK_THRESHOLD && _due('ladder')) {
    const where = source ? ` (${source})` : '';
    // via module.exports so tests can spy on the delivery layer
    void module.exports.send(`⚠️ llm-ladder недоступна: ${streak} отказов подряд${where}${reason ? ` — ${reason}` : ''}${detail ? `\n${String(detail).slice(0, 300)}` : ''}`);
  }
  return streak;
}

// Engine-health transition to `unavailable` — fired ONCE per outage (the caller
// only reports the transition, not every failing call after it).
function engineUnavailable(engine, { message = null } = {}) {
  if (!_due(`engine:${engine}`)) return false;
  // via module.exports so tests can spy on the delivery layer
  void module.exports.send(`🔴 Движок ${engine} недоступен${message ? `: ${String(message).slice(0, 300)}` : ''}\nШаги планов уйдут на fallback-рунги; почините и проверьте /health-full.`);
  return true;
}

function _resetForTests() {
  ladderStreaks.clear();
  lastAlertAt.clear();
}

module.exports = { ladderOutcome, engineUnavailable, send, _resetForTests, LADDER_STREAK_THRESHOLD, COOLDOWN_MS };
