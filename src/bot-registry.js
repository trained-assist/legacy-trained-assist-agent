'use strict';

// Telegram bot registry (epic #1342). The single source of truth is
// infra/env-manifest.json → bots.registry; this module is its only reader.
// Adding a bot = 1 registry entry + its token in Secret Manager + the name in
// src/secrets.js OPTIONAL (check-env-sync.js enforces the last two).
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'infra', 'env-manifest.json');

function loadRegistry(manifest = require(MANIFEST_PATH)) {
  const bots = manifest?.bots?.registry;
  if (!Array.isArray(bots) || bots.length === 0) throw new Error('env-manifest.json: bots.registry is missing or empty');
  return bots.map(b => Object.freeze({ ...b }));
}

const BOTS = Object.freeze(loadRegistry());

// audience → Secret Manager / env name of that bot's token.
function tokenSecretName(audience, bots = BOTS) {
  return bots.find(b => b.audience === audience)?.token_secret_name ?? null;
}

// Enabled bots whose token did not resolve. `values` is keyed by secret name
// (the raw Secret Manager / env names, e.g. RECRUITER_BOT_TOKEN).
function missingBotTokens(values, bots = BOTS) {
  return bots.filter(b => b.enabled !== false && !values?.[b.token_secret_name]);
}

// audience → base URL of the gateway Worker that serves that bot. Agent → gateway
// callbacks (run-finished, held-messages) must reach the gateway that DISPATCHED
// the run: its IntakeBuffer holds the chat `busy` until that push arrives, and the
// outbox path disables its /tasks/running poll. Sending every audience to the
// classic gateway left recruiter/freelance chats «Идёт текущая задача» for the
// full 45-min BUSY_MAX after each run. `default` keeps env MEDIA_GATEWAY_URL; an
// unknown audience gets null — never another bot's gateway.
function gatewayUrl(audience = 'default', { bots = BOTS, env = process.env } = {}) {
  const aud = audience || 'default';
  const bot = bots.find(b => b.audience === aud);
  if (!bot) return null;
  const raw = bot.gateway_url || (aud === 'default' ? env.MEDIA_GATEWAY_URL : '');
  return raw ? String(raw).replace(/\/+$/, '') : null;
}

module.exports = { BOTS, loadRegistry, tokenSecretName, missingBotTokens, gatewayUrl };
