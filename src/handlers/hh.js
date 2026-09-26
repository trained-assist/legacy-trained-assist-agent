// HH handler — all /hh/* + /api/hh/proactive/* routes (issue #942 P3.1).
//
// server.js is the router; HH business logic lives here. This module is the first
// and reference handler: pre-gate routes (no AGENT_SECRET — authenticated by the
// HH token file / HMAC token param) are dispatched from handleHhPublic BEFORE the
// Bearer gate; post-gate routes (ats-config, reset-ats-results) from
// handleHhAuthed AFTER it (they need the Bearer token).
//
// Layout mirrors the old server.js layout so bodies stay byte-identical (V2 check:
// diff server.js@main vs this file per block).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { userWorkDir } = require('../data-paths');

const { sendRejection, REJECT_REASON_ACTION } = require('../hh-rejection');
const { hydrateResume, buildResumeText, resumeNotice } = require('../hh-resume');
const { hhFetch, hhPut, hhPostForm, readHhToken, refreshHhToken, readActiveVacancies } = require('../hh-utils');
const { bullshitGuard } = require('../hh-bullshit-guard');
const { buildAvailabilityBlock, buildRecruiterIdentity, buildMessageSystemPrompt, buildRejectionSystemPrompt, loadBaseOverride, DEFAULT_MESSAGE_BASE, BASE_PROMPT_FILENAME } = require('../hh-message-prompts');
const { hhInterviewConfigAllowsTime } = require('../hh-negotiations');

// Cold-search schedule lives in the generic cron (#1489 S7.1); core reaches it only
// through the provider's hh_proactive_schedule tool, never through cron tables.
async function coldSearchSchedule(username, workDir, params) {
  try {
    const text = await require('../mcp-action').runMcpTool({ tool: 'hh_proactive_schedule', params, username, workDir, timeoutMs: 20000 });
    return JSON.parse(text || '{}');
  } catch (e) { return { error: e.message }; }
}
async function coldSearchMonitoring(username, workDir, vacancyId) {
  const legacy = require('../hh-cold-search-schedule').getSchedules(username, workDir)[vacancyId] || {};
  const flags = { starred: !!legacy.starred, archived: !!legacy.archived };
  if (!vacancyId) return flags;
  const st = await coldSearchSchedule(username, workDir, { action: 'status', vacancy_id: String(vacancyId) });
  if (st.error) return { ...flags, enabled: false, error: `Статус расписания недоступен: ${st.error}` };
  return { ...flags, enabled: !!st.enabled, last_attempt: st.last_run || null,
    last_success: st.last_status === 'succeeded' ? st.last_run : null,
    status: st.last_status || null, next_run: st.next_run || null };
}
const { generateProactivePageHtml } = require('../hh-proactive-page');
const { runProactiveSearch, scoreUnscoredProactiveCandidates } = require('../hh-proactive-search');
const { hhStylePageHtml } = require('../hh-style-html');
const { generateReviewPageHtml } = require('../hh-review-page-html');

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function proactiveHmac(uname) {
  const { createHmac } = require('crypto');
  const secret = process.env.AGENT_SECRET || '';
  return createHmac('sha256', secret).update(uname).digest('hex').slice(0, 16);
}

// Signed URL to the recruiter's proactive results page. Was referenced in server.js
// but never defined there — /api/hh/proactive/search always 500'd. Defined here
// (same scheme as 92-hh-proactive.js / hh-autoscan.js proactiveUrlFor). `vacancyId`
// is a plain, non-HMAC'd query param appended alongside the token — same pattern as
// hhReviewUrl in hh-quick.js — so multi-vacancy step 7's tab switcher can deep-link
// straight into the right tab. Omitted (falsy) → no param, unchanged for
// single-vacancy callers.
function proactiveUrl(username, vacancyId) {
  const base = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const token = proactiveHmac(username);
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${base}/hh/proactive?username=${encodeURIComponent(username)}&token=${token}${vacancyParam}`;
}

const { latestProactiveFile } = require('../hh-cold-search-snapshots');

function appendGuardBlock(username, negId, reason, checks, blocked = true) {
  try {
    const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
    const logPath = path.join(dataDir, 'hh', String(username), 'guard-log.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
    entries.unshift({ at: Date.now(), neg_id: negId, reason, checks, blocked });
    if (entries.length > 100) entries.length = 100;
    fs.writeFileSync(logPath, JSON.stringify(entries), { mode: 0o600 });
  } catch { /* non-critical */ }
}

function generateCandidateProfileHtml(neg, history, username, callbackBase, reviewUrl) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const r = neg?.resume || {};
  const ats = history?.ats_result || null;
  const msgs = history?.messages || [];
  const draft = history?.message_draft?.text || ats?.draft_message || '';

  const name = [r.last_name, r.first_name].filter(Boolean).join(' ') || neg?.applicant?.name || 'Кандидат';
  const jobTitle = r.title || '';
  const expMonths = r.total_experience?.months || 0;
  const expStr = expMonths ? `${Math.floor(expMonths / 12)} лет ${expMonths % 12 ? (expMonths % 12) + ' мес' : ''}`.trim() : '';
  const location = r.area?.name || '';
  const salary = r.salary ? `${r.salary.amount?.toLocaleString('ru-RU')} ${r.salary.currency}` : '';
  const hhLink = neg?.alternate_url || r.alternate_url || '';
  const coverLetter = neg?.message || '';

  const colorMap = { 'ПРОПУСТИТЬ': '#16a34a', 'УТОЧНИТЬ': '#ca8a04', 'ОТКЛОНИТЬ': '#dc2626' };
  const col = colorMap[ats?.verdict] || '#64748b';
  const scorePct = ats?.score != null ? Math.round(ats.score * 10) : 0;

  const metaItems = [jobTitle, expStr, location, salary].filter(Boolean);

  // ATS section
  const matchedHtml = (ats?.matched || []).map(m => `<span class="tag tag-ok">${esc(m)}</span>`).join('');
  const gapsHtml = (ats?.gaps || []).map(g => `<span class="tag tag-gap">${esc(g)}</span>`).join('');

  // Message history
  const histHtml = msgs.length === 0
    ? '<p class="no-msgs">Переписки ещё не было</p>'
    : msgs.map(m => `<div class="msg-bubble msg-${esc(m.role || 'employer')}">
        <div class="msg-meta-row"><span class="msg-who">${m.role === 'employer' ? '👔 Рекрутер' : '👤 Кандидат'}</span><span class="msg-time">${(m.timestamp || '').slice(0, 10)}</span></div>
        <div class="msg-body">${esc(m.text || '').replace(/\n/g, '<br>')}</div>
      </div>`).join('');

  const neg_id = neg?.id || history?.neg_id || '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — профиль кандидата</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
.topbar{background:#1e293b;color:#f8fafc;padding:12px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
.topbar a{color:#94a3b8;text-decoration:none;font-size:14px}
.topbar a:hover{color:#f8fafc}
.topbar .cname{font-size:18px;font-weight:700;color:#fff;flex:1}
.page{max-width:860px;margin:0 auto;padding:24px 16px;display:grid;gap:16px}
.card{background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:16px;font-weight:600;color:#64748b;margin-bottom:16px;border-bottom:1px solid #f1f5f9;padding-bottom:8px}
.hero-meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.hero-meta span{font-size:14px;color:#64748b}
.hero-meta .sep{color:#cbd5e1}
.hh-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:#d6001c;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600}
.hh-btn:hover{background:#b0001a}
.score-section{display:flex;align-items:center;gap:16px;padding:16px;background:#f8fafc;border-radius:8px;margin-bottom:16px}
.score-big{font-size:36px;font-weight:800;line-height:1}
.score-details{flex:1}
.score-bar{height:8px;background:#e2e8f0;border-radius:4px;margin-bottom:6px}
.score-fill{height:100%;border-radius:4px}
.verdict-big{font-size:13px;font-weight:700;padding:4px 10px;border-radius:20px;color:#fff;display:inline-block}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.tag-ok{background:#dcfce7;color:#166534}
.tag-gap{background:#fee2e2;color:#991b1b}
.reasoning{font-size:14px;color:#475569;margin-top:12px;font-style:italic;line-height:1.5}
.job{padding:12px 0;border-bottom:1px solid #f1f5f9}
.job:last-child{border-bottom:none}
.job-header{font-size:14px;margin-bottom:4px}
.job-dates{color:#94a3b8;font-size:12px;font-weight:400}
.job-desc{font-size:13px;color:#64748b;margin-top:4px;line-height:1.5}
.skills{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.skill-tag{background:#f1f5f9;color:#475569;padding:4px 10px;border-radius:20px;font-size:12px}
.edu-list{font-size:13px;color:#64748b;margin-top:8px;padding-left:16px}
.cover{font-size:14px;line-height:1.7;white-space:pre-wrap;color:#374151;background:#fefce8;padding:16px;border-radius:8px;border-left:3px solid #ca8a04}
.msg-bubble{padding:12px 16px;border-radius:8px;margin-bottom:10px}
.msg-employer{background:#eff6ff;border-left:3px solid #3b82f6}
.msg-applicant{background:#f0fdf4;border-left:3px solid #22c55e}
.msg-meta-row{display:flex;justify-content:space-between;margin-bottom:4px}
.msg-who{font-size:12px;font-weight:700;color:#64748b}
.msg-time{font-size:11px;color:#94a3b8}
.msg-body{font-size:14px;line-height:1.6;white-space:pre-wrap}
.no-msgs{color:#94a3b8;font-style:italic;padding:12px 0}
.draft-area{width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:14px;font-family:inherit;resize:vertical;min-height:120px;color:#1e293b;background:#fff;margin-bottom:12px}
.btn-send{background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
.btn-send:hover{background:#1d4ed8}
.btn-send:disabled{background:#94a3b8;cursor:default}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;display:none;z-index:100}
.toast.err{background:#dc2626}
</style>
</head>
<body>
<div class="topbar">
  <a href="${esc(reviewUrl)}">← Назад к ревью</a>
  <span class="cname">${esc(name)}</span>
  ${hhLink ? `<a class="hh-btn" href="${esc(hhLink)}" target="_blank" rel="noopener">↗ HH</a>` : ''}
</div>

<div class="page">

  <!-- Hero: meta info -->
  <div class="card">
    <h2>Основная информация</h2>
    <div class="hero-meta">
      ${metaItems.map((x, i) => `<span>${esc(x)}</span>${i < metaItems.length - 1 ? '<span class="sep">·</span>' : ''}`).join('')}
    </div>
  </div>

  <!-- ATS Score -->
  ${ats ? `<div class="card">
    <h2>Оценка ATS</h2>
    <div class="score-section">
      <div class="score-big" style="color:${col}">${ats.score != null ? ats.score.toFixed(1) : '—'}</div>
      <div class="score-details">
        <div class="score-bar"><div class="score-fill" style="width:${scorePct}%;background:${col}"></div></div>
        <span class="verdict-big" style="background:${col}">${esc(ats.verdict || '')}</span>
      </div>
    </div>
    ${matchedHtml || gapsHtml ? `<div class="tags">${matchedHtml}${gapsHtml}</div>` : ''}
    ${ats.reasoning ? `<p class="reasoning">${esc(ats.reasoning)}</p>` : ''}
  </div>` : ''}

  <!-- Message history -->
  <div class="card">
    <h2>История переписки (${msgs.length} сообщ.)</h2>
    ${histHtml}
  </div>

  <!-- Draft / send -->
  <div class="card">
    <h2>${msgs.some(m => m.role === 'employer') ? 'Follow-up' : 'Новое сообщение'}</h2>
    <textarea class="draft-area" id="draft-msg">${esc(draft)}</textarea>
    <div style="display:flex;gap:8px">
      <button class="btn-send" id="sendBtn" onclick="doSend()" ${!neg_id ? 'disabled' : ''}>✓ Отправить в HH</button>
    </div>
  </div>

  <!-- Experience -->
  <div class="card"><h2>Резюме</h2><p>${esc(resumeNotice(neg, ats))}</p>
    <pre style="white-space:pre-wrap;font-family:inherit">${esc(buildResumeText(neg || {}))}</pre>
  </div>

  <!-- Cover letter -->
  ${coverLetter ? `<div class="card">
    <h2>Сопроводительное письмо</h2>
    <div class="cover">${esc(coverLetter)}</div>
  </div>` : ''}

</div>

<div class="toast" id="toast"></div>

<script>
const NEG_ID = '${esc(String(neg_id))}';
const HH_USER = '${esc(String(username))}';
const CALLBACK_BASE = ${JSON.stringify(callbackBase)} || (location.pathname.startsWith('/agent/') ? '/agent' : '');

function showToast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4000);
}

async function doSend(force) {
  const msg = document.getElementById('draft-msg').value.trim();
  if (!msg) { showToast('Сообщение пустое', true); return; }
  const btn = document.getElementById('sendBtn');
  btn.disabled = true; btn.textContent = '⏳...';
  try {
    const r = await fetch(CALLBACK_BASE + '/hh/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: HH_USER, negotiation_id: NEG_ID, message: msg, force: !!force }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.blocked) {
      btn.disabled = false; btn.textContent = '✓ Отправить в HH';
      if (confirm('🚫 Guard: ' + (data.reason || 'заблокировано') + '\n\nЭто ты лично проверяешь и отправляешь — всё равно отправить?')) {
        return doSend(true);
      }
    } else if (!r.ok) {
      showToast('❌ ' + (data.error || r.statusText), true);
      btn.disabled = false; btn.textContent = '✓ Отправить в HH';
    } else {
      showToast('✅ Отправлено!');
      btn.textContent = '✓ Отправлено';
      // Reload to show new message in history
      setTimeout(() => location.reload(), 1500);
    }
  } catch(e) {
    showToast('❌ ' + e.message, true);
    btn.disabled = false; btn.textContent = '✓ Отправить в HH';
  }
}
</script>
</body>
</html>`;
}

/**
 * Pre-gate HH routes (no AGENT_SECRET — authenticated by HH token file / HMAC).
 * Returns true if the request was handled.
 */
async function handleHhPublic(req, url, res, ctx) {
  const { readChatId, secrets, getSecretsCache, BASE_USERS_DIR, PORT,
          getHhNegotiationsWithCache, syncHhMessagesToHistory, fetchAllHhNegotiations, getHhDiscardedWithCache, hhCacheFile } = ctx;
  const _secretsCache = getSecretsCache();

  function proactiveErrPage(msg) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Проактивный поиск</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  }

if (req.method === 'OPTIONS' && (url.pathname === '/hh/send' || url.pathname === '/hh/reject' || url.pathname === '/hh/send-and-reject' || url.pathname === '/hh/ats-config' || url.pathname === '/hh/review' || url.pathname === '/hh/candidate' || url.pathname === '/hh/reset-ats-results' || url.pathname === '/hh/generate-message' || url.pathname === '/hh/update-style' || url.pathname === '/hh/update-base-prompt' || url.pathname === '/hh/sync-negotiations')) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  return res.end();
}

if (req.method === 'GET' && url.pathname === '/hh/response-updates') {
  const username = url.searchParams.get('username');
  const vacancyId = url.searchParams.get('vacancy_id');
  if (![username, vacancyId].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && url.searchParams.get('token') !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  if (!readActiveVacancies(path.join(BASE_USERS_DIR, username)).some(v => String(v.id) === vacancyId)) return json(res, 403, { error: 'Unknown vacancy' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
    const saved = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancyId), 'utf8'));
    return json(res, 200, { synced_at: saved.synced_at });
  } catch { return json(res, 200, { synced_at: null }); }
}

if (req.method === 'POST' && url.pathname === '/hh/response-state') {
  const body = JSON.parse(await readBody(req));
  const { username, vacancy_id, negotiation_id, status, token } = body;
  if (![username, vacancy_id, negotiation_id].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'Invalid token' });
  const vacancies = readActiveVacancies(path.join(BASE_USERS_DIR, username));
  if (!vacancies.some(v => String(v.id) === String(vacancy_id))) return json(res, 403, { error: 'Unknown vacancy' });
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  try {
    const cache = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancy_id), 'utf8'));
    if (!cache.negotiations.some(n => String(n.id) === String(negotiation_id))) return json(res, 404, { error: 'Unknown response' });
    require('../hh-response-state').setResponseState(dataDir, username, vacancy_id, negotiation_id, status);
    return json(res, 200, { ok: true, status });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

if (req.method === 'GET' && url.pathname === '/hh/review') {
  const username = url.searchParams.get('username') || '';
  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>HH Ревью</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}h2{margin-bottom:12px}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  // Token check: HMAC-SHA256(AGENT_SECRET, username).slice(0,16)
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    const given = url.searchParams.get('token') || '';
    if (given !== expected) return errPage('Ссылка недействительна. Запроси новую у бота.');
  }
  if (!username || !fs.existsSync(tokenFile)) return errPage('HH не подключён. Скажи боту «подключи HH».');
  let tokenData;
  try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return errPage('Ошибка чтения токена.'); }

  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const workDir = path.join(BASE_USERS_DIR, username);
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const vacancy = requestedVacancyId ? activeVacancies.find(v => String(v.id) === requestedVacancyId) : activeVacancies[0];
  if (!vacancy?.id) return errPage('Вакансия не выбрана. Скажи боту «мои вакансии» и выбери вакансию.');

  let negotiations = [], syncedAt = null, syncError = null;
  try {
    const result = await getHhNegotiationsWithCache(dataDir, username, vacancy.id, tokenData.access_token);
    negotiations = result.negotiations;
    syncedAt = result.synced_at;
  } catch (e) {
    console.error('[hh/review] fetch error:', e.message);
    syncError = 'Не удалось обновить отклики из HH. Показаны последние сохранённые данные.';
    try {
      const cached = JSON.parse(fs.readFileSync(hhCacheFile(dataDir, username, vacancy.id), 'utf8'));
      negotiations = cached.negotiations; syncedAt = cached.synced_at;
    } catch { syncError = 'Не удалось загрузить отклики из HH. Нажмите «Обновить» для повтора.'; }
  }

  // Sync HH thread messages into local history before rendering
  // (capped at 15 negs, ~2-3s max; errors are non-fatal)
  await syncHhMessagesToHistory(dataDir, username, negotiations, tokenData.access_token).catch(e => {
    console.error('[hh/review] message sync error:', e.message);
  });

  // Rejected candidates are not part of the review list, but a candidate can reply
  // after being rejected. Fetch discard-stage negotiations and sync their threads so
  // such replies surface as "ответил после отказа" instead of silently going unread.
  let discarded = [];
  try {
    discarded = await getHhDiscardedWithCache(dataDir, username, vacancy.id, tokenData.access_token);
    await syncHhMessagesToHistory(dataDir, username, discarded, tokenData.access_token, { incremental: true, cap: 30 }).catch(e => {
      console.error('[hh/review] discard sync error:', e.message);
    });
  } catch (e) {
    console.error('[hh/review] discard fetch error:', e.message);
  }

  let lastScoredAt = null;
  try {
    const logPath = path.join(dataDir, 'hh', String(username), 'last-scoring.json');
    if (fs.existsSync(logPath)) lastScoredAt = JSON.parse(fs.readFileSync(logPath, 'utf8')).at || null;
  } catch { /* non-critical */ }

  const callbackBase = ''; // Same-origin public URL, including legacy /agent links.
  const html = generateReviewPageHtml(negotiations, vacancy.title || 'Вакансия', username, callbackBase, dataDir, {
    syncedAt, syncError, list: url.searchParams.get('list') || 'active',
    vacancyId: vacancy.id,
    lastScoredAt,
    vacancies: activeVacancies,
    discarded,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return;
}

if (req.method === 'GET' && url.pathname === '/hh/candidate') {
  const username = url.searchParams.get('username') || '';
  const neg_id = url.searchParams.get('neg_id') || '';
  const errPage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Профиль кандидата</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f1f5f9;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) return errPage('Ссылка недействительна.');
  }
  if (!username || !neg_id) return errPage('Не указан username или neg_id.');
  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return errPage('HH не подключён.');
  let tokenData;
  try { tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return errPage('Ошибка чтения токена.'); }

  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const candFile = path.join(dataDir, 'hh', String(username), 'candidates', `${neg_id}.json`);
  const history = fs.existsSync(candFile)
    ? (() => { try { return JSON.parse(fs.readFileSync(candFile, 'utf8')); } catch { return {}; } })()
    : {};

  // Fetch single negotiation from HH API for resume + cover letter
  let neg = null;
  try {
    neg = await hhFetch(`/negotiations/${neg_id}`, tokenData);
    await hydrateResume(neg, tokenData);
  } catch (e) {
    console.error(`[hh/candidate] fetch neg ${neg_id}:`, e.message);
  }

  const callbackBase = '';
  const reviewUrl = require('../hh-quick').hhReviewUrl(username, url.searchParams.get('vacancy_id') || neg?.vacancy?.id);

  const html = generateCandidateProfileHtml(neg, history, username, callbackBase, reviewUrl);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
  return;
}

if (req.method === 'GET' && url.pathname === '/hh/sync-log') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Ссылка недействительна.</h2></body></html>');
    }
  }
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const hhDir = path.join(dataDir, 'hh', username);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(path.join(hhDir, 'sync-log.json'), 'utf8')); } catch {}
  let guardEntries = [];
  try { guardEntries = JSON.parse(fs.readFileSync(path.join(hhDir, 'guard-log.json'), 'utf8')); } catch {}
  const fmt = ts => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rows = entries.length === 0
    ? '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px">Нет данных — скоринг ещё не запускался</td></tr>'
    : entries.map(e => {
        const msgs = e.new_messages_loaded != null ? `+${e.new_messages_loaded} сообщ.` : '—';
        const msgsColor = (e.new_messages_loaded || 0) > 0 ? '#2563eb' : '#94a3b8';
        const scoredColor = (e.scored || 0) > 0 ? '#16a34a' : '#94a3b8';
        const errColor = (e.sync_errors || 0) > 0 ? '#dc2626' : '#94a3b8';
        const errStr = e.sync_errors != null ? (e.sync_errors > 0 ? `⚠ ${e.sync_errors}` : '—') : '—';
        return `<tr>
          <td>${fmt(e.at)}</td>
          <td>${e.checked ?? '—'}</td>
          <td style="color:${msgsColor}">${msgs}</td>
          <td style="color:${scoredColor}">${(e.scored || 0) > 0 ? '+' + e.scored + ' скор.' : 'без изм.'}</td>
          <td style="color:#64748b">${e.with_new_messages != null ? e.with_new_messages + ' канд.' : '—'}</td>
          <td style="color:${errColor}">${errStr}</td>
        </tr>`;
      }).join('');
  const guardRows = guardEntries.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:16px">Guard блокировок не было</td></tr>'
    : guardEntries.slice(0, 20).map(g => `<tr>
        <td>${fmt(g.at)}</td>
        <td style="color:#64748b;font-family:monospace;font-size:12px">${g.neg_id || '—'}</td>
        <td style="color:${g.blocked === false ? '#d97706' : '#dc2626'}">${g.blocked === false ? '⚠ пропущена проверка' : '⛔ заблокировано'}</td>
        <td style="color:#64748b">${g.reason || '—'}</td>
      </tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>История скоринга</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;padding:24px}h1{font-size:20px;font-weight:700;margin-bottom:4px}.sub{font-size:13px;color:#64748b;margin-bottom:20px}h2{font-size:16px;font-weight:600;margin:24px 0 8px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:8px}th{background:#f8fafc;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;padding:10px 16px;text-align:left;border-bottom:1px solid #e2e8f0}td{padding:10px 16px;font-size:14px;border-bottom:1px solid #f1f5f9}tr:last-child td{border-bottom:none}</style>
</head><body>
<h1>История скоринга и Guard</h1>
<p class="sub">Последние запуски · ${username}</p>
<h2>Фоновый скоринг</h2>
<table><thead><tr><th>Время (МСК)</th><th>Проверено</th><th>Новых сообщ.</th><th>Скоринг</th><th>С активностью</th><th>API ошибки</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Bullshit Guard — последние блокировки и пропуски проверки</h2>
<table><thead><tr><th>Время</th><th>neg_id</th><th>Статус</th><th>Причина</th></tr></thead><tbody>${guardRows}</tbody></table>
</body></html>`);
}

if (req.method === 'GET' && url.pathname === '/hh/ats-editor') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    const given = url.searchParams.get('token') || '';
    if (given !== expected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Ссылка недействительна. Запроси новую у бота.</h2></body></html>');
    }
  }
  const { atsEditorHtml } = require('../hh-ats-editor-html.js');
  const { readAtsConfig, readAtsDraft } = require('../hh-scoring');
  // Must match BASE_USERS_DIR — Claude writes contexts here via cwd
  const workDir = path.join(BASE_USERS_DIR, username);
  const contextBase = path.join(workDir, 'contexts');
  const stagesFile = path.join(contextBase, 'hh', 'ats_stages.json');
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const activeVacancy = activeVacancies.find(v => String(v.id) === requestedVacancyId) || activeVacancies[0] || null;
  let currentConfig = readAtsConfig(workDir, activeVacancy?.id || null);
  // No live config yet — offer the LLM-extracted draft (hh_extract_ats_config) as the
  // starting point instead. The draft never goes live on its own: it only reaches
  // scoring once the recruiter reviews it here and clicks Save.
  let isDraft = false;
  if (!currentConfig) {
    const draft = readAtsDraft(workDir, activeVacancy?.id || null);
    if (draft) { currentConfig = draft; isDraft = true; }
  }
  let currentStages = null;
  try {
    if (fs.existsSync(stagesFile)) currentStages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
  } catch {}
  const callbackBase = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const html = atsEditorHtml(currentConfig, currentStages, {
    callbackBase,
    username,
    agentSecret: agentSecret || '',
    vacancies: activeVacancies,
    activeVacancyId: activeVacancy?.id || '',
    isDraft,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(html);
}

if (req.method === 'POST' && url.pathname === '/hh/send') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username, negotiation_id, message, force } = body || {};
  if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });

  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));

  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const histDir = path.join(dataDir, 'hh', String(username), 'candidates');
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, `${negotiation_id}.json`);
  const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
  history.messages = history.messages || [];

  const allowSpecificTime = hhInterviewConfigAllowsTime(username);
  const guard = await bullshitGuard(message, history.messages, { username, allowSpecificTime });
  if (!guard.ok) {
    if (!force) {
      console.warn(`[hh/send] guard blocked user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
      appendGuardBlock(username, negotiation_id, guard.reason, guard.checks);
      return json(res, 200, { ok: false, blocked: true, reason: guard.reason, checks: guard.checks });
    }
    // Recruiter reviewed the block and chose to send anyway — this path is only
    // reachable from the single-candidate send buttons, never from sendAll(),
    // so a bulk blast can't self-override. Still logged for the guard history page.
    console.warn(`[hh/send] guard block FORCED by user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
    appendGuardBlock(username, negotiation_id, `[отправлено вручную несмотря на блок] ${guard.reason}`, guard.checks, false);
  }
  if (guard.degraded) {
    console.warn(`[hh/send] guard degraded (semantic check skipped) user=${username} neg=${negotiation_id} checks=${JSON.stringify(guard.checks)}`);
    appendGuardBlock(username, negotiation_id, 'семантическая проверка пропущена (' + (guard.checks.llm_skipped || 'unknown') + ')', guard.checks, false);
  }
  if (guard.checks.invented_time) {
    appendGuardBlock(username, negotiation_id, 'сообщение упоминает время/дату — не блокирует отправку, только для истории', guard.checks, false);
  }

  const firstContact = !history.messages.some(m => m.role === 'employer');
  try {
    await hhPostForm(`/negotiations/${negotiation_id}/messages`, tokenData, { message });
    history.messages.push({ role: 'employer', text: message, timestamp: new Date().toISOString() });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    // Delivery already succeeded: a stage error must never suggest resending.
    if (firstContact) {
      try {
        const negotiation = await hhFetch(`/negotiations/${negotiation_id}`, tokenData);
        if (negotiation.state?.id === 'response') {
          await hhPut(`/negotiations/consider/${negotiation_id}`, tokenData);
        }
      } catch (e) {
        console.warn('[hh/send] stage move to consider failed:', e.message);
      }
    }
    console.log(`[hh/send] user=${username} neg=${negotiation_id} len=${message.length}`);
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('[hh/send] error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/generate-message') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_id, resume_text, candidate_name, already_sent, message_type } = body || {};
  if (!username || !negotiation_id) return json(res, 400, { error: 'missing fields' });

  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile = path.join(hhTokensBase, String(username), 'openrouter');
  const apiKey = fs.existsSync(orKeyFile) ? fs.readFileSync(orKeyFile, 'utf8').trim() : process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json(res, 503, { error: 'OpenRouter key not configured' });

  const styleFile = path.join(hhTokensBase, String(username), 'hh-message-style');
  const commStyle = fs.existsSync(styleFile) ? fs.readFileSync(styleFile, 'utf8').trim() : null;
  const baseOverride = loadBaseOverride(hhTokensBase, username);

  // Read recruiter identity config (agency, name, signature, rules)
  let msgCfg = null;
  try {
    const msgCfgFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'message_config.json');
    if (fs.existsSync(msgCfgFile)) {
      const raw = JSON.parse(fs.readFileSync(msgCfgFile, 'utf8'));
      let val = raw?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      if (val && typeof val === 'object') msgCfg = val;
    }
  } catch { /* ignore */ }

  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
  const histFile = path.join(candDir, `${negotiation_id}.json`);
  const history = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : { messages: [] };
  const msgs = history.messages || [];
  const hasPriorContact = msgs.some(m => m.role === 'employer');
  const candidateReplied = msgs.some(m => m.role === 'applicant');
  const msgType = message_type === 'rejection' ? 'rejection'
    : candidateReplied ? 'reply'
    : (already_sent || hasPriorContact ? 'followup' : 'initial');

  // Read HH token once — reused for resume fetch and vacancy fetch
  let hhToken = null;
  try {
    const hhTokenFile = path.join(hhTokensBase, String(username), 'hh');
    if (fs.existsSync(hhTokenFile)) hhToken = JSON.parse(fs.readFileSync(hhTokenFile, 'utf8'));
  } catch { /* ignore */ }

  let fullResumeText = (resume_text || '').trim();
  if (hhToken) {
    try {
      const neg = await hhFetch(`/negotiations/${negotiation_id}`, hhToken);
      await hydrateResume(neg, hhToken);
      if (neg._resume_status === 'full') fullResumeText = buildResumeText(neg);
    } catch { /* use page text if HH is temporarily unavailable */ }
  }

  // Fetch vacancy description from HH API for targeted message generation
  let vacancyContext = '';
  if (hhToken) {
    try {
      const vacancyCtxFile = path.join(userWorkDir(username), 'contexts', 'hh', 'active_vacancy.json');
      const vacData = fs.existsSync(vacancyCtxFile) ? JSON.parse(fs.readFileSync(vacancyCtxFile, 'utf8'))?.value : null;
      if (vacData?.id) {
        const vac = await hhFetch(`/vacancies/${vacData.id}`, hhToken);
        const descText = (vac.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const skills = (vac.key_skills || []).map(s => s.name).join(', ');
        const parts = [`Вакансия: ${vac.name || ''}`];
        if (descText) parts.push('Описание и требования:\n' + descText);
        if (skills) parts.push('Ключевые навыки: ' + skills);
        vacancyContext = parts.join('\n\n');
      }
    } catch { /* ignore — generate without vacancy context */ }
  }

  // interview_config (set via the ATS editor) — only proposes a concrete call
  // slot when it has real availability, otherwise asks the candidate instead
  // of inventing a time (see hh-message-prompts.js / commit 3ff4e11 / #606).
  let interviewConfig = null;
  try {
    const atsConfigFile = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'ats_config.json');
    if (fs.existsSync(atsConfigFile)) {
      let val = JSON.parse(fs.readFileSync(atsConfigFile, 'utf8'))?.value;
      if (typeof val === 'string') val = JSON.parse(val);
      interviewConfig = val?.interview_config || null;
    }
  } catch { /* ignore */ }
  const availabilityBlock = buildAvailabilityBlock(interviewConfig);

  const recruiterCtx = buildRecruiterIdentity(msgCfg);
  const systemPrompt = msgType === 'rejection'
    ? buildRejectionSystemPrompt({ recruiterCtx, commStyle })
    : buildMessageSystemPrompt({ vacancyContext, recruiterCtx, commStyle, baseOverride });

  const firstName = (candidate_name || 'Кандидат').split(' ')[0];
  const convoCtx = msgs.slice(-8).map(m => {
    const who = m.role === 'employer' ? 'Рекрутер' : 'Кандидат';
    return `${who}: ${(m.text || '').slice(0, 500)}`;
  }).join('\n');
  const ats = history.ats_result || {};
  const gaps = (ats.gaps || []).slice(0, 2).join(', ') || 'нет критических пробелов';
  const atsLine = ats.score != null
    ? `ATS-оценка: ${ats.score}/10, вердикт: ${ats.verdict || 'n/a'}. Совпадения: ${(ats.matched || []).slice(0, 3).join(', ') || 'нет'}. Уточнить: ${gaps}.\n\n`
    : '';
  const userMsg = msgType === 'rejection'
    ? `Напиши вежливый отказ кандидату ${firstName}.`
    : `Кандидат: ${firstName}\n\n${msgType === 'initial' ? `Резюме:\n${fullResumeText || '(резюме недоступно — напиши общее приглашение)'}\n\n` : ''}${atsLine}История переписки:\n${convoCtx || '(переписки ещё не было — это первое сообщение)'}${msgType === 'followup' ? '\n\n(кандидат не ответил на наше последнее сообщение)' : ''}${availabilityBlock}\n\nНапиши следующее сообщение кандидату.`;

  function callLlm(userContent) {
    return new Promise((resolve, reject) => {
      const reqBody = JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        temperature: 0.7,
        max_tokens: 800,
      });
      const hreq = require('https').request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
      }, (hres) => {
        const chunks = [];
        hres.on('data', c => chunks.push(c));
        hres.on('end', () => {
          try {
            const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (p.error) reject(new Error(p.error.message || JSON.stringify(p.error)));
            else resolve(p.choices[0].message.content);
          } catch (e) { reject(e); }
        });
      });
      hreq.on('error', reject);
      hreq.write(reqBody);
      hreq.end();
    });
  }

  try {
    // Guard's primary job is feeding the generator, not just gatekeeping at send
    // time: draft, check, and if it fails on something the model can fix (placeholder,
    // repeated question/intro, template garbage), regenerate once telling it exactly
    // what was wrong. Only a still-failing second attempt reaches the recruiter as a
    // visible warning — invented_time is informational-only so it never triggers this.
    const allowSpecificTime = hhInterviewConfigAllowsTime(username);
    let message = await callLlm(userMsg);
    let guard = await bullshitGuard(message, msgs, { username, allowSpecificTime });
    if (!guard.ok) {
      console.warn(`[hh/generate-message] draft failed guard, regenerating: user=${username} neg=${negotiation_id} reason="${guard.reason}"`);
      const retryMsg = `${userMsg}\n\n(Предыдущая попытка была отклонена автопроверкой: "${guard.reason}". Не повторяй эту ошибку — напиши новый вариант без неё.)`;
      message = await callLlm(retryMsg);
      guard = await bullshitGuard(message, msgs, { username, allowSpecificTime });
    }

    if (!history.ats_result) history.ats_result = {};
    history.ats_result.draft_message = message;
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(histFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    const resp = { ok: true, message };
    if (!guard.ok) resp.guard_warning = guard.reason;
    return json(res, 200, resp);
  } catch (e) {
    console.error('[hh/generate-message] error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/reject') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_ids } = body || {};
  if (!username || !Array.isArray(negotiation_ids) || negotiation_ids.length === 0) {
    return json(res, 400, { error: 'missing fields' });
  }
  const hhTokensBase2 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const tokenFile2 = path.join(hhTokensBase2, String(username), 'hh');
  if (!fs.existsSync(tokenFile2)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData2 = JSON.parse(fs.readFileSync(tokenFile2, 'utf8'));
  const results = [];
  for (const negId of negotiation_ids) {
    try {
      await hhPut(`/negotiations/${REJECT_REASON_ACTION}/${negId}`, tokenData2);
      results.push({ negotiation_id: negId, ok: true });
    } catch (e) { results.push({ negotiation_id: negId, ok: false, error: e.message }); }
  }
  const failed = results.filter(r => !r.ok).length;
  console.log(`[hh/reject] user=${username} total=${negotiation_ids.length} failed=${failed}`);
  return json(res, 200, { ok: true, results });
}

if (req.method === 'POST' && url.pathname === '/hh/send-and-reject') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username, negotiation_id, force } = body || {};
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!username || !negotiation_id || !message) return json(res, 400, { error: 'missing fields' });

  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const tokenFile = path.join(hhTokensBase, String(username), 'hh');
  if (!fs.existsSync(tokenFile)) return json(res, 403, { error: 'HH not connected for this user' });
  const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));

  const dataDir2 = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const histDir2 = path.join(dataDir2, 'hh', String(username), 'candidates');
  fs.mkdirSync(histDir2, { recursive: true });
  const histFile2 = path.join(histDir2, `${negotiation_id}.json`);
  const history2 = fs.existsSync(histFile2) ? JSON.parse(fs.readFileSync(histFile2, 'utf8')) : { messages: [] };
  history2.messages = history2.messages || [];

  // A persisted operation resumes only the HH stage (or asks for reconciliation).
  // Rechecking its already-delivered message trips the duplicate-message guard
  // before sendRejection can perform the safe stage-only retry.
  const resumeOnly = ['message_sent', 'done', 'sending', 'unknown', 'discarding'].includes(history2.rejection_operation?.status);
  const guard2 = resumeOnly ? { ok: true, checks: {} } : await bullshitGuard(message, history2.messages, { username });
  if (!guard2.ok) {
    if (!force) {
      console.warn(`[hh/send-and-reject] guard blocked user=${username} neg=${negotiation_id} reason="${guard2.reason}"`);
      appendGuardBlock(username, negotiation_id, guard2.reason, guard2.checks);
      return json(res, 200, { ok: false, blocked: true, reason: guard2.reason, checks: guard2.checks });
    }
    console.warn(`[hh/send-and-reject] guard block FORCED by user=${username} neg=${negotiation_id} reason="${guard2.reason}"`);
    appendGuardBlock(username, negotiation_id, `[отправлено вручную несмотря на блок] ${guard2.reason}`, guard2.checks, false);
  }
  if (guard2.degraded) {
    console.warn(`[hh/send-and-reject] guard degraded (semantic check skipped) user=${username} neg=${negotiation_id} checks=${JSON.stringify(guard2.checks)}`);
    appendGuardBlock(username, negotiation_id, 'семантическая проверка пропущена (' + (guard2.checks.llm_skipped || 'unknown') + ')', guard2.checks, false);
  }
  if (guard2.checks.invented_time) {
    appendGuardBlock(username, negotiation_id, 'сообщение упоминает время/дату — не блокирует отправку, только для истории', guard2.checks, false);
  }

  try {
    const result = await sendRejection({
      historyFile: histFile2,
      message,
      send: text => hhPostForm(`/negotiations/${negotiation_id}/messages`, tokenData, { message: text }),
      discard: () => hhPut(`/negotiations/${REJECT_REASON_ACTION}/${negotiation_id}`, tokenData),
    });
    console.log(`[hh/send-and-reject] user=${username} neg=${negotiation_id} ok=${result.ok}`);
    return json(res, 200, result);
  } catch (e) {
    console.error('[hh/send-and-reject] error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'GET' && url.pathname === '/hh/style') {
  const username = url.searchParams.get('username') || '';
  const agentSecret = process.env.AGENT_SECRET || '';
  const errStylePage = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Стиль общения</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;background:#f8fafc;color:#1e293b}</style>
</head><body><h2>${msg}</h2></body></html>`);
  };
  if (agentSecret) {
    const { createHmac } = require('crypto');
    const expected = createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16);
    if ((url.searchParams.get('token') || '') !== expected) return errStylePage('Ссылка недействительна. Запроси новую у бота.');
  }
  if (!username) return errStylePage('Не указан пользователь.');
  const hhTokensBase3 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const styleFile3 = path.join(hhTokensBase3, String(username), 'hh-message-style');
  const existingStyle = fs.existsSync(styleFile3) ? fs.readFileSync(styleFile3, 'utf8').trim() : '';
  const callbackBase3 = (process.env.AGENT_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const hmacToken3 = agentSecret ? require('crypto').createHmac('sha256', agentSecret).update(username).digest('hex').slice(0, 16) : '';
  const defaultStyle = '- Тон: профессиональный, дружелюбный, без официоза. Обращение на «вы».\n- Приветствие: «Добрый день, [Имя]!» или «Здравствуйте, [Имя]!»\n- Структура: приветствие → что понравилось в резюме → описание роли → 1-2 конкретных вопроса → призыв ответить\n- Всегда задаю конкретные вопросы по опыту из требований вакансии, не общие\n- Не использую штампы: «рассмотрели вашу кандидатуру», «вакансия открылась», «мы ищем»\n- Длина: 4-6 предложений\n- Подпись: имя рекрутера';
  const rulesValue = (existingStyle || defaultStyle).replace(/`/g, '\\`');
  const existingBase = loadBaseOverride(hhTokensBase3, username) || '';
  const hasBaseOverride = !!existingBase;
  const baseValue = (existingBase || DEFAULT_MESSAGE_BASE).replace(/`/g, '\\`');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(hhStylePageHtml({ username, rulesValue, baseValue, hasBaseOverride, callbackBase: callbackBase3, hmacToken: hmacToken3 }));
}

if (req.method === 'POST' && url.pathname === '/hh/update-style') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body4 = JSON.parse(await readBody(req));
  const { username, token: givenToken, examples, direct = false, save: doSave = true } = body4 || {};
  if (!username || !examples || typeof examples !== 'string') return json(res, 400, { error: 'missing fields' });
  if (!direct && examples.trim().length < 50) return json(res, 400, { error: 'examples too short' });
  const agentSecret4 = process.env.AGENT_SECRET || '';
  if (agentSecret4) {
    const { createHmac } = require('crypto');
    const expected4 = createHmac('sha256', agentSecret4).update(String(username)).digest('hex').slice(0, 16);
    if (givenToken !== expected4) return json(res, 403, { error: 'invalid token' });
  }
  const hhTokensBase4 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');

  // direct mode: save as-is without AI
  if (direct) {
    fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
    fs.writeFileSync(path.join(hhTokensBase4, String(username), 'hh-message-style'), examples.trim());
    console.log('[hh/update-style] direct save for', username, 'len=', examples.length);
    return json(res, 200, { ok: true, style: examples.trim() });
  }

  const orKeyFile4 = path.join(hhTokensBase4, String(username), 'openrouter');
  const apiKey4 = fs.existsSync(orKeyFile4) ? fs.readFileSync(orKeyFile4, 'utf8').trim() : process.env.OPENROUTER_API_KEY;
  if (!apiKey4) return json(res, 503, { error: 'OpenRouter key not configured' });

  const systemPrompt4 = 'Ты — аналитик коммуникаций. Тебе могут прислать отдельные сообщения рекрутера ИЛИ полные диалоги между рекрутером и кандидатом. Если это диалог — проанализируй только сообщения рекрутера, проигнорируй ответы кандидата.\n\nСоставь краткое описание стиля общения рекрутера. Это описание будет использоваться как инструкция для нейросети при генерации новых сообщений.\n\nФормат — структурированный список на русском языке (через дефис):\n- Тон и манера (формальность, теплота)\n- Характерные обороты и приветствия (с реальными примерами из текста)\n- Структура типичного сообщения\n- Что обычно уточняет или спрашивает\n- Чего избегает\n- Длина сообщений\n\nБудь конкретным — цитируй реальные фразы из примеров.';
  const userMsg4 = 'Примеры (могут быть диалоги или отдельные сообщения рекрутера):\n\n' + examples.trim().slice(0, 4000);

  try {
    const style = await new Promise((resolve, reject) => {
      const reqBody4 = JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt4 }, { role: 'user', content: userMsg4 }],
        temperature: 0.3,
        max_tokens: 600,
      });
      const hreq4 = require('https').request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey4, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody4) },
      }, (hres4) => {
        const chunks4 = [];
        hres4.on('data', c => chunks4.push(c));
        hres4.on('end', () => {
          try {
            const p = JSON.parse(Buffer.concat(chunks4).toString('utf8'));
            if (p.error) reject(new Error(p.error.message || JSON.stringify(p.error)));
            else resolve(p.choices[0].message.content);
          } catch (e) { reject(e); }
        });
      });
      hreq4.on('error', reject);
      hreq4.write(reqBody4);
      hreq4.end();
    });

    if (doSave !== false) {
      fs.mkdirSync(path.join(hhTokensBase4, String(username)), { recursive: true });
      fs.writeFileSync(path.join(hhTokensBase4, String(username), 'hh-message-style'), style.trim());
      console.log('[hh/update-style] saved style for', username, 'len=', style.length);
    }
    return json(res, 200, { ok: true, style });
  } catch (e) {
    console.error('[hh/update-style] error:', e.message);
    return json(res, 500, { error: 'generation failed: ' + e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/hh/update-base-prompt') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body5 = JSON.parse(await readBody(req));
  const { username, token: givenToken5, text, reset = false } = body5 || {};
  if (!username) return json(res, 400, { error: 'missing fields' });
  const agentSecret5 = process.env.AGENT_SECRET || '';
  if (agentSecret5) {
    const { createHmac } = require('crypto');
    const expected5 = createHmac('sha256', agentSecret5).update(String(username)).digest('hex').slice(0, 16);
    if (givenToken5 !== expected5) return json(res, 403, { error: 'invalid token' });
  }
  const hhTokensBase5 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const baseFile5 = path.join(hhTokensBase5, String(username), BASE_PROMPT_FILENAME);

  if (reset) {
    try { fs.unlinkSync(baseFile5); } catch { /* already absent */ }
    console.log('[hh/update-base-prompt] reset to default for', username);
    return json(res, 200, { ok: true, text: DEFAULT_MESSAGE_BASE });
  }

  if (!text || typeof text !== 'string' || text.trim().length < 50) {
    return json(res, 400, { error: 'text too short' });
  }
  fs.mkdirSync(path.join(hhTokensBase5, String(username)), { recursive: true });
  fs.writeFileSync(baseFile5, text.trim());
  console.log('[hh/update-base-prompt] saved override for', username, 'len=', text.length);
  return json(res, 200, { ok: true });
}

if (req.method === 'POST' && url.pathname === '/hh/sync-negotiations') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { username: syncUser, vacancy_id: syncVacancyId, token: syncAuth } = body || {};
  if (process.env.AGENT_SECRET && syncAuth !== proactiveHmac(syncUser) && req.headers.authorization !== `Bearer ${process.env.AGENT_SECRET}`) return json(res, 403, { error: 'Invalid token' });
  if (![syncUser, syncVacancyId].every(x => /^[a-zA-Z0-9_-]+$/.test(String(x || '')))) return json(res, 400, { error: 'Invalid scope' });
  const hhTokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const syncTokenFile = path.join(hhTokensBase, String(syncUser), 'hh');
  if (!fs.existsSync(syncTokenFile)) return json(res, 403, { error: 'HH not connected' });
  if (!readActiveVacancies(path.join(BASE_USERS_DIR, syncUser)).some(v => String(v.id) === String(syncVacancyId))) return json(res, 403, { error: 'Unknown vacancy' });
  const syncTokenData = JSON.parse(fs.readFileSync(syncTokenFile, 'utf8'));
  const syncDataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  try {
    const { negotiations, synced_at } = await getHhNegotiationsWithCache(syncDataDir, syncUser, syncVacancyId, syncTokenData.access_token, { force: true });
    console.log(`[hh/sync] user=${syncUser} vacancy=${syncVacancyId} count=${negotiations.length}`);
    return json(res, 200, { ok: true, count: negotiations.length, synced_at });
  } catch (e) {
    console.error('[hh/sync] error:', e.message);
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'GET' && url.pathname === '/hh/proactive') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) {
    return proactiveErrPage('Ссылка недействительна. Запроси новую у бота.');
  }
  const workDir = path.join(BASE_USERS_DIR, username);
  const activeVacancies = readActiveVacancies(workDir);
  const requestedVacancyId = url.searchParams.get('vacancy_id') || '';
  const vacancyId = requestedVacancyId || activeVacancies[0]?.id || '';
  const file = latestProactiveFile(username, vacancyId);
  let results = { vacancy_id: vacancyId, vacancy_title: activeVacancies.find(v => String(v.id) === String(vacancyId))?.title || 'Вакансия', candidates: [], search_queries: [], total_collected: 0, total_after_knockout: 0 };
  if (file) {
    try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return proactiveErrPage('Ошибка чтения данных.'); }
  }
  const callbackBase = (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
  const { loadCandidateComments, loadAllCandidates, candidateMatchesVacancy, candidateStatusOf } = require('../hh-proactive-search');
  const pageComments = loadCandidateComments(username, vacancyId);
  // Render from the unified all-candidates store (search + manual, accumulated
  // across runs) rather than only the latest search-results snapshot — keeps the
  // rest of `results` (vacancy_title, stats, searched_at) from the snapshot.
  // Records with no vacancy_ids (pre-step-7 data, or manually added with no active
  // vacancy resolvable) are a wildcard and show up under every tab.
  const byVacancy = Object.values(loadAllCandidates(username, vacancyId)).filter(c => candidateMatchesVacancy(c, vacancyId));
  // Triage state tabs: a candidate lives in exactly one of active/starred/archived
  // (see hh-proactive-search.js candidateStatusOf) — starring or archiving moves it
  // out of the other tabs entirely instead of just dimming it in place.
  const requestedList = url.searchParams.get('list') || 'active';
  const listView = ['active', 'starred', 'archived'].includes(requestedList) ? requestedList : 'active';
  const stateCounts = { active: 0, starred: 0, archived: 0 };
  for (const c of byVacancy) stateCounts[candidateStatusOf(c)]++;
  let unified = byVacancy.filter(c => candidateStatusOf(c) === listView);
  if (listView === 'active') {
    // Main feed: rank by fit for the vacancy (score), not by recency.
    unified.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    // Fallback for the very first run, before anything has been merged into the
    // unified store yet — show the freshly-computed (already score-sorted) results.
    if (!byVacancy.length) unified = results.candidates || [];
  } else {
    // Starred/archived: most recently moved into this tab first.
    unified.sort((a, b) => new Date(b.status_changed_at || 0) - new Date(a.status_changed_at || 0));
  }
  results.candidates = unified;
  const monitoring = await coldSearchMonitoring(username, workDir, vacancyId);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  return res.end(generateProactivePageHtml(results, username, callbackBase, given, pageComments, { activeVacancies, vacancyId, listView, stateCounts, monitoring }));
}

if (req.method === 'GET' && url.pathname === '/api/hh/proactive/candidates') {
  const username = url.searchParams.get('username') || '';
  const given = url.searchParams.get('token') || '';
  if (process.env.AGENT_SECRET && given !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const { loadAllCandidates } = require('../hh-proactive-search');
  const all = Object.values(loadAllCandidates(username, url.searchParams.get('vacancy_id')))
    .sort((a, b) => new Date(b.found_at || b.added_at || 0) - new Date(a.found_at || a.added_at || 0));
  return json(res, 200, { total: all.length, candidates: all });
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/ai-score') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', candidate_id = '', token: givenToken = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const vacancyId = body.vacancy_id || require('../hh-cold-search-context').readSearchContext(path.join(BASE_USERS_DIR, username), 'active_vacancy')?.id;
  if (!vacancyId) return json(res, 400, { error: 'vacancy_id required' });
  const file = latestProactiveFile(username, vacancyId);
  if (!file) return json(res, 404, { error: 'no results yet' });
  let results;
  try { results = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return json(res, 500, { error: 'read error' }); }
  const candidate = require('../hh-proactive-search').loadAllCandidates(username, vacancyId)[candidate_id]
    || (results.candidates || []).find(c => c.id === candidate_id);
  if (!candidate) return json(res, 404, { error: 'candidate not found' });
  const cfg = results.ats_config || {};
  const knockoutList = (cfg.knockout || []).map(k => `- ${k}`).join('\n');
  const requiredList = (cfg.required || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n');
  const preferredList = (cfg.preferred || []).map(r => `- ${r.name} (вес ${r.weight})`).join('\n');
  const expLines = (candidate.experience || []).map(e => `  ${e.position} — ${e.company} (${e.start || '?'} – ${e.end || 'н.в.'})`).join('\n');
  const prompt = `Оцени кандидата для вакансии "${cfg.vacancy_title || 'Вакансия'}".

Критерии knockout (если отсутствует — отклонить):
${knockoutList || '—'}

Обязательные критерии (с весами):
${requiredList || '—'}

Желательные критерии:
${preferredList || '—'}

Данные кандидата:
Должность: ${candidate.title}
Опыт: ${candidate.total_exp_years} лет
Регион: ${candidate.area}
Компании: ${(candidate.recent_companies || []).join(', ')}
Опыт (должности):
${expLines || '—'}
Текущий score (эвристика): ${candidate.score} (${candidate.tag})

Дай развёрнутую оценку (3-5 предложений): соответствует ли кандидат? Какие сигналы "за" и "против"?
Предложи уточнённый score (число от 0 до 12) и тег (PASS/REVIEW/WEAK).

Ответ строго в JSON: {"evaluation": "...", "score": N, "tag": "PASS|REVIEW|WEAK"}`;

  const hhTokensBase2 = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const orKeyFile2 = path.join(hhTokensBase2, String(username), 'openrouter');
  const orKey2 = fs.existsSync(orKeyFile2) ? fs.readFileSync(orKeyFile2, 'utf8').trim() : (process.env.OPENROUTER_API_KEY || '');
  if (!orKey2) return json(res, 500, { error: 'OpenRouter API key not configured. Add key via /settoken openrouter <key>' });
  try {
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${orKey2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash', max_tokens: 1024, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      return json(res, 500, { error: `OpenRouter API ${aiRes.status}: ${errText.slice(0, 200)}` });
    }
    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { evaluation: text, score: candidate.score, tag: candidate.tag };
    } catch {
      parsed = { evaluation: text, score: candidate.score, tag: candidate.tag };
    }
    return json(res, 200, parsed);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/search') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const workDir = path.join(BASE_USERS_DIR, username);
  try {
    const result = await runProactiveSearch(username, workDir, {
      vacancyId: body.vacancy_id,
      ...(Object.prototype.hasOwnProperty.call(body, 'area') ? { area: body.area } : {}),
      refreshAccessToken: (u) => refreshHhToken(u, _secretsCache),

    });
    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/comment') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', candidate_id = '', text = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!candidate_id) return json(res, 400, { error: 'candidate_id required' });
  try {
    const { saveCandidateComment } = require('../hh-proactive-search');
    saveCandidateComment(username, candidate_id, { text: String(text).slice(0, 1000) }, body.vacancy_id);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/vacancy-state') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token = '', vacancy_id, action } = body || {};
  if (process.env.AGENT_SECRET && token !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  const workDir = path.join(BASE_USERS_DIR, username);
  if (!readActiveVacancies(workDir).some(v => String(v.id) === String(vacancy_id))) return json(res, 404, { error: 'vacancy not tracked' });
  // Page flags (starred/archived) stay in the legacy per-vacancy file; the schedule
  // itself is a cron job owned by hh_proactive_schedule (#1489 S7.1).
  const patches = { enable: { archived: false }, disable: {},
    star: { starred: true }, unstar: { starred: false }, archive: { archived: true }, restore: { archived: false } };
  const cronOp = { enable: 'enable', disable: 'disable', archive: 'disable' }[action];
  if (!patches[action]) return json(res, 400, { error: 'invalid action' });
  try {
    if (action === 'enable') require('../hh-cold-search-context').resolveSearchContext(workDir, vacancy_id);
    if (cronOp) {
      const out = await coldSearchSchedule(username, workDir, { action: cronOp, vacancy_id: String(vacancy_id) });
      if (out.error) return json(res, 502, { error: out.error });
    }
    const state = require('../hh-cold-search-schedule').updateSchedule(username, workDir, vacancy_id, patches[action]);
    return json(res, 200, { ok: true, state: { ...state, ...(await coldSearchMonitoring(username, workDir, vacancy_id)) } });
  } catch (e) { return json(res, 400, { error: e.message }); }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/set-status') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', candidate_id = '', status = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!candidate_id) return json(res, 400, { error: 'candidate_id required' });
  try {
    const { setCandidateStatus } = require('../hh-proactive-search');
    const rec = setCandidateStatus(username, candidate_id, status, body.vacancy_id);
    return json(res, 200, { ok: true, status: rec.status, status_changed_at: rec.status_changed_at });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/import-seen') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', ids = [] } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: 'ids array required' });
  try {
    const { loadSeenIds, saveSeenIds } = require('../hh-proactive-search');
    // Resolve vacancy key the same way runProactiveSearch does — from the ATS
    // config / active vacancy, NOT from the latest results file. Results files
    // don't exist before the first search run, and the recruiter legitimately
    // imports "old 100 candidates" BEFORE enabling the search (so those 100 are
    // never re-notified). Falling back to 'unknown' would put the imports in a
    // bucket the search never reads — the old candidates would be re-notified.
    let vacancyKey = 'unknown';
    const ctxAts = path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'ats_config.json');
    try {
      const raw = JSON.parse(fs.readFileSync(ctxAts, 'utf8'));
      let v = raw?.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (v?.vacancy_id) vacancyKey = String(v.vacancy_id);
    } catch { /* no ats config — fall through */ }
    if (vacancyKey === 'unknown') {
      try {
        const avRaw = JSON.parse(fs.readFileSync(path.join(BASE_USERS_DIR, String(username), 'contexts', 'hh', 'active_vacancy.json'), 'utf8'));
        if (avRaw?.value?.id) vacancyKey = String(avRaw.value.id);
      } catch { /* no active vacancy — fall through */ }
    }
    if (vacancyKey === 'unknown') {
      const latestFile = latestProactiveFile(username);
      if (latestFile) {
        try {
          const r = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
          vacancyKey = r.vacancy_id || r.vacancy_title || 'unknown';
        } catch {}
      }
    }
    const seen = loadSeenIds(username);
    const today = new Date().toISOString().slice(0, 10);
    const bucket = seen[vacancyKey] || {};
    let imported = 0;
    for (const id of ids) {
      const cleanId = String(id).replace(/[^a-zA-Z0-9]/g, '');
      if (cleanId && !bucket[cleanId]) { bucket[cleanId] = today; imported++; }
    }
    seen[vacancyKey] = bucket;
    saveSeenIds(username, seen);
    return json(res, 200, { ok: true, imported, total: Object.keys(bucket).length });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

if (req.method === 'POST' && url.pathname === '/api/hh/proactive/add-manual') {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { username = '', token: givenToken = '', resume_url_or_id = '', vacancy_id: requestedVacancyId = '' } = body || {};
  if (process.env.AGENT_SECRET && givenToken !== proactiveHmac(username)) return json(res, 403, { error: 'invalid token' });
  if (!resume_url_or_id) return json(res, 400, { error: 'resume_url_or_id required' });
  try {
    const { parseResumeId, addManualCandidate } = require('../hh-proactive-search');
    const resumeId = parseResumeId(resume_url_or_id);
    if (!resumeId) return json(res, 400, { error: 'could not parse resume id from input' });
    const hhToken = readHhToken(username);
    if (!hhToken) return json(res, 403, { error: 'HH токен не найден' });
    let resumeData;
    try {
      resumeData = await hhFetch(`/resumes/${encodeURIComponent(resumeId)}`, hhToken);
    } catch (e) {
      // One-shot refresh + retry on expired token, same pattern as proactive-search.
      if (/40[13]/.test(String(e.message || ''))) {
        const fresh = await refreshHhToken(username, _secretsCache);
        if (fresh) resumeData = await hhFetch(`/resumes/${encodeURIComponent(resumeId)}`, { access_token: fresh });
        else throw e;
      } else {
        throw e;
      }
    }
    // Tag with whichever vacancy is active for this profile — prefer the tab the
    // recruiter was on (requestedVacancyId, sent by the page) and fall back to the
    // profile's first active vacancy. If neither resolves, vacancy_ids stays []
    // (wildcard — addManualCandidate's documented behavior for that case).
    const activeVacancies = readActiveVacancies(path.join(BASE_USERS_DIR, username));
    const vacancyId = (requestedVacancyId && activeVacancies.find(v => String(v.id) === String(requestedVacancyId)))
      ? requestedVacancyId
      : (activeVacancies[0]?.id || '');
    const record = addManualCandidate(username, resumeData, vacancyId);
    return json(res, 200, { ok: true, candidate: record });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
  return false;
}

/**
 * Post-gate HH routes (BEHIND the Bearer gate — require Authorization: Bearer).
 * Returns true if the request was handled.
 */
async function handleHhAuthed(req, url, res, ctx) {
  const { BASE_USERS_DIR } = ctx;

if (req.method === 'GET' && url.pathname === '/hh/ats-config') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const username = url.searchParams.get('username') || '';
  const vacancyId = url.searchParams.get('vacancy_id') || null;
  // Must match BASE_USERS_DIR so runHhScoringForUser can find the file
  const workDir = username ? path.join(BASE_USERS_DIR, username) : process.cwd();
  const stagesFile = path.join(workDir, 'contexts', 'hh', 'ats_stages.json');
  const { readAtsConfig } = require('../hh-scoring');
  const config = readAtsConfig(workDir, vacancyId);
  let stages = null;
  try {
    if (fs.existsSync(stagesFile)) stages = JSON.parse(fs.readFileSync(stagesFile, 'utf8')).value;
  } catch {}
  return json(res, 200, { ok: true, config, stages });
}

if (req.method === 'POST' && url.pathname === '/hh/reset-ats-results') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // NOTE (multi-vacancy step 3/6, deliberately deferred): candidate history files
  // (candidates/{neg_id}.json) don't record which vacancy they belong to, so this
  // still resets ALL of a user's candidates across every tracked vacancy — "Re-run
  // Funnel" on one vacancy's tab wipes another vacancy's scores too. Scoping this
  // properly needs either stamping vacancy_id onto candidate history on write, or
  // fetching the vacancy's negotiation ID set here before filtering. Out of scope for
  // the tabs-only pass; flagging so it isn't mistaken for "already handled".
  const body = JSON.parse(await readBody(req));
  const { username } = body || {};
  if (!username) return json(res, 400, { error: 'username required' });
  const dataDir = process.env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data');
  const candDir = path.join(dataDir, 'hh', String(username), 'candidates');
  let reset = 0;
  let skipped = 0;
  if (fs.existsSync(candDir)) {
    for (const f of fs.readdirSync(candDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(candDir, f);
      try {
        const hist = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (hist.ats_result !== undefined) {
          delete hist.ats_result;
          hist.ats_reset_at = new Date().toISOString();
          fs.writeFileSync(fp, JSON.stringify(hist, null, 2));
          reset++;
        } else {
          skipped++;
        }
      } catch { skipped++; }
    }
  }
  console.log(`[hh/reset-ats-results] user=${username} reset=${reset} skipped=${skipped}`);
  return json(res, 200, { ok: true, reset, skipped });
}

if (req.method === 'POST' && url.pathname === '/hh/ats-config') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const body = JSON.parse(await readBody(req));
  const { config, stages, username, vacancy_id: vacancyId } = body || {};
  if (!config || typeof config !== 'object') return json(res, 400, { error: 'config required' });
  // Must match BASE_USERS_DIR so runHhScoringForUser can find the file
  const contextBase = username
    ? path.join(BASE_USERS_DIR, username, 'contexts')
    : path.join(process.cwd(), 'contexts');
  const hhContextDir = path.join(contextBase, 'hh');
  fs.mkdirSync(hhContextDir, { recursive: true });
  const now = new Date().toISOString();
  // Once the editor knows which vacancy it's editing (multi-vacancy tabs), save under
  // the per-vacancy key only — writing to the legacy singleton too would let whichever
  // vacancy tab saves last silently clobber the others' config (same class of bug
  // step 2/6 fixed for the background scoring read path; see hh-scoring.js readAtsConfig).
  const configName = vacancyId ? `ats_config:${vacancyId}` : 'ats_config';
  fs.writeFileSync(
    path.join(hhContextDir, `${configName}.json`),
    JSON.stringify({ value: { ...config, vacancy_id: vacancyId || config.vacancy_id }, updated_at: now }, null, 2),
  );
  // Funnel stages stay a single global blob for now (deliberately deferred, like
  // hh_generate_message tone context in PR #1067 — different vacancies commonly share
  // the same interview stages; per-vacancy stages can follow if that stops being true).
  if (Array.isArray(stages)) {
    fs.writeFileSync(
      path.join(hhContextDir, 'ats_stages.json'),
      JSON.stringify({ value: stages, updated_at: now }, null, 2),
    );
  }
  console.log(`[hh/ats-config] saved vacancy="${config.vacancy_title}" vacancy_id=${vacancyId || 'legacy'} stages=${stages?.length || 0} user=${username || 'default'}`);
  return json(res, 200, { ok: true });
}
  return false;
}

module.exports = { handleHhPublic, handleHhAuthed, generateCandidateProfileHtml };
