'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createHmac } = require('crypto');

const USER_ID = process.env.USER_ID || '';

// ── Helpers ────────────────────────────────────────────────────────────────

function sessionDir() {
  // Call Tips data lives in the profile workspace (USERS_ROOT/<u>), not the
  // legacy SYSTEM_ROOT/sessions tree — same root the /calltips-session endpoint reads.
  return require('../../data-paths').userWorkDir(USER_ID);
}

function tokenBase() {
  return process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
}

function readHhToken() {
  const { readHhToken: read } = require('../../domains/hh/lib').hhLib('hh-utils');
  return read(USER_ID);
}

// Scoped token for the Call Tips desktop app — bound to this profile only,
// never the master AGENT_SECRET. Mirrors calltipsHmac() in src/server.js.
function calltipsHmac(profile) {
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(`calltips:${profile}`).digest('hex').slice(0, 24);
}

function hhRequest(method, apiPath, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hh.ru',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'trained-assist-agent/1.0 (kobzevvv@gmail.com)',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HH parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HH request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hhGet(apiPath, token) {
  return hhRequest('GET', apiPath, token.access_token);
}

function openrouterCall(messages, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return reject(new Error('OPENROUTER_API_KEY not set'));
    const body = JSON.stringify({
      model: 'google/gemini-2.5-flash-lite',
      max_tokens: maxTokens,
      messages,
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'calltips-plan',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content || '';
          resolve(text);
        } catch { reject(new Error('OpenRouter parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Get active vacancy ─────────────────────────────────────────────────────

async function getActiveVacancy(token) {
  const me = await hhGet('/me', token);
  const employerId = token.employer_id || me.employer?.id;
  if (!employerId) return null;
  const data = await hhGet(`/employers/${employerId}/vacancies/active`, token);
  return data.items?.[0] || null;
}

// ── Search candidate by name in negotiations ───────────────────────────────

async function findCandidateByName(token, vacancyId, namePart) {
  const query = namePart.toLowerCase();
  for (const state of ['response', 'invitation', 'discard']) {
    try {
      const data = await hhGet(
        `/negotiations/${state}?vacancy_id=${vacancyId}&per_page=50`,
        token
      );
      const found = (data.items || []).find(n => {
        const r = n.resume || {};
        const full = [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ').toLowerCase();
        return full.includes(query);
      });
      if (found) return found;
    } catch {}
  }
  return null;
}

// ── Format resume text ─────────────────────────────────────────────────────

function buildResumeText(negotiation) {
  const resume = negotiation.resume || {};
  const name = [resume.last_name, resume.first_name, resume.middle_name].filter(Boolean).join(' ');
  const lines = [];

  if (resume.title) lines.push(`Позиция: ${resume.title}`);
  if (resume.total_experience?.months) {
    const y = Math.floor(resume.total_experience.months / 12);
    const m = resume.total_experience.months % 12;
    lines.push(`Опыт: ${y} лет${m ? ' ' + m + ' мес' : ''}`);
  }
  if (resume.area?.name) lines.push(`Локация: ${resume.area.name}`);
  if (resume.salary) lines.push(`Зарплата: ${resume.salary.amount?.toLocaleString('ru-RU')} ${resume.salary.currency}`);

  if (resume.experience?.length) {
    lines.push('\nОпыт работы:');
    for (const job of resume.experience.slice(0, 6)) {
      const start = job.start?.slice(0, 7) || '';
      const end = job.end?.slice(0, 7) || 'н.в.';
      lines.push(`- ${job.company || ''} (${start}–${end}): ${job.position || ''}`);
      if (job.description) lines.push(`  ${job.description.slice(0, 400)}`);
    }
  }
  if (resume.skill_set?.length) lines.push(`\nНавыки: ${resume.skill_set.slice(0, 30).join(', ')}`);
  if (resume.education?.primary?.length) {
    const edu = resume.education.primary[0];
    lines.push(`\nОбразование: ${edu.name || ''}, ${edu.organization || ''} (${edu.year || ''})`);
  }
  if (negotiation.message) lines.push(`\nСопроводительное письмо:\n${negotiation.message.slice(0, 600)}`);

  return { name, text: lines.join('\n') };
}

// ── Generate interview plan ────────────────────────────────────────────────

async function generatePlan(candidateName, resumeText, jobText, duration) {
  const qCount = duration < 20 ? 4 : duration < 45 ? 8 : 14;
  const prompt = `Ты опытный рекрутер. Составь структурированный план интервью на ${duration} минут.

Кандидат: ${candidateName}
РЕЗЮМЕ:
${resumeText.slice(0, 3000)}

ВАКАНСИЯ / ТЕМА:
${(jobText || '').slice(0, 1500)}

Сгенерируй ${qCount} вопросов в 3 блоках. Для каждого вопроса — конкретный уточняющий followUp.

Верни ТОЛЬКО JSON (без обёрток, без markdown):
{"sections":[{"category":"technical","title":"Профессиональный опыт","questions":[{"text":"...","followUp":"..."}]},{"category":"soft","title":"Soft Skills","questions":[...]},{"category":"situational","title":"Ситуационные","questions":[...]}]}`;

  const raw = await openrouterCall([{ role: 'user', content: prompt }], 2000);
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(clean);
}

// ── Load pre-generated plan from calltips-plans/ ──────────────────────────

function loadPreGeneratedPlan(candidateName) {
  const plansDir = path.join(sessionDir(), 'calltips-plans');
  if (!fs.existsSync(plansDir)) return null;
  const query = candidateName.toLowerCase();
  for (const file of fs.readdirSync(plansDir)) {
    if (!file.endsWith('.json')) continue;
    // slug is "фамилия-имя.json" — check if query words are all present in slug
    const slug = file.replace(/\.json$/, '');
    const slugWords = slug.split('-').filter(Boolean);
    const queryWords = query.split(/\s+/).filter(w => w.length > 1);
    if (queryWords.every(qw => slugWords.some(sw => sw.startsWith(qw)))) {
      try { return JSON.parse(fs.readFileSync(path.join(plansDir, file), 'utf8')); }
      catch {}
    }
  }
  return null;
}

// ── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  isReady: () => true,

  tools: {
    calltips_get_login: {
      description: 'Get the Call Tips desktop app login for this user: profile name + a scoped token (NOT the master agent secret). Use when user asks "как залогинить call tips", "дай токен для call tips", "подключи приложение для звонков", or after they report the app logged in as someone else / wrong profile.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const agentUrl = (process.env.AGENT_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
        const token = calltipsHmac(USER_ID);
        return {
          agentUrl,
          profile: USER_ID,
          token,
          message: `Открой Call Tips → Настройки и введи:\nURL агента: ${agentUrl}\nПрофиль: ${USER_ID}\nТокен: ${token}\n\nЭто токен только для звонков этого профиля — не мастер-пароль агента, им нельзя зайти в чужой профиль. Если приложение уже залогинено под чужим именем — нажми «Выйти» в Call Tips и войди этими данными.`,
        };
      },
    },

    calltips_prepare: {
      description: 'Prepare a Call Tips interview plan for a candidate. Fetches their HH resume, generates structured question plan, and saves it so the Call Tips app can load it with "📥 Из агента". Use when user says "подготовь план для звонка с [имя]" or "подготовь интервью с [имя]".',
      inputSchema: {
        type: 'object',
        properties: {
          candidate_name: {
            type: 'string',
            description: 'Full name or partial name of the candidate (will be searched in HH responses)',
          },
          vacancy_id: {
            type: 'string',
            description: 'Optional: specific HH vacancy ID. If omitted, uses the most recent active vacancy.',
          },
          duration: {
            type: 'number',
            description: 'Interview duration in minutes. Default: 30.',
          },
          lang: {
            type: 'string',
            description: 'Interview language: ru or en. Default: ru.',
          },
        },
        required: ['candidate_name'],
      },
      handler: async ({ candidate_name, vacancy_id, duration = 30, lang = 'ru' }) => {
        // 0. Check pre-generated plans first (fast path, no HH/LLM calls)
        const preGen = loadPreGeneratedPlan(candidate_name);
        if (preGen) {
          const dir = sessionDir();
          fs.mkdirSync(dir, { recursive: true });
          const filePath = path.join(dir, 'calltips-latest.json');
          fs.writeFileSync(filePath, JSON.stringify(preGen, null, 2));
          const totalQ = preGen.plan?.sections?.reduce((n, s) => n + s.questions.length, 0) || 0;
          return {
            ok: true,
            source: 'pre-generated',
            candidateName: preGen.candidateName,
            vacancyName: preGen.vacancyName || '',
            totalQuestions: totalQ,
            sections: preGen.plan?.sections?.map(s => ({ title: s.title, count: s.questions.length })),
            message: `✅ Загружен готовый план: ${totalQ} вопросов для ${preGen.candidateName}.\nОткрой Call Tips → «📥 Из агента» и начинай.`,
          };
        }

        const token = readHhToken();
        if (!token) return { error: 'HH не подключён. Используй hh_connect.' };

        // 1. Get active vacancy
        let vacancy = null;
        let vacId = vacancy_id;
        if (!vacId) {
          vacancy = await getActiveVacancy(token);
          if (!vacancy) return { error: 'Нет активных вакансий на HH. Создай вакансию или укажи vacancy_id.' };
          vacId = vacancy.id;
        } else {
          try { vacancy = await hhGet(`/vacancies/${vacId}`, token); } catch {}
        }

        const jobText = vacancy ? `${vacancy.name}\n\n${(vacancy.description || '').replace(/<[^>]+>/g, ' ').slice(0, 2000)}` : '';

        // 2. Find candidate in negotiations
        const neg = await findCandidateByName(token, vacId, candidate_name);
        if (!neg) {
          return {
            error: `Кандидат "${candidate_name}" не найден в откликах на вакансию "${vacancy?.name || vacId}". Проверь написание имени или vacancy_id.`,
            hint: 'Используй calltips_list_candidates чтобы увидеть список кандидатов.',
          };
        }

        // 3. Build resume context
        const { name: fullName, text: resumeText } = buildResumeText(neg);

        // 4. Generate plan via OpenRouter (cheap model)
        const plan = await generatePlan(fullName, resumeText, jobText, duration);

        // 5. Write calltips-latest.json
        const dir = sessionDir();
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'calltips-latest.json');
        const payload = {
          candidateName: fullName,
          resumeText,
          jobText,
          lang,
          duration,
          plan,
          generatedAt: new Date().toISOString(),
          hhNegotiationId: neg.id,
          hhVacancyId: vacId,
        };
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

        const totalQ = plan.sections?.reduce((n, s) => n + s.questions.length, 0) || 0;
        return {
          ok: true,
          source: 'generated',
          candidateName: fullName,
          vacancyName: vacancy?.name || vacId,
          totalQuestions: totalQ,
          sections: plan.sections?.map(s => ({ title: s.title, count: s.questions.length })),
          message: `✅ План готов: ${totalQ} вопросов для ${fullName}.\nОткрой Call Tips → «📥 Из агента» и начинай.`,
        };
      },
    },

    calltips_list_candidates: {
      description: 'List candidates with HH responses ready to prepare interview plans for. Use when user asks "кто откликнулся", "покажи кандидатов", "список откликов".',
      inputSchema: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', description: 'Optional: specific vacancy ID.' },
          state: { type: 'string', description: 'Filter: response | invitation | all. Default: all.' },
        },
      },
      handler: async ({ vacancy_id, state = 'all' } = {}) => {
        const token = readHhToken();
        if (!token) return { error: 'HH не подключён. Используй hh_connect.' };

        let vacId = vacancy_id;
        let vacancyName = '';
        if (!vacId) {
          const vac = await getActiveVacancy(token);
          if (!vac) return { error: 'Нет активных вакансий на HH.' };
          vacId = vac.id;
          vacancyName = vac.name;
        }

        const states = state === 'all' ? ['response', 'invitation'] : [state];
        const candidates = [];
        for (const s of states) {
          try {
            const data = await hhGet(`/negotiations/${s}?vacancy_id=${vacId}&per_page=50`, token);
            for (const neg of data.items || []) {
              const r = neg.resume || {};
              const name = [r.last_name, r.first_name].filter(Boolean).join(' ') || 'Кандидат';
              candidates.push({
                name,
                state: s,
                title: r.title || '',
                location: r.area?.name || '',
                negotiation_id: neg.id,
              });
            }
          } catch {}
        }

        return {
          vacancy: vacancyName || vacId,
          total: candidates.length,
          candidates,
          hint: candidates.length
            ? `Используй calltips_prepare(candidate_name="...") чтобы подготовить план для конкретного кандидата.`
            : 'Откликов нет.',
        };
      },
    },
  },
};
