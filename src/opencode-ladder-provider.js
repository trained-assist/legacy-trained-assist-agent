'use strict';

// OpenCode agent runs → the trained-assist-llm-ladder worker (issue #1687, finishes #1614).
//
// The ladders (rung order, failover, per-model health, OpenCode Go key rotation, paid tail) live
// ONLY in the worker (https://llm-ladder.trainedassist.store, repo trained-assist-llm-ladder).
// This module does no routing of its own: it maps an OpenCode profile to a worker ladder name and
// emits the per-run OPENCODE_CONFIG piece — one openai-compatible provider `ladder` whose model id
// is the worker's ladder id (e.g. `ladder/build`, `ladder/service:plan`). There is no in-process
// fallback: if the worker is unreachable the run fails with a clear category (classifyWorkerFailure).
//
// The engine gets the worker token as OPENCODE_LADDER_TOKEN — a per-run engine credential (like
// CLAUDE_CODE_OAUTH_TOKEN), so the #1649 env allowlist can admit it while the server-side
// LLM_LADDER_TOKEN stays server-only.

const { LADDER_URL, ladderToken } = require('./service-llm');

const ROLES = ['build', 'plan', 'explore', 'general', 'review'];
const PROVIDER_ID = 'ladder';
const TOKEN_ENV = 'OPENCODE_LADDER_TOKEN';

// OpenCode profile → worker ladder PER ROLE (issue #2065). A profile is no longer one ladder for
// every role: the agent's default `master` walks the worker's role ladders (build/plan/explore/
// general/review — each agent role is its own ladder on the worker, config/ladders.json), so the
// worker's D1 log finally sees per-role traffic instead of everything on `service:*`. The ladder
// value is the full worker model id suffix: role ladders are named after the role (`ladder/build`),
// ladders that carry their own role variants keep the suffix (`ladder/service:plan`,
// `ladder/research:explore`). This table mirrors the owner's own
// ~/.config/opencode/profiles/{master,phd,free,ladder-research}.json.
//
// Every VALUE is a ladder the worker resolves; scripts/check-client-contracts.mjs (llm-ladder
// repo) checks exactly that against the live config/ladders.json, so a rename on either side
// fails loudly. `russian` is the one non-ladder key — the service ladder plus a reviewer prompt
// (see ROLE_PROMPTS).
const ALL_ROLES = (ladder) => Object.freeze(Object.fromEntries(ROLES.map((role) => [role, `${ladder}:${role}`])));
const PROFILE_ROLE_LADDER = Object.freeze({
  // master (the default, src/profiles.js): one role ladder per agent role — the #2065 fix.
  master: Object.freeze({ build: 'build', plan: 'plan', explore: 'explore', general: 'general', review: 'review' }),
  // phd: the build role on the advanced build ladder (mimo-first), everything else like master.
  phd: Object.freeze({ build: 'build advanced', plan: 'plan', explore: 'explore', general: 'general', review: 'review' }),
  // free: the build role on the hard-$0 free ladder, everything else like master.
  free: Object.freeze({ build: 'free', plan: 'plan', explore: 'explore', general: 'general', review: 'review' }),
  // Single-ladder profiles: every role rides the same ladder (the service/research/doctor cases).
  service: ALL_ROLES('service'), // the standard ladder; /oc_service, /oc_go, /oc_ds
  doctor: ALL_ROLES('doctor'),   // playbook doctor fallback after claude → codex
  research: Object.freeze({ build: 'research', plan: 'research:plan', explore: 'research:explore', general: 'research:general', review: 'research:review' }), // hermes_web_research — worker ladder, Go-first (llm-ladder #28)
  russian: ALL_ROLES('service'), // service ladder + the strict Russian reviewer prompt below
});

// Names still found in a per-profile profiles.json, in OPENCODE_PROFILE or behind a /profile
// alias from before the ladder rename. Resolved on READ only — never written back — so stored
// state keeps working after the rename instead of falling through to the default profile (a
// stored `max` must still reach `doctor`, not `master`). A profile is renamed by /profile or
// by editing profiles.json; the aliases in infra/opencode-switch-profile.sh and
// src/runner/quick/profile-commands.js point at the new names.
const LEGACY_PROFILE_LADDER = Object.freeze({
  deepseek: 'service', // the ladder's former name
  value: 'service',    // duplicate of service
  max: 'doctor',       // duplicate of doctor
});

// Research used to be a DIRECT pin to `opencode-go/mimo-v2.6-flash` (subscription, no
// fallback). Incident 2026-10-01: a weekly Go allowance cap made every research run
// 429 → opencode retried silently → the 5-min inactivity watchdog killed the run and the
// step read it as «не уложился в бюджет» — all with NO rung to fall to, because a pin
// never failovers. The worker's `research` ladder (Go mimo → Go deepseek-v4.1 → paid
// OpenRouter tails, trained-assist-llm-ladder #28) keeps the same Go-first economics but
// owns what the pin could not: per-key rotation, health skips and a paid tail when Go is
// spent. The box's own Go keys stay only as the credential for the built-in `opencode-go`
// provider when a run is explicitly pointed there (`OPENCODE_MODEL=opencode-go/...`).

const ROLE_PROMPTS = Object.freeze({
  russian: {
    review: 'Ты строгий рецензент текстов о кандидатах. НЕ редактируй файлы — только читай и комментируй.\n\nПроверь подготовленный материал:\n1. Каждый факт должен подтверждаться источником — пометь всё, что взялось ниоткуда\n2. Роли, технологии, проекты, стаж — точное соответствие исходным данным\n3. Ничего важного не потеряно из интервью или транскрипта\n4. Нет необоснованных оценок кандидата\n5. Русский язык: живость, ясность, без канцелярита, без повторов\n6. Структура и объём соответствуют задаче\n\nВывод: пронумерованный список замечаний. В конце: LGTM / МИНОРНОЕ / КРИТИЧНО.',
  },
});

const PROFILES = Object.freeze(Object.keys(PROFILE_ROLE_LADDER));

// Unknown profile → the default service ladder with the role intact (the pre-#2065 fallback);
// a known profile with a role it doesn't declare → the service ladder's default role. Never a
// local model list — the worker owns every rung.
function ladderFor(profileName, role = 'build') {
  const ladders = PROFILE_ROLE_LADDER[profileName];
  if (ladders) return ladders[role] || 'service';
  const legacy = LEGACY_PROFILE_LADDER[profileName];
  if (legacy) return `${legacy}:${role}`;
  return `service:${role}`;
}

function modelFor(profileName, role = 'build') {
  return `${PROVIDER_ID}/${ladderFor(profileName, role)}`;
}

// Every ladder call carries who made it, so the worker's D1 log (ladder_calls, llm-ladder#18)
// can be queried per task/run/session/user/chat — the way to find the million-token sessions.
// opencode expands {env:NAME} over the whole config file; an unset name becomes "" and the
// worker stores it as null.
const TRACE_HEADERS = Object.freeze({
  'x-ladder-trace': '{env:AGENT_TASK_ID}',
  'x-ladder-run': '{env:AGENT_RUN_ID}',
  'x-ladder-session': '{env:AGENT_SESSION_ID}',
  'x-ladder-user': '{env:AGENT_USER_ID}',
  'x-ladder-chat': '{env:AGENT_TRACE_CHAT}',
  // "Application" slice in the OpenRouter console (worker: llm-ladder#33 — the slug goes
  // out as HTTP-Referer/X-OpenRouter-Title). AGENT_LADDER_APP is the run type, set in
  // runEngineProcess: background-playbooks | hermes-research | opencode-chat (#1917).
  'x-ladder-app': '{env:AGENT_LADDER_APP}',
});

// AGENT_TRACE_CHAT value: runs with no chat (plan/durable sessions) → "" (stored as null),
// never the literal string "null" that would group them under a fake chat in the log.
function traceChat(chatId) {
  return chatId == null || chatId === '' ? '' : String(chatId);
}

function providerConfig() {
  const models = {};
  for (const ladder of new Set(Object.values(PROFILE_ROLE_LADDER).flatMap((ladders) => Object.values(ladders)))) {
    models[ladder] = { name: `llm-ladder ${ladder}` };
  }
  return {
    [PROVIDER_ID]: {
      npm: '@ai-sdk/openai-compatible',
      name: 'trained-assist-llm-ladder',
      options: { baseURL: `${LADDER_URL()}/v1`, apiKey: `{env:${TOKEN_ENV}}`, headers: TRACE_HEADERS },
      models,
    },
  };
}

// The per-run OPENCODE_CONFIG piece: {provider, model, agent: {role: {model, prompt?}}}.
function buildOcProfileOverrides(profileName) {
  const prompts = ROLE_PROMPTS[profileName] || {};
  const agent = {};
  for (const role of ROLES) {
    agent[role] = { model: modelFor(profileName, role), ...(prompts[role] ? { prompt: prompts[role] } : {}) };
  }
  return { provider: providerConfig(), model: agent.build.model, agent };
}

// Error text of a failed OpenCode run on a `ladder/*` model → what went wrong on the worker side,
// or null (not a worker-level failure — the runner's generic paths handle it). Patterns are the
// texts opencode 1.18 actually reports (checked live 2026-09-28):
//   worker_unreachable — "Cannot connect to API: Unable to connect…", a rejected token ("unauthorized",
//                        401) or a worker config error (unknown ladder / no provider key): the worker
//                        never served the call (fail-soft: the step fails with this category).
//   ladder_exhausted   — the worker's 502 ladder_error "every rung failed".
//   context            — the prompt did not fit the model's context window.
function classifyWorkerFailure(text) {
  const t = String(text || '');
  if (!t) return null;
  if (/context[_\s-]?length|maximum context|context window|prompt is too long|input (?:is )?too long|too many tokens/i.test(t)) return 'context';
  if (/ladder_error|every rung failed/i.test(t)) return 'ladder_exhausted';
  if (/cannot connect to api|unable to connect|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|getaddrinfo|socket hang up|unauthori[sz]ed|\b401\b|unknown ladder|no provider key configured/i.test(t)) return 'worker_unreachable';
  return null;
}

module.exports = {
  ROLES, PROFILES, PROFILE_ROLE_LADDER, LEGACY_PROFILE_LADDER, PROVIDER_ID, TOKEN_ENV, TRACE_HEADERS,
  ladderFor, modelFor, providerConfig, traceChat, buildOcProfileOverrides, ladderToken, classifyWorkerFailure,
};
