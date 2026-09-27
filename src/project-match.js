'use strict';
// Pinned chat, but the new task is clearly about ANOTHER project → ask instead of
// binding silently (owner, 2026-09-24: «нужно, если высокая уверенность, что проект другой»).
//
// The pin stays the default: we only leave it when a cheap classifier (gemini-2.5-flash
// via OpenRouter) is CONFIDENT the task belongs to a different existing project. Any
// doubt, short text, timeout or error → keep the pin (fail-safe = old behaviour).
// OpenRouter first, OpenAI gpt-4o-mini fallback (OpenRouter credits ran out on 2026-09-24).
// Even a confident mismatch never re-routes on its own: it turns 'auto' into 'ask'
// with the suggested project first and the pinned one second — the user decides.

const FALLBACK_MODEL = process.env.PROJECT_MATCH_FALLBACK_MODEL || 'gpt-4o-mini';
const DEFAULT_THRESHOLD = Number(process.env.PROJECT_MISMATCH_THRESHOLD) || 0.85;
const MIN_TASK_CHARS = 20; // «привет», «ок», «делай» carry no topic — never second-guess the pin

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function describeProject(p, pinnedId) {
  const s = p.summary || {};
  const sense = [s.start, s.middle, s.end].filter(Boolean).join(' / ');
  return `${p.id === pinnedId ? '[ЗАКРЕПЛЁН] ' : ''}id=${p.id} | ${clip(p.name || p.label || p.id, 80)} | тип ${p.type || 'generic'}${sense ? ` | ${clip(sense, 400)}` : ''}`;
}

const SYSTEM_PROMPT = [
  'Ты маршрутизатор задач по проектам пользователя ИИ-ассистента.',
  'Чат закреплён за одним проектом (помечен [ЗАКРЕПЛЁН]) — по умолчанию новая задача идёт туда.',
  'Твоя работа — заметить, когда задача ЯВНО про ДРУГОЙ проект из списка.',
  'Ответь СТРОГО JSON: {"projectId": "<id из списка>", "confidence": <0.1|0.5|0.9>, "reason": "<до 12 слов>"}.',
  'Шкала confidence (только эти три значения):',
  '  0.9 — в задаче есть конкретная тема/сущность (выставка, вакансия, клиент, продукт, сервис), которая совпадает с историей этого проекта и НЕ совпадает с закреплённым;',
  '  0.5 — задача скорее про этот проект, но прямого совпадения нет;',
  '  0.1 — задача общая/короткая/подходит нескольким проектам.',
  'Если задача про закреплённый проект или неясно — верни id закреплённого проекта.',
].join('\n');

// Pure: turn a decideNewSessionProject() result + classifier verdict into the response.
// Only a pinned 'auto' with a confident verdict for ANOTHER listed project changes anything.
function applyMismatch(decision, verdict, { threshold = DEFAULT_THRESHOLD, allProjects = [] } = {}) {
  if (!decision || decision.action !== 'auto' || !decision.pinned || !verdict) return decision;
  const pinned = decision.project;
  if (!verdict.projectId || verdict.projectId === pinned.id) return decision;
  if (!(Number(verdict.confidence) >= threshold)) return decision;
  const suggested = allProjects.find(p => p.id === verdict.projectId);
  if (!suggested) return decision;
  const rest = allProjects.filter(p => p.id !== suggested.id && p.id !== pinned.id);
  return {
    action: 'ask',
    choices: [suggested, pinned, ...rest],
    active: pinned.id,
    pinned: true,
    project: pinned,
    mismatch: { suggested: suggested.id, pinned: pinned.id, confidence: Number(verdict.confidence), reason: clip(verdict.reason, 120) },
  };
}

// Verdict object → normalized {projectId, confidence, reason} or null (garbage / unknown id).
function _verdict(v, projects) {
  if (!v || typeof v.projectId !== 'string' || !projects.some(p => p.id === v.projectId)) return null;
  const confidence = Math.max(0, Math.min(1, Number(v.confidence) || 0));
  return { projectId: v.projectId, confidence, reason: clip(v.reason, 120) };
}

// One provider call → parsed verdict or null (http error / garbage / unknown id).
async function _ask(url, key, model, projects, text, { timeoutMs, fetchImpl, pinnedId }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Проекты:\n${projects.map(p => describeProject(p, pinnedId)).join('\n')}\n\nЗадача:\n${text}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 80,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) { console.warn('[project-match] http', res.status, url.includes('openai.com') ? 'openai' : 'openrouter'); return undefined; }
  const data = await res.json();
  const raw = String(data.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return _verdict(JSON.parse(m[0]), projects);
}

// Returns {projectId, confidence, reason} or null. Never throws. Service-LLM ladder first
// (src/service-llm.js: Go rungs → OpenRouter last); if no rung answers and an OpenAI key exists →
// gpt-4o-mini.
async function classifyTaskProject(task, projects, { apiKey, openaiKey, timeoutMs = 3500, fetchImpl = fetch, pinnedId = null } = {}) {
  const serviceLlm = require('./service-llm');
  const orKey = apiKey || null;
  const oaKey = openaiKey || process.env.OPENAI_API_KEY;
  const text = clip(task, 1500);
  if ((!serviceLlm.available(orKey) && !oaKey) || text.length < MIN_TASK_CHARS || !Array.isArray(projects) || projects.length < 2) return null;
  // Deterministic order (pinned first, rest by id): list order used to swing the model's
  // confidence 0.7↔0.9 on the same task.
  const ordered = [...projects].sort((x, y) => (y.id === pinnedId) - (x.id === pinnedId) || String(x.id).localeCompare(String(y.id)));
  projects = ordered;
  const opts = { timeoutMs, fetchImpl, pinnedId };
  if (serviceLlm.available(orKey)) {
    try {
      const r = await serviceLlm.serviceChat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Проекты:\n${projects.map(p => describeProject(p, pinnedId)).join('\n')}\n\nЗадача:\n${text}` },
        ],
        json: true, maxTokens: 80, timeoutMs, totalTimeoutMs: timeoutMs + 2000, apiKey: orKey,
        source: 'project-match', fetchImpl: fetchImpl === fetch ? null : fetchImpl,
      });
      if (r) return _verdict(r.value, projects); // answered (verdict or garbage) — don't pay twice
    } catch (e) { console.warn('[project-match] service-llm:', e.message); }
  }
  if (oaKey) {
    try {
      return (await _ask('https://api.openai.com/v1/chat/completions', oaKey, FALLBACK_MODEL, projects, text, opts)) || null;
    } catch (e) { console.warn('[project-match] openai:', e.message); }
  }
  return null;
}

module.exports = { classifyTaskProject, applyMismatch, describeProject, DEFAULT_THRESHOLD, MIN_TASK_CHARS };
