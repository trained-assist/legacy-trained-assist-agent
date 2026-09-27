'use strict';
// Durable project-level name + 3-sense summary.
//
// A PROJECT groups many sessions (see projects.js). Its display name and summary are
// small persisted artifacts on project.json, regenerated cheaply (gemini-2.5-flash via
// OpenRouter) as the project GROWS — so a project can be born with a provisional name
// and "mature" into a real one, exactly as it accumulates work. Mirrors the per-session
// summarizer (session-summary.js): generate ONCE per meaningful change, store it, and
// read the stored field everywhere (Telegram project picker, /project list, web UI).
//
// The summary has THREE senses (the user's ask, 2026-09-13):
//   start  — с чего проект начинался
//   middle — что делали в процессе (проект часто перетекает с темы на тему — это норма)
//   end    — где сейчас / чем закончили
// so a long, meandering project reads clearly and stray long messages never cost the
// user a mangled "первые-слова" name again.
//
// The project id/folder is IMMUTABLE — only the display `name` changes. Renaming the
// folder would break session cwd bindings + active-<chat> pointers, so we never touch it.

const DEFAULT_MODEL = process.env.PROJECT_SUMMARY_MODEL || process.env.SESSION_SUMMARY_MODEL || 'google/gemini-2.5-flash';

// Build a compact digest from a project's session summaries (oldest → newest). We feed
// the model the ALREADY-SUMMARIZED sessions (title/gist/ended), not raw transcripts —
// cheaper and the sessions are usually summarized already. Falls back to a session's
// topic when it has no summary yet. Head+tail bounded so cost stays predictable.
function buildProjectDigest(sessionMetas, { headSessions = 3, tailSessions = 14, total = 12000 } = {}) {
  const metas = (sessionMetas || []).filter(Boolean);
  if (metas.length === 0) return '';
  // oldest first — the model needs chronology to tell start from end.
  const ordered = [...metas].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let picked;
  if (ordered.length <= headSessions + tailSessions) {
    picked = ordered;
  } else {
    picked = [
      ...ordered.slice(0, headSessions),
      { _gap: ordered.length - headSessions - tailSessions },
      ...ordered.slice(-tailSessions),
    ];
  }
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = picked.map((m) => {
    if (m._gap) return `… (ещё ${m._gap} диалогов между) …`;
    const sm = m.summary || {};
    const title = clip(sm.title || m.topic || '', 90);
    const gist = clip(sm.gist, 200);
    const ended = clip(sm.ended, 140);
    let line = `• ${title}`;
    if (gist) line += ` — ${gist}`;
    if (ended) line += ` (итог: ${ended})`;
    return line;
  });
  let out = lines.join('\n');
  if (out.length > total) out = out.slice(0, total) + '\n… (обрезано) …';
  return out;
}

const SYSTEM_PROMPT = [
  'Ты именуешь и резюмируешь ПРОЕКТ — цепочку связанных рабочих диалогов пользователя с ИИ-ассистентом.',
  'Тебе дают краткие резюме диалогов проекта в хронологии (сверху — самые ранние).',
  'Отвечай СТРОГО одним JSON-объектом без markdown, с полями:',
  '- "name": короткое осмысленное название проекта, 2-6 слов, до 60 символов. Суть работы, НЕ первые слова первого сообщения. Без кавычек и точки в конце.',
  '- "summary": объект из трёх коротких смыслов:',
  '    "start"  — с чего проект начинался (1 фраза),',
  '    "middle" — что делали в процессе, основные темы (1-2 фразы; проект мог перетекать с темы на тему — это нормально, перечисли главное),',
  '    "end"    — где сейчас / чем закончили последним (1 фраза).',
  '- "type": один из "recruiting" (подбор/вакансии/интервью), "expo" (выставки/каталоги участников), "generic" (всё остальное).',
  'ВАЖНО: пиши на языке диалогов (обычно русский). Не выдумывай — только из данных. Название должно отличать этот проект от других.',
].join('\n');

function coerceProjectSummary(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const name = String(obj.name || '').replace(/\s+/g, ' ').replace(/^["'«»]+|["'«».]+$/g, '').trim().slice(0, 60);
  const s = obj.summary && typeof obj.summary === 'object' ? obj.summary : {};
  const clip = (x, n) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const summary = {
    start: clip(s.start, 200),
    middle: clip(s.middle, 320),
    end: clip(s.end, 200),
  };
  const type = ['recruiting', 'expo', 'generic'].includes(obj.type) ? obj.type : 'generic';
  if (!name && !summary.start && !summary.middle) return null;
  return { name: name || summary.start.slice(0, 60), summary, type };
}

// Generate {name, summary:{start,middle,end}, type} from a project's session metas.
// Returns null on any failure (caller keeps the previous name/summary). Never throws.
// Runs on the service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
async function generateProjectSummary(sessionMetas, { apiKey, timeoutMs = 25000 } = {}) {
  const serviceLlm = require('./service-llm');
  if (!serviceLlm.available(apiKey)) return null;
  const digest = buildProjectDigest(sessionMetas);
  if (!digest) return null;
  try {
    const parsed = await serviceLlm.serviceJson({
      system: SYSTEM_PROMPT,
      user: `Диалоги проекта (хронология):\n\n${digest}\n\nВерни JSON: name + summary{start,middle,end} + type.`,
      maxTokens: 500, temperature: 0.2, timeoutMs, apiKey, source: 'project-summary',
    });
    return parsed ? coerceProjectSummary(parsed) : null;
  } catch (e) {
    console.warn('[project-summary] generate error:', e.message);
    return null;
  }
}

module.exports = { generateProjectSummary, buildProjectDigest, coerceProjectSummary, DEFAULT_MODEL };
