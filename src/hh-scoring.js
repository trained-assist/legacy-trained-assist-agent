'use strict';
const { buildResumeText, resumeHash, RESUME_VERSION } = require('./hh-resume');

// Pure scoring utilities — no global state, no USER_ID dependency.
// Used by both 90-hh.js MCP tool and server.js /hh/review endpoint.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, loadBaseOverride } = require('./hh-message-prompts');

const FALLBACK_MODEL = 'google/gemini-2.5-flash';

const CHINESE_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/;

function hasGarbage(text) {
  if (!text) return false;
  return CHINESE_RE.test(text) || text.includes('�');
}

function isCleanResult(llmResult) {
  if (hasGarbage(llmResult.reasoning)) return false;
  if ((llmResult.strong || []).some(s => hasGarbage(s))) return false;
  if ((llmResult.missing || []).some(m => hasGarbage(m))) return false;
  return true;
}

// LLM transport/key helpers live in the platform client (epic #1470).
const { llmCall, gcCall, readGigachatKey, readOrKey, parseLlmJson } = require('./llm-client');

function buildAtsPrompt(config) {
  // Support all config shapes: must_have/nice_to_have, required/preferred, knockout/required_skills/preferred_skills
  const mustHave = config.must_have?.length ? config.must_have
    : config.required?.length ? config.required.map(c => c.name || c.criterion || c)
    : [
        ...(config.knockout || []).map(k => k.criterion || k),
        ...(config.required_skills || []).map(s => s.skill || s),
      ];
  const niceToHave = config.nice_to_have?.length ? config.nice_to_have
    : config.preferred?.length ? config.preferred.map(c => c.name || c)
    : (config.preferred_skills || []).map(s => s.skill || s);

  const mustList = mustHave.map(r => `  - ${r}`).join('\n') || '  (не указано)';
  const niceList = niceToHave.map(r => `  - ${r}`).join('\n') || '  (не указано)';

  const expNote = config.experience_min_years
    ? `\nМинимальный опыт: ${config.experience_min_years} лет — снижай балл если меньше, но не обнуляй за одно это.`
    : '';

  const ctx = config.vacancy_context || config.profile || '';
  return `Ты — опытный рекрутер. Оцени кандидата для позиции: ${config.vacancy_title || config.title}.
Контекст: ${ctx}${expNote}

ОБЯЗАТЕЛЬНЫЕ требования (отсутствие каждого снижает оценку):
${mustList}

ЖЕЛАТЕЛЬНЫЕ навыки (наличие повышает оценку):
${niceList}

ШКАЛА ОЦЕНКИ (1–10, абсолютная — не подгоняй под пул):
  9–10: Идеальное совпадение — все обязательные + большинство желательных, сильные примеры
  7–8:  Хорошее совпадение — большинство обязательных подтверждены, есть желательные
  5–6:  Частичное совпадение — часть обязательных есть, остальное неясно из резюме
  3–4:  Слабое совпадение — мало обязательных, или опыт не релевантен роли
  1–2:  Не подходит — явное несоответствие ключевым требованиям

ВАЖНО: Данные HH-резюме могут быть краткими. Если навык не упомянут — ставь низкий балл, но не 0 за одно только отсутствие упоминания. 0 — только явное несоответствие.

Отвечай ТОЛЬКО JSON без markdown. Пиши человекочитаемые фразы, не названия полей:
{
  "score": 7.5,
  "strong": ["3 года в private banking БКС", "Собственная база 20+ HNWI-клиентов", "AUM 800 млн ₽"],
  "missing": ["Опыт 3.5 года — требуется от 6", "Не подтверждён средний чек клиента"],
  "reasoning": "2–3 предложения: общее впечатление и главный аргумент за/против"
}`;
}

function computeScore(llmResult, config) {
  const score = Math.round(Math.max(0, Math.min(10, llmResult.score || 0)) * 2) / 2;
  const passThreshold = config.pass_threshold || config.thresholds?.strong || 7;
  const reviewThreshold = config.review_threshold || config.thresholds?.consider || 5;
  let verdict;
  if (score >= passThreshold) verdict = 'ПРОПУСТИТЬ';
  else if (score >= reviewThreshold) verdict = 'УТОЧНИТЬ';
  else verdict = 'ОТКЛОНИТЬ';

  return {
    score,
    verdict,
    matched: llmResult.strong || [],
    gaps: llmResult.missing || [],
    reasoning: llmResult.reasoning || '',
  };
}

// ─── evaluateCandidate: GigaChat → Gemini fallback ───────────────────────────

async function evaluateCandidate(candidateText, atsConfig, apiKey, gigachatKey) {
  const messages = [
    { role: 'system', content: buildAtsPrompt(atsConfig) },
    { role: 'user', content: `Оцени кандидата:\n\n${candidateText}` },
  ];

  // Primary: GigaChat (free, no Chinese garbage)
  if (gigachatKey) {
    try {
      const content = await gcCall(gigachatKey, messages, 2000, 0.1);
      const llmResult = parseLlmJson(content);
      if (isCleanResult(llmResult)) return computeScore(llmResult, atsConfig);
      console.warn('[hh-scoring] GigaChat returned garbage, falling back to Gemini');
    } catch (e) {
      console.warn(`[hh-scoring] GigaChat failed: ${e.message}, falling back to Gemini`);
    }
  }

  // Fallback: Gemini via OpenRouter
  if (!apiKey) throw new Error('No LLM credentials available');
  const content = await llmCall(apiKey, FALLBACK_MODEL, messages, 2000, 0.1);
  const llmResult = parseLlmJson(content);
  return computeScore(llmResult, atsConfig);
}

// ─── Read tokens ──────────────────────────────────────────────────────────────

function readAtsConfigFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let value = data?.value || null;
    // Guard: context_set sometimes stores value as JSON string instead of object
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return value;
  } catch { return null; }
}

function readAtsConfig(workDir, expectedVacancyId = null) {
  // Per-vacancy config (ats_config:{vacancy_id}.json) is the multi-vacancy path —
  // recruiters tracking several vacancies at once (hh_set_active_vacancy) save one
  // config per vacancy so the background loop can score each independently instead
  // of sharing a single global config across whichever vacancy was set last.
  if (expectedVacancyId) {
    const perVacancy = readAtsConfigFile(path.join(workDir, 'contexts', 'hh', `ats_config:${expectedVacancyId}.json`));
    if (perVacancy) return perVacancy;
  }
  // Legacy singleton — still the only config for profiles tracking one vacancy.
  const value = readAtsConfigFile(path.join(workDir, 'contexts', 'hh', 'ats_config.json'));
  if (!value) return null;
  // Guard: config was extracted for a different vacancy and never regenerated after
  // hh_set_active_vacancy switched — using it here would silently score the wrong
  // vacancy's candidates against the wrong criteria.
  if (value?.vacancy_id && expectedVacancyId && value.vacancy_id !== expectedVacancyId) {
    console.warn(`[hh-scoring] skipping: ats_config is for vacancy ${value.vacancy_id}, active vacancy is ${expectedVacancyId} — regenerate via hh_extract_ats_config`);
    return null;
  }
  return value;
}

// Draft extracted by hh_extract_ats_config, pending recruiter review in /hh/ats-editor.
// Kept separate from the live ats_config:{id} file so an LLM-generated first pass never
// goes live for background scoring before a human has looked at it in the editor.
function readAtsDraft(workDir, vacancyId) {
  const file = vacancyId
    ? path.join(workDir, 'contexts', 'hh', `ats_config_draft:${vacancyId}.json`)
    : path.join(workDir, 'contexts', 'hh', 'ats_config_draft.json');
  return readAtsConfigFile(file);
}

// ─── Candidate history ────────────────────────────────────────────────────────

function candidateHistoryPath(username, negotiationId) {
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  return path.join(dataDir, 'hh', String(username), 'candidates', `${negotiationId}.json`);
}

function readCandidateHistory(username, negotiationId) {
  const file = candidateHistoryPath(username, negotiationId);
  if (!fs.existsSync(file)) return { messages: [], ats_result: null };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { messages: [], ats_result: null }; }
}

function saveCandidateHistory(username, negotiationId, data) {
  const file = candidateHistoryPath(username, negotiationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ─── Batch scoring: GigaChat primary ─────────────────────────────────────────

async function scoreUnscoredCandidates(negotiations, username, workDir, { maxConcurrent = 5, msgSyncStats = null, vacancyId = null } = {}) {
  const atsConfig = readAtsConfig(workDir, vacancyId);
  if (!atsConfig) return 0;

  const gigachatKey = readGigachatKey(username);
  const apiKey = readOrKey(username);
  if (!gigachatKey && !apiKey) return 0;

  const unscored = negotiations.filter(neg => {
    if (neg._resume_status !== 'full') return false;
    const history = readCandidateHistory(username, neg.id);
    if (neg._resume_status === 'full' && (history.ats_result?.resume_version !== RESUME_VERSION || history.ats_result?.resume_hash !== resumeHash(neg))) return true;
    if (history.ats_result?.score == null) return true; // not scored yet
    // re-score if candidate replied after last scoring
    const scoredAt = history.ats_result.scored_at || 0;
    const lastCandMsg = [...(history.messages || [])].reverse().find(m => m.role === 'applicant');
    if (!lastCandMsg) return false;
    return new Date(lastCandMsg.timestamp || 0).getTime() > scoredAt;
  });

  const writeLog = (checked, scored) => {
    try {
      const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
      const dir = path.join(dataDir, 'hh', String(username));
      fs.mkdirSync(dir, { recursive: true });
      const entry = {
        at: Date.now(),
        checked,
        scored,
        // message sync stats from background loop (null when called from tests/manual)
        ...(msgSyncStats ? {
          with_new_messages: msgSyncStats.synced,
          new_messages_loaded: msgSyncStats.newMessages,
        } : {}),
      };
      // last-scoring.json — single entry for quick read
      fs.writeFileSync(path.join(dir, 'last-scoring.json'), JSON.stringify(entry), { mode: 0o600 });
      // sync-log.json — rolling last 50 entries
      const logPath = path.join(dir, 'sync-log.json');
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { /* first run */ }
      entries.unshift(entry);
      if (entries.length > 50) entries.length = 50;
      fs.writeFileSync(logPath, JSON.stringify(entries), { mode: 0o600 });
    } catch { /* non-critical */ }
  };

  if (!unscored.length) {
    writeLog(negotiations.length, 0);
    return 0;
  }

  let scored = 0;
  for (let i = 0; i < unscored.length; i += maxConcurrent) {
    const batch = unscored.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const history = readCandidateHistory(username, neg.id);
        const candMsgs = (history.messages || []).filter(m => m.role === 'applicant');
        const resumeText = buildResumeText(neg, candMsgs);
        const result = await module.exports.evaluateCandidate(resumeText, atsConfig, apiKey, gigachatKey);
        if (result.score != null) {
          result.scored_at = Date.now();
          result.resume_version = RESUME_VERSION;
          result.resume_hash = resumeHash(neg);
          history.ats_result = result;
          saveCandidateHistory(username, neg.id, history);
          scored++;
        }
      } catch (e) {
        console.error(`[hh-scoring] failed to score ${neg.id}:`, e.message);
      }
    }));
  }

  writeLog(unscored.length, scored);
  return scored;
}

// ─── Draft generation: GigaChat primary ──────────────────────────────────────

async function generateDraftMessages(negotiations, username, workDir, { maxConcurrent = 3, vacancyId = null } = {}) {
  const atsConfig = readAtsConfig(workDir, vacancyId);
  if (!atsConfig) return 0;

  const gigachatKey = readGigachatKey(username);
  const apiKey = readOrKey(username);
  if (!gigachatKey && !apiKey) return 0;

  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const styleFile = path.join(tokensBase, String(username), 'hh-message-style');
  const commStyle = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, 'utf8').trim() : null;
  const baseOverride = loadBaseOverride(tokensBase, username);

  // Read recruiter identity config (agency, name, signature, rules)
  let msgCfg = null;
  try {
    const msgCfgFile = path.join(workDir, 'contexts', 'hh', 'message_config.json');
    if (fs.existsSync(msgCfgFile)) {
      const raw = JSON.parse(fs.readFileSync(msgCfgFile, 'utf8'));
      let val = raw?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      if (val && typeof val === 'object') msgCfg = val;
    }
  } catch { /* ignore */ }
  const recruiterCtx = buildRecruiterIdentity(msgCfg);
  const availabilityBlock = buildAvailabilityBlock(atsConfig.interview_config);

  const vacancyCtx = atsConfig.vacancy_title && atsConfig.vacancy_context
    ? `Вакансия: ${atsConfig.vacancy_title}\n\n${atsConfig.vacancy_context}`
    : '';

  const needDraft = negotiations.filter(neg => {
    if (neg._resume_status !== 'full') return false;
    const h = readCandidateHistory(username, neg.id);
    // Rejections use the fixed standard text rendered on the review page — never an
    // LLM draft. Generated "rejections" produced invitations, "[Имя]" placeholders
    // and wrong-name greetings that a single click could send to a candidate.
    if (h.ats_result?.verdict === 'ОТКЛОНИТЬ') return false;
    return h.ats_result?.score != null && !h.ats_result?.draft_message;
  });

  if (!needDraft.length) return 0;

  const baseSystem = buildMessageSystemPrompt({ vacancyContext: vacancyCtx, recruiterCtx, commStyle, baseOverride });

  let generated = 0;

  for (let i = 0; i < needDraft.length; i += maxConcurrent) {
    const batch = needDraft.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(async (neg) => {
      try {
        const history = readCandidateHistory(username, neg.id);

        const r = neg.resume || {};
        const firstName = r.first_name || r.last_name || 'Кандидат';

        const systemPrompt = baseSystem;

        const resumeText = buildResumeText(neg);
        const userMsg = `Напиши первое сообщение кандидату ${firstName}.\n\nРезюме:\n${resumeText}${availabilityBlock}`;

        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ];

        let message = null;

        // Primary: GigaChat
        if (gigachatKey) {
          try {
            message = await gcCall(gigachatKey, messages, 600, 0.7);
            if (hasGarbage(message)) {
              console.warn(`[hh-drafts] GigaChat returned garbage for ${neg.id}, falling back`);
              message = null;
            }
          } catch (e) {
            console.warn(`[hh-drafts] GigaChat failed for ${neg.id}: ${e.message}, falling back`);
          }
        }

        // Fallback: Gemini
        if (!message && apiKey) {
          message = await llmCall(apiKey, FALLBACK_MODEL, messages, 600, 0.7);
          if (hasGarbage(message)) throw new Error('Gemini fallback returned garbage');
        }

        if (!message) throw new Error('No LLM credentials produced a result');

        history.ats_result.draft_message = message.trim();
        saveCandidateHistory(username, neg.id, history);
        generated++;
      } catch (e) {
        console.error(`[hh-drafts] failed to generate draft for ${neg.id}:`, e.message);
      }
    }));
  }

  return generated;
}

module.exports = {
  FALLBACK_MODEL,
  llmCall,
  gcCall,
  parseLlmJson,
  buildAtsPrompt,
  computeScore,
  evaluateCandidate,
  readAtsConfig,
  readAtsDraft,
  readOrKey,
  readGigachatKey,
  readCandidateHistory,
  saveCandidateHistory,
  buildResumeText,
  scoreUnscoredCandidates,
  generateDraftMessages,
};
