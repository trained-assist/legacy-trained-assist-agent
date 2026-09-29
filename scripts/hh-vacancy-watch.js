#!/usr/bin/env node
// hh-vacancy-watch.js — ежедневный снапшот remote-вакансий HH + детектор повторного найма
//
// Запускать на RU VM (178.212.14.192) — отдельный IP от recruiting-трафика на GCP VM.
// Cron: 0 7 * * * cd ~/trained-assist-agent && node scripts/hh-vacancy-watch.js >> ~/hh-watch.log 2>&1
//
// Env vars (читает из ~/secrets.env автоматически через --env-file, или вручную):
//   HH_WATCH_TOKEN    — HH OAuth access_token (отдельный от recruiting-токена)
//   OPENAI_API_KEY    — для GPT-4o-mini duplicate-check (или GIGACHAT_TOKEN для GigaChat)
//   TELEGRAM_BOT_TOKEN + ALERT_CHAT_ID — куда слать алерты

'use strict';

const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { readCredentialFile } = require('../src/credential-store');

// --- Config ---

const DB_PATH = path.join(os.homedir(), 'hh-watch', 'vacancies.db');
const WATCH_DAYS = 7;          // сколько дней следим за работодателем после закрытия
const HH_DELAY_MS = 250;       // 4 req/s — вежливо
const HH_USER_AGENT = 'hh-watch/1.0 (vladimir@skillset.ae)';

function loadEnv() {
  const envFile = path.join(os.homedir(), 'secrets.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

function getHhToken() {
  if (process.env.HH_WATCH_TOKEN) return process.env.HH_WATCH_TOKEN;
  // Fallback: читаем токен из профиля (если файл скопирован на эту VM)
  const candidates = [
    path.join(os.homedir(), 'agent-tokens', 'hh-watch', 'hh'),
    path.join(os.homedir(), 'agent-tokens', 'recruiter', 'hh'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(readCredentialFile(p)).access_token; } catch {}
    }
  }
  return null;
}

const HH_TOKEN = getHhToken();
// tg_groups_monitor_bot — dedicated bot for HH watch alerts
const BOT_TOKEN = process.env.HH_WATCH_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || process.env.OPERATOR_CHAT_ID;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GIGACHAT_TOKEN = process.env.GIGACHAT_TOKEN;

// --- HTTP helpers ---

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { reject(new Error(`parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  const buf = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'content-length': buf.length } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({}); }
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- HH API ---

async function hhGet(apiPath) {
  const { status, body } = await httpsGet('api.hh.ru', apiPath, {
    'Authorization': `Bearer ${HH_TOKEN}`,
    'HH-User-Agent': HH_USER_AGENT,
    'User-Agent': HH_USER_AGENT,
  });
  if (status === 401 || status === 403) throw new Error(`HH auth error ${status}: ${JSON.stringify(body)}`);
  return body;
}

async function fetchRoleIds() {
  const data = await hhGet('/professional_roles');
  const ids = [];
  for (const cat of data.categories || []) {
    for (const role of cat.roles || []) ids.push(role.id);
  }
  return ids;
}

async function fetchVacanciesPage(params) {
  const qs = new URLSearchParams({ schedule: 'remote', per_page: '100', ...params }).toString();
  const data = await hhGet(`/vacancies?${qs}`);
  return data;
}

// Collect items from one paginated query (up to 2000 results). Returns total found count.
async function collectPages(baseParams, seen, all) {
  let page = 0;
  let found = 0;
  while (true) {
    const data = await fetchVacanciesPage({ ...baseParams, page: String(page) });
    if (!Array.isArray(data.items) || data.items.length === 0) break;
    if (page === 0) found = data.found || 0;

    for (const v of data.items) {
      const id = parseInt(v.id);
      const empId = parseInt(v.employer?.id);
      if (seen.has(id) || !empId) continue;
      seen.add(id);
      all.push({
        id,
        employer_id: empId,
        employer_name: v.employer?.name || '',
        title: v.name || '',
        published_at: (v.published_at || '').slice(0, 10),
        created_at: (v.created_at || '').slice(0, 10),
        area_id: v.area?.id || null,
        area_name: v.area?.name || '',
        salary_from: v.salary?.from ?? null,
        salary_to: v.salary?.to ?? null,
        salary_currency: v.salary?.currency || null,
        salary_gross: v.salary?.gross ? 1 : 0,
        experience_id: v.experience?.id || null,
        employment_form: v.employment_form?.id || null,
        snippet_req: (v.snippet?.requirement || '').slice(0, 500),
        snippet_resp: (v.snippet?.responsibility || '').slice(0, 500),
      });
    }

    const totalPages = data.pages || 0;
    if (page >= totalPages - 1) break;
    page++;
    await sleep(HH_DELAY_MS);
  }
  return found;
}

// Generate date windows over last 30 days (3-day chunks)
function dateWindows() {
  const windows = [];
  const now = new Date();
  for (let daysBack = 0; daysBack < 30; daysBack += 3) {
    const to = new Date(now - daysBack * 86400000);
    const from = new Date(now - (daysBack + 3) * 86400000);
    windows.push({
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    });
  }
  return windows;
}

async function fetchAllRemoteVacancies() {
  // HH API caps at 2000 results per query (20 pages × 100).
  // Strategy: split by professional_role; if role > 2000, further split by 3-day date windows.
  const seen = new Set();
  const all = [];

  const roleIds = await fetchRoleIds();
  console.log(`  Splitting by ${roleIds.length} professional roles...`);

  for (let i = 0; i < roleIds.length; i++) {
    const roleId = roleIds[i];

    // Try without date split first. collectPages returns found count from first page.
    const found = await collectPages({ professional_role: roleId }, seen, all);

    if (found > 2000) {
      // Role exceeded cap — re-fetch with 3-day date windows to catch missed ones
      for (const window of dateWindows()) {
        await collectPages({ professional_role: roleId, ...window }, seen, all);
        await sleep(HH_DELAY_MS);
      }
    }

    if (i % 50 === 0) console.log(`  roles processed: ${i}/${roleIds.length} — unique vacancies: ${all.length}`);
    await sleep(HH_DELAY_MS);
  }

  return all;
}

async function fetchEmployerNewVacancies(employerId, sinceDate) {
  // period=7 = опубликовано за последние 7 дней
  const data = await hhGet(
    `/vacancies?employer_id=${employerId}&schedule=remote&per_page=20&period=${WATCH_DAYS}&order_by=publication_time`
  );
  const items = data.items || [];
  return items
    .filter(v => (v.published_at || '').slice(0, 10) >= sinceDate)
    .map(v => ({
      id: parseInt(v.id),
      title: v.name || '',
      published_at: (v.published_at || '').slice(0, 10),
      area_name: v.area?.name || '',
      salary_from: v.salary?.from ?? null,
      salary_to: v.salary?.to ?? null,
      salary_currency: v.salary?.currency || null,
      url: v.alternate_url || `https://hh.ru/vacancy/${v.id}`,
    }));
}

// --- LLM duplicate check ---
// Приоритет: OPENAI_API_KEY → GIGACHAT_TOKEN → текстовая эвристика

const DEDUP_PROMPT = (oldTitle, newTitle, oldSnippet = '', newSnippet = '') => {
  const oldCtx = oldSnippet ? `\nТребования: ${oldSnippet.slice(0, 200)}` : '';
  const newCtx = newSnippet ? `\nТребования: ${newSnippet.slice(0, 200)}` : '';
  return `Один работодатель закрыл вакансию и открыл новую. Это та же самая позиция (повторный найм на ту же роль)?\n\nСтарая: "${oldTitle}"${oldCtx}\nНовая: "${newTitle}"${newCtx}\n\nОтветь одним словом: ДА или НЕТ`;
};

async function isDuplicateOpenAI(oldTitle, newTitle, oldSnippet, newSnippet) {
  const body = await httpsPost(
    'api.openai.com',
    '/v1/chat/completions',
    { 'Authorization': `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
    {
      model: 'gpt-4o-mini',
      max_tokens: 5,
      messages: [{ role: 'user', content: DEDUP_PROMPT(oldTitle, newTitle, oldSnippet, newSnippet) }],
    }
  );
  const text = (body.choices?.[0]?.message?.content || '').trim().toUpperCase();
  return text.startsWith('ДА');
}

async function isDuplicateGigaChat(oldTitle, newTitle, oldSnippet, newSnippet) {
  const body = await httpsPost(
    'gigachat.devices.sberbank.ru',
    '/api/v1/chat/completions',
    { 'Authorization': `Bearer ${GIGACHAT_TOKEN}`, 'content-type': 'application/json' },
    {
      model: 'GigaChat',
      max_tokens: 5,
      messages: [{ role: 'user', content: DEDUP_PROMPT(oldTitle, newTitle, oldSnippet, newSnippet) }],
    }
  );
  const text = (body.choices?.[0]?.message?.content || '').trim().toUpperCase();
  return text.startsWith('ДА');
}

function isDuplicateHeuristic(oldTitle, newTitle) {
  const normalize = s => s.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, '').trim();
  const wordsA = new Set(normalize(oldTitle).split(/\s+/));
  const wordsB = normalize(newTitle).split(/\s+/);
  const overlap = wordsB.filter(w => w.length > 3 && wordsA.has(w)).length;
  return overlap >= 2;
}

async function isDuplicate(oldTitle, newTitle, oldSnippet = '', newSnippet = '') {
  try {
    if (OPENAI_KEY)     return await isDuplicateOpenAI(oldTitle, newTitle, oldSnippet, newSnippet);
    if (GIGACHAT_TOKEN) return await isDuplicateGigaChat(oldTitle, newTitle, oldSnippet, newSnippet);
  } catch (e) {
    console.error('  LLM dedup error, falling back to heuristic:', e.message);
  }
  return isDuplicateHeuristic(oldTitle, newTitle);
}

// --- Telegram alert ---

async function sendAlert(text) {
  if (!BOT_TOKEN || !ALERT_CHAT_ID) {
    console.log('[ALERT]', text);
    return;
  }
  await httpsPost(
    'api.telegram.org',
    `/bot${BOT_TOKEN}/sendMessage`,
    { 'content-type': 'application/json' },
    { chat_id: ALERT_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }
  ).catch(e => console.error('Telegram send error:', e.message));
}

// --- DB setup ---

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS vacancies (
      id              INTEGER PRIMARY KEY,
      employer_id     INTEGER NOT NULL,
      employer_name   TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL,
      published_at    TEXT NOT NULL,
      created_at      TEXT,
      area_id         INTEGER,
      area_name       TEXT,
      salary_from     INTEGER,
      salary_to       INTEGER,
      salary_currency TEXT,
      salary_gross    INTEGER,
      experience_id   TEXT,
      employment_form TEXT,
      snippet_req     TEXT,
      snippet_resp    TEXT,
      first_seen      TEXT NOT NULL,
      last_seen       TEXT NOT NULL,
      archived_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vac_emp     ON vacancies(employer_id);
    CREATE INDEX IF NOT EXISTS idx_vac_arch    ON vacancies(archived_at) WHERE archived_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS watch (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      employer_id     INTEGER NOT NULL,
      employer_name   TEXT NOT NULL DEFAULT '',
      old_vacancy_id  INTEGER NOT NULL,
      old_title       TEXT NOT NULL,
      archived_at     TEXT NOT NULL,
      watch_until     TEXT NOT NULL,
      new_vacancy_id  INTEGER,
      new_title       TEXT,
      verdict         TEXT,       -- 'duplicate' | 'different' | 'expired' | NULL
      alerted         INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_watch_emp      ON watch(employer_id);
    CREATE INDEX IF NOT EXISTS idx_watch_pending  ON watch(watch_until) WHERE verdict IS NULL;
  `);

  return db;
}

// --- Main ---

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== HH Vacancy Watch [${today}] ===`);

  if (!HH_TOKEN) {
    console.error('ERROR: No HH token. Set HH_WATCH_TOKEN env var or copy token file to ~/agent-tokens/hh-watch/hh');
    process.exit(1);
  }

  const db = initDb();

  // --- 1. Снапшот всех remote-вакансий ---
  console.log('\n[1] Fetching all remote vacancies...');
  const vacancies = await fetchAllRemoteVacancies();
  console.log(`    Fetched: ${vacancies.length}`);

  const upsert = db.prepare(`
    INSERT INTO vacancies (
      id, employer_id, employer_name, title, published_at, created_at,
      area_id, area_name, salary_from, salary_to, salary_currency, salary_gross,
      experience_id, employment_form, snippet_req, snippet_resp,
      first_seen, last_seen
    ) VALUES (
      @id, @employer_id, @employer_name, @title, @published_at, @created_at,
      @area_id, @area_name, @salary_from, @salary_to, @salary_currency, @salary_gross,
      @experience_id, @employment_form, @snippet_req, @snippet_resp,
      @today, @today
    )
    ON CONFLICT(id) DO UPDATE SET
      last_seen = excluded.last_seen,
      employer_name = excluded.employer_name,
      salary_from = excluded.salary_from,
      salary_to = excluded.salary_to,
      snippet_req = excluded.snippet_req,
      snippet_resp = excluded.snippet_resp
  `);
  const upsertAll = db.transaction(rows => {
    for (const v of rows) upsert.run({ ...v, today });
  });
  upsertAll(vacancies);

  // --- 2. Пометить исчезнувшие как archived ---
  const { changes: archived } = db.prepare(`
    UPDATE vacancies SET archived_at = ?
    WHERE last_seen < ? AND archived_at IS NULL
  `).run(today, today);
  console.log(`[2] Archived today: ${archived}`);

  // --- 3. Добавить новые archived на слежку ---
  const newlyArchived = db.prepare(`
    SELECT id, employer_id, employer_name, title, archived_at
    FROM vacancies
    WHERE archived_at = ?
      AND id NOT IN (SELECT old_vacancy_id FROM watch)
  `).all(today);

  const addWatch = db.prepare(`
    INSERT INTO watch (employer_id, employer_name, old_vacancy_id, old_title, archived_at, watch_until)
    VALUES (@employer_id, @employer_name, @id, @title, @archived_at, date(@archived_at, '+${WATCH_DAYS} days'))
  `);
  const addWatchAll = db.transaction(rows => {
    for (const v of rows) addWatch.run(v);
  });
  addWatchAll(newlyArchived);
  console.log(`[3] New watches added: ${newlyArchived.length}`);

  // --- 4. Проверить активные наблюдения ---
  const pending = db.prepare(`
    SELECT * FROM watch
    WHERE verdict IS NULL AND watch_until >= ?
    ORDER BY archived_at DESC
    LIMIT 200
  `).all(today);
  console.log(`[4] Checking ${pending.length} active watches...`);

  const updateVerdict = db.prepare(`
    UPDATE watch SET new_vacancy_id = @new_id, new_title = @new_title, verdict = @verdict WHERE id = @id
  `);
  const markAlerted = db.prepare(`UPDATE watch SET alerted = 1 WHERE id = ?`);

  let alerts = 0;
  for (const w of pending) {
    try {
      await sleep(HH_DELAY_MS);
      const newVacs = await fetchEmployerNewVacancies(w.employer_id, w.archived_at);

      // Исключаем старую вакансию и уже известные
      const candidates = newVacs.filter(v => v.id !== w.old_vacancy_id);
      if (candidates.length === 0) continue;

      // Достаём snippet старой вакансии из БД для более точного сравнения
      const oldSnippet = db.prepare('SELECT snippet_req FROM vacancies WHERE id = ?').get(w.old_vacancy_id)?.snippet_req || '';
      for (const nv of candidates) {
        const dup = await isDuplicate(w.old_title, nv.title, oldSnippet, '');
        updateVerdict.run({ id: w.id, new_id: nv.id, new_title: nv.title, verdict: dup ? 'duplicate' : 'different' });

        if (dup && !w.alerted) {
          const days = Math.round((new Date(nv.published_at) - new Date(w.archived_at)) / 86400000);
          // Подтянем детали старой вакансии из БД
          const oldVac = db.prepare('SELECT * FROM vacancies WHERE id = ?').get(w.old_vacancy_id) || {};
          const salaryStr = (v) => {
            if (!v.salary_from && !v.salary_to) return '';
            const from = v.salary_from ? `от ${v.salary_from.toLocaleString('ru')}` : '';
            const to = v.salary_to ? `до ${v.salary_to.toLocaleString('ru')}` : '';
            const gross = v.salary_gross ? ' до вычета налогов' : ' на руки';
            return ` (${[from, to].filter(Boolean).join(' ')} ${v.salary_currency || ''}${gross})`;
          };
          const nvSalary = nv.salary_from || nv.salary_to
            ? ` (${[nv.salary_from && `от ${nv.salary_from.toLocaleString('ru')}`, nv.salary_to && `до ${nv.salary_to.toLocaleString('ru')}`].filter(Boolean).join(' ')} ${nv.salary_currency || ''})`
            : '';
          await sendAlert(
            `🔄 *Повторный найм — ${w.employer_name}*\n` +
            `📍 ${oldVac.area_name || nv.area_name || 'удалённо'}\n\n` +
            `❌ Закрыли: «${w.old_title}»${salaryStr(oldVac)} (${w.archived_at})\n` +
            `✅ Открыли: «${nv.title}»${nvSalary} (+${days} дн.)\n\n` +
            `👉 https://hh.ru/vacancy/${nv.id}`
          );
          markAlerted.run(w.id);
          alerts++;
          break;
        }
      }
    } catch (e) {
      console.error(`  watch ${w.id} (employer ${w.employer_id}): ${e.message}`);
    }
  }

  // --- 5. Протухшие наблюдения ---
  const { changes: expired } = db.prepare(`
    UPDATE watch SET verdict = 'expired' WHERE verdict IS NULL AND watch_until < ?
  `).run(today);

  // --- Итог ---
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM vacancies WHERE archived_at IS NULL)              AS active,
      (SELECT COUNT(*) FROM vacancies WHERE archived_at IS NOT NULL)          AS total_archived,
      (SELECT COUNT(*) FROM watch WHERE verdict IS NULL AND watch_until >= ?) AS watching,
      (SELECT COUNT(*) FROM watch WHERE verdict = 'duplicate')                AS duplicates_total,
      (SELECT COUNT(*) FROM watch WHERE alerted = 1)                         AS alerted_total
  `).get(today);

  console.log(`\n--- Stats ---`);
  console.log(`  Active vacancies:  ${stats.active}`);
  console.log(`  Archived total:    ${stats.total_archived}`);
  console.log(`  Currently watching:${stats.watching}`);
  console.log(`  Duplicates found:  ${stats.duplicates_total} (${stats.alerted_total} alerted)`);
  console.log(`  Alerts today:      ${alerts}`);
  console.log(`  Expired watches:   ${expired}`);
  console.log(`=== Done ===\n`);

  db.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
