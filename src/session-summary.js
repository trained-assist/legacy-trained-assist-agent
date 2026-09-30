// Durable per-session summaries.
//
// A session summary is a small, persisted artifact — {title, gist, ended, key_points}
// generated ONCE per meaningful change (message count grew) and written to disk
// (both the session file and the index). It is the single source of truth for
// session previews across surfaces: Telegram /sessions + "Подробнее N", and the
// web session manager (secondary consumer, reads the same field). Generating it
// once and storing it — rather than re-deriving a preview from raw messages on
// every render — is the whole point: previews stay stable, cheap, and bilingual.

const DEFAULT_MODEL = process.env.SESSION_SUMMARY_MODEL || 'google/gemini-2.5-flash';

// Build a compact transcript for the model: the opening (goal) + the tail (how it
// ended), each message clipped, total bounded. Keeps token cost predictable.
function buildTranscript(messages, { headMsgs = 2, tailMsgs = 10, perMsg = 700, total = 14000 } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, perMsg);
  let picked;
  if (messages.length <= headMsgs + tailMsgs) {
    picked = messages;
  } else {
    picked = [...messages.slice(0, headMsgs), { role: '_gap', content: `… (пропущено ${messages.length - headMsgs - tailMsgs} сообщений) …` }, ...messages.slice(-tailMsgs)];
  }
  const lines = picked.map((m) => {
    if (m.role === '_gap') return m.content;
    const who = m.role === 'user' ? 'Пользователь' : 'Ассистент';
    return `${who}: ${clip(m.content)}`;
  });
  let out = lines.join('\n');
  if (out.length > total) out = out.slice(0, total) + '\n… (обрезано) …';
  return out;
}

const SYSTEM_PROMPT = [
  'Ты кратко резюмируешь диалог пользователя с ИИ-ассистентом для списка сессий.',
  'Отвечай СТРОГО одним JSON-объектом без markdown-обёртки, с полями:',
  '- "title": короткий осмысленный заголовок сессии, до 60 символов (суть задачи, не первые слова).',
  '- "gist": 1-2 предложения — о чём сессия, что делали.',
  '- "ended": 1 предложение — чем закончилась / текущее состояние (сделано / ждёт / оборвалось).',
  '- "key_points": массив из 2-5 очень коротких пунктов (решения, артефакты, открытые хвосты).',
  'ВАЖНО: пиши на ТОМ ЖЕ языке, что и диалог (русский или английский). Не выдумывай факты — только из диалога.',
].join('\n');

function coerceSummary(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const title = String(obj.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const gist = String(obj.gist || '').trim().slice(0, 600);
  const ended = String(obj.ended || '').trim().slice(0, 400);
  let kp = Array.isArray(obj.key_points) ? obj.key_points : [];
  kp = kp.map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean).slice(0, 5);
  if (!title && !gist) return null;
  return { title: title || gist.slice(0, 60), gist, ended, key_points: kp };
}

// Generate a summary object for a session's messages. Returns null on any failure
// (no key, network, unparseable) — caller keeps the previous summary / topic fallback.
// Runs on the service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
// `ctx` (#1917) — {session, user} → x-ladder-* headers, so a summary call is queryable
// in the worker's D1 log per session/user (no ctx → no headers, as before).
async function generateSummary(messages, { apiKey, timeoutMs = 20000, ctx = null } = {}) {
  const serviceLlm = require('./service-llm');
  if (!serviceLlm.available(apiKey)) return null;
  const transcript = buildTranscript(messages);
  if (!transcript) return null;
  try {
    const parsed = await serviceLlm.serviceJson({
      system: SYSTEM_PROMPT,
      user: `Диалог:\n\n${transcript}\n\nВерни JSON-резюме.`,
      maxTokens: 600, temperature: 0.2, timeoutMs, apiKey, source: 'session-summary',
      ctx,
    });
    return parsed ? coerceSummary(parsed) : null;
  } catch (e) {
    console.warn('[session-summary] generate error:', e.message);
    return null;
  }
}

module.exports = { generateSummary, buildTranscript, coerceSummary, DEFAULT_MODEL };
