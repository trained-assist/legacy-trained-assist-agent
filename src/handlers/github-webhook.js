'use strict';

// POST /webhooks/github — event-driven wake for durable waits (issue #1846).
//
// The GitHub webhook is a PUSH, not a poll: a delivery that matches a waiting
// step's subject brings that step's next poll forward to now, so the plan wakes
// in seconds instead of on the 30s tick. The webhook NEVER decides the verdict —
// it only moves `due_at` and nudges the executor; the validator still runs on
// the poll (src/playbook-validators.js). A lost or forged delivery therefore
// degrades to the ordinary poll, never to a wrong "satisfied".
//
// Mounted in src/server.js BEFORE the global Bearer gate (GitHub sends no Bearer
// token), like /health. That is why the handler carries its own authentication:
// HMAC-SHA256 over the RAW body (`X-Hub-Signature-256`), fail-closed.
//
// Refusal order (each step before the next, no side effect on refusal):
//   404  no webhook secret configured — nobody is served
//   413  body over the limit — readBodyBuffer throws
//   401  signature missing/mismatched — timing-safe over the raw bytes
//   400  valid signature, body is not JSON
//   202  accepted (matched or not) — a delivery with nothing to wake is still OK
//
// The handler is transport-shaped like the other handlers (returns false when it
// did not handle the route) so server.js can delegate to it.

const crypto = require('crypto');

// Any of these env/secret names configures the hook; the first non-empty wins.
// Multiple names because the secret may already live under a broader convention.
const SECRET_ENV_NAMES = [
  'GITHUB_WEBHOOK_SECRET', 'GH_WEBHOOK_SECRET', 'DURABLE_WEBHOOK_SECRET',
  'WEBHOOK_SECRET', 'GITHUB_WEBHOOKS_SECRET',
];
const SIGNATURE_HEADER = 'x-hub-signature-256';
const MAX_BODY_BYTES = 1_048_576; // 1 MiB — GitHub caps payloads well below this

/** Resolve the configured webhook secret from ctx.secrets then process.env. */
function resolveSecret(secrets) {
  for (const name of SECRET_ENV_NAMES) {
    const fromCtx = secrets && secrets[name];
    if (typeof fromCtx === 'string' && fromCtx) return fromCtx;
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  }
  return null;
}

/** Timing-safe HMAC-SHA256 comparison of the raw body against the header. */
function signatureValid(rawBody, header, secret) {
  if (typeof header !== 'string' || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/**
 * Handle one GitHub delivery.
 * @param {object} req node request
 * @param {URL} url parsed request URL
 * @param {object} res node response
 * @param {object} ctx host helpers: { json, readBodyBuffer, readBody, secrets, getGtdTickNow }
 * @returns {Promise<boolean|void>} false when the route did not match
 */
async function handleGithubWebhook(req, url, res, ctx = {}) {
  const { json, secrets, getGtdTickNow } = ctx;
  if (url.pathname !== '/webhooks/github') return false;
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  // 1. Fail closed when no secret is configured: an unauthenticated wake endpoint
  //    would let anyone resume any waiting plan.
  const secret = resolveSecret(secrets);
  if (!secret) return json(res, 404, { error: 'webhook not configured' });

  // 2. Read the raw body (needed verbatim for HMAC). Over the limit → 413.
  const readBuf = ctx.readBodyBuffer || ctx.readBody;
  if (typeof readBuf !== 'function') return json(res, 500, { error: 'no body reader' });
  let rawBody;
  try {
    rawBody = await readBuf(req, MAX_BODY_BYTES);
  } catch (e) {
    return json(res, 413, { error: 'payload too large' });
  }
  if (!Buffer.isBuffer(rawBody)) rawBody = Buffer.from(String(rawBody || ''));

  // 3. Signature over the raw bytes, before parsing anything.
  if (!signatureValid(rawBody, req.headers[SIGNATURE_HEADER], secret)) {
    return json(res, 401, { error: 'invalid signature' });
  }

  // 4. Only now is the body trusted enough to parse.
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'bad json' });
  }

  const event = req.headers['x-github-event'] || null;
  const deliveryId = req.headers['x-github-delivery'] || null;

  // 5. Match and wake. A wake is best-effort: an internal error must not turn a
  //    valid delivery into a 5xx (GitHub would retry and amplify it).
  let woken = 0;
  try {
    woken = await wakeMatchingWaits({ event, payload, deliveryId });
  } catch (e) {
    console.warn('[github-webhook] wake error:', e.message);
  }
  if (woken > 0) {
    // Nudge the executor now; the wait tick is the fallback if this is dropped.
    try { await require('../durable-kick').notify('github-event'); } catch { /* poll covers it */ }
    if (typeof getGtdTickNow === 'function') { try { await getGtdTickNow()(); } catch { /* best effort */ } }
  }
  return json(res, 202, { ok: true, event, woken });
}

/**
 * Bring every waiting step whose subject matches this delivery forward to now.
 * @returns {Promise<number>} how many waits were woken (deduped deliveries count 0)
 */
async function wakeMatchingWaits({ event, payload, deliveryId }) {
  const { matchUntil } = require('../github-event-subjects');
  const store = require('../gtd-controller').durableStore();
  let woken = 0;
  for (const row of store.listActiveWaiters()) {
    let wait;
    try { wait = JSON.parse(row.wait_json); } catch { continue; }
    if (!wait || wait.resolved) continue;
    const hits = matchUntil(wait.until, event, payload);
    if (!hits.length) continue;
    const hit = hits[0];
    const r = store.accelerateWaitByEvent(row.id, {
      deliveryId, event, key: hit.key, subject: hit.subject,
    });
    if (r && r.changed) woken += 1;
  }
  return woken;
}

module.exports = { handleGithubWebhook, resolveSecret, signatureValid, wakeMatchingWaits, SECRET_ENV_NAMES };
module.exports.default = handleGithubWebhook;
