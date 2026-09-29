'use strict';

// Live-bot QA bearer endpoint (#1851 S1, issue #1878).
//
// A single server-side route `POST /web/qa-bearer` that lets the agent PROVE a feature
// works on the live bot without ever seeing a secret and without a real client being
// reachable. It exposes three ops, all behind the SAME bearer boundary as
// /web/run-bearer (WEB_VERIFY_SECRET || AGENT_SECRET):
//
//   status → agent /health.commit + gateway /health.buildSha + expected-SHA comparison
//            (merge-base) + error lines from the journal for the last N minutes;
//   send   → run a task for the derived TEST profile `qa-<caller>` via the existing
//            streamWebTask (SSE out) — the profile is derived server-side: a `username`
//            field in the body is read by NOTHING, so a real client is unreachable by
//            construction;
//   trace   → a compact follow-up for a session id: messages + buttons (parsed from the
//             runner's [buttons] audit line) + journal lines + execution history.
//
// Privileged reads (journalctl via `sudo -n`, git merge-base, execution-history) live in
// THIS server-side handler — the MCP tools only send HTTP over AGENT_PUBLIC_URL, so the
// isolated agent slot never needs the secret or access to localhost.
//
// Safety (confirmed 🔴 rules): profile is always `qa-${caller}`; caller is
// `^[a-zA-Z0-9_-]{1,48}$`; op=send is rate-limited to 20/hour per caller.

const fs = require('fs');
const path = require('path');
const { userWorkDir, SYSTEM_ROOT } = require('../data-paths');

const CALLER_RE = /^[a-zA-Z0-9_-]{1,48}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;
const DEFAULT_GATEWAY_HEALTH_URL = 'https://trained-assist-tg-bot.skillset-apply.workers.dev/health';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) { rejected = true; return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
  });
}

// ── derived test profile + rate limit ────────────────────────────────────────

function qaProfileName(caller) {
  return `qa-${caller}`;
}

function ensureQaProfile(caller) {
  const workDir = userWorkDir(qaProfileName(caller));
  const profileFile = path.join(workDir, 'profile.json');
  if (fs.existsSync(profileFile)) return workDir; // never overwrite an existing profile
  try {
    require('../profiles').save(workDir, {
      engine: 'opencode',
      ocProfile: 'value',
      about: 'QA-профиль для проверки живого бота (создан автоматически, только для тестов)',
    });
  } catch (e) {
    // Profile creation is best-effort: the run still works with the engine default.
    console.warn('[qa-live] profile create failed:', e.message);
  }
  return workDir;
}

function rateLimitPath(caller) {
  return path.join(SYSTEM_ROOT, 'qa-live', `${caller}.json`);
}

// Fixed 1h window keyed off wall-clock. Returns { allowed, resetsIn, remaining }.
function consumeSendQuota(caller, now = Date.now()) {
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const resetsIn = Math.ceil((windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
  const fp = rateLimitPath(caller);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { /* first call / corrupt → reset */ }
  if (!rec || rec.windowStart !== windowStart || typeof rec.count !== 'number') {
    rec = { windowStart, count: 0 };
  }
  if (rec.count >= RATE_LIMIT_MAX) {
    return { allowed: false, resetsIn, remaining: 0 };
  }
  rec.count += 1;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.warn('[qa-live] rate-limit write failed:', e.message);
  }
  return { allowed: true, resetsIn, remaining: RATE_LIMIT_MAX - rec.count };
}

// ── privileged reads (journal / git) ─────────────────────────────────────────

function journalSinceEpoch(sinceMinutes) {
  const mins = Number.isFinite(Number(sinceMinutes)) && Number(sinceMinutes) > 0 ? Number(sinceMinutes) : 30;
  return Math.floor(Date.now() / 1000) - mins * 60;
}

function readJournal(sinceEpoch) {
  try {
    const { execSync } = require('child_process');
    return execSync(`sudo -n journalctl -u assist-agent --since @${sinceEpoch} -o cat --no-pager`, {
      timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    }).toString();
  } catch (e) {
    return null;
  }
}

function readErrors(sinceEpoch) {
  const raw = readJournal(sinceEpoch);
  if (raw == null) {
    return { sinceEpoch, count: null, samples: [], reason: 'журнал недоступен (нет sudo/journalctl)' };
  }
  const lines = raw.split('\n').filter((l) => l && /error|exception|failed|unhandled/i.test(l));
  return { sinceEpoch, count: lines.length, samples: lines.slice(-20) };
}

function gitMaybe(gitDir, args) {
  const { execSync } = require('child_process');
  return execSync(`git ${args}`, { cwd: gitDir, timeout: 10000, stdio: 'ignore' });
}

function expectedInfo(expectedSha, liveFullSha) {
  if (!expectedSha || !/^[0-9a-f]{7,40}$/i.test(String(expectedSha))) {
    return { sha: expectedSha || null, reached: null, reason: 'ожидаемый SHA не передан или некорректен' };
  }
  const gitDir = process.env.AGENT_GIT_DIR || '/home/vova/trained-assist-agent';
  const hasObject = () => {
    try { gitMaybe(gitDir, `cat-file -e ${expectedSha}^{commit}`); return true; } catch { return false; }
  };
  if (!hasObject()) {
    try { gitMaybe(gitDir, `fetch --quiet origin ${expectedSha}`); } catch { /* offline → leave unknown */ }
  }
  if (!hasObject()) return { sha: expectedSha, reached: null, reason: 'ожидаемый SHA неизвестен в git-источнике' };
  if (!liveFullSha) return { sha: expectedSha, reached: null, reason: 'живой SHA релиза неизвестен' };
  try {
    gitMaybe(gitDir, `merge-base --is-ancestor ${expectedSha} ${liveFullSha}`);
    return { sha: expectedSha, reached: true };
  } catch {
    return { sha: expectedSha, reached: false, reason: 'ожидаемый SHA не в истории живого релиза' };
  }
}

// ── ops ──────────────────────────────────────────────────────────────────────

async function opStatus(body) {
  const out = {};

  // agent: local /health, fall back to the release SHA file/git when unreachable.
  let commit = '';
  let fullSha = '';
  try {
    const port = process.env.PORT || '8080';
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    commit = j.commit || '';
    fullSha = j.fullSha || j.commit || '';
    out.agent = { commit, fullSha, uptime: j.uptime ?? null, vm: j.vm ?? null };
  } catch (e) {
    out.agent = { commit: '', fullSha: '', error: String(e && e.message || e).slice(0, 200) };
  }
  if (!commit) {
    try {
      commit = require('../release-info').getReleaseSha() || '';
      fullSha = fullSha || commit;
      out.agent.commit = commit;
      out.agent.fullSha = fullSha;
    } catch { /* keep empty */ }
  }

  // gateway: /health.buildSha (the deployed Worker's SHA).
  const gwUrl = process.env.GATEWAY_HEALTH_URL || DEFAULT_GATEWAY_HEALTH_URL;
  try {
    const r = await fetch(gwUrl, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    out.gateway = { status: j.status || 'ok', buildSha: typeof j.buildSha === 'string' ? j.buildSha : null, url: gwUrl };
  } catch (e) {
    out.gateway = { status: 'unreachable', buildSha: null, url: gwUrl, error: String(e && e.message || e).slice(0, 200) };
  }

  out.expected = expectedInfo(body.expectSha, fullSha);
  out.errors = readErrors(journalSinceEpoch(body.sinceMinutes));
  return out;
}

async function opSend(req, res, body, caller, secrets) {
  const quota = consumeSendQuota(caller);
  if (!quota.allowed) {
    return json(res, 429, { error: 'rate limit exceeded', limit: RATE_LIMIT_MAX, resetsIn: quota.resetsIn });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json(res, 400, { error: 'text required' });
  const sessionId = (body.sessionId && SESSION_ID_RE.test(body.sessionId)) ? body.sessionId : null;
  ensureQaProfile(caller);

  // Require at call time (not destructured at module load) so tests/sandbox can stub it.
  const webRoutes = require('../web-routes');
  const { newWebSessionId } = require('../core/web-conversation');
  const username = qaProfileName(caller);
  const newSessionId = sessionId ? null : newWebSessionId();
  return webRoutes.streamWebTask({
    req, res, secrets, username, task: text, sessionId, newSessionId,
  });
}

// ── trace parsing (buttons from the [buttons] audit line) ─────────────────────

// Extract the first balanced JSON array that starts after `key=` in `line`.
function extractJsonArray(line, key) {
  const at = line.indexOf(key);
  if (at < 0) return null;
  const start = line.indexOf('[', at + key.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(line.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function parseButtons(journalLines) {
  const line = [...journalLines].reverse().find((l) => l.includes('[buttons]'));
  if (!line) return { labels: [], callbacks: [], source: null };
  const attached = extractJsonArray(line, 'attached=') || [];
  const callbacks = extractJsonArray(line, 'callbacks=') || [];
  const labels = attached.map((b) => (typeof b === 'string' ? b : b && b.text)).filter(Boolean);
  return { labels, callbacks, source: 'journal' };
}

function readExecutions(sessionId) {
  const dir = path.join(SYSTEM_ROOT, 'execution-history');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (out.length >= 3) break;
    if (!f.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!raw.includes(sessionId)) continue;
      const rec = JSON.parse(raw);
      out.push({
        executionId: rec.executionId || f.replace(/\.json$/, ''),
        taskId: rec.taskId || null,
        finalStatus: rec.finalStatus || null,
        attempts: (rec.attempts || []).map((a) => ({
          attempt: a.attempt, engine: a.engine ?? null, model: a.model ?? null,
          failureClass: a.failureClass ?? null, errorText: String(a.errorText || '').slice(0, 300),
        })),
      });
    } catch { /* skip unreadable/foreign */ }
  }
  return out;
}

async function opTrace(body, caller) {
  const sessionId = body.sessionId;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { status: 400, body: { error: 'invalid sessionId' } };
  const workDir = userWorkDir(qaProfileName(caller));
  const session = require('../session-store').getSession(workDir, sessionId);
  // Scope by construction: the session file must live under the qa-<caller> profile.
  if (!session) return { status: 404, body: { error: 'session not found', sessionId } };

  const sinceEpoch = journalSinceEpoch(body.sinceMinutes);
  const rawJournal = readJournal(sinceEpoch);
  const journal = rawJournal == null
    ? []
    : rawJournal.split('\n').filter((l) => l.includes(`session=${sessionId}`)).slice(-50);
  const messages = (session.messages || []).slice(-30).map((m) => ({
    role: m.role, content: String(m.content == null ? '' : m.content).slice(0, 1500), at: m.at || null,
  }));
  const messageCount = Array.isArray(session.messages) ? session.messages.length : (session.messageCount || 0);
  return {
    status: 200,
    body: {
      session: { id: sessionId, topic: session.topic || null, lastAt: session.lastAt || null, messageCount },
      messages,
      buttons: parseButtons(journal),
      journal,
      executions: readExecutions(sessionId),
    },
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

async function handleQaLive(req, url, res, ctx = {}) {
  const secrets = ctx.secrets || {};
  const verifySecret = secrets.WEB_VERIFY_SECRET || secrets.AGENT_SECRET;
  const auth = req.headers['authorization'] || '';
  if (!verifySecret || auth !== `Bearer ${verifySecret}`) return json(res, 401, { error: 'unauthorized' });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  body = body || {};

  const op = body.op;
  const caller = body.caller;
  if (caller != null && !CALLER_RE.test(String(caller))) return json(res, 400, { error: 'invalid caller' });

  if (op === 'status') {
    return json(res, 200, await opStatus(body));
  }

  if (!caller || !CALLER_RE.test(String(caller))) return json(res, 400, { error: 'caller required' });

  if (op === 'send') return opSend(req, res, body, caller, secrets);

  if (op === 'trace') {
    const out = await opTrace(body, caller);
    return json(res, out.status, out.body);
  }

  return json(res, 400, { error: 'unknown op', op: op || null });
}

module.exports = {
  handleQaLive,
  _internals: { qaProfileName, ensureQaProfile, consumeSendQuota, extractJsonArray, parseButtons, expectedInfo },
  RATE_LIMIT_MAX,
};
