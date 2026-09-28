'use strict';
// Bugs & Features collector — turns report folders (written by sessions in the
// `bugs-and-features` project) into GitHub issues.
//
// Runs as a cross-profile cron (`scripts/bugs-collector-cron.sh`). It is deliberately
// NOT exposed as an MCP tool and has no HTTP route: users never invoke it, and it never
// writes into a user's working tree beyond its own `collector/state.json`. See
// BUGS-AND-FEATURES-SPEC.md §3.2/§3.6.
//
// Trigger model — a debounce without a long-lived watcher:
//   cron every ~2 min + a "quiet gate". A report is collected only once NOTHING under
//   its folder has changed for QUIET_MS (default 3 min). While the session is still
//   dropping in a transcript/attachment, the folder mtime keeps moving and the report
//   stays invisible to the collector. This survives restarts and needs no daemon.
//
// Dedup / processed marking — `index.jsonl` is append-only and is NEVER rewritten here.
// Processed ids live in `collector/state.json` ({processed:{id:{issue,url,at}}}), so a
// re-run never re-opens an issue. Each issue body also carries a hidden marker
// `<!-- bugs-collector:<profile>/<id> -->`; if state is ever lost the collector falls
// back to searching GitHub for that marker before creating a duplicate.
//
// The issue text is written by an LLM (what happened, who hit it, what the user wants),
// because a template flattens a multi-message report into noise. If the model/key is
// unavailable we still file a plain, complete template issue — a report is never dropped.

const fs = require('fs');
const path = require('path');
const { USERS_ROOT, listProfiles } = require('./data-paths');
const { atomicJson } = require('./atomic-json');
const { resolveGithubToken } = require('./github-token');

const REPO = process.env.BUGS_COLLECTOR_REPO || process.env.BUG_REPORT_REPO || 'trained-assist/trained-assist-agent';
const QUIET_MS = Number(process.env.BUGS_COLLECTOR_QUIET_MS || 3 * 60 * 1000);
const MODEL = process.env.BUGS_COLLECTOR_MODEL || 'google/gemini-2.5-flash';
const PROJECT_ID = 'bugs-and-features';
const MARKER = (profile, id) => `<!-- bugs-collector:${profile}/${id} -->`;

// ── Paths ─────────────────────────────────────────────────────────────────────
function projectDir(profileDir) {
  return path.join(profileDir, 'projects', PROJECT_ID);
}
function indexPath(profileDir) {
  return path.join(projectDir(profileDir), 'index.jsonl');
}
function statePath(profileDir) {
  return path.join(projectDir(profileDir), 'collector', 'state.json');
}

// ── Index (append-only contract) ──────────────────────────────────────────────
// Parses one profile's index.jsonl. Malformed lines are skipped, not fatal.
function readIndex(profileDir) {
  const file = indexPath(profileDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (e) {
      console.warn(`[bugs-collector] skipping malformed line in ${file}: ${e.message}`);
    }
  }
  return entries;
}

// Returns [{ profile, entry }] for every open entry across every profile under USERS_ROOT.
function collectOpen({ usersRoot = USERS_ROOT } = {}) {
  const profiles = listProfiles(usersRoot);
  const open = [];
  for (const profile of profiles) {
    const entries = readIndex(path.join(usersRoot, profile));
    for (const entry of entries) {
      if (entry && entry.status === 'open') open.push({ profile, entry });
    }
  }
  return open;
}

// ── State ─────────────────────────────────────────────────────────────────────
function readState(profileDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(profileDir), 'utf8'));
    if (s && s.processed && typeof s.processed === 'object') return s;
  } catch { /* missing or unreadable -> fresh state */ }
  return { processed: {} };
}
function writeState(profileDir, state) {
  try {
    atomicJson(statePath(profileDir), state);
  } catch (e) {
    console.warn(`[bugs-collector] could not persist state for ${profileDir}: ${e.message}`);
  }
}

// ── Quiet gate ────────────────────────────────────────────────────────────────
// Newest mtime anywhere under `dir` (folder + files, recursive). 0 if it doesn't exist.
function newestMtimeMs(dir) {
  let max = 0;
  const walk = (d) => {
    let st;
    try { st = fs.statSync(d); } catch { return; }
    if (st.mtimeMs > max) max = st.mtimeMs;
    if (!st.isDirectory()) return;
    let ents = [];
    try { ents = fs.readdirSync(d); } catch { return; }
    for (const e of ents) walk(path.join(d, e));
  };
  walk(dir);
  return max;
}

// A report is "quiet" when nothing under its folder changed for >= quietMs.
function isQuiet(reportDir, { now = Date.now(), quietMs = QUIET_MS } = {}) {
  const m = newestMtimeMs(reportDir);
  if (m === 0) return false; // missing folder -> nothing to collect
  return (now - m) >= quietMs;
}

// ── Report reading ────────────────────────────────────────────────────────────
// `dir` comes from index.jsonl — keep it a plain relative path inside reports/.
function safeRel(p) {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) &&
    !p.split(/[\\/]/).includes('..');
}
function reportDir(profileDir, entry) {
  const rel = entry.dir || entry.id;
  if (!safeRel(rel)) return null;
  return path.join(projectDir(profileDir), 'reports', rel);
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function readReportInput(dir) {
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch { /* optional */ }
  let transcript = '';
  try { transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8').slice(0, 8000); } catch { /* optional */ }
  return {
    report,
    transcript,
    attachments: listDir(path.join(dir, 'attachments')),
    evidence: listDir(path.join(dir, 'evidence')),
  };
}

// ── Issue text (LLM, with a durable template fallback) ─────────────────────────
function extractJson(raw) {
  const fenced = String(raw || '').match(/```(?:json)?\n([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : String(raw || '')).trim();
  return JSON.parse(candidate);
}

function fallbackIssue({ entry, profile, input }) {
  const r = input.report || {};
  const kind = r.kind === 'feature' || entry.kind === 'feature' ? 'feature' : 'bug';
  const title = `[${kind}] ${(r.title || entry.title || entry.id).slice(0, 120)}`;
  const lines = [
    `**Тип:** ${kind}`,
    `**Профиль:** \`${profile}\``,
    `**Отчёт:** \`${entry.id}\`${r.area ? ` · область: ${r.area}` : ''}${r.severity ? ` · важность: ${r.severity}` : ''}`,
    '',
    '### Что сообщил пользователь',
    r.summary || '(в report.json нет summary)',
    '',
    '### Контекст',
    r.sessionId ? `Сессия: \`${r.sessionId}\`` : '',
    input.transcript ? `\n<details><summary>Транскрипт</summary>\n\n${input.transcript}\n\n</details>` : '',
    input.attachments.length ? `\nВложения (локально): ${input.attachments.join(', ')}` : '',
    input.evidence.length ? `\nEvidence (локально): ${input.evidence.join(', ')}` : '',
    '',
    '_Собрано автоматически из проекта «Bugs and Features» (fallback-шаблон: модель недоступна)._',
  ];
  return { kind, title, body: lines.filter(Boolean).join('\n') };
}

async function llmIssue({ entry, profile, input, apiKey, model = MODEL }) {
  const r = input.report || {};
  const system = [
    'Ты — сборщик багов и фич из внутренних отчётов пользователей продукта.',
    'На входе — папка отчёта: report.json, сырой транскрипт сообщений пользователя, списки вложений и evidence.',
    'Составь ПОДРОБНУЮ заявку в GitHub на русском так, чтобы её можно было взять в работу без переспросов.',
    'Обязательно раскрой: (1) что случилось / что хотят; (2) кто столкнулся (профиль);',
    '(3) зачем это нужно и что именно хочет пользователь его словами; (4) контекст и шаги воспроизведения, если видны.',
    'Не выдумывай факты, которых нет во входе. Если чего-то не хватает — так и напиши «уточнить».',
    'Ответь ТОЛЬКО JSON без markdown-обёртки:',
    '{"kind":"bug|feature","title":"краткий заголовок","body":"подробное описание в markdown","labels":["..."]}',
  ].join(' ');
  const user = [
    `Профиль: ${profile}`,
    `Запись индекса: ${JSON.stringify(entry)}`,
    `report.json: ${JSON.stringify(input.report)}`,
    `Вложения: ${input.attachments.join(', ') || '(нет)'}`,
    `Evidence: ${input.evidence.join(', ') || '(нет)'}`,
    '',
    'Транскрипт сообщений пользователя:',
    input.transcript || '(пусто)',
  ].join('\n');

  // Service-LLM ladder (src/service-llm.js: Go rungs → OpenRouter last).
  const content = await require('./service-llm').serviceText({ system, user, maxTokens: 2000, temperature: 0.2, timeoutMs: 45_000, apiKey, source: 'bugs-collector' });
  if (content == null) throw new Error('bugs-collector: no service-llm rung answered');
  const parsed = extractJson(content);
  if (!parsed || !parsed.title || !parsed.body) throw new Error('model returned no usable title/body');
  const kind = parsed.kind === 'feature' ? 'feature' : 'bug';
  const labels = Array.isArray(parsed.labels) ? parsed.labels.filter(x => typeof x === 'string') : [];
  return { kind, title: String(parsed.title).slice(0, 140), body: String(parsed.body), labels };
}

// ── GitHub ────────────────────────────────────────────────────────────────────
// Env first (GITHUB_ISSUES_TOKEN/GH_TOKEN), then the credential file — never the
// token embedded in the git remote URL (see src/github-token.js).
function resolveToken() {
  return resolveGithubToken();
}

async function ghFindExisting(marker, token, repo = REPO) {
  const q = encodeURIComponent(`repo:${repo} is:issue in:body "${marker}"`);
  const res = await fetch(`https://api.github.com/search/issues?q=${q}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'trained-assist-agent' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const item = data?.items?.[0];
  return item ? { number: item.number, url: item.html_url } : null;
}

async function ghCreateIssue({ title, body, labels, token, repo = REPO }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'trained-assist-agent',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub create HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function run({
  usersRoot = USERS_ROOT,
  now = Date.now(),
  quietMs = QUIET_MS,
  dryRun = false,
  apiKey = process.env.OPENROUTER_API_KEY,
  token = resolveToken(),
  model = MODEL,
  repo = REPO,
  llm = llmIssue,
  createIssue = ghCreateIssue,
  findExisting = ghFindExisting,
  logger = console,
} = {}) {
  const profiles = listProfiles(usersRoot);

  const result = { profiles: profiles.length, due: 0, created: [], skipped: 0, errors: [] };

  for (const profile of profiles) {
    const pDir = path.join(usersRoot, profile);
    const state = readState(pDir);
    let stateChanged = false;

    for (const entry of readIndex(pDir)) {
      if (!entry || entry.status !== 'open') continue;
      if (state.processed[entry.id]) { result.skipped++; continue; }

      const dir = reportDir(pDir, entry);
      if (!dir) { result.errors.push(`${profile}/${entry.id}: bad dir`); continue; }
      if (!fs.existsSync(dir)) { result.errors.push(`${profile}/${entry.id}: report folder missing`); continue; }
      if (!isQuiet(dir, { now, quietMs })) { result.skipped++; continue; }

      result.due++;
      const input = readReportInput(dir);
      const marker = MARKER(profile, entry.id);

      // Guard against a duplicate if state was lost: metadata-only, best-effort.
      if (!dryRun && token) {
        try {
          const existing = await findExisting(marker, token, repo);
          if (existing) {
            state.processed[entry.id] = { issue: existing.number, url: existing.url, at: now, via: 'marker' };
            stateChanged = true;
            logger.log(`[bugs-collector] already filed ${profile}/${entry.id} -> ${existing.url}`);
            continue;
          }
        } catch (e) {
          logger.warn(`[bugs-collector] dedup search failed for ${profile}/${entry.id}: ${e.message}`);
        }
      }

      let issue;
      try {
        if (llm !== llmIssue || require('./service-llm').available(apiKey)) {
          issue = await llm({ entry, profile, input, apiKey, model });
        } else {
          throw new Error('no LLM key (OpenCode Go / OPENROUTER_API_KEY)');
        }
      } catch (e) {
        logger.warn(`[bugs-collector] LLM failed for ${profile}/${entry.id} (${e.message}); using template`);
        issue = fallbackIssue({ entry, profile, input });
      }
      const labels = [...new Set([issue.kind, 'from-bugs-collector', ...(issue.labels || [])])];
      const body = `${marker}\n\n${issue.body}`;

      if (dryRun) {
        result.created.push({ profile, id: entry.id, dryRun: true, title: issue.title });
        logger.log(`[bugs-collector][dry-run] ${profile}/${entry.id}: ${issue.title}`);
        continue;
      }
      if (!token) {
        result.errors.push(`${profile}/${entry.id}: no GitHub token (nothing filed)`);
        continue;
      }

      try {
        const created = await createIssue({ title: issue.title, body, labels, token, repo });
        state.processed[entry.id] = { issue: created.number, url: created.url, at: now };
        stateChanged = true;
        result.created.push({ profile, id: entry.id, issue: created.number, url: created.url, title: issue.title });
        logger.log(`[bugs-collector] filed ${profile}/${entry.id} -> ${created.url}`);
      } catch (e) {
        result.errors.push(`${profile}/${entry.id}: ${e.message}`);
        logger.error(`[bugs-collector] create failed for ${profile}/${entry.id}: ${e.message}`);
      }
    }

    if (stateChanged) writeState(pDir, state);
  }

  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const quietArg = args.find(a => a.startsWith('--quiet-ms='));
  const nowArg = args.find(a => a.startsWith('--now='));
  const dryRun = args.includes('--dry-run');
  run({
    dryRun,
    quietMs: quietArg ? Number(quietArg.split('=')[1]) : QUIET_MS,
    now: nowArg ? Number(nowArg.split('=')[1]) : Date.now(),
  }).then((r) => {
    if (r.created.length === 0 && r.errors.length === 0) {
      console.log(`[bugs-collector] no reports due (profiles=${r.profiles}, skipped=${r.skipped}).`);
    } else {
      console.log(`[bugs-collector] profiles=${r.profiles} due=${r.due} filed=${r.created.length}` +
        `${dryRun ? ' (dry-run)' : ''} skipped=${r.skipped} errors=${r.errors.length}`);
      for (const c of r.created) console.log(`  + ${c.profile}/${c.id} -> ${c.url || c.title}`);
      for (const e of r.errors) console.log(`  ! ${e}`);
    }
    process.exit(0);
  }).catch((e) => {
    console.error('[bugs-collector] fatal:', e.message);
    process.exit(1);
  });
}

module.exports = {
  collectOpen, readIndex, indexPath,
  projectDir, statePath, readState, writeState,
  newestMtimeMs, isQuiet, reportDir, readReportInput,
  fallbackIssue, llmIssue, resolveToken, ghFindExisting, ghCreateIssue,
  run, MARKER, QUIET_MS, MODEL, REPO, PROJECT_ID,
};
