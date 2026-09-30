#!/usr/bin/env node
// scripts/profile-repo.mjs — issue #1921 v1: провижининг приватного репо на каждый
// профиль в орге `profiles-artifacts` + инвайт юзеру по запросу.
//
// v1 = ТОЛЬКО «создать репо» и «инвайтнуть collaborator'а». Push текстового образа
// профиля — это M6/M7 и стоит на гейте #1923; этот скрипт вообще не трогает git.
// (Сознательно: предусловия первого push — EXCLUDE-секреты в clean list и C4 rollout
// — ещё не выполнены, см. предусловия в #1921.)
//
// Usage:
//   node scripts/profile-repo.mjs ensure --profile <name>
//   node scripts/profile-repo.mjs invite --profile <name> --github <login>
//   node scripts/profile-repo.mjs status --profile <name> [--github <login>]
//
// Токен: $PROFILES_ORG_GITHUB_TOKEN (fine-grained PAT, org-only, user kobzevvv —
// administration:write подтверждён, см. «Статус проверок» в #1921). В прод читается
// из GCP Secret Manager того же имени через `gcloud secrets versions access`, когда
// env-переменная не задана. Токен НИКОГДА не печатается, не пишется в файлы и не
// попадает в env движка (правило C3, #1789) — в коде ниже нет ни одного console.*
// с token, ни одной записи token в файл.
//
// ── Схема имени репо (решение архитектора, 2026-09-30) ─────────────────────────
//   repo  = "profile-" + sanitize(profileId)
//   sanitize(profileId) = toLowerCase → каждый символ вне [a-z0-9-] → "-"
//                         → обрезать краевые "-"
//   Префикс `profile-` обязателен: обходит зарезервированные GitHub-имена
//   (settings, new, orgs, …) и коллизии с репо самой орги.
//   Защита от коллизии: если sanitize(profileId) !== profileId (имя было
//   нормализовано, значит два профиля могут схлопнуться на один base) — дописать
//   "-" + первые 6 hex sha256(profileId):
//       "alice"  → profile-alice              (уже каноничное — суффикса нет)
//       "Alice"  → profile-alice-1f0c09        (нормализовано — суффикс есть)
//   Оба случая детерминированы чистой функцией от profileId: без сканирования
//   каталога профилей, без чтения git-истории — один profileId всегда даёт одно
//   имя репо (пустой base → "profile-" + sha256-суффикс).
//
// Exit codes: 0 ок · 1 usage / нет токена · 2 ошибка GitHub API
//
// Тесты: test/profile-repo.test.cjs (fetch инжектится, живого GitHub нет).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const ORG = 'profiles-artifacts';
export const API_BASE = 'https://api.github.com';
export const TOKEN_ENV = 'PROFILES_ORG_GITHUB_TOKEN';
export const SECRET_ID = 'PROFILES_ORG_GITHUB_TOKEN';
export const DEFAULT_GCP_PROJECT = 'alesa-personal-assistent';
export const REPO_PREFIX = 'profile-';

export class UsageError extends Error {}
export class TokenError extends Error {}
export class GitHubError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = info.status;
    this.method = info.method;
    this.path = info.path;
  }
}

// ── Именование (см. шапку) ─────────────────────────────────────────────────────

export function sanitizeProfile(profileId) {
  return String(profileId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sha6(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 6);
}

export function repoNameFor(profileId) {
  const id = String(profileId ?? '');
  const base = sanitizeProfile(id);
  if (!base) return `${REPO_PREFIX}${sha6(id)}`;
  return base === id ? `${REPO_PREFIX}${base}` : `${REPO_PREFIX}${base}-${sha6(id)}`;
}

export function repoUrlFor(profileId) {
  return `https://github.com/${ORG}/${repoNameFor(profileId)}`;
}

// ── Токен ──────────────────────────────────────────────────────────────────────

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (r.error) {
    return { ok: false, missing: r.error.code === 'ENOENT', stdout: '', stderr: String(r.error.message || '') };
  }
  return { ok: r.status === 0, missing: false, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) || '';
}

/**
 * env → gcloud Secret Manager → чёткая ошибка с инструкцией.
 * Никогда не включает значение токена ни в возврат-сообщение ошибки, ни в логи.
 */
export function resolveToken({ env = process.env, run = defaultRun } = {}) {
  const fromEnv = String(env[TOKEN_ENV] || '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const project = env.PROFILES_ORG_GCP_PROJECT || DEFAULT_GCP_PROJECT;
  const res = run('gcloud', [
    'secrets', 'versions', 'access', 'latest',
    `--secret=${SECRET_ID}`,
    `--project=${project}`,
  ]);
  const token = res && res.ok ? String(res.stdout || '').trim() : '';
  if (token) return { token, source: 'gcloud' };

  const why = !res || res.missing
    ? '`gcloud` не найден в PATH'
    : `gcloud не вернул токен${firstLine(res.stderr) ? `: ${firstLine(res.stderr)}` : ''}`;

  throw new TokenError([
    `${TOKEN_ENV} не задан, и токен из GCP Secret Manager прочитать не удалось (${why}).`,
    '',
    'Чинится двумя способами (на выбор):',
    `  • на операторской машине:  export ${TOKEN_ENV}='<fine-grained PAT, орга ${ORG}, Contents:R/W + Administration:W>'`,
    `  • при настроенный gcloud:  gcloud secrets versions access latest --secret=${SECRET_ID} --project=${project}`,
    '',
    'Токен — секрет: не печатать, не коммитить, не отдавать в env движка (правило C3, #1789).',
  ].join('\n'));
}

// ── GitHub REST ────────────────────────────────────────────────────────────────

export async function ghRequest(pathname, {
  method = 'GET',
  token,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new UsageError('fetch недоступен в этом окружении (нужен Node ≥ 18)');
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    return await fetchImpl(`${API_BASE}${pathname}`, init);
  } catch (e) {
    throw new GitHubError(`GitHub API недоступен для ${method} ${pathname}: ${e && e.message ? e.message : e}`, {
      method,
      path: pathname,
    });
  }
}

async function readJson(res) {
  try {
    const parsed = await res.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function apiError(method, pathname, res) {
  const payload = await readJson(res);
  const detail = payload.message ? ` — ${payload.message}` : '';
  return new GitHubError(`GitHub ${method} ${pathname} → ${res.status}${detail}`, {
    status: res.status,
    method,
    path: pathname,
  });
}

// ── ensure ─────────────────────────────────────────────────────────────────────

export async function ensureRepo(profileId, { token, fetchImpl, out = () => {} } = {}) {
  const id = String(profileId ?? '');
  if (!id) throw new UsageError('пустой profileId');
  const repo = repoNameFor(id);
  const repoPath = `/repos/${ORG}/${repo}`;

  const head = await ghRequest(repoPath, { token, fetchImpl });
  if (head.status === 200) {
    const info = await readJson(head);
    out(`ensure ${ORG}/${repo}: существует (private=${info.private !== false}) — no-op, история не тронута`);
    return {
      repo,
      state: 'exists',
      private: info.private !== false,
      url: info.html_url || `https://github.com/${ORG}/${repo}`,
    };
  }
  if (head.status !== 404) throw await apiError('GET', repoPath, head);

  const created = await ghRequest(`/orgs/${ORG}/repos`, {
    method: 'POST',
    token,
    fetchImpl,
    body: {
      name: repo,
      private: true,
      description: `Trained-assist profile image for "${id}" (issue #1921)`,
    },
  });
  if (created.status === 201) {
    const info = await readJson(created);
    out(`ensure ${ORG}/${repo}: создан приватным`);
    return { repo, state: 'created', private: true, url: info.html_url || `https://github.com/${ORG}/${repo}` };
  }
  if (created.status === 422) {
    // Имя занято: гонка с параллельным ensure или репо уже существует (в т.ч. под
    // другим профилем, давшим тот же base). Повторное чтение = идемпотентный no-op.
    const again = await ghRequest(repoPath, { token, fetchImpl });
    if (again.status === 200) {
      const info = await readJson(again);
      out(`ensure ${ORG}/${repo}: существует (создан параллельно) — no-op`);
      return {
        repo,
        state: 'exists',
        private: info.private !== false,
        url: info.html_url || `https://github.com/${ORG}/${repo}`,
      };
    }
    throw await apiError('POST', `/orgs/${ORG}/repos`, created);
  }
  throw await apiError('POST', `/orgs/${ORG}/repos`, created);
}

// ── invite ─────────────────────────────────────────────────────────────────────

// Логины GitHub: буквы/цифры/дефис, не начинается и не заканчивается дефисом, ≤39 символов.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function requireLogin(value) {
  const login = String(value ?? '').trim();
  if (!LOGIN_RE.test(login)) {
    throw new UsageError(`не похоже на GitHub-логин: ${JSON.stringify(value ?? null)} (пример: kobzevvv)`);
  }
  return login;
}

export async function inviteUser(profileId, githubLogin, { token, fetchImpl, out = () => {} } = {}) {
  const login = requireLogin(githubLogin);
  const repo = repoNameFor(profileId);
  const pathname = `/repos/${ORG}/${repo}/collaborators/${encodeURIComponent(login)}`;

  const res = await ghRequest(pathname, { method: 'PUT', token, fetchImpl, body: { permission: 'push' } });
  if (res.status === 201) {
    out(`invite ${ORG}/${repo} ← ${login}: приглашение отправлено (push)`);
    return { repo, login, state: 'invited' };
  }
  if (res.status === 204) {
    out(`invite ${ORG}/${repo} ← ${login}: уже collaborator (push) — no-op`);
    return { repo, login, state: 'already' };
  }
  if (res.status === 404) {
    const probe = await ghRequest(`/repos/${ORG}/${repo}`, { token, fetchImpl });
    if (probe.status === 404) {
      throw new GitHubError(`репо ${ORG}/${repo} не существует — сначала: ensure --profile ${profileId}`, {
        status: 404,
        method: 'PUT',
        path: pathname,
      });
    }
    throw new GitHubError(`GitHub-логин не найден: ${login} (репо ${ORG}/${repo} существует)`, {
      status: 404,
      method: 'PUT',
      path: pathname,
    });
  }
  throw await apiError('PUT', pathname, res);
}

// ── status ─────────────────────────────────────────────────────────────────────

export async function repoStatus(profileId, { githubLogin, token, fetchImpl, out = () => {} } = {}) {
  const id = String(profileId ?? '');
  if (!id) throw new UsageError('пустой profileId');
  const repo = repoNameFor(id);
  const repoPath = `/repos/${ORG}/${repo}`;
  const url = `https://github.com/${ORG}/${repo}`;

  const res = await ghRequest(repoPath, { token, fetchImpl });
  if (res.status === 404) {
    const report = { repo, url, state: 'missing' };
    if (githubLogin) {
      report.githubLogin = requireLogin(githubLogin);
      report.collaborator = false;
    }
    out(`status ${ORG}/${repo}: НЕ СУЩЕСТВУЕТ (ожидается ${repoUrlFor(id)})`);
    return report;
  }
  if (res.status !== 200) throw await apiError('GET', repoPath, res);

  const info = await readJson(res);
  const report = {
    repo,
    url: info.html_url || url,
    state: 'exists',
    private: info.private !== false,
    defaultBranch: info.default_branch || null,
  };
  if (githubLogin) {
    const login = requireLogin(githubLogin);
    const member = await ghRequest(`${repoPath}/collaborators/${encodeURIComponent(login)}`, { token, fetchImpl });
    if (member.status !== 204 && member.status !== 404) throw await apiError('GET', `${repoPath}/collaborators/${login}`, member);
    report.githubLogin = login;
    report.collaborator = member.status === 204;
  }
  out(`status ${ORG}/${repo}: существует, private=${report.private}${report.collaborator === undefined ? '' : `, ${report.githubLogin} collaborator=${report.collaborator}`}`);
  return report;
}

// ── Аудит-лог действий (#1921 п.2 «Лог действий») ─────────────────────────────
// JSONL в SYSTEM_ROOT; в запись НИКОГДА не попадает токен (только id/действие/результат).

function systemRoot() {
  return require('../src/data-paths.js').SYSTEM_ROOT;
}

export function defaultLogPath() {
  return path.join(systemRoot(), 'profile-repo-log.jsonl');
}

export function logAction(entry, { logPath } = {}) {
  const file = logPath === undefined ? defaultLogPath() : logPath;
  if (!file) return null;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  fs.appendFileSync(file, line, { mode: 0o600 });
  return file;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const USAGE = [
  'Usage:',
  '  node scripts/profile-repo.mjs ensure --profile <name>            создать приватное репо (идемпотентно)',
  '  node scripts/profile-repo.mjs invite --profile <name> --github <login>   инвайт collaborator с push-правом',
  '  node scripts/profile-repo.mjs status --profile <name> [--github <login>] состояние репо (/ инвайта)',
  '',
  `Орга: ${ORG} · схема имени репо: ${REPO_PREFIX}<sanitize(profileId)> (см. шапку файла)`,
  `Токен: $${TOKEN_ENV} (в прод — GCP Secret Manager, fallback gcloud secrets versions access).`,
  'Exit codes: 0 ок · 1 usage / нет токена · 2 ошибка GitHub API',
].join('\n');

function parseArgv(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const opts = {};
  while (args.length) {
    const a = args.shift();
    if (!a.startsWith('--')) throw new UsageError(`лишний аргумент: ${a}`);
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let value = eq === -1 ? undefined : a.slice(eq + 1);
    if (value === undefined) {
      if (!args.length || args[0].startsWith('--')) throw new UsageError(`флаг --${key} требует значение`);
      value = args.shift();
    }
    if (key === 'profile') opts.profile = value;
    else if (key === 'github') opts.github = value;
    else throw new UsageError(`неизвестный флаг: --${key}`);
  }
  return { cmd, opts };
}

function reportEntry(cmd, opts, result) {
  return { cmd, profile: opts.profile || null, repo: result.repo || null, result: result.state || null, github: opts.github || result.login || null };
}

/**
 * Точка входа. deps инжектятся тестами: {env, fetchImpl, run, out, err, logPath}.
 * Возвращает exit code, сама процесс не завершает.
 */
export async function main(argv, deps = {}) {
  const out = deps.out || ((m) => console.log(m));
  const err = deps.err || ((m) => console.error(m));
  try {
    if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
      out(USAGE);
      return 0;
    }
    const { cmd, opts } = parseArgv(argv);
    if (!opts.profile) throw new UsageError('нет обязательного --profile <name>');

    if (cmd === 'ensure' || cmd === 'invite' || cmd === 'status') {
      const { token, source } = resolveToken({ env: deps.env || process.env, run: deps.run });
      const ctx = { token, fetchImpl: deps.fetchImpl, out };
      let result;
      if (cmd === 'ensure') result = await ensureRepo(opts.profile, ctx);
      else if (cmd === 'invite') result = await inviteUser(opts.profile, opts.github, ctx);
      else result = await repoStatus(opts.profile, { ...ctx, githubLogin: opts.github });

      try {
        logAction(reportEntry(cmd, opts, result), { logPath: deps.logPath });
      } catch (e) {
        err(`warning: аудит-лог не записан (${e && e.message ? e.message : e})`);
      }
      out(`token: ${source === 'env' ? 'env ' + TOKEN_ENV : 'gcloud Secret Manager'}`);
      if (cmd !== 'status') out(result.url || repoUrlFor(opts.profile));
      return 0;
    }
    throw new UsageError(`неизвестная команда: ${cmd}`);
  } catch (e) {
    if (e instanceof TokenError) {
      err(e.message);
      return 1;
    }
    if (e instanceof UsageError) {
      err(`error: ${e.message}`);
      err('');
      err(USAGE);
      return 1;
    }
    if (e instanceof GitHubError) {
      err(`error: ${e.message}`);
      return 2;
    }
    err(`error: ${e && e.stack ? e.stack : e}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
