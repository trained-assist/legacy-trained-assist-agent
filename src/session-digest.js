'use strict';

// «📋 Сжатый лог» — the friendly session digest behind GET /web/session/:id/digest
// and POST /web/session-digest (issue #1777). Two passes over one session:
//
//   Pass A (deterministic, free): the trace timeline cut into buckets per tool
//     family (files / web / code / send / other) with minutes summed from the
//     events' own timestamps, plus artifacts — the same detectors the PostToolUse
//     hook uses (URLs, e-mails, IPs, tickets, file paths, masked API keys) and
//     the phone detector this module adds — classified into PI vs attributes.
//   Pass B (one cheap LLM call): a compact projection → strict JSON contract
//     {activities:[{label,minutes}], summary}. The model only NAMES the buckets;
//     minutes stay deterministic («деньги только за названия»). One retry, then
//     degrade to the deterministic part without a summary — never an error.
//
// Honesty (#1893): an empty session (no trace events and at most one
// substantive message) answers {empty:true, message:'Лог недоступен'} BEFORE
// the cache and without any LLM call — the model used to invent verdicts like
// «Сессия фактически не состоялась…» out of nothing. A non-empty one carries
// facts[] — deterministic per-family objects (file paths, URLs, repositories,
// commands, publications) pulled from the events; pass B only retells them.
//
// Result is cached at <workDir>/sessions/<id>.digest.json, keyed by a freshness
// hash (event count + last event time + message count), TTL 7 days — same TTL
// as the trace itself. A session without an opencode trace (claude engine) still
// gets a digest, built from its messages alone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userWorkDir } = require('./data-paths');
const { atomicJson } = require('./atomic-json');
const { getSession } = require('./session-store');
const { readTrace } = require('./session-trace');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const DIGEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Bump whenever pass A/B semantics change (idle-gap caps, detectors, labels).
// The freshness key is content-only, so without a format version a stale
// cache keeps serving the OLD numbers for up to TTL — a fixed bug that still
// shows the wrong value on screen for days. Version is part of the key → one
// bump invalidates every cached digest at once.
const DIGEST_FORMAT_VERSION = 3;
const MIN = 60 * 1000;
const MAX_IDLE_GAP_MS = 120 * MIN;   // one event never claims more than 2h of "work"
const MAX_VALUE = 500;               // chars per artifact value
const MAX_MSG = 300;                 // chars of message text carried into the projection

const FAMILY_LABELS = {
  files: 'Работа с файлами',
  web: 'Работа в интернете',
  code: 'Код и тесты',
  send: 'Отправка и публикации',
  other: 'Прочее',
  messages: 'Переписка',
};

// ── Pass A: detectors ────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>)\]},]{4,}/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const API_KEY_RE = /\b(AIza[A-Za-z0-9_-]{35}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xoxb-[A-Za-z0-9-]+)\b/g;
const TICKET_RE = /#\d{2,}\b|\b[A-Z][A-Z0-9]+-\d+\b/g;
const PHONE_CAND_RE = /(?<![\d])\+?\d[\d\s().-]{7,}\d(?![\d])/g;

const EMAIL_SKIP = ['example.com', '@types', '@modelcontextprotocol', '@anthropic', 'noreply', '@users.noreply'];
const TICKET_SKIP = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'HTTP', 'UTF', 'SHA', 'RSA', 'AES']);

/**
 * Phone numbers, normalized: '+7 (916) 123-45-67' → '+79161234567',
 * '8 916 765 43 21' → '+79167654321', '+44 20 7946 0958' → '+442079460958'.
 * Deliberately strict against the usual false positives: an INN (10 digits),
 * a date (2026-09-28), a pid (123456) and a version (1.2.3) are not phones —
 * a bare number must be exactly 11 digits starting 7/8 (RU), a '+' number
 * must carry 8–15 digits.
 */
function detectPhones(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Set();
  for (const cand of text.match(PHONE_CAND_RE) || []) {
    const digits = cand.replace(/[()\s.\-]/g, '');
    if (!/^\+?\d+$/.test(digits)) continue;
    if (digits.startsWith('+')) {
      const d = digits.slice(1);
      if (d.length >= 8 && d.length <= 15) out.add(`+${d}`);
      continue;
    }
    if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) out.add(`+7${digits.slice(1)}`);
  }
  return [...out];
}

function extractUrls(text) {
  const m = text.match(URL_RE) || [];
  return [...new Set(m.map(u => u.replace(/[.,;:!?)}\]]+$/, '')).filter(u => u.length <= MAX_VALUE))].slice(0, 10);
}

function extractEmails(text) {
  const m = text.match(EMAIL_RE) || [];
  return [...new Set(m)].filter(e => !EMAIL_SKIP.some(s => e.includes(s))).slice(0, 5);
}

function extractIPs(text) {
  const m = text.match(IP_RE) || [];
  return [...new Set(m)].filter(ip => !ip.startsWith('0.') && !ip.startsWith('127.0') && ip !== '0.0.0.0').slice(0, 5);
}

function extractApiKeys(text) {
  const m = text.match(API_KEY_RE) || [];
  return [...new Set(m)].slice(0, 3).map(key => ({
    masked: `${key.slice(0, 8)}...${key.slice(-4)}`,
  }));
}

function extractTickets(text) {
  const m = text.match(TICKET_RE) || [];
  return [...new Set(m)].filter(t => !TICKET_SKIP.has(t.split('-')[0]) && t.length < 20).slice(0, 5);
}

/** Run every detector over one blob of text → raw {type, kind?, value} entries. */
function detectAll(text) {
  const out = [];
  if (!text) return out;
  for (const url of extractUrls(text)) out.push({ type: 'url', value: url });
  for (const email of extractEmails(text)) out.push({ type: 'contact', kind: 'email', value: email });
  for (const phone of detectPhones(text)) out.push({ type: 'contact', kind: 'phone', value: phone });
  for (const ip of extractIPs(text)) out.push({ type: 'ip', value: ip });
  for (const { masked } of extractApiKeys(text)) out.push({ type: 'api_key', value: masked });
  for (const ticket of extractTickets(text)) out.push({ type: 'ticket', value: ticket });
  return out;
}

/**
 * Split artifacts into what is PERSONAL (phone / e-mail / IP) and what is an
 * ATTRIBUTE (links, documents, tickets, companies). Masked API keys are neither:
 * they never appear in the PI group.
 */
function classifyArtifacts(list) {
  const groups = { pi: [], attributes: [], other: [] };
  for (const a of list || []) {
    if (!a || a.value == null) continue;
    const type = a.type;
    const kind = a.kind || (a.metadata && a.metadata.kind) || '';
    const isPI = type === 'ip' || kind === 'ip_address'
      || (type === 'contact' && (kind === 'phone' || kind === 'email'))
      || kind === 'phone' || kind === 'email';
    const isKey = type === 'api_key' || kind === 'api_key';
    if (isKey) groups.other.push(a);
    else if (isPI) groups.pi.push(a);
    else groups.attributes.push(a);
  }
  return groups;
}

// ── Pass A: timeline buckets ─────────────────────────────────────────────────

const WEB_TOOLS = /^(webfetch|web_search|websearch|browser|playwright|fetch|http|crawl|scrape|website|ru_browser)/;
const FILES_TOOLS = /^(read|write|edit|multiedit|delete|glob|grep|ls|tree|patch|move|copy|mkdir|find|list)/;
const CODE_TOOLS = /^(bash|shell|exec|run|test|npm|node|python|repl|spawn|github|engineering|cicd|dev_)/;
// MCP tools arrive as `<server>_<tool>` (engineering-skills_github_pr_checks); a server name
// always has a dash, so `web_search` is left alone.
const MCP_PREFIX = /^[a-z0-9]+(?:-[a-z0-9]+)+_(?=.)/;
const SEND_TOOLS = /^(publish|deploy|send|upload|share|tg_send)/;

function familyOf(ev) {
  if (!ev || ev.kind !== 'tool') return 'other';
  const t = String(ev.tool || '').toLowerCase().replace(MCP_PREFIX, '');
  if (SEND_TOOLS.test(t)) return 'send';
  if (WEB_TOOLS.test(t)) return 'web';
  if (FILES_TOOLS.test(t)) return 'files';
  if (CODE_TOOLS.test(t)) return 'code';
  if (t === 'bash' && /curl|wget|https?:\/\//.test(ev.input || '')) return 'web';
  return 'other';
}

/** ms per family: each event claims the gap until the next one (idle gaps capped). */
function timelineMs(events) {
  const timed = (events || []).filter(e => typeof e.at === 'number');
  const sorted = timed.slice().sort((a, b) => a.at - b.at);
  const totals = {};
  for (let i = 0; i < sorted.length - 1; i++) {
    let delta = sorted[i + 1].at - sorted[i].at;
    if (delta <= 0) continue;
    if (delta > MAX_IDLE_GAP_MS) delta = MAX_IDLE_GAP_MS;
    const family = familyOf(sorted[i]);
    totals[family] = (totals[family] || 0) + delta;
  }
  return totals;
}

function activitiesFromTotals(totals) {
  return Object.keys(totals)
    .map(family => ({ family, minutes: Math.round(totals[family] / MIN), label: FAMILY_LABELS[family] || family }))
    .filter(a => a.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.family.localeCompare(b.family));
}

function truncateValue(s) {
  const v = String(s == null ? '' : s).trim();
  return v.length > MAX_VALUE ? v.slice(0, MAX_VALUE) + '…' : v;
}

function inputFilePaths(ev) {
  if (ev.kind !== 'tool' || typeof ev.input !== 'string') return [];
  try {
    const obj = JSON.parse(ev.input);
    if (!obj || typeof obj !== 'object') return [];
    const p = obj.filePath || obj.path || obj.file_path;
    return p ? [String(p)] : [];
  } catch { return []; }
}

/**
 * Deterministic pass over one session: buckets with minutes + classified
 * artifacts. Same input → byte-identical output (no wall-clock anywhere).
 */
function buildDigest({ events, messages } = {}) {
  events = Array.isArray(events) ? events : [];
  messages = Array.isArray(messages) ? messages : [];

  const totals = timelineMs(events);
  let activities = activitiesFromTotals(totals);
  if (!activities.length && messages.length > 1) {
    // No engine trace — the conversation itself is the timeline. Cap each
    // consecutive gap at MAX_IDLE_GAP_MS, exactly like timelineMs does for the
    // trace: a thread that spans days must not report days of "work". Long
    // pauses between replies are idle time, not activity.
    const ats = messages.map(m => m.at).filter(a => typeof a === 'number').sort((a, b) => a - b);
    let ms = 0;
    for (let i = 0; i < ats.length - 1; i++) {
      const delta = ats[i + 1] - ats[i];
      if (delta <= 0) continue;
      ms += Math.min(delta, MAX_IDLE_GAP_MS);
    }
    const minutes = Math.round(ms / MIN);
    if (minutes > 0) activities = [{ family: 'messages', minutes, label: FAMILY_LABELS.messages }];
  }

  const raw = [];
  for (const ev of events) {
    if (ev.kind === 'tool') raw.push(...detectAll(`${ev.input || ''} ${ev.output || ''}`));
    else if (ev.kind === 'text' && ev.text) raw.push(...detectAll(ev.text));
    for (const p of inputFilePaths(ev)) raw.push({ type: 'file', value: truncateValue(p) });
  }
  for (const m of messages) if (typeof m.content === 'string') raw.push(...detectAll(m.content));

  const seen = new Set();
  const deduped = [];
  for (const a of raw) {
    const value = truncateValue(a.value);
    if (!value) continue;
    const key = `${a.type}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...a, value });
  }

  const users = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  return {
    activities,
    facts: buildFacts(events),
    artifacts: classifyArtifacts(deduped),
    firstUserMessage: users.length ? truncateValue(users[0].content).slice(0, MAX_MSG) : null,
    lastUserMessage: users.length > 1 ? truncateValue(users[users.length - 1].content).slice(0, MAX_MSG) : null,
  };
}

// ── Pass A: facts (what was touched, not how it went) ───────────────────────

const MAX_FACT_ITEMS = 10;     // per family
const MAX_COMMAND = 160;       // chars per bash command shown
const MAX_CONTEXT = 200;       // chars of reasoning carried as context
const MIN_SUBSTANTIVE = 20;    // chars: shorter messages («привет») carry no work
const EMPTY_MESSAGE = 'Лог недоступен';
const REPO_URL_RE = /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?=[/\s"'#?]|$)/g;
const REPO_FLAG_RE = /(?:--repo|-R)[\s=]+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;

const FACT_FAMILIES = [
  ['files', 'Файлы'],
  ['web', 'Сайты'],
  ['github', 'GitHub'],
  ['bash', 'Команды'],
  ['send', 'Публикации и отправка'],
  ['context', 'Контекст (рассуждение агента)'],
];

function toolInputObject(ev) {
  if (typeof ev.input !== 'string' || !ev.input) return {};
  try { const o = JSON.parse(ev.input); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}

function reposIn(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(REPO_URL_RE)) out.push(m[1]);
  for (const m of text.matchAll(REPO_FLAG_RE)) out.push(m[1]);
  return out;
}

function oneLine(s, n) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
}

/**
 * Deterministic facts per family from trace events: the concrete objects the
 * agent touched. No verdicts, no counts of "success" — only what the events
 * name. → [{family, label, items:[string]}] (families without items omitted).
 */
function buildFacts(events) {
  const bags = Object.fromEntries(FACT_FAMILIES.map(([f]) => [f, new Set()]));
  const add = (family, v) => { const x = oneLine(v, MAX_VALUE); if (x && bags[family].size < MAX_FACT_ITEMS) bags[family].add(x); };
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev) continue;
    if (ev.kind === 'reasoning' && ev.text && ev.text.trim().length >= MIN_SUBSTANTIVE) {
      add('context', oneLine(ev.text, MAX_CONTEXT));
      continue;
    }
    if (ev.kind !== 'tool') continue;
    const tool = String(ev.tool || '').toLowerCase().replace(MCP_PREFIX, '');
    const input = toolInputObject(ev);
    const blob = `${ev.input || ''} ${ev.output || ''}`;
    for (const r of reposIn(blob)) add('github', r);
    if (typeof input.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(input.repo)) add('github', input.repo);
    const family = familyOf(ev);
    if (tool === 'bash' || tool === 'shell') {
      if (input.command) add('bash', oneLine(input.command, MAX_COMMAND));
      continue;
    }
    if (family === 'send') {
      const urls = extractUrls(String(ev.output || ''));
      if (urls.length) urls.forEach(u => add('send', u));
      else add('send', [tool, input.slug || input.title || input.path || input.file_path || ''].filter(Boolean).join(': '));
      continue;
    }
    if (family === 'web') {
      if (input.url) add('web', input.url);
      else if (input.query) add('web', `поиск: ${input.query}`);
      else extractUrls(String(ev.input || '')).forEach(u => add('web', u));
      continue;
    }
    for (const p of inputFilePaths(ev)) add('files', p);
    if (!inputFilePaths(ev).length && family === 'files' && input.pattern) add('files', `${tool}: ${input.pattern}`);
  }
  return FACT_FAMILIES
    .filter(([f]) => bags[f].size)
    .map(([family, label]) => ({ family, label, items: [...bags[family]] }));
}

/** Nothing to tell: no trace events, at most one substantive message, and no
 *  concrete object (link, contact, ticket…) in the messages either — a lone
 *  «позвони +7 916 …» still carries a fact worth showing. */
function isEmptySession(events, messages) {
  if (Array.isArray(events) && events.length) return false;
  const texts = (Array.isArray(messages) ? messages : [])
    .filter(m => typeof m.content === 'string').map(m => m.content.trim());
  if (texts.some(t => detectAll(t).length)) return false;
  return texts.filter(t => t.length >= MIN_SUBSTANTIVE).length <= 1;
}

// ── Pass B: one cheap LLM call, strict JSON contract ────────────────────────

function findJsonObjects(s) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf('{', i)) !== -1) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    out.push(s.slice(i, end + 1));
    i = end + 1;
  }
  return out;
}

function validDigestPayload(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.activities)) return null;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return null;
  const activities = [];
  for (const a of obj.activities) {
    if (!a || typeof a !== 'object') return null;
    if (typeof a.label !== 'string' || !a.label.trim()) return null;
    if (typeof a.minutes !== 'number' || !Number.isFinite(a.minutes)) return null;
    activities.push({ label: a.label.trim(), minutes: a.minutes });
  }
  return { activities, summary: obj.summary.trim() };
}

/** Strict parser for the model's answer: thinking garbage, prose and fences are
 *  all tolerated, but only a well-shaped {activities, summary} is accepted —
 *  anything else (including "I can't") is null, i.e. a retryable miss. */
function parseDigestJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ');
  const cands = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cands.push(...findJsonObjects(fence[1]));
  cands.push(...findJsonObjects(s));
  for (const c of cands) {
    let obj;
    try { obj = JSON.parse(c); } catch { continue; }
    const v = validDigestPayload(obj);
    if (v) return v;
  }
  return null;
}

function projectionOf(base) {
  const proj = {
    activities: (base.activities || []).map(a => ({ label: a.label, minutes: a.minutes })),
    facts: (base.facts || []).map(f => ({ [f.label]: f.items })),
    artifacts: {
      pi: (base.artifacts.pi || []).slice(0, 10).map(a => a.value),
      attributes: (base.artifacts.attributes || []).slice(0, 15).map(a => a.value),
      other: (base.artifacts.other || []).slice(0, 5).map(a => a.value),
    },
  };
  if (base.firstUserMessage) proj.first_user_message = base.firstUserMessage;
  if (base.lastUserMessage) proj.last_user_message = base.lastUserMessage;
  return proj;
}

function buildPrompt(base) {
  return 'Собери сжатый лог рабочей сессии. Ответь СТРОГО одним JSON-объектом без markdown: '
    + '{"activities":[{"label":"занятие","minutes":N}],"summary":"2-4 фразы по-русски"}. '
    + 'minutes бери из данных сессии без изменений, label — короткое название занятия. '
    + 'summary — перескажи только факты из данных (какие файлы, сайты, репозитории, команды, '
    + 'публикации), называя конкретные объекты. Не давай оценок и выводов о сессии '
    + '(«не состоялась», «успешно», «ничего не сделано»), не додумывай то, чего нет в данных. '
    + 'Данные сессии:\n'
    + JSON.stringify(projectionOf(base));
}

function defaultLlm() {
  return async (prompt) => {
    try {
      const { serviceChat } = require('./service-llm');
      const r = await serviceChat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 700, temperature: 0.2, source: 'session-digest',
      });
      return r ? r.content : null;
    } catch { return null; }
  };
}

function mergeLabels(baseActivities, llmActivities) {
  return (baseActivities || []).map(a => {
    const m = (llmActivities || []).find(x => x.minutes === a.minutes);
    return m ? { ...a, label: m.label } : a;
  });
}

/** One LLM call (one retry) over the compact projection. On failure returns the
 *  deterministic part with summary:null, degraded:true — never throws. */
async function summarizeDigest(base, { llm } = {}) {
  const call = llm || defaultLlm();
  const prompt = buildPrompt(base);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = null;
    try { raw = await call(prompt); } catch { raw = null; }
    const parsed = parseDigestJson(raw);
    if (parsed) {
      return {
        ...base,
        activities: mergeLabels(base.activities, parsed.activities),
        summary: parsed.summary,
        degraded: false,
      };
    }
  }
  return { ...base, summary: null, degraded: true };
}

// ── Endpoint core: cache + degradation ───────────────────────────────────────

function freshnessKey(events, messages) {
  const lastEventAt = events.length ? Math.max(...events.map(e => (typeof e.at === 'number' ? e.at : 0))) : 0;
  const lastMsgAt = messages.length ? Math.max(...messages.map(m => (typeof m.at === 'number' ? m.at : 0))) : 0;
  const h = crypto.createHash('sha1')
    .update(`v${DIGEST_FORMAT_VERSION}|${events.length}|${lastEventAt}|${messages.length}|${lastMsgAt}`);
  return h.digest('hex').slice(0, 16);
}

function readCache(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!raw || typeof raw.key !== 'string' || typeof raw.createdAt !== 'number' || !raw.digest) return null;
    if (Date.now() - raw.createdAt > DIGEST_TTL_MS) return null;
    return raw;
  } catch { return null; }
}

function writeCache(fp, payload) {
  try {
    atomicJson(fp, payload);
  } catch (e) {
    console.warn('[session-digest] cache write:', e.message);
  }
}

/**
 * The whole digest for one session: cache → pass A → pass B.
 * Returns { ok:true, engine, empty, activities, facts, artifacts, summary,
 * degraded, cached, ttlMs } ({empty:true, message:'Лог недоступен'} when there
 * is nothing to tell) or { ok:false, error }. Never fails because of the LLM — pass B
 * degrades instead. engine is 'opencode' when the timeline came from a real
 * trace and null when the digest was built from messages alone.
 */
async function getDigestFor(username, sessionId, { llm } = {}) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'invalid session id' };
  const workDir = userWorkDir(username);
  const session = getSession(workDir, sessionId);
  if (!session) return { ok: false, error: 'session not found' };

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const trace = readTrace(workDir, session);
  const events = trace.ok ? trace.events : [];
  const engine = trace.ok ? 'opencode' : null;
  const cacheFile = path.join(workDir, 'sessions', `${sessionId}.digest.json`);

  // Nothing to digest: say so honestly — no LLM, no cache (the next run may
  // bring events, and an empty answer must never outlive them).
  if (isEmptySession(events, messages)) {
    return {
      ok: true, engine, sessionId, empty: true, message: EMPTY_MESSAGE,
      activities: [], facts: [], artifacts: { pi: [], attributes: [], other: [] },
      summary: null, degraded: false, cached: false, ttlMs: DIGEST_TTL_MS,
    };
  }

  const key = freshnessKey(events, messages);
  const hit = readCache(cacheFile);
  if (hit && hit.key === key) return { ...hit.digest, cached: true };

  const base = buildDigest({ events, messages });
  const summarized = await summarizeDigest(base, { llm: llm || defaultLlm() });
  const out = {
    ok: true,
    engine,
    sessionId,
    empty: false,
    activities: summarized.activities,
    facts: summarized.facts,
    artifacts: summarized.artifacts,
    summary: summarized.summary,
    degraded: !!summarized.degraded,
    cached: false,
    ttlMs: DIGEST_TTL_MS,
  };
  // Degraded (LLM down) is served but not cached — the next click retries pass B.
  if (!out.degraded) writeCache(cacheFile, { key, createdAt: Date.now(), digest: out });
  return out;
}

module.exports = {
  familyOf,
  detectPhones,
  classifyArtifacts,
  buildDigest,
  buildFacts,
  isEmptySession,
  parseDigestJson,
  summarizeDigest,
  freshnessKey,
  getDigestFor,
};
