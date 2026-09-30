'use strict';

// Per-audience bot token names come from the bot registry (epic #1342,
// infra/env-manifest.json → bots.registry). `default` is the classic bot: its token
// is already `secrets.BOT_TOKEN`, so it needs no re-routing.
const { BOTS } = require('./bot-registry');
const BOT_TOKEN_SECRET = Object.fromEntries(BOTS.map(b => [b.audience, b.audience === 'default' ? null : b.token_secret_name]));

// Bot credentials stay server-side. An audience must never fall back to another bot.
// A missing audience (legacy pending/session records) resolves to 'default' by the
// caller (taskDelivery) before reaching here — this function only ever sees 'default'
// or an explicitly set audience, and an explicitly unknown one always throws
// (#1302 §2 — reject, never silently default).
function deliverySecrets(secrets, audience = 'default') {
  if (!audience || audience === 'default') return secrets;
  if (!Object.hasOwn(BOT_TOKEN_SECRET, audience)) throw new Error(`Unsupported Telegram audience: ${audience}`);
  const secretName = BOT_TOKEN_SECRET[audience];
  const token = secrets?.[secretName];
  if (!token) throw new Error(`${audience} Telegram delivery is not configured`);
  return { ...secrets, BOT_TOKEN: token, TELEGRAM_BOT_TOKEN: token };
}

function taskDelivery(opts) {
  let audience = opts.user.audience;
  // Legacy pending records did not persist audience; recover it from the session.
  // Index FIRST (issue #1916 PR-C): a body read here would miss an ARCHIVED
  // session — its record in sessions.json carries `audience` and is always local,
  // so the answer needs no GCS and no materialize this early in the run.
  if (!audience && opts.sessionId && opts.user.workDir) {
    const store = require('./session-store');
    audience = store.getSessionRecord(opts.user.workDir, opts.sessionId)?.audience
      || store.getSession(opts.user.workDir, opts.sessionId)?.audience;
  }
  audience ||= 'default';
  return { ...opts, user: { ...opts.user, audience }, secrets: deliverySecrets(opts.secrets, audience) };
}
module.exports = { deliverySecrets, taskDelivery };
