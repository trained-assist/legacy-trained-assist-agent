'use strict';

// Static-site deploys to Cloudflare Pages on behalf of a profile (issue #1774).
//
// Why this lives server-side: since engine isolation (#1649) the agent process
// gets no Cloudflare credential (CLOUDFLARE_API_TOKEN is server-only and HOME is
// the profile's .agent-home, so wrangler's OAuth login is gone too). Handing the
// shared token back to the engine would undo the isolation, so the deploy runs
// in the MCP process (service user) and the token never reaches the agent.
//
// Token resolution, first match wins:
//   1. the profile's own token: agent-tokens/<user>/cloudflare —
//      {"value": "<api token>", "account_id": "<id>"} (account_id optional)
//   2. the shared admin default: ADMIN_CLOUDFLARE_API_TOKEN (canonical, #2046),
//      falling back to the legacy CF_API_TOKEN / CLOUDFLARE_API_TOKEN —
//      plus CF_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID, or the only account the
//      token can see
//
// On the shared account several profiles share one Pages namespace, so every
// project created through here is recorded with its owner, and a profile may only
// deploy to projects it owns. A project that already existed without a record is
// refused (unless the profile is in CF_PAGES_ADMIN_USERS, which claims it) — no
// silent takeover of someone else's site.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { TOKENS_ROOT, SYSTEM_ROOT, userWorkDir } = require('./data-paths');
const { readTokenValue } = require('./token-value');
const { readCredentialFile } = require('./credential-store');
const { mirrorSite } = require('./site-mirror');

const CF_API = 'https://api.cloudflare.com/client/v4';
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const WRANGLER = process.env.CF_PAGES_WRANGLER || 'wrangler@4';

function ownTokenFile(username, tokensRoot = TOKENS_ROOT) {
  return path.join(tokensRoot, String(username), 'cloudflare');
}

function readOwnToken(username, tokensRoot = TOKENS_ROOT) {
  let raw;
  try { raw = readCredentialFile(ownTokenFile(username, tokensRoot)).trim(); } catch { return null; }
  if (!raw) return null;
  let accountId = '';
  try {
    const j = JSON.parse(raw);
    accountId = String(j.account_id || j.accountId || '').trim();
  } catch { /* plain token string */ }
  const token = readTokenValue(raw);
  return token ? { token, accountId } : null;
}

/** → {source:'own'|'shared', token, accountId} | null */
function resolveCredential(username, { env = process.env, tokensRoot = TOKENS_ROOT } = {}) {
  const own = readOwnToken(username, tokensRoot);
  if (own) return { source: 'own', token: own.token, accountId: own.accountId };
  const token = env.ADMIN_CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '';
  if (!token) return null;
  return { source: 'shared', token, accountId: env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || '' };
}

async function cfFetch(fetchImpl, token, method, urlPath, body) {
  const res = await fetchImpl(CF_API + urlPath, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok && json?.success !== false, json };
}

function cfErrors(r) {
  const errs = (r.json?.errors || []).map(e => `${e.code}: ${e.message}`).join('; ');
  return errs || `HTTP ${r.status}`;
}

async function resolveAccountId(cred, fetchImpl) {
  if (cred.accountId) return cred.accountId;
  const r = await cfFetch(fetchImpl, cred.token, 'GET', '/accounts?per_page=5');
  if (!r.ok) throw new Error(`не удалось определить аккаунт Cloudflare (${cfErrors(r)}) — укажи account_id`);
  const list = r.json?.result || [];
  if (list.length !== 1) throw new Error(`токен видит ${list.length} аккаунт(ов) Cloudflare — укажи account_id`);
  return list[0].id;
}

// ── Ownership ledger (shared account only) ────────────────────────────────────

function ledgerPath(dataRoot = SYSTEM_ROOT) {
  return path.join(dataRoot, 'cf-pages-owners.json');
}

function readLedger(dataRoot) {
  try { return JSON.parse(fs.readFileSync(ledgerPath(dataRoot), 'utf8')); } catch { return {}; }
}

function writeLedger(dataRoot, ledger) {
  const fp = ledgerPath(dataRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fp);
}

function recordOwner(dataRoot, accountId, project, username, how) {
  const ledger = readLedger(dataRoot);
  ledger[`${accountId}/${project}`] = { owner: String(username), how, at: new Date().toISOString() };
  writeLedger(dataRoot, ledger);
}

// ── Source dir guard ──────────────────────────────────────────────────────────

/** The deployed folder must be inside the caller's own profile (the MCP runs as the
 *  service user and could otherwise ship any directory on the host). */
function resolveSourceDir(dir, username, { workDir = userWorkDir(username) } = {}) {
  if (!dir) throw new Error('dir обязателен');
  let real, root;
  try { real = fs.realpathSync(path.resolve(workDir, dir)); } catch { throw new Error(`папка не найдена: ${dir}`); }
  try { root = fs.realpathSync(workDir); } catch { throw new Error('рабочая папка профиля не найдена'); }
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('папка должна лежать внутри рабочей папки профиля');
  if (real === root) throw new Error('нельзя публиковать всю рабочую папку профиля — укажи папку сайта');
  if (!fs.statSync(real).isDirectory()) throw new Error(`не папка: ${dir}`);
  if (!fs.existsSync(path.join(real, 'index.html'))) throw new Error(`в папке нет index.html: ${dir}`);
  return real;
}

function runWrangler(args, env, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    execFile('npx', ['--yes', WRANGLER, ...args], { env, timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err }));
  });
}

/**
 * Deploy `dir` (inside the profile) as Pages project `project`.
 * deps are injectable for tests: fetchImpl, runWranglerImpl, env, tokensRoot, dataRoot, workDir.
 */
async function deploySite({ username, dir, project, branch = 'main' }, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const run = deps.runWranglerImpl || runWrangler;
  const dataRoot = deps.dataRoot || SYSTEM_ROOT;
  if (!username) return { ok: false, error: 'USER_ID не задан' };
  const name = String(project || '').trim().toLowerCase();
  if (!PROJECT_RE.test(name)) return { ok: false, error: 'имя проекта: латиница/цифры/дефис, до 58 символов, не начинается и не кончается дефисом' };

  let src;
  try { src = resolveSourceDir(dir, username, { workDir: deps.workDir || userWorkDir(username) }); } catch (e) { return { ok: false, error: e.message }; }

  const cred = resolveCredential(username, { env, tokensRoot: deps.tokensRoot || TOKENS_ROOT });
  if (!cred) return { ok: false, error: 'нет ни своего токена Cloudflare, ни общего по умолчанию', hint: 'connect({service:"cloudflare"}) — подключить свой' };

  let accountId;
  try { accountId = await resolveAccountId(cred, fetchImpl); } catch (e) { return { ok: false, error: e.message, token_source: cred.source }; }

  const got = await cfFetch(fetchImpl, cred.token, 'GET', `/accounts/${accountId}/pages/projects/${name}`);
  const exists = got.ok;
  if (!exists && got.status !== 404) return { ok: false, error: `Cloudflare: ${cfErrors(got)}`, token_source: cred.source };

  if (cred.source === 'shared' && exists) {
    const rec = readLedger(dataRoot)[`${accountId}/${name}`];
    const admins = String(env.CF_PAGES_ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (rec && rec.owner !== String(username)) {
      return { ok: false, error: `проект «${name}» в общем аккаунте принадлежит другому профилю — выбери другое имя`, token_source: 'shared' };
    }
    if (!rec) {
      if (!admins.includes(String(username))) {
        return { ok: false, error: `проект «${name}» уже есть в общем аккаунте и ни за кем не закреплён — выбери другое имя (или оператор добавит профиль в CF_PAGES_ADMIN_USERS)`, token_source: 'shared' };
      }
      recordOwner(dataRoot, accountId, name, username, 'admin-claim');
    }
  }

  if (!exists) {
    const created = await cfFetch(fetchImpl, cred.token, 'POST', `/accounts/${accountId}/pages/projects`, { name, production_branch: branch });
    if (!created.ok) return { ok: false, error: `не удалось создать проект: ${cfErrors(created)}`, token_source: cred.source };
    if (cred.source === 'shared') recordOwner(dataRoot, accountId, name, username, 'created');
  }

  // Minimal env: the credential goes only to this child, never to the agent process.
  const childEnv = {
    PATH: env.PATH || process.env.PATH,
    HOME: env.HOME || process.env.HOME,
    CLOUDFLARE_API_TOKEN: cred.token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: 'false',
    CI: '1',
  };
  const out = await run(['pages', 'deploy', src, '--project-name', name, '--branch', branch, '--commit-dirty=true'], childEnv);
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.code !== 0) {
    return { ok: false, error: 'wrangler pages deploy упал', token_source: cred.source, output: text.split(cred.token).join('***').slice(-1500) };
  }
  const m = text.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i);
  const pagesDevUrl = `https://${name}.pages.dev`;
  // Branded copy on the product domain (src/site-mirror.js). Production branch only:
  // preview branches stay on their pages.dev URL. A mirror failure never fails the
  // deploy — the pages.dev link still works and the reason is reported.
  let mirror = null;
  if (branch === 'main') {
    try { mirror = mirrorSite({ src, name, username, dataRoot, env }); } catch (e) { mirror = { ok: false, error: e.message }; }
  }
  return {
    ok: true,
    url: mirror?.ok ? mirror.url : pagesDevUrl,
    pages_dev_url: pagesDevUrl,
    deployment_url: m ? m[0] : null,
    ...(mirror && !mirror.ok ? { branded_url_error: mirror.error } : {}),
    project: name,
    created: !exists,
    token_source: cred.source,
  };
}

/** Diagnostics without the secret: which token would be used and for which account. */
async function deployStatus(username, deps = {}) {
  const cred = resolveCredential(username, { env: deps.env || process.env, tokensRoot: deps.tokensRoot || TOKENS_ROOT });
  if (!cred) return { ok: false, token_source: null, error: 'нет ни своего, ни общего токена Cloudflare' };
  try {
    const accountId = await resolveAccountId(cred, deps.fetchImpl || globalThis.fetch);
    return { ok: true, token_source: cred.source, account_id: accountId };
  } catch (e) {
    return { ok: false, token_source: cred.source, error: e.message };
  }
}

module.exports = { deploySite, deployStatus, resolveCredential, resolveSourceDir, ledgerPath, PROJECT_RE };
