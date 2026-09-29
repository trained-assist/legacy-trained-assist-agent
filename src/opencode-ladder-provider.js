'use strict';

// OpenCode agent runs → the trained-assist-llm-ladder worker (issue #1687, finishes #1614).
//
// The ladders (rung order, failover, per-model health, OpenCode Go key rotation, paid tail) live
// ONLY in the worker (https://llm-ladder.trainedassist.store, repo trained-assist-llm-ladder).
// This module does no routing of its own: it maps an OpenCode profile to a worker ladder name and
// emits the per-run OPENCODE_CONFIG piece — one openai-compatible provider `ladder` whose model id
// is `<ladder>:<role>` (e.g. `ladder/deepseek:plan`). There is no in-process fallback: if the
// worker is unreachable the run fails with a clear category (classifyWorkerFailure).
//
// The engine gets the worker token as OPENCODE_LADDER_TOKEN — a per-run engine credential (like
// CLAUDE_CODE_OAUTH_TOKEN), so the #1649 env allowlist can admit it while the server-side
// LLM_LADDER_TOKEN stays server-only.

const { LADDER_URL, ladderToken } = require('./service-llm');

const ROLES = ['build', 'plan', 'explore', 'general', 'review'];
const PROVIDER_ID = 'ladder';
const TOKEN_ENV = 'OPENCODE_LADDER_TOKEN';

// OpenCode profile → worker ladder. The decision per profile is listed in PR for #1687.
const PROFILE_LADDER = Object.freeze({
  deepseek: 'deepseek', // default; playbook bachelor/master
  doctor: 'doctor',     // playbook doctor fallback after claude → codex
  free: 'free',
  max: 'doctor',        // was the "strongest Go models" ladder — the worker's strongest tier is doctor
  value: 'deepseek',    // was a cheap OpenRouter/GigaChat ladder — superseded by deepseek
  russian: 'deepseek',  // GigaChat ladder dropped; keeps its strict Russian reviewer prompt
});

// Research (hermes_research) is pinned, not laddered — but on OpenCode Go, not OpenRouter.
// Go is a flat $10/mo subscription with a per-model monthly allowance (MiMo-V2.6-Flash:
// $0.14/$0.28 per 1M, ~150k requests/month included), so the research profile has no
// marginal per-call cost and can be offered without counting tokens — which is exactly
// the point of a researcher that runs on every research-shaped task. ladder-log already
// classifies `opencode-go/*` as tier `subscription`.
//
// `opencode-go` is a built-in provider (auth: OPENCODE_API_KEY, endpoint
// https://opencode.ai/zen/go/v1); runEngineProcess maps the box's OPENCODE_GO_API_KEY
// onto it. Verified live on the prod VM 2026-09-28: `opencode run -m
// opencode-go/mimo-v2.6-flash` on the shipped client (1.18.31) answers, even though the
// model is newer than that build's registry.
//
// Failover: the box carries TWO Go keys in rotation (`OPENCODE_GO_API_KEYS`, both passed
// through as OPENCODE_API_KEY — verified live, the comma-joined pair is accepted), so one
// exhausted key does not stop research. What is still missing is a rung BENEATH Go: when
// both keys are spent the run fails instead of degrading. That rung is
// `openrouter/google/gemini-2.5-flash`, and it lives in the `search` ladder — the last
// item on checklist.md, in the llm-ladder worker where ladders belong (#1687).
const DIRECT_MODEL = Object.freeze({
  research: 'opencode-go/mimo-v2.6-flash',
});

const ROLE_PROMPTS = Object.freeze({
  russian: {
    review: 'Ты строгий рецензент текстов о кандидатах. НЕ редактируй файлы — только читай и комментируй.\n\nПроверь подготовленный материал:\n1. Каждый факт должен подтверждаться источником — пометь всё, что взялось ниоткуда\n2. Роли, технологии, проекты, стаж — точное соответствие исходным данным\n3. Ничего важного не потеряно из интервью или транскрипта\n4. Нет необоснованных оценок кандидата\n5. Русский язык: живость, ясность, без канцелярита, без повторов\n6. Структура и объём соответствуют задаче\n\nВывод: пронумерованный список замечаний. В конце: LGTM / МИНОРНОЕ / КРИТИЧНО.',
  },
});

const PROFILES = Object.freeze([...Object.keys(PROFILE_LADDER), ...Object.keys(DIRECT_MODEL)]);

// Unknown profile → deepseek (the default ladder), never a local model list.
function ladderFor(profileName) {
  return PROFILE_LADDER[profileName] || (DIRECT_MODEL[profileName] ? null : 'deepseek');
}

function modelFor(profileName, role = 'build') {
  if (DIRECT_MODEL[profileName]) return DIRECT_MODEL[profileName];
  return `${PROVIDER_ID}/${ladderFor(profileName)}:${role}`;
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
});

function providerConfig() {
  const models = {};
  for (const ladder of new Set(Object.values(PROFILE_LADDER))) {
    for (const role of ROLES) models[`${ladder}:${role}`] = { name: `llm-ladder ${ladder}:${role}` };
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
  ROLES, PROFILES, PROFILE_LADDER, DIRECT_MODEL, PROVIDER_ID, TOKEN_ENV, TRACE_HEADERS,
  ladderFor, modelFor, providerConfig, buildOcProfileOverrides, ladderToken, classifyWorkerFailure,
};
