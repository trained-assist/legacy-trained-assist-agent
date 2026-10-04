'use strict';
// Judge for a durable step reply WITHOUT a terminal DURABLE marker (#1907).
//
// Audit 2026-09-30 (docs/audits/playbook-background-execution-audit-2026-09-30.md §3.2):
// 94% of OpenCode step failures (174/186) were `no DURABLE terminal marker` — the agent
// DID the work (its reply contains «ИТОГ ШАГА», PR/issue links) but never printed the
// final `DURABLE: done` line. The attempt was burned, retried, and on attempt 3 the
// quality path escalated bachelor/master → doctor (Claude): 66 expensive escalations for
// a protocol miss, not a content failure.
//
// Two reply classes must be told apart BEFORE the marker check decides anything:
//   1. an engine/infra failure the runner returned AS the reply («Процесс завершился с
//      ошибкой», dead llm-ladder, auth loss, …) — not the agent's answer at all; it must
//      recover like a crash (no quality escalation, backoff) — #1908;
//   2. a real agent answer that only forgot the marker — one cheap service-LLM judge call
//      decides done / failed / uncertain instead of burning the attempt.
//
// The judge NEVER bypasses deterministic checks: verdict 'done' routes through the same
// `DURABLE: done` path (recordItemValidations → blocking-gate → complete), so a failing
// registered check still fails the step (#1861 gate intact).

// Texts the runner returns as a failed run (crash, dead ladder, auth, interrupted run).
// Kept narrow on purpose: agent prose about an error may still be a content failure and
// belongs to the judge, not to the infra path.
const ENGINE_FAILURE_RES = [
  /Процесс (?:снова )?завершился с ошибкой/i,
  /⚡ Быстрый сбой/i,
  /Работа прервана \(/i,
  /Не удалось запустить или завершить работу/i,
  /Не удалось продолжить сессию движка/i,
  /Не удалось восстановить сессию после перезапуска/i,
  /Восстановление после перезапуска сервера не удалось/i,
  /llm-ladder (?:недоступен|unreachable)/i,
  /вся лестница моделей/i,
  /все ступени отказали/i,
  /every rung failed/i,
  /ladder_exhausted/i,
  /purchase more credits|usage limit/i,
  /not logged in|please run \/login|invalid[_\s-]?api[_\s-]?key|authentication failed/i,
  /Авторизация \S+ истекла/i,
  /Не удалось принять задачу/i,
  // #1911: killed by the step's own budget — deterministic class, never the judge.
  /Шаг не уложился в бюджет|step timeout: \d+s budget exhausted|Движок молчал 5 мин|inactivity timeout: no output/i,
];

const SUBSTANTIAL_RE = /ИТОГ ШАГА/i;
// A reply too short to contain real work is not worth a judge call (and never worth
// an escalation): retry at the same level with the reason in the input.
const MIN_JUDGE_CHARS = 200;

// A reply that summarizes real work («ИТОГ ШАГА») is the AGENT's answer even when it
// quotes an engine error — it goes to the judge. Runner failures never contain a
// step summary: they are the runner's own fixed messages.
function looksLikeEngineFailure(text) {
  const t = String(text || '');
  if (SUBSTANTIAL_RE.test(t)) return false;
  return ENGINE_FAILURE_RES.some(re => re.test(t));
}

const SYSTEM_PROMPT = [
  'Ты проверяешь, выполнен ли шаг фонового плейбука. Агент обязан был завершить ответ строкой',
  'DURABLE: done / DURABLE: failed / DURABLE: waiting, но не сделал этого.',
  'По ответу агента реши, был ли ШАГ ВЫПОЛНЕН.',
  'Ответь строго JSON: {"verdict":"done"|"failed"|"uncertain","reason":"до 120 символов"}.',
  'done — работа явно сделана и подтверждена (итог, ссылки на PR/issue/файлы/результаты проверок).',
  'failed — агент явно не справился, сообщил об ошибке или ничего не сделал.',
  'uncertain — ответ обрезан, мало деталей, непонятно, сделана ли работа.',
  'Если сам не уверен — выбирай uncertain.',
].join(' ');

function buildUserPrompt({ task, item, said }) {
  return [
    `Task goal: ${task.goal || '(none)'}`,
    `Step (${(item.position ?? 0) + 1}): ${item.title || '(untitled)'}`,
    item.instructions ? `Step instructions: ${item.instructions}` : '',
    item.validation_json ? `Validation contract: ${item.validation_json}` : '',
    `Agent reply (tail):\n${String(said).slice(-4000)}`,
  ].filter(Boolean).join('\n');
}

function normalizeVerdict(obj, reason) {
  const v = obj && typeof obj === 'object' ? obj.verdict : null;
  if (v === 'done' || v === 'failed' || v === 'uncertain') {
    return { verdict: v, reason: String(obj.reason || reason || '').slice(0, 200) };
  }
  return { verdict: 'uncertain', reason: reason || (v ? `bad-verdict:${String(v).slice(0, 40)}` : 'bad-json') };
}

/**
 * Decide what a markerless reply means.
 *
 * @param {object}   o
 * @param {string}   o.said       the raw reply
 * @param {object}   o.item       task_items row
 * @param {object}   o.task       durable_tasks row
 * @param {number}   [o.timeoutMs] per-run budget for the judge call
 * @param {object}   [o.serviceLlm] injectable service-llm module (tests)
 * @returns {Promise<{verdict:'done'|'failed'|'uncertain', reason:string}>}
 *   'uncertain' with a machine reason is returned WITHOUT any LLM call for the
 *   empty/too-short/no-provider cases — the caller then retries at the same level.
 */
async function judgeMarkerlessReply({ said, item, task, timeoutMs = 15000, serviceLlm = null, ctx = null } = {}) {
  const text = String(said || '');
  // Engine/infra failures are decided deterministically — never by the judge (#1908).
  if (looksLikeEngineFailure(text)) return { verdict: 'failed', reason: 'engine-failure-text' };
  if (!text.trim()) return { verdict: 'uncertain', reason: 'empty-reply' };
  if (!SUBSTANTIAL_RE.test(text) && text.trim().length < MIN_JUDGE_CHARS) {
    return { verdict: 'uncertain', reason: 'too-short' };
  }
  const llm = serviceLlm || require('./service-llm');
  if (!llm.available()) return { verdict: 'uncertain', reason: 'no-llm-provider' };
  try {
    const r = await llm.serviceJson({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ task, item, said: text }),
      maxTokens: 80,
      timeoutMs,
      totalTimeoutMs: timeoutMs + 5000,
      source: 'durable-marker-judge',
      // Attribution: the verdict decides whether a durable step passed, so the rung trace
      // belongs to that step — `item`/`task` identify it even with no surrounding request.
      ctx: ctx || { trace: (item && (item.id || item.itemId)) || task || null },
    });
    if (!r) return { verdict: 'uncertain', reason: 'llm-unavailable' };
    // serviceJson returns the PARSED VALUE already (service-llm.js unwraps `value`
    // itself). Reading `.value` here asked for `undefined` on every real reply, so
    // the judge answered `uncertain` forever and the rescue never once fired.
    return normalizeVerdict(r, 'llm-no-json');
  } catch (e) {
    return { verdict: 'uncertain', reason: `llm-error:${String(e.message).slice(0, 80)}` };
  }
}

module.exports = { judgeMarkerlessReply, looksLikeEngineFailure, ENGINE_FAILURE_RES };
