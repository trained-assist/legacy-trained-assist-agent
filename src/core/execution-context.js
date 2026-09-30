'use strict';

// Trusted ExecutionContext (epic #1365 §2–3). Built by the HOST from verified
// transport/auth facts — never from message text or model arguments.
//
// Interaction policy is host-resolved from the verified channel:
//   telegram → conversation lane required (≤1 interactive run per dialog,
//              even across different sessions);
//   web      → no shared lane; only the per-session writer guard applies.
// Neither policy ever serializes a whole profile / project / workDir.
const { makeConversationRef, conversationKey, fromLegacyTelegram } = require('./conversation-ref');

const TRIGGERS = Object.freeze(['user', 'cron', 'durable_task', 'webhook', 'system']);

const CHANNEL_POLICIES = Object.freeze({
  telegram: Object.freeze({ conversationLaneRequired: true }),
  web: Object.freeze({ conversationLaneRequired: false }),
});
const HEADLESS_POLICY = Object.freeze({ conversationLaneRequired: false });

function interactionPolicyFor(channel) {
  const p = CHANNEL_POLICIES[channel];
  if (!p) throw new TypeError(`no interaction policy declared for channel "${channel}"`);
  return p;
}

function nonEmpty(name, v) {
  if (typeof v !== 'string' || v.length === 0) throw new TypeError(`ExecutionContext.${name} must be a non-empty string`);
}

function createExecutionContext(input = {}) {
  const { principal, actor, sessionId, executionId, requestId, rootTaskId, projectId, product, origin, bindings } = input;
  nonEmpty('principal.profileId', principal?.profileId);
  nonEmpty('executionId', executionId);
  nonEmpty('requestId', requestId);
  if (!origin || !TRIGGERS.includes(origin.trigger)) throw new TypeError(`ExecutionContext.origin.trigger must be one of ${TRIGGERS.join('|')}`);
  if ('interactionPolicy' in input) throw new TypeError('interactionPolicy is host-derived from sourceRef.channel and cannot be supplied');

  const sourceRef = input.sourceRef ? makeConversationRef(input.sourceRef) : undefined;
  const replyToRef = input.replyToRef ? makeConversationRef(input.replyToRef) : undefined;
  // Interactive runs must know where they came from and where to answer.
  // Headless cron/system runs may lack both — never a fake chat or session.
  if (origin.trigger === 'user' && (!sourceRef || !replyToRef)) throw new TypeError('interactive (trigger=user) execution requires sourceRef and replyToRef');
  if (actor) {
    nonEmpty('actor.channel', actor.channel);
    nonEmpty('actor.endpointId', actor.endpointId);
    nonEmpty('actor.actorId', actor.actorId);
  }
  // A durable continuation of a Telegram task inherits the dialog's lane; a
  // headless job with no source dialog gets no artificial lock.
  const interactionPolicy = sourceRef ? interactionPolicyFor(sourceRef.channel) : HEADLESS_POLICY;

  const ctx = {
    principal: Object.freeze({ profileId: principal.profileId }),
    ...(actor && { actor: Object.freeze({ channel: actor.channel, endpointId: actor.endpointId, actorId: actor.actorId }) }),
    ...(sourceRef && { sourceRef }),
    ...(replyToRef && { replyToRef }),
    ...(sessionId && { sessionId }),
    executionId,
    requestId,
    ...(rootTaskId && { rootTaskId }),
    ...(projectId && { projectId }),
    ...(product && { product: Object.freeze({ ...product }) }),
    origin: Object.freeze({ trigger: origin.trigger, ...(origin.channel && { channel: origin.channel }), ...(origin.endpointId && { endpointId: origin.endpointId }) }),
    interactionPolicy,
    ...(bindings && { bindings: Object.freeze({ ...bindings }) }),
  };
  return Object.freeze(ctx);
}

// Admission scopes this execution must hold for its whole run (§2.3).
// Never includes profile/project/workDir — those are not mutexes.
const laneScope = ref => `lane:${conversationKey(ref)}`;
const sessionScope = (profileId, sessionId) => `session:${profileId}:${sessionId}`;

function admissionScopes(ctx) {
  const scopes = [];
  if (ctx.interactionPolicy.conversationLaneRequired && ctx.sourceRef) scopes.push(laneScope(ctx.sourceRef));
  if (ctx.sessionId) scopes.push(sessionScope(ctx.principal.profileId, ctx.sessionId));
  return scopes;
}

// Same scopes for a legacy /run request (chatId/audience/threadId) until the
// runner is driven by a real ExecutionContext (PR3/PR4). chatId 0 (Web /
// internal) has no dialog → session writer guard only. An audience missing
// from the bot registry still gets a lane (never silently unserialized).
//
// `parallel: true` is the USER'S EXPLICIT choice to run a second interactive
// execution in the same dialog («⚡ Параллельно», RC-03 in trained-agent-
// architecture; owner decision 2026-09-30) — the only way past the lane. The
// opt-out applies to THIS run's lane only; the session writer guard is never
// bypassed (two writers of one history stay impossible, CH-05), and every run
// without the flag keeps taking the lane as before (default = one at a time).
function legacyAdmissionScopes({ chatId, audience, threadId, profileId, sessionId, parallel } = {}) {
  const scopes = [];
  let ref = null;
  try { ref = fromLegacyTelegram({ chatId, audience, threadId }); }
  catch { if (!parallel) scopes.push(`lane:legacy:${encodeURIComponent(audience || 'default')}|${chatId}|${threadId || ''}`); }
  if (ref && !parallel) scopes.push(laneScope(ref));
  if (sessionId && profileId) scopes.push(sessionScope(profileId, sessionId));
  return scopes;
}

module.exports = { createExecutionContext, interactionPolicyFor, admissionScopes, legacyAdmissionScopes, laneScope, sessionScope, TRIGGERS, CHANNEL_POLICIES };
