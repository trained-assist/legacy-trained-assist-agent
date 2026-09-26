'use strict';

function fmtSalary(salary) {
  if (!salary) return null;
  const from = salary.from ? salary.from.toLocaleString('ru-RU') : null;
  const to = salary.to ? salary.to.toLocaleString('ru-RU') : null;
  const cur = salary.currency === 'RUR' ? '₽' : (salary.currency || '');
  if (from && to) return `${from}–${to} ${cur}/мес`;
  if (from) return `от ${from} ${cur}/мес`;
  if (to) return `до ${to} ${cur}/мес`;
  return null;
}

function fmtDate(iso) {
  if (!iso) return '…';
  return iso.slice(0, 7).replace('-', '.');
}

// Russian dd.mm.yyyy date format for the "Найден: ДД.ММ.ГГГГ" discovery badge.
// Returns null (not a placeholder string) for missing/invalid input so callers can
// omit the badge entirely rather than render something broken.
function fmtFoundAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function tagBadgeBg(tag) {
  if (tag === 'PASS') return '#16a34a';
  if (tag === 'REVIEW') return '#ca8a04';
  return '#6b7280';
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTags(tags, color, bg) {
  if (!tags || !tags.length) return '';
  return tags.map(t =>
    `<span class="tag" style="background:${bg};color:${color};border:1px solid ${color}40">${escHtml(t)}</span>`
  ).join('');
}

function candidateCard(c, idx, existingComment) {
  const salary = fmtSalary(c.salary);
  const companies = (c.recent_companies || []).slice(0, 3).join(' · ');

  // Enrichment tags
  const plusTags = renderTags(c.plus_tags, '#15803d', '#f0fdf4');
  const yellowTags = renderTags(c.yellow_tags, '#92400e', '#fffbeb');
  const redTags = renderTags(c.red_tags, '#991b1b', '#fef2f2');
  const hasTags = plusTags || yellowTags || redTags;

  // Summary
  const summaryWhy = escHtml(c.summary_why || '');
  const summaryPitch = escHtml(c.summary_pitch || '');
  const hasSummary = summaryWhy || summaryPitch;

  // Fallback heuristic signals (shown only when no AI enrichment)
  const signals = !hasTags
    ? (c.score_signals || []).map(s => `<span class="tag tag-gray">${escHtml(s)}</span>`).join('')
    : '';

  // Experience list (compact)
  const expRows = (c.experience || []).map(e =>
    `<li>${escHtml(e.position)} — ${escHtml(e.company)} (${fmtDate(e.start)}–${fmtDate(e.end)})</li>`
  ).join('');

  const hasAi = Boolean(c.plus_tags || c.summary_why);
  const isNew = Boolean(c.is_new);
  const commentText = escHtml(existingComment || '');
  // Discovery date badge (#1) — found_at is set for search-discovered candidates and
  // for manually-added ones (added_at). Omit silently when absent/unparseable rather
  // than showing a placeholder — e.g. legacy candidates from before this field existed.
  const foundAtLabel = fmtFoundAt(c.found_at || c.added_at);
  const source = c.source === 'manual' ? 'manual' : 'search';
  const fullName = `${c.first_name || ''} ${c.last_name || ''}`.trim();
  const searchBlob = escHtml(`${fullName} ${c.title || ''}`.trim());
  // Triage status (active/starred/archived) lives on the candidate record — missing
  // status (legacy data) defaults to 'active', mirroring candidateStatusOf() in
  // hh-proactive-search.js. Each state gets its own set of move-to actions; moving
  // a card out of the tab it's currently rendered in removes it from view client-side.
  const status = c.status === 'starred' ? 'starred' : c.status === 'archived' ? 'archived' : 'active';
  const idAttr = escHtml(c.id);
  const statusActions = status === 'active'
    ? `<button class="btn-star" onclick="setStatus('${idAttr}','starred',this)">⭐ Выбрать</button>
    <button class="btn-archive" onclick="setStatus('${idAttr}','archived',this)">🗄 В архив</button>`
    : status === 'starred'
    ? `<button class="btn-star btn-star-active" onclick="setStatus('${idAttr}','active',this)">★ Убрать из выбранных</button>
    <button class="btn-archive" onclick="setStatus('${idAttr}','archived',this)">🗄 В архив</button>`
    : `<button class="btn-restore" onclick="setStatus('${idAttr}','active',this)">↩ Вернуть в список</button>`;

  return `<div class="card ${isNew ? 'card-new' : ''}" data-idx="${idx}" data-id="${idAttr}" data-score="${Number(c.score || 0)}" data-tag="${escHtml(c.tag || '')}" data-source="${source}" data-search="${searchBlob.toLowerCase()}">
  <div class="card-header">
    <div class="card-left">
      <a class="card-title" href="${escHtml(c.hh_url)}" target="_blank" rel="noopener">${escHtml(c.title)}</a>
      <div class="card-meta">
        ${isNew ? '<span class="badge-new">NEW</span> ' : ''}${c.age ? `${c.age} лет · ` : ''}${c.total_exp_years} лет опыта · ${escHtml(c.area)}${salary ? ` · <span class="salary">${escHtml(salary)}</span>` : ''}
      </div>
      ${companies ? `<div class="card-companies">${escHtml(companies)}</div>` : ''}
      <div class="card-badges-row">
        ${foundAtLabel ? `<span class="badge-found">Найден: ${foundAtLabel}</span>` : ''}
        ${source === 'manual' ? '<span class="badge-manual">Добавлен вручную</span>' : ''}
      </div>
    </div>
    <div class="card-right">
      <span class="badge" style="background:${tagBadgeBg(c.tag)}">${escHtml(c.tag)} ${(Number(c.score) || 0).toFixed(1)}</span>
    </div>
  </div>

  ${hasTags ? `<div class="tags-row">${plusTags}${yellowTags}${redTags}</div>` : ''}
  ${signals ? `<div class="tags-row">${signals}</div>` : ''}

  ${hasSummary ? `<div class="summary">
    ${summaryWhy ? `<p class="summary-why">${summaryWhy}</p>` : ''}
    ${summaryPitch ? `<p class="summary-pitch">💼 ${summaryPitch}</p>` : ''}
  </div>` : ''}

  ${expRows ? `<details class="exp-details"><summary class="exp-toggle">Карьера</summary><ul class="exp-list">${expRows}</ul></details>` : ''}

  <div class="comment-row">
    <textarea class="comment-box" placeholder="Комментарий (например: не из Новосибирска, без банковского опыта…)" rows="2" data-id="${idAttr}">${commentText}</textarea>
    <button class="btn-comment" onclick="saveComment('${idAttr}', this)">Сохранить</button>
  </div>

  <div class="card-footer">
    <a class="btn-hh" href="${escHtml(c.hh_url)}" target="_blank" rel="noopener">Открыть резюме ↗</a>
    <button class="btn-ai ${hasAi ? 'btn-ai-secondary' : ''}" onclick="openAiModal('${idAttr}','${escHtml(c.title)}')">${hasAi ? 'Обновить AI оценку' : 'AI оценить'}</button>
    ${statusActions}
  </div>
</div>`;
}

function generateProactivePageHtml(results, username, callbackBase, token, existingComments, opts = {}) {
  const { activeVacancies = [], vacancyId = '', listView = 'active', stateCounts = { active: 0, starred: 0, archived: 0 } } = opts;
  const monitoring = opts.monitoring || {};
  const candidates = results.candidates || [];
  const comments = existingComments || {};
  const searchedAt = results.searched_at
    ? new Date(results.searched_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    : '—';
  const passCount = candidates.filter(c => c.tag === 'PASS').length;
  const reviewCount = candidates.filter(c => c.tag === 'REVIEW').length;
  const newCount = candidates.filter(c => c.is_new).length;
  const isEnriched = results.ai_enriched !== false && candidates.some(c => c.plus_tags || c.summary_why);

  // Slider upper bound (#4): scores are roughly 0-10 but technically unbounded
  // (baseScore + sum of criteria weights for this vacancy), so size the slider to
  // whatever's actually in the data, with a sane floor so it isn't a degenerate 0-0
  // range on a fresh/empty list.
  const maxObservedScore = candidates.reduce((m, c) => Math.max(m, Number(c.score) || 0), 0);
  const sliderMax = Math.max(10, Math.ceil(maxObservedScore * 10) / 10);

  const cardChunks = candidates.map((c, i) => candidateCard(c, i, comments[c.id]?.text));
  const cardsJson = JSON.stringify(cardChunks);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Проактивный поиск — ${escHtml(results.vacancy_title || 'Вакансия')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;min-height:100vh}
a{color:#2563eb;text-decoration:none}
a:hover{text-decoration:underline}

/* Header */
.header{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;position:sticky;top:0;z-index:10}
.header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.vacancy-tabs{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.vacancy-tab{padding:6px 14px;border:1px solid #c7d2fe;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;color:#4f46e5;background:#eef2ff}
.vacancy-tab.active{background:#4f46e5;color:#fff;border-color:#4f46e5}
.state-tabs{display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap}
.state-tab{padding:6px 14px;border:1px solid #e2e8f0;border-radius:20px;font-size:13px;font-weight:600;text-decoration:none;color:#475569;background:#f1f5f9}
.state-tab.active{background:#1e293b;color:#fff;border-color:#1e293b}
.vacancy-title{font-size:1.05rem;font-weight:600;color:#1e293b}
.searched-at{font-size:.78rem;color:#94a3b8;margin-top:2px}
.ai-badge{display:inline-block;font-size:.72rem;background:#ede9fe;color:#6d28d9;border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.stat{background:#f1f5f9;border-radius:6px;padding:4px 10px;font-size:.8rem;color:#475569}
.stat strong{color:#1e293b}
.btn-search{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:.83rem;cursor:pointer;white-space:nowrap;flex-shrink:0}
.btn-search:hover{background:#1d4ed8}
.btn-search:disabled{opacity:.6;cursor:not-allowed}

/* Main */
.main{max-width:860px;margin:0 auto;padding:18px 14px}

/* Card */
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:15px;margin-bottom:12px}
.card-new{border-left:3px solid #2563eb}
.badge-new{display:inline-block;background:#2563eb;color:#fff;border-radius:3px;padding:1px 5px;font-size:.68rem;font-weight:700;letter-spacing:.04em;vertical-align:middle;margin-right:3px}
.card-badges-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.badge-found{display:inline-block;font-size:.72rem;color:#64748b;background:#f1f5f9;border-radius:4px;padding:1px 7px}
.badge-manual{display:inline-block;font-size:.72rem;color:#7c3aed;background:#f3e8ff;border-radius:4px;padding:1px 7px}

/* Comment */
.comment-row{display:flex;gap:6px;align-items:flex-start;margin:6px 0}
.comment-box{flex:1;font-size:.78rem;border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;resize:vertical;color:#1e293b;background:#fff;font-family:inherit}
.comment-box:focus{outline:none;border-color:#6366f1}
.btn-comment{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;padding:5px 10px;font-size:.75rem;cursor:pointer;color:#475569;white-space:nowrap;align-self:flex-start}
.btn-comment:hover{background:#e2e8f0}
.btn-comment.saved{color:#16a34a;border-color:#86efac}
.card-header{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:8px}
.card-left{flex:1;min-width:0}
.card-title{font-size:.97rem;font-weight:600;display:block;margin-bottom:3px;line-height:1.3}
.card-meta{font-size:.8rem;color:#64748b;margin-bottom:3px}
.salary{color:#16a34a;font-weight:500}
.card-companies{font-size:.78rem;color:#94a3b8}
.card-right{flex-shrink:0;padding-top:1px;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.badge{display:inline-block;color:#fff;border-radius:5px;padding:3px 9px;font-size:.75rem;font-weight:700;letter-spacing:.03em}

/* Tags */
.tags-row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.tag{border-radius:4px;padding:2px 8px;font-size:.73rem;font-weight:500;white-space:nowrap}
.tag-gray{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}

/* Summary */
.summary{background:#f8fafc;border-left:3px solid #6366f1;border-radius:0 6px 6px 0;padding:10px 12px;margin-bottom:8px;font-size:.83rem;line-height:1.55}
.summary-why{color:#1e293b;margin-bottom:5px}
.summary-pitch{color:#4338ca;font-style:italic}

/* Career */
.exp-details{margin-bottom:8px}
.exp-toggle{font-size:.78rem;color:#94a3b8;cursor:pointer;list-style:none;user-select:none}
.exp-toggle::-webkit-details-marker{display:none}
.exp-toggle::before{content:"▸ "}
details[open] .exp-toggle::before{content:"▾ "}
.exp-list{margin:5px 0 0 14px;font-size:.78rem;color:#64748b;line-height:1.6}

/* Footer */
.card-footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.btn-hh{background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#0369a1;font-weight:500}
.btn-hh:hover{background:#e0f2fe}
.btn-ai{background:#ede9fe;border:1px solid #c4b5fd;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#6d28d9;font-weight:500}
.btn-ai:hover{background:#ddd6fe}
.btn-ai-secondary{background:#f8fafc;border-color:#e2e8f0;color:#64748b}
.btn-ai-secondary:hover{background:#f1f5f9}
.btn-star{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#92400e;font-weight:500}
.btn-star:hover{background:#fef3c7}
.btn-star-active{background:#fef3c7;border-color:#fcd34d}
.btn-archive{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#64748b;font-weight:500}
.btn-archive:hover{background:#f1f5f9}
.btn-restore{background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#0369a1;font-weight:500}
.btn-restore:hover{background:#e0f2fe}

/* Import row */
.import-row{margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9}
.btn-import{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:5px 12px;font-size:.78rem;cursor:pointer;color:#475569}
.btn-import:hover{background:#f1f5f9}
.btn-import.secondary{margin-left:6px}

/* Manual-add form */
.manual-row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.manual-input{flex:1;min-width:220px;font-size:.78rem;border:1px solid #e2e8f0;border-radius:5px;padding:6px 8px;color:#1e293b;background:#fff;font-family:inherit}
.manual-input:focus{outline:none;border-color:#6366f1}

/* Filter bar */
.filter-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid #f1f5f9}
.search-input{flex:1;min-width:180px;font-size:.83rem;border:1px solid #e2e8f0;border-radius:6px;padding:7px 10px;color:#1e293b;background:#fff;font-family:inherit}
.search-input:focus{outline:none;border-color:#6366f1}
.score-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.score-filter input[type=range]{width:140px}
.score-filter-label{font-size:.78rem;color:#64748b;white-space:nowrap}
.preset-btns{display:flex;gap:4px;flex-wrap:wrap}
.btn-preset{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;padding:4px 9px;font-size:.75rem;cursor:pointer;color:#475569}
.btn-preset:hover{background:#e2e8f0}
.btn-preset.active{background:#2563eb;color:#fff;border-color:#2563eb}
.source-filter{font-size:.78rem;border:1px solid #e2e8f0;border-radius:5px;padding:5px 8px;color:#1e293b;background:#fff;font-family:inherit}
.filter-count{font-size:.8rem;color:#64748b;white-space:nowrap;margin-left:auto}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#fff;border-radius:12px;padding:24px;max-width:580px;width:92%;max-height:82vh;overflow-y:auto;position:relative}
.modal-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:1.2rem;cursor:pointer;color:#94a3b8;line-height:1}
.modal-close:hover{color:#1e293b}
.modal-title{font-size:.97rem;font-weight:600;margin-bottom:14px;padding-right:24px}
.modal-body{font-size:.88rem;line-height:1.6;color:#1e293b}
.modal-score{margin-top:12px;padding:10px 12px;background:#f8fafc;border-radius:6px;font-size:.83rem;border:1px solid #e2e8f0}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:60px 20px;color:#94a3b8;font-size:.9rem}

/* Dark mode */
@media(prefers-color-scheme:dark){
  body{background:#0f172a;color:#e2e8f0}
  .header{background:#1e293b;border-color:#334155}
  .vacancy-title,.stat strong{color:#e2e8f0}
  .stat{background:#0f172a;color:#94a3b8}
  .card{background:#1e293b;border-color:#334155}
  .card-meta,.page-info{color:#94a3b8}
  .summary{background:#1a1f2e;border-left-color:#818cf8}
  .summary-why{color:#e2e8f0}
  .summary-pitch{color:#a5b4fc}
  .tag-gray{background:#334155;color:#94a3b8;border-color:#475569}
  .btn-page{background:#1e293b;border-color:#334155;color:#e2e8f0}
  .btn-page:hover:not(:disabled){background:#334155}
  .btn-hh{background:#0c1a2e;border-color:#1e40af;color:#93c5fd}
  .btn-ai{background:#1e1b4b;border-color:#4338ca;color:#a5b4fc}
  .btn-ai-secondary{background:#1e293b;border-color:#334155;color:#64748b}
  .comment-box{background:#0f172a;border-color:#334155;color:#e2e8f0}
  .btn-comment{background:#1e293b;border-color:#334155;color:#94a3b8}
  .btn-comment:hover{background:#334155}
  .modal{background:#1e293b;color:#e2e8f0}
  .modal-score{background:#0f172a;border-color:#334155}
  .exp-list{color:#94a3b8}
  .ai-badge{background:#1e1b4b;color:#a5b4fc}
  .badge-found{background:#0f172a;color:#94a3b8}
  .badge-manual{background:#2e1065;color:#c4b5fd}
  .search-input,.manual-input{background:#0f172a;border-color:#334155;color:#e2e8f0}
  .btn-preset{background:#1e293b;border-color:#334155;color:#94a3b8}
  .btn-preset:hover{background:#334155}
  .btn-preset.active{background:#2563eb;color:#fff;border-color:#2563eb}
  .source-filter{background:#0f172a;border-color:#334155;color:#e2e8f0}
  .filter-count,.score-filter-label{color:#94a3b8}
  .filter-bar{border-color:#334155}
  .state-tab{background:#1e293b;border-color:#334155;color:#94a3b8}
  .state-tab.active{background:#e2e8f0;color:#0f172a;border-color:#e2e8f0}
  .btn-star{background:#1e1b0a;border-color:#78350f;color:#fbbf24}
  .btn-star-active{background:#451a03;border-color:#92400e}
  .btn-archive{background:#1e293b;border-color:#334155;color:#94a3b8}
  .btn-restore{background:#0c1a2e;border-color:#1e40af;color:#93c5fd}
}
@media(max-width:600px){.card-header{flex-direction:column}.card-right{align-self:flex-end}.header-top{flex-direction:column}}
</style>
</head>
<body>
<div class="header">
${activeVacancies.length > 1 ? `<div class="vacancy-tabs">${activeVacancies.map(v => {
  const href = `${escHtml(callbackBase)}/hh/proactive?username=${escHtml(username)}&token=${escHtml(token)}&vacancy_id=${escHtml(v.id)}`;
  const isActive = String(v.id) === String(vacancyId);
  return `<a class="vacancy-tab${isActive ? ' active' : ''}" href="${href}">${escHtml(v.title || v.id)}</a>`;
}).join('')}</div>` : ''}
  <div class="state-tabs">${[
    ['active', 'Найдено'],
    ['starred', '⭐ Выбрано'],
    ['archived', '🗄 Архив'],
  ].map(([key, label]) => {
    const href = `${escHtml(callbackBase)}/hh/proactive?username=${escHtml(username)}&token=${escHtml(token)}${vacancyId ? `&vacancy_id=${escHtml(vacancyId)}` : ''}&list=${key}`;
    const isActive = key === listView;
    return `<a class="state-tab${isActive ? ' active' : ''}" href="${href}">${label} (${stateCounts[key] || 0})</a>`;
  }).join('')}</div>
  ${vacancyId ? `<div data-testid="vacancy-monitoring">
    <span role="status">Мониторинг: ${monitoring.archived ? 'вакансия в архиве' : monitoring.enabled ? 'включён' : 'выключен'}.
    Попытка: ${escHtml(monitoring.last_attempt || '—')}. Успешно: ${escHtml(monitoring.last_success || '—')}.
    Результат: ${escHtml(({ partial: 'поиск выполнен, AI-оценка не завершена', success: 'есть новые', zero_new: 'новых нет', succeeded: 'поиск выполнен', failed: 'ошибка', running: 'выполняется', unknown: 'исход неизвестен (запуск прерван)', rejected: 'не запущен политикой' })[monitoring.status] || 'ещё не запускался')}.${monitoring.enabled && monitoring.next_run ? ` Следующий: ${escHtml(monitoring.next_run)}.` : ''}</span>
    ${monitoring.error ? `<span role="alert">${escHtml(monitoring.error)}</span>` : ''}
    <button data-testid="monitor-toggle" onclick="vacancyAction('${monitoring.enabled ? 'disable' : 'enable'}',this)">${monitoring.enabled ? 'Отключить мониторинг' : 'Включить мониторинг'}</button>
    <button data-testid="vacancy-star" onclick="vacancyAction('${monitoring.starred ? 'unstar' : 'star'}',this)">${monitoring.starred ? '★ Убрать звезду вакансии' : '☆ Отметить вакансию'}</button>
    <button data-testid="vacancy-archive" onclick="vacancyAction('${monitoring.archived ? 'restore' : 'archive'}',this)">${monitoring.archived ? 'Вернуть вакансию из архива' : 'Архивировать вакансию'}</button>
  </div>` : ''}
  <div class="header-top">
    <div>
      <div class="vacancy-title">
        ${escHtml(results.vacancy_title || 'Проактивный поиск')}
        ${isEnriched ? '<span class="ai-badge">AI оценён</span>' : ''}
      </div>
      <div class="searched-at">Поиск: ${escHtml(searchedAt)}</div>
    </div>
    <button class="btn-search" id="searchBtn" onclick="runSearch()">🔍 Новый поиск</button>
  </div>
  <div class="stats">
    <div class="stat">Собрано: <strong>${results.total_collected || 0}</strong></div>
    <div class="stat">После фильтра: <strong>${results.total_after_knockout || 0}</strong></div>
    <div class="stat">PASS: <strong style="color:#16a34a">${passCount}</strong></div>
    ${reviewCount ? `<div class="stat">REVIEW: <strong style="color:#ca8a04">${reviewCount}</strong></div>` : ''}
    ${newCount ? `<div class="stat">Новых: <strong style="color:#2563eb">${newCount}</strong></div>` : ''}
    <div class="stat">${listView === 'active' ? 'Топ' : 'Показано'}: <strong>${candidates.length}</strong></div>
  </div>
  <div class="import-row">
    <button class="btn-import" onclick="toggleImport()">📥 Импорт просмотренных</button>
    <button class="btn-import secondary" onclick="toggleManualAdd()">➕ Добавить кандидата вручную</button>
    <div id="importPanel" style="display:none;margin-top:8px">
      <textarea id="importIds" class="comment-box" style="width:100%;height:60px" placeholder="Вставьте ссылки HH или ID резюме (по одному на строку)"></textarea>
      <button class="btn-comment" style="margin-top:4px" onclick="importSeen()">Добавить в базу просмотренных</button>
      <span id="importStatus" style="margin-left:8px;font-size:.78rem;color:#64748b"></span>
    </div>
    <div id="manualAddPanel" style="display:none;margin-top:8px">
      <div class="manual-row">
        <input id="manualInput" class="manual-input" type="text" placeholder="Ссылка на резюме HH или ID резюме">
        <button class="btn-comment" onclick="addManualCandidate()">Добавить кандидата</button>
      </div>
      <span id="manualAddStatus" style="font-size:.78rem;color:#64748b"></span>
    </div>
  </div>
  <div class="filter-bar">
    <input id="nameSearch" class="search-input" type="text" placeholder="Поиск по имени / должности…">
    <div class="score-filter">
      <span class="score-filter-label">Score ≥</span>
      <input id="scoreSlider" type="range" min="0" max="${sliderMax}" step="0.1" value="0">
      <span class="score-filter-label" id="scoreSliderVal">0.0</span>
    </div>
    <div class="preset-btns" id="presetBtns">
      <button class="btn-preset active" data-preset="all">Все</button>
      <button class="btn-preset" data-preset="pass">PASS</button>
      <button class="btn-preset" data-preset="review">REVIEW</button>
      <button class="btn-preset" data-preset="top9">Топ ≥9</button>
    </div>
    <select id="sourceFilter" class="source-filter">
      <option value="">Все источники</option>
      <option value="search">Найдены поиском</option>
      <option value="manual">Добавлены вручную</option>
    </select>
    <span class="filter-count" id="filterCount"></span>
  </div>
</div>

<div class="main">
  <div id="cards"></div>
  <div class="empty" id="emptyState" style="display:none">Нет кандидатов, подходящих под фильтр</div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()" title="Закрыть">✕</button>
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-score" id="modalScore" style="display:none"></div>
  </div>
</div>

<script>
// Full unified candidate list (search + manual), rendered client-side. #2/#5: no
// server pagination — this is an internal tool with realistically dozens to low
// hundreds of candidates, so a plain continuous scroll over the filtered set is
// simpler and fine.
const CARDS = ${cardsJson};
// let, not const: setStatus() decrements this when a card moves out of the
// current tab (starred/archived), so the "показано N из M" counter stays accurate
// without a full page reload.
let TOTAL = CARDS.length;
const USERNAME = ${JSON.stringify(username)};
const TOKEN = ${JSON.stringify(token)};
const CALLBACK_BASE = ${JSON.stringify(callbackBase)};
const SLIDER_MAX = ${JSON.stringify(sliderMax)};
const VACANCY_ID = ${JSON.stringify(vacancyId || '')};

let activePreset = 'all';
const FILTER_KEY = 'hh-proactive-filters:' + USERNAME + ':' + VACANCY_ID;
function saveFilters() {
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify({
    name: document.getElementById('nameSearch').value,
    score: document.getElementById('scoreSlider').value,
    source: document.getElementById('sourceFilter').value, preset: activePreset,
  })); } catch {}
}
try {
  const filters = JSON.parse(sessionStorage.getItem(FILTER_KEY) || '{}');
  document.getElementById('nameSearch').value = filters.name || '';
  document.getElementById('scoreSlider').value = filters.score || 0;
  document.getElementById('scoreSliderVal').textContent = Number(document.getElementById('scoreSlider').value).toFixed(1);
  document.getElementById('sourceFilter').value = filters.source || '';
  activePreset = ['all', 'pass', 'review', 'top9'].includes(filters.preset) ? filters.preset : 'all';
  document.querySelectorAll('#presetBtns .btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === activePreset));
} catch {}
window.addEventListener('pagehide', saveFilters);
let modalRequest = 0;

// Debounce helper (#3: ~150-200ms) shared by the name search input.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Composite client-side filter (#5): name/title search + score floor + quick preset
// (all/PASS/REVIEW/top-score) + optional source, all combined with AND, no reload.
function matchesFilters(el, nameQuery, minScore, preset, source) {
  const score = parseFloat(el.dataset.score) || 0;
  const tag = el.dataset.tag || '';
  if (nameQuery) {
    // Cyrillic-safe: toLowerCase() works correctly on Cyrillic in JS, and data-search
    // is pre-lowercased server-side — just do a plain substring match, no regex.
    const haystack = el.dataset.search || '';
    if (!haystack.includes(nameQuery)) return false;
  }
  if (score < minScore) return false;
  if (preset === 'pass' && tag !== 'PASS') return false;
  if (preset === 'review' && tag !== 'REVIEW') return false;
  if (preset === 'top9' && score < 9) return false;
  if (source && el.dataset.source !== source) return false;
  return true;
}

function applyFilters() {
  saveFilters();
  const nameQuery = document.getElementById('nameSearch').value.trim().toLowerCase();
  const minScore = parseFloat(document.getElementById('scoreSlider').value) || 0;
  const source = document.getElementById('sourceFilter').value;
  const cards = document.querySelectorAll('#cards .card');
  let shown = 0;
  cards.forEach(el => {
    const visible = matchesFilters(el, nameQuery, minScore, activePreset, source);
    el.style.display = visible ? '' : 'none';
    if (visible) shown++;
  });
  document.getElementById('filterCount').textContent = 'показано ' + shown + ' из ' + TOTAL;
  document.getElementById('emptyState').style.display = (TOTAL > 0 && shown === 0) ? 'block' : 'none';
}

const applyFiltersDebounced = debounce(applyFilters, 180);

function renderCards() {
  document.getElementById('cards').innerHTML = CARDS.length
    ? CARDS.join('')
    : '';
  document.getElementById('emptyState').style.display = CARDS.length ? 'none' : 'block';
  if (!CARDS.length) document.getElementById('emptyState').textContent = 'Нет кандидатов';
  applyFilters();
}

document.getElementById('nameSearch').addEventListener('input', applyFiltersDebounced);
document.getElementById('sourceFilter').addEventListener('change', applyFilters);
document.getElementById('scoreSlider').addEventListener('input', e => {
  document.getElementById('scoreSliderVal').textContent = parseFloat(e.target.value).toFixed(1);
  applyFiltersDebounced();
});

document.getElementById('presetBtns').addEventListener('click', e => {
  const btn = e.target.closest('.btn-preset');
  if (!btn) return;
  activePreset = btn.dataset.preset;
  document.querySelectorAll('#presetBtns .btn-preset').forEach(b => b.classList.toggle('active', b === btn));
  applyFilters();
});

function openAiModal(candidateId, title) {
  const request = ++modalRequest;
  const modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = '<div style="text-align:center;padding:24px"><div class="spinner"></div><div style="margin-top:10px;color:#94a3b8;font-size:.85rem">Запрашиваю AI оценку…</div></div>';
  document.getElementById('modalScore').style.display = 'none';
  modal.classList.add('open');

  fetch(CALLBACK_BASE + '/api/hh/proactive/ai-score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, candidate_id: candidateId, token: TOKEN, vacancy_id: VACANCY_ID }),
  })
  .then(r => r.json())
  .then(data => {
    if (request !== modalRequest) return;
    if (data.error) {
      document.getElementById('modalBody').innerHTML = '<span style="color:#dc2626">Ошибка: ' + esc(data.error) + '</span>';
      return;
    }
    // Render tags from AI response
    const plusHtml = (data.plus_tags||[]).map(t => '<span class="tag" style="background:#f0fdf4;color:#15803d;border:1px solid #86efac40">'+esc(t)+'</span>').join('');
    const yellowHtml = (data.yellow_tags||[]).map(t => '<span class="tag" style="background:#fffbeb;color:#92400e;border:1px solid #fcd34d40">'+esc(t)+'</span>').join('');
    const redHtml = (data.red_tags||[]).map(t => '<span class="tag" style="background:#fef2f2;color:#991b1b;border:1px solid #fca5a540">'+esc(t)+'</span>').join('');
    const tagsRow = (plusHtml||yellowHtml||redHtml) ? '<div class="tags-row" style="margin-bottom:12px">'+plusHtml+yellowHtml+redHtml+'</div>' : '';

    const summaryWhy = esc(data.summary_why||'');
    const summaryPitch = esc(data.summary_pitch||'');
    const summaryHtml = (summaryWhy||summaryPitch) ? '<div class="summary">'+(summaryWhy?'<p class="summary-why">'+summaryWhy+'</p>':'')+(summaryPitch?'<p class="summary-pitch">💼 '+summaryPitch+'</p>':'')+'</div>' : '';

    const evalHtml = data.evaluation ? '<p style="margin-top:8px;line-height:1.6">'+renderMd(esc(data.evaluation))+'</p>' : '';

    document.getElementById('modalBody').innerHTML = tagsRow + summaryHtml + evalHtml;

    if (data.score !== undefined || data.tag) {
      const tagColor = data.tag === 'PASS' ? '#16a34a' : data.tag === 'REVIEW' ? '#ca8a04' : '#6b7280';
      const scoreEl = document.getElementById('modalScore');
      scoreEl.innerHTML = 'AI оценка: <span style="background:'+tagColor+';color:#fff;border-radius:4px;padding:2px 8px;font-weight:700">'+esc(data.tag||'')+(data.score?' '+data.score:'')+'</span>';
      scoreEl.style.display = 'block';
    }
  })
  .catch(e => {
    if (request !== modalRequest) return;
    document.getElementById('modalBody').innerHTML = '<span style="color:#dc2626">Ошибка: ' + esc(e.message) + '</span>';
  });
}

function closeModal() {
  modalRequest++;
  document.getElementById('modal').classList.remove('open');
}
document.getElementById('modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

function renderMd(text) {
  return text
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,'<em>$1</em>')
    .replace(/\\n/g,'<br>');
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function vacancyAction(action, button) {
  button.disabled = true;
  try {
    const response = await fetch(CALLBACK_BASE + '/api/hh/proactive/vacancy-state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, vacancy_id: VACANCY_ID, action }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Ошибка сохранения');
    location.reload();
  } catch (error) { alert(error.message); button.disabled = false; }
}

async function runSearch() {
  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Идёт поиск + AI…';
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, vacancy_id: VACANCY_ID }),
    });
    const data = await res.json();
    if (data.error) {
      alert('Ошибка: ' + data.error);
      btn.disabled = false;
      btn.textContent = '🔍 Новый поиск';
    } else {
      btn.textContent = '✅ Готово! Обновляем…';
      setTimeout(() => location.reload(), 1200);
    }
  } catch (e) {
    alert('Ошибка: ' + e.message);
    btn.disabled = false;
    btn.textContent = '🔍 Новый поиск';
  }
}

async function saveComment(candidateId, btn) {
  const textarea = document.querySelector('.comment-box[data-id="' + candidateId + '"]');
  if (!textarea) return;
  const text = textarea.value.trim();
  btn.textContent = '…';
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, candidate_id: candidateId, text, vacancy_id: VACANCY_ID }),
    });
    const data = await res.json();
    if (data.error) { btn.textContent = 'Ошибка'; return; }
    btn.textContent = 'Сохранено';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'Сохранить'; btn.classList.remove('saved'); }, 2000);
  } catch (e) {
    btn.textContent = 'Ошибка';
  }
}

function toggleImport() {
  const panel = document.getElementById('importPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function toggleManualAdd() {
  const panel = document.getElementById('manualAddPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// Move a candidate between active/starred/archived. Each tab only shows candidates
// in its own state, so a successful transition means this card no longer belongs on
// the current page — remove it from the DOM (and the live counter) instead of just
// toggling a class. On failure, leave the card in place and surface the error.
async function setStatus(candidateId, status, btn) {
  const card = btn.closest('.card');
  card.style.opacity = '.4';
  btn.disabled = true;
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/set-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, candidate_id: candidateId, status, vacancy_id: VACANCY_ID }),
    });
    const data = await res.json();
    if (data.error) {
      card.style.opacity = '';
      btn.disabled = false;
      alert('Ошибка: ' + data.error);
      return;
    }
    card.remove();
    TOTAL--;
    applyFilters();
  } catch (e) {
    card.style.opacity = '';
    btn.disabled = false;
    alert('Ошибка: ' + e.message);
  }
}

// #2: real manual-add — creates a persisted candidate card (distinct from
// import-seen, which only excludes an id from future search results).
async function addManualCandidate() {
  const input = document.getElementById('manualInput');
  const status = document.getElementById('manualAddStatus');
  const value = input.value.trim();
  if (!value) { status.textContent = 'Вставьте ссылку на резюме или ID'; return; }
  status.textContent = 'Добавляю…';
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/add-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, resume_url_or_id: value, vacancy_id: VACANCY_ID }),
    });
    const data = await res.json();
    if (data.error) { status.textContent = 'Ошибка: ' + esc(data.error); return; }
    status.textContent = 'Кандидат добавлен. Обновляем список…';
    input.value = '';
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    status.textContent = 'Ошибка: ' + esc(e.message);
  }
}

async function importSeen() {
  const raw = document.getElementById('importIds').value;
  const status = document.getElementById('importStatus');
  // Extract IDs from HH URLs (e.g. hh.ru/resume/abc123) or bare IDs
  const ids = raw.split(/\\n|\\r|,/).map(s => {
    const m = s.match(/\\/resume\\/([a-zA-Z0-9]+)/);
    return m ? m[1] : s.replace(/[^a-zA-Z0-9]/g, '');
  }).filter(Boolean);
  if (!ids.length) { status.textContent = 'Не найдено ID'; return; }
  status.textContent = 'Отправляю…';
  try {
    const res = await fetch(CALLBACK_BASE + '/api/hh/proactive/import-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, token: TOKEN, ids }),
    });
    const data = await res.json();
    if (data.error) { status.textContent = 'Ошибка: ' + esc(data.error); return; }
    status.textContent = 'Добавлено ' + (data.imported || 0) + ' ID в базу просмотренных.';
    document.getElementById('importIds').value = '';
  } catch (e) {
    status.textContent = 'Ошибка: ' + esc(e.message);
  }
}

renderCards();
</script>
</body>
</html>`;
}

module.exports = { generateProactivePageHtml };
