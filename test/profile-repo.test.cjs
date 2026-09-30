'use strict';
// #1921 v1 — scripts/profile-repo.mjs: провижининг приватного репо в орге
// profiles-artifacts + инвайт collaborator'а. Живого GitHub нет: fetch и gcloud
// инжектятся, как в остальных тестах репо (см. gateway-callback.test.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET = 'ghp_TEST_SECRET_VALUE_never_log_me';

// require() не умеет .mjs — грузим динамическим import'ом (CJS top-level await запрещён).
async function load() {
  if (!globalThis.__profileRepoMod) globalThis.__profileRepoMod = await import('../scripts/profile-repo.mjs');
  return globalThis.__profileRepoMod;
}

function sha6(v) {
  return createHash('sha256').update(String(v), 'utf8').digest('hex').slice(0, 6);
}

function mock(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push({ url: u, method, headers: init.headers || {}, body: init.body });
    // once:true — маршрут отдаётся один раз (для гонок «404 → 422 → 200»)
    const r = routes.find((x) => (x.method || 'GET') === method && x.re.test(u) && (!x.once || !x.used));
    if (!r) throw new Error(`unexpected request: ${method} ${u}`);
    r.used = true;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => (r.json === undefined ? {} : r.json) };
  };
  return { fetchImpl, calls };
}

const TOKEN_DEPS = { token: SECRET, out: () => {} };

// ── Схема имени репо (решение архитектора 2026-09-30) ─────────────────────────

test('repoNameFor: каноничный profileId → profile-<name> без суффикса', async () => {
  const { repoNameFor } = await load();
  assert.equal(repoNameFor('alice'), 'profile-alice');
  assert.equal(repoNameFor('recruiter-skillset'), 'profile-recruiter-skillset');
  assert.equal(repoNameFor('a1-b2'), 'profile-a1-b2');
});

test('repoNameFor: санитизация меняет имя → sha256-суффикс (защита от коллизии)', async () => {
  const { repoNameFor } = await load();
  assert.equal(repoNameFor('Alice'), `profile-alice-${sha6('Alice')}`);
  assert.equal(repoNameFor('Alice Bob'), `profile-alice-bob-${sha6('Alice Bob')}`);
  assert.equal(repoNameFor('-abc-'), `profile-abc-${sha6('-abc-')}`);
  assert.equal(repoNameFor('A1_b'), `profile-a1-b-${sha6('A1_b')}`);
  // Два профиля, схлопывающиеся на один base, обязаны дать разные репо
  assert.notEqual(repoNameFor('Alice'), repoNameFor('ALICE'));
  assert.notEqual(repoNameFor('alice'), repoNameFor('Alice'));
  // Пустой base (одни дефисы) → репо на хэше, не «profile-»
  assert.equal(repoNameFor('---'), `profile-${sha6('---')}`);
  // Детерминизм: один и тот же profileId всегда даёт одно имя
  assert.equal(repoNameFor('Alice'), repoNameFor('Alice'));
});

test('sanitizeProfile: toLowerCase, [^a-z0-9-] → "-", краевые "-" обрезаются', async () => {
  const { sanitizeProfile } = await load();
  assert.equal(sanitizeProfile('Alice'), 'alice');
  assert.equal(sanitizeProfile('a b'), 'a-b');
  assert.equal(sanitizeProfile('--x--'), 'x');
  assert.equal(sanitizeProfile('a--b'), 'a--b'); // внутренние дефисы не схлопываются
  assert.equal(sanitizeProfile('Юзер/№7'), '7');
});

test('префикс profile- обязателен (зарезервированные GitHub-имена, коллизии с репо орги)', async () => {
  const { repoNameFor, ORG, repoUrlFor } = await load();
  for (const reserved of ['settings', 'new', 'orgs', 'organizations', 'features', 'explore']) {
    assert.ok(repoNameFor(reserved).startsWith('profile-'), reserved);
    assert.ok(!repoNameFor(reserved).endsWith('profile-'));
  }
  assert.equal(repoUrlFor('alice'), `https://github.com/${ORG}/profile-alice`);
});

// ── Токен ─────────────────────────────────────────────────────────────────────

test('resolveToken: env выигрывает, gcloud не дёргается', async () => {
  const { resolveToken } = await load();
  let ran = 0;
  const r = resolveToken({ env: { PROFILES_ORG_GITHUB_TOKEN: ` ${SECRET} ` }, run: () => { ran++; return { ok: true, stdout: 'other' }; } });
  assert.deepEqual(r, { token: SECRET, source: 'env' });
  assert.equal(ran, 0);
});

test('resolveToken: env пуст → fallback на gcloud secrets versions access', async () => {
  const { resolveToken, SECRET_ID } = await load();
  let seen;
  const r = resolveToken({
    env: {},
    run: (cmd, args) => { seen = { cmd, args }; return { ok: true, stdout: `${SECRET}\n` }; },
  });
  assert.equal(r.source, 'gcloud');
  assert.equal(r.token, SECRET);
  assert.equal(seen.cmd, 'gcloud');
  assert.deepEqual(seen.args.slice(0, 4), ['secrets', 'versions', 'access', 'latest']);
  assert.ok(seen.args.includes(`--secret=${SECRET_ID}`));
  assert.ok(seen.args.some((a) => a.startsWith('--project=')));
});

test('resolveToken: нет ни env, ни gcloud → чёткая ошибка с инструкцией, без токена в тексте', async () => {
  const { resolveToken, TokenError, TOKEN_ENV, SECRET_ID } = await load();
  assert.throws(
    () => resolveToken({ env: {}, run: () => ({ ok: false, missing: true, stderr: '' }) }),
    (e) => {
      assert.ok(e instanceof TokenError, `ожидали TokenError, получили ${e}`);
      assert.ok(e.message.includes(TOKEN_ENV), 'имя переменной в ошибке');
      assert.ok(e.message.includes('export '), 'инструкция: export');
      assert.ok(e.message.includes(`gcloud secrets versions access`), 'инструкция: команда gcloud');
      assert.ok(e.message.includes(`--secret=${SECRET_ID}`), 'имя секрета в инструкции');
      assert.ok(e.message.includes('profiles-artifacts'), 'орга в инструкции');
      assert.ok(!e.message.includes(SECRET), 'токен не утек в текст ошибки');
      return true;
    },
  );
});

test('resolveToken: gcloud упал (не ENOENT) → та же чёткая ошибка с stderr первой строкой', async () => {
  const { resolveToken, TokenError } = await load();
  assert.throws(
    () => resolveToken({ env: {}, run: () => ({ ok: false, missing: false, stderr: 'ERROR: permission denied\nmore\n' }) }),
    (e) => {
      assert.ok(e instanceof TokenError);
      assert.ok(e.message.includes('permission denied'), 'первая строка stderr в диагностике');
      assert.ok(!e.message.includes('stdout'), 'stdout не попадает в ошибку');
      return true;
    },
  );
});

// ── ensure ────────────────────────────────────────────────────────────────────

test('ensure: репо уже есть → GET только, POST нет (идемпотентный no-op, история не тронута)', async () => {
  const { ensureRepo } = await load();
  const { fetchImpl, calls } = mock([{ re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true, html_url: 'https://github.com/profiles-artifacts/profile-alice' } }]);
  const out = [];
  const r = await ensureRepo('alice', { ...TOKEN_DEPS, fetchImpl, out: (m) => out.push(m) });
  assert.equal(r.state, 'exists');
  assert.equal(r.private, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.ok(out.join('\n').includes('no-op'));
});

test('ensure: репо нет → GET 404, POST /orgs/.../repos приватным, 201 → created', async () => {
  const { ensureRepo, ORG } = await load();
  const { fetchImpl, calls } = mock([
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 404, json: { message: 'Not Found' } },
    { method: 'POST', re: /\/orgs\/profiles-artifacts\/repos$/, status: 201, json: { html_url: `https://github.com/${ORG}/profile-alice` } },
  ]);
  const r = await ensureRepo('alice', { ...TOKEN_DEPS, fetchImpl });
  assert.equal(r.state, 'created');
  assert.equal(r.private, true);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'был POST создания');
  const body = JSON.parse(post.body);
  assert.equal(body.name, 'profile-alice');
  assert.equal(body.private, true, 'репо обязано быть приватным');
  // Authorization при каждом вызове, значение токена — только в заголовке
  assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(post.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(post.headers.Accept, 'application/vnd.github+json');
  assert.ok(!post.url.includes(SECRET), 'токен не попадает в URL');
});

test('ensure: гонка (422 на создании) → повторное чтение, репо существует → exists, не ошибка', async () => {
  const { ensureRepo } = await load();
  const { fetchImpl, calls } = mock([
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 404, json: {}, once: true },
    { method: 'POST', re: /\/orgs\/profiles-artifacts\/repos$/, status: 422, json: { message: 'name already exists on this account' } },
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true } },
  ]);
  const r = await ensureRepo('alice', { ...TOKEN_DEPS, fetchImpl });
  assert.equal(r.state, 'exists');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
});

test('ensure: неожиданный статус → GitHubError с кодом', async () => {
  const { ensureRepo, GitHubError } = await load();
  const { fetchImpl } = mock([{ re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 500, json: { message: 'boom' } }]);
  await assert.rejects(() => ensureRepo('alice', { ...TOKEN_DEPS, fetchImpl }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.status, 500);
    assert.ok(e.message.includes('boom'));
    assert.ok(!e.message.includes(SECRET));
    return true;
  });
});

// ── invite ────────────────────────────────────────────────────────────────────

test('invite: 201 → invited, PUT с permission=push', async () => {
  const { inviteUser, ORG } = await load();
  const { fetchImpl, calls } = mock([
    { method: 'PUT', re: /\/repos\/profiles-artifacts\/profile-alice\/collaborators\/kobzevvv$/, status: 201, json: { id: 1 } },
  ]);
  const out = [];
  const r = await inviteUser('alice', 'kobzevvv', { ...TOKEN_DEPS, fetchImpl, out: (m) => out.push(m) });
  assert.deepEqual(r, { repo: 'profile-alice', login: 'kobzevvv', state: 'invited' });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, `https://api.github.com/repos/${ORG}/profile-alice/collaborators/kobzevvv`);
  assert.deepEqual(JSON.parse(calls[0].body), { permission: 'push' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(out.join('\n').includes('push'));
});

test('invite: 204 → уже collaborator (no-op)', async () => {
  const { inviteUser } = await load();
  const { fetchImpl, calls } = mock([
    { method: 'PUT', re: /\/collaborators\/kobzevvv$/, status: 204, json: {} },
  ]);
  const r = await inviteUser('alice', 'kobzevvv', { ...TOKEN_DEPS, fetchImpl });
  assert.equal(r.state, 'already');
  assert.equal(calls.length, 1, 'без лишних запросов');
});

test('invite: 404 и репо нет → подсказка запустить ensure', async () => {
  const { inviteUser, GitHubError } = await load();
  const { fetchImpl } = mock([
    { method: 'PUT', re: /\/collaborators\/kobzevvv$/, status: 404, json: { message: 'Not Found' } },
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 404, json: {} },
  ]);
  await assert.rejects(() => inviteUser('alice', 'kobzevvv', { ...TOKEN_DEPS, fetchImpl }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.ok(e.message.includes('ensure --profile alice'), e.message);
    return true;
  });
});

test('invite: 404, репо есть → виноват логин, а не репо', async () => {
  const { inviteUser, GitHubError } = await load();
  const { fetchImpl } = mock([
    { method: 'PUT', re: /\/collaborators\/no-such-user$/, status: 404, json: { message: 'Could not add user' } },
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true } },
  ]);
  await assert.rejects(() => inviteUser('alice', 'no-such-user', { ...TOKEN_DEPS, fetchImpl }), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.ok(e.message.includes('no-such-user'), e.message);
    assert.ok(e.message.includes('profile-alice'), e.message);
    return true;
  });
});

test('invite: мусор вместо логина → UsageError, запрос не уходит', async () => {
  const { inviteUser, UsageError } = await load();
  const { fetchImpl, calls } = mock([]);
  for (const bad of ['', 'has space', 'x'.repeat(40), 'ends-', '-lead', null]) {
    await assert.rejects(() => inviteUser('alice', bad, { ...TOKEN_DEPS, fetchImpl }), UsageError, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, 'инвалидный логин = ни одного запроса');
});

// ── status ────────────────────────────────────────────────────────────────────

test('status: репо есть, --github → 204 = collaborator', async () => {
  const { repoStatus, ORG } = await load();
  const { fetchImpl, calls } = mock([
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true, html_url: `https://github.com/${ORG}/profile-alice`, default_branch: 'main' } },
    { re: /\/collaborators\/kobzevvv$/, status: 204, json: {} },
  ]);
  const r = await repoStatus('alice', { ...TOKEN_DEPS, fetchImpl, githubLogin: 'kobzevvv' });
  assert.equal(r.state, 'exists');
  assert.equal(r.private, true);
  assert.equal(r.collaborator, true);
  assert.equal(r.defaultBranch, 'main');
  assert.equal(calls.length, 2);
});

test('status: репо нет → missing, инвайт-проверка не дёргается', async () => {
  const { repoStatus } = await load();
  const { fetchImpl, calls } = mock([{ re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 404, json: {} }]);
  const r = await repoStatus('alice', { ...TOKEN_DEPS, fetchImpl, githubLogin: 'kobzevvv' });
  assert.equal(r.state, 'missing');
  assert.equal(r.collaborator, false);
  assert.equal(calls.length, 1);
});

test('status: репо есть, юзер не collaborator → 404 = false', async () => {
  const { repoStatus } = await load();
  const { fetchImpl } = mock([
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true } },
    { re: /\/collaborators\/kobzevvv$/, status: 404, json: {} },
  ]);
  const r = await repoStatus('alice', { ...TOKEN_DEPS, fetchImpl, githubLogin: 'kobzevvv' });
  assert.equal(r.collaborator, false);
});

// ── CLI ───────────────────────────────────────────────────────────────────────

test('main: help → 0, неизвестная команда / нет --profile → 1 с usage', async () => {
  const { main } = await load();
  const lines = [];
  const out = (m) => lines.push(String(m));
  const err = (m) => lines.push(String(m));

  assert.equal(await main(['--help'], { out, err }), 0);
  assert.ok(lines.join('\n').includes('Usage:'));

  lines.length = 0;
  assert.equal(await main(['frobnicate', '--profile', 'alice'], { out, err, run: () => { throw new Error('не должен дёргаться'); } }), 1);
  assert.ok(lines.join('\n').includes('неизвестная команда'));

  lines.length = 0;
  assert.equal(await main(['ensure'], { out, err, run: () => { throw new Error('не должен дёргаться'); } }), 1);
  assert.ok(lines.join('\n').includes('--profile'), 'ошибка говорит про --profile');
});

test('main: без токена → exit 1 и инструкция, ни одного запроса в GitHub', async () => {
  const { main } = await load();
  const errs = [];
  let fetched = 0;
  const code = await main(['ensure', '--profile', 'alice'], {
    env: {},
    run: () => ({ ok: false, missing: true, stderr: '' }),
    fetchImpl: async () => { fetched++; throw new Error('no network'); },
    out: () => {},
    err: (m) => errs.push(String(m)),
    logPath: null,
  });
  assert.equal(code, 1);
  assert.equal(fetched, 0, 'без токена запросов к GitHub не бывает');
  const text = errs.join('\n');
  assert.ok(text.includes('PROFILES_ORG_GITHUB_TOKEN'));
  assert.ok(text.includes('gcloud secrets versions access'));
  assert.ok(!text.includes(SECRET));
});

test('main: ensure проходит, токен не виден ни в stdout, ни в stderr, действие в аудит-логе', async () => {
  const { main } = await load();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-repo-log-'));
  const logPath = path.join(tmp, 'profile-repo-log.jsonl');
  const { fetchImpl, calls } = mock([
    { re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 404, json: {} },
    { method: 'POST', re: /\/orgs\/profiles-artifacts\/repos$/, status: 201, json: { html_url: 'https://github.com/profiles-artifacts/profile-alice' } },
  ]);
  const out = [];
  const errs = [];
  const code = await main(['ensure', '--profile', 'alice'], {
    env: { PROFILES_ORG_GITHUB_TOKEN: SECRET },
    fetchImpl,
    out: (m) => out.push(String(m)),
    err: (m) => errs.push(String(m)),
    logPath,
  });
  assert.equal(code, 0);
  const printed = [...out, ...errs].join('\n');
  assert.ok(!printed.includes(SECRET), 'токен не напечатан');
  assert.ok(out.join('\n').includes('profile-alice'), 'видно имя репо');

  const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cmd, 'ensure');
  assert.equal(entries[0].profile, 'alice');
  assert.equal(entries[0].repo, 'profile-alice');
  assert.equal(entries[0].result, 'created');
  assert.ok(!fs.readFileSync(logPath, 'utf8').includes(SECRET), 'токен не попал в аудит-лог');
  assert.equal(calls.length, 2);

  // Повторный вызов = no-op: только GET, лог пополняется второй записью, история репо не тронута
  const again = mock([{ re: /\/repos\/profiles-artifacts\/profile-alice$/, status: 200, json: { private: true } }]);
  assert.equal(await main(['ensure', '--profile', 'alice'], {
    env: { PROFILES_ORG_GITHUB_TOKEN: SECRET },
    fetchImpl: again.fetchImpl,
    out: () => {},
    err: () => {},
    logPath,
  }), 0);
  assert.equal(again.calls.length, 1);
  assert.equal(again.calls[0].method, 'GET');
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI без токена (реальный запуск, PATH без gcloud) → exit 1, понятная ошибка', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-repo-path-'));
  const env = { ...process.env, PROFILES_ORG_GITHUB_TOKEN: '', PROFILES_ORG_GCP_PROJECT: '', PATH: tmp };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'profile-repo.mjs'), 'ensure', '--profile', 'alice'], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('PROFILES_ORG_GITHUB_TOKEN'), r.stderr);
  assert.ok(r.stderr.includes('gcloud secrets versions access'), r.stderr);
  assert.ok(!/ghp_/.test(String(r.stdout) + String(r.stderr)), 'никаких токенов в выводе');
});
