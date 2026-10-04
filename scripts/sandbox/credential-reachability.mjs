#!/usr/bin/env node
// Sandbox «credential reachability» — исполнимая форма сценария
// docs/user-scenarios/engineering/03-credential-reachability.md (US-CRED-01…05),
// issue #1891 (epic #1885). Одна команда:
//
//     npm run sandbox:cred-reachability
//
// Уровень автономности: S5 — агент сам поднимает окружение (временный HOME /
// AGENT_DATA_DIR / USERS_DIR / AGENT_TOKENS_DIR с фикстурными профилями и
// ключами-заглушками) и гоняет все шаги сценария через реальные блоки ядра:
// реестр, чистую функцию сборки env MCP-скилов, CLI CI-контракта и CLI
// profile-migrate. Никакой сети, никаких настоящих ключей. Цикл ≤ 30 с.
//
// Проверки (сценарий → проверка):
//   C1  US-CRED-01  реестр config/credentials.json грузится и валиден по
//                   contracts/credentials.schema.json (через src/credential-registry.js);
//                   мёртвый config/mcp-provider-env.json удалён;
//                   регресс-записи есть: deepgram (DEEPGRAM_API_KEY + alias DEEPGRAM_KEY),
//                   cloudflare (CLOUDFLARE_API_TOKEN + alias CF_API_TOKEN),
//                   sales dadata (.inn-config.json).
//   C2  US-CRED-01  реестр отвергает невалидную запись (нет consumer, files с `..`).
//   C3  US-CRED-01  buildMcpToolEnv (вынос из browser.js) — чистая функция; заявленные
//                   HH_CLIENT_ID / HH_CLIENT_SECRET / AGENT_TOKENS_DIR доходят до MCP-скила.
//   C4  US-CRED-01  CI-контракт scripts/check-credential-reachability.js: на дереве → exit 0;
//                   с реестром, где заявлено непредоставляемое имя → exit 1 и имя в выводе.
//   C5  US-CRED-02  тот же контракт: тул, читающий токен через os.homedir() → exit 1;
//                   core-тулы ядра сами os.homedir()+agent-tokens не используют.
//   C6  US-CRED-03  profile-migrate фаза credentials-reachability: --dry-run --json отдаёт
//                   «имя → reachable → source», без значений ключей; --apply пишет только
//                   ledger; удалили файл ключа → --verify exit 2 с именем; вернули → exit 0.
//   C7  US-CRED-04  alias: при DEEPGRAM_KEY / CF_API_TOKEN (без canonical) → reachable=true,
//                   source = alias-имя.
//   C8  US-CRED-05  dadata: env нет, USERS_DIR/<u>/.inn-config.json есть → reachable=true.
//   C9  spec        сценарий docs/user-scenarios/engineering/03-credential-reachability.md есть.
//   C10 US-CRED-06  регресс 01.10.2026: токены всех ботов объявлены; контракт ловит
//                   ВКЛЮЧЁННОГО потребителя, чей ключ не объявлен (обратное направление) и
//                   имя, которое загрузчик секретов не возит.
//   C11 US-CRED-07  pre-deploy гард scripts/check-deploy-secrets-gate.js: сломанный токен →
//                   exit 1 с именем бота И симлинк прод-релиза остался на прошлом коммите
//                   (стенд: агент-master → <rel>/aaaaaaaaaaa, кандидат bbbbbbbbbbb).
//
// Контракты, которые песочница пинит для реализации (срезы S1–S8):
//   • src/credential-registry.js: load(file?) → {version, credentials[]}; validate(obj) кидает.
//   • src/browser.js экспортирует buildMcpToolEnv({userId, workDir, …}) → объект env.
//   • scripts/check-credential-reachability.js [--registry <file>] [--tools-dir <dir>]:
//     exit 0 ок / 1 нарушение, имена в выводе, значения — никогда.
//   • profile-migrate: фаза `credentials-reachability`, корень токенов = AGENT_TOKENS_DIR
//     (data-paths), --json отдаёт credentials[] {consumer,name,reachable,source,sha256?}.
//
// Пока срезы не сделаны, песочница обязана быть КРАСНОЙ по этим причинам.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(CORE, ...p);

// Секреты-заглушки: уникальные строки, которых не должно быть ни в одном выводе.
const SECRETS = {
  deepgram: 'sbx-deepgram-VALUE-7f3a',
  dadata: 'sbx-dadata-VALUE-91c2',
  cf: 'sbx-cf-VALUE-4b8d',
  hhId: 'sbx-hh-id-VALUE-22e1',
  hhSecret: 'sbx-hh-secret-VALUE-5a0f',
};

const results = [];
function check(id, name, fn) {
  try {
    const r = fn();
    if (r && r.ok === false) results.push({ id, name, ok: false, reason: r.reason });
    else results.push({ id, name, ok: true, note: r && r.note });
  } catch (e) {
    results.push({ id, name, ok: false, reason: `${e.name}: ${e.message.split('\n')[0]}` });
  }
}
const need = (cond, reason) => { if (!cond) throw new Error(reason); };
const leaks = (text) => Object.values(SECRETS).filter(v => String(text).includes(v));

// ── изолированное окружение ──────────────────────────────────────────────────
const SBX = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-reachability-sbx-'));
const ENV_DIRS = {
  HOME: path.join(SBX, 'home'),
  AGENT_DATA_DIR: path.join(SBX, 'agent-data'),
  USERS_DIR: path.join(SBX, 'users'),
  AGENT_TOKENS_DIR: path.join(SBX, 'agent-tokens'),
};
for (const d of Object.values(ENV_DIRS)) fs.mkdirSync(d, { recursive: true });
const PROFILE = 'sbx-profile';
const deepgramKeyFile = path.join(ENV_DIRS.AGENT_TOKENS_DIR, PROFILE, 'deepgram', 'key.txt');
fs.mkdirSync(path.dirname(deepgramKeyFile), { recursive: true });
fs.writeFileSync(deepgramKeyFile, SECRETS.deepgram, { mode: 0o600 });
fs.mkdirSync(path.join(ENV_DIRS.USERS_DIR, PROFILE), { recursive: true });
fs.writeFileSync(path.join(ENV_DIRS.USERS_DIR, PROFILE, '.inn-config.json'),
  JSON.stringify({ dadata_token: SECRETS.dadata }));

// Чистый env: никаких живых ключей хоста не протекает в дочерние процессы.
const baseEnv = { PATH: process.env.PATH, NODE_ENV: 'test', ...ENV_DIRS };
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: CORE, env: { ...baseEnv, ...extraEnv }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}
const tail = (s) => s.trim().split('\n').slice(-2).join(' | ').slice(0, 220);

// ── C1–C2: реестр ────────────────────────────────────────────────────────────
let registry = null;
check('C1', 'US-CRED-01 реестр config/credentials.json валиден, регресс-записи есть', () => {
  need(fs.existsSync(rel('contracts', 'credentials.schema.json')), 'нет contracts/credentials.schema.json');
  need(fs.existsSync(rel('config', 'credentials.json')), 'нет config/credentials.json');
  need(fs.existsSync(rel('src', 'credential-registry.js')), 'нет src/credential-registry.js');
  const reg = require(rel('src', 'credential-registry.js'));
  registry = reg.load(rel('config', 'credentials.json'));
  const all = registry.credentials;
  const has = (canon, alias) => all.some(c => (c.env || []).includes(canon) && (!alias || (c.aliases || []).includes(alias)));
  need(has('SYSTEM_DEEPGRAM_API_KEY', 'DEEPGRAM_API_KEY'), 'нет записи deepgram SYSTEM_DEEPGRAM_API_KEY + alias DEEPGRAM_API_KEY');
  need(has('ADMIN_CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'), 'нет записи cloudflare ADMIN_CLOUDFLARE_API_TOKEN + alias CF_API_TOKEN');
  need(all.some(c => (c.files || []).some(f => f.endsWith('.inn-config.json'))), 'нет записи dadata с .inn-config.json');
  need(!fs.existsSync(rel('config', 'mcp-provider-env.json')), 'мёртвый config/mcp-provider-env.json не удалён');
  return { note: `${all.length} записей` };
});

check('C2', 'US-CRED-01 реестр отвергает невалидные записи', () => {
  const reg = require(rel('src', 'credential-registry.js'));
  const bad = [
    { version: 1, credentials: [{ scope: 'platform', env: ['X'] }] },
    { version: 1, credentials: [{ consumer: 'x', scope: 'profile', files: ['../escape.txt'] }] },
    { version: 1, credentials: [{ consumer: 'x', scope: 'profile', files: ['/abs/path'] }] },
  ];
  for (const b of bad) {
    let threw = false;
    try { reg.validate(b); } catch { threw = true; }
    need(threw, `validate принял ${JSON.stringify(b.credentials[0])}`);
  }
});

// ── C3: env MCP-скилов ───────────────────────────────────────────────────────
check('C3', 'US-CRED-01 buildMcpToolEnv доносит HH_CLIENT_* и AGENT_TOKENS_DIR', () => {
  const r = run(['-e', `
    process.env.HH_CLIENT_ID = ${JSON.stringify(SECRETS.hhId)};
    process.env.HH_CLIENT_SECRET = ${JSON.stringify(SECRETS.hhSecret)};
    const b = require('./src/browser.js');
    if (typeof b.buildMcpToolEnv !== 'function') { console.log('NO_FN'); process.exit(3); }
    const env = b.buildMcpToolEnv({ userId: ${JSON.stringify(PROFILE)}, workDir: process.env.USERS_DIR + '/${PROFILE}' });
    const want = ['USER_ID', 'WORK_DIR', 'HH_CLIENT_ID', 'HH_CLIENT_SECRET', 'AGENT_TOKENS_DIR'];
    const miss = want.filter(k => !env[k]);
    console.log(miss.length ? 'MISSING ' + miss.join(',') : 'OK');
    process.exit(miss.length ? 4 : 0);
  `]);
  need(r.code !== 3, 'src/browser.js не экспортирует buildMcpToolEnv');
  need(r.code === 0, `env MCP-скила: ${tail(r.stdout || r.out)}`);
});

// ── C4–C5: CI-контракт ───────────────────────────────────────────────────────
const CONTRACT = rel('scripts', 'check-credential-reachability.js');
check('C4', 'US-CRED-01 CI-контракт: дерево зелёное, непредоставленное имя → exit 1', () => {
  need(fs.existsSync(CONTRACT), 'нет scripts/check-credential-reachability.js');
  const ok = run([CONTRACT]);
  need(ok.code === 0, `на дереве exit ${ok.code}: ${tail(ok.out)}`);
  const badReg = path.join(SBX, 'bad-registry.json');
  fs.writeFileSync(badReg, JSON.stringify({ version: 1, credentials: [
    { consumer: 'sbx', scope: 'platform', env: ['SBX_NEVER_PROVIDED_KEY'], source: 'secrets-env', reader: 'sbx' },
  ] }));
  const bad = run([CONTRACT, '--registry', badReg]);
  need(bad.code === 1, `непредоставленное имя: ожидали exit 1, получили ${bad.code}`);
  need(bad.out.includes('SBX_NEVER_PROVIDED_KEY'), 'в выводе нет имени нарушителя');
});

check('C5', 'US-CRED-02 CI-контракт: os.homedir() для токенов → exit 1; core чист', () => {
  const dirty = [];
  for (const f of fs.readdirSync(rel('src', 'mcp-skills', 'tools'))) {
    if (!f.endsWith('.js')) continue;
    const t = fs.readFileSync(rel('src', 'mcp-skills', 'tools', f), 'utf8');
    if (/os\.homedir\(\)\s*,\s*['"]agent-tokens['"]/.test(t)) dirty.push(f);
  }
  need(fs.existsSync(CONTRACT), 'нет scripts/check-credential-reachability.js');
  const toolsDir = path.join(SBX, 'bad-tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, '99-sbx.js'),
    "const os=require('os'),path=require('path');\nmodule.exports=()=>path.join(os.homedir(),'agent-tokens','u','x');\n");
  const bad = run([CONTRACT, '--tools-dir', toolsDir]);
  need(bad.code === 1, `тул с os.homedir(): ожидали exit 1, получили ${bad.code}`);
  need(bad.out.includes('99-sbx.js'), 'в выводе нет файла-нарушителя');
  need(!dirty.length, `core-тулы читают токены через os.homedir(): ${dirty.join(', ')}`);
});

// ── C6–C8: инвариант миграции ────────────────────────────────────────────────
const CLI = rel('scripts', 'profile-migrate', 'cli.mjs');
const PHASE = 'credentials-reachability';
function scan(extraEnv = {}, mode = '--dry-run') {
  const r = run([CLI, PHASE, '--profile', PROFILE, '--users-root', ENV_DIRS.USERS_DIR,
    mode, '--json', '--drain-timeout', '0'], extraEnv);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  const creds = json ? (json.credentials || (json.profiles || []).flatMap(p => p.credentials || [])) : [];
  return { ...r, json, creds };
}
const find = (creds, name) => creds.find(c => c.name === name || c.consumer === name);

check('C6', 'US-CRED-03 profile-migrate: dry-run/apply/verify, было→не стало = exit 2', () => {
  const dry = scan();
  need(dry.code === 0, `фаза ${PHASE} --dry-run: exit ${dry.code}: ${tail(dry.out)}`);
  need(dry.creds.length > 0, 'в --json нет credentials[]');
  const dg = find(dry.creds, 'deepgram') || find(dry.creds, 'DEEPGRAM_API_KEY');
  need(dg && dg.reachable === true, 'deepgram key.txt не reachable в dry-run');
  need(!leaks(dry.out).length, 'в выводе dry-run значение ключа');
  const ap = scan({}, '--apply');
  need(ap.code === 0, `--apply: exit ${ap.code}: ${tail(ap.out)}`);
  const ledgerHits = spawnSync('grep', ['-rl', PHASE, ENV_DIRS.AGENT_DATA_DIR, ENV_DIRS.USERS_DIR], { encoding: 'utf8' }).stdout.trim();
  need(ledgerHits, 'после --apply нет записей фазы в ledger');
  const ledgerText = ledgerHits.split('\n').map(f => fs.readFileSync(f, 'utf8')).join('\n');
  need(!leaks(ledgerText).length, 'в ledger значение ключа');
  const same = scan({}, '--verify');
  need(same.code === 0, `--verify без изменений: exit ${same.code}: ${tail(same.out)}`);
  fs.renameSync(deepgramKeyFile, `${deepgramKeyFile}.moved`);
  const lost = scan({}, '--verify');
  fs.renameSync(`${deepgramKeyFile}.moved`, deepgramKeyFile);
  need(lost.code === 2, `ключ пропал: ожидали --verify exit 2, получили ${lost.code}`);
  need(/deepgram|DEEPGRAM_API_KEY/.test(lost.out), 'в выводе --verify нет имени потерянного ключа');
  need(!leaks(lost.out).length, 'в выводе --verify значение ключа');
});

check('C7', 'US-CRED-04 alias: DEEPGRAM_KEY / CF_API_TOKEN засчитываются', () => {
  const r = scan({ DEEPGRAM_KEY: SECRETS.deepgram, CF_API_TOKEN: SECRETS.cf });
  need(r.code === 0, `фаза ${PHASE}: exit ${r.code}: ${tail(r.out)}`);
  const cf = find(r.creds, 'ADMIN_CLOUDFLARE_API_TOKEN') || find(r.creds, 'cloudflare');
  need(cf && cf.reachable === true, 'ADMIN_CLOUDFLARE_API_TOKEN не reachable через alias CF_API_TOKEN');
  need(cf.source === 'CF_API_TOKEN', `source ожидали CF_API_TOKEN, получили ${cf && cf.source}`);
  need(!leaks(r.out).length, 'в выводе значение ключа');
});

check('C8', 'US-CRED-05 dadata: env нет, .inn-config.json есть → reachable', () => {
  const r = scan();
  need(r.code === 0, `фаза ${PHASE}: exit ${r.code}: ${tail(r.out)}`);
  const d = r.creds.find(c => /dadata/i.test(`${c.consumer} ${c.name}`) && c.reachable === true);
  need(d, 'dadata не reachable через USERS_DIR/<u>/.inn-config.json');
});

check('C9', 'spec: docs/user-scenarios/engineering/03-credential-reachability.md', () => {
  need(fs.existsSync(rel('docs', 'user-scenarios', 'engineering', '03-credential-reachability.md')), 'нет файла сценария');
});

// ── C10–C11: бот-токены и pre-deploy гард (01.10.2026, класс «потребитель без ключа») ──
// Наблюдение после релиза нашло: sales-бот включён в bots.registry, а SALES_BOT_TOKEN не
// грузится. Односторонний контракт (объявлено ⊆ предоставлено) этот класс по построению
// не видит. C10 пинит обратное направление, C11 — что красный гард не даёт релиз уехать.
const GATE = rel('scripts', 'check-deploy-secrets-gate.js');
const BOTS = ['TELEGRAM_BOT_TOKEN', 'RECRUITER_BOT_TOKEN', 'FREELANCE_BOT_TOKEN', 'SALES_BOT_TOKEN'];
const botEnv = (skip) => Object.fromEntries(
  BOTS.filter(n => n !== skip).map(n => [n, `sbx-${n.toLowerCase()}-VALUE-3c8b`]));

check('C10', 'регресс 01.10: токены ботов объявлены, контракт ловит включённого потребителя без ключа', () => {
  const reg = require(rel('src', 'credential-registry.js')).load(rel('config', 'credentials.json'));
  const declared = new Set(reg.credentials.flatMap(c => c.env || []));
  for (const n of BOTS) need(declared.has(n), `${n} не объявлен в config/credentials.json`);
  const bots = require(rel('src', 'bot-registry.js')).BOTS;
  const enabled = bots.filter(b => b.enabled !== false).map(b => b.token_secret_name);
  need(enabled.includes('SALES_BOT_TOKEN'), 'sales-бот выключен — песочница не проверяет его контракт');

  // На дереве — зелёное, включая обратное направление.
  const ok = run([CONTRACT]);
  need(ok.code === 0, `на дереве exit ${ok.code}: ${tail(ok.out)}`);

  // Выкинули токен включённого бота из реестра → exit 1 с именем (старое слепое место).
  const raw = JSON.parse(fs.readFileSync(rel('config', 'credentials.json'), 'utf8'));
  for (const c of raw.credentials) {
    if (c.consumer === 'core:bot-tokens') c.env = c.env.filter(n => n !== 'SALES_BOT_TOKEN');
  }
  const noSales = path.join(SBX, 'no-sales-registry.json');
  fs.writeFileSync(noSales, JSON.stringify(raw));
  const bad = run([CONTRACT, '--registry', noSales]);
  need(bad.code === 1, `токен включённого бота не объявлен: ожидали exit 1, получили ${bad.code}`);
  need(bad.out.includes('SALES_BOT_TOKEN'), 'в выводе нет имени бота без ключа');
  need(/bots\.registry/.test(bad.out), 'в выводе нет указания, какой реестр хоста включил потребителя');

  // Объявили, но загрузчик его не возит → тоже красное (обещание манифеста без поставки).
  const orphan = { version: 1, credentials: [
    { consumer: 'sbx', scope: 'platform', host: 'secrets', env: ['SBX_LOADER_NEVER_FETCHES'], source: 'sbx', reader: 'sbx' },
  ] };
  const orphanReg = path.join(SBX, 'orphan-registry.json');
  fs.writeFileSync(orphanReg, JSON.stringify(orphan));
  const orphanRun = run([CONTRACT, '--registry', orphanReg]);
  need(orphanRun.code === 1, `имя вне загрузчика: ожидали exit 1, получили ${orphanRun.code}`);
  need(orphanRun.out.includes('SBX_LOADER_NEVER_FETCHES'), 'в выводе нет имени, которое загрузчик не возит');
});

check('C11', 'pre-deploy гард: сломанный токен → красный И прод-релиз остался на прошлом коммите', () => {
  need(fs.existsSync(GATE), 'нет scripts/check-deploy-secrets-gate.js');
  // Стенд: «текущий» релиз (куда указывает симлинк) + кандидат, который хотим активировать.
  const live = path.join(SBX, 'agent-releases', 'aaaaaaaaaaa');
  const cand = path.join(SBX, 'agent-releases', 'bbbbbbbbbbb');
  for (const d of [live, cand]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'index.js'), '// release\n'); }
  const link = path.join(SBX, 'agent-master');
  fs.symlinkSync(live, link);

  const gate = (skip) => run([GATE, '--release', CORE, '--env', 'gcp'],
    { SECRETS_SOURCE: 'env', ...botEnv(skip) });
  const clean = gate();
  need(clean.code === 0, `все токены на месте: ожидали exit 0, получили ${clean.code}: ${tail(clean.out)}`);

  const broken = gate('SALES_BOT_TOKEN');
  need(broken.code === 1, `SALES_BOT_TOKEN отсутствует: ожидали exit 1, получили ${broken.code}`);
  need(broken.out.includes('SALES_BOT_TOKEN'), 'в выводе гарда нет имени бота без токена');
  need(broken.out.includes('sales'), 'в выводе гарда нет botId');
  // Стенд-инвариант D1: красный гард не переводит симлинк — релиз не активируется.
  need(fs.readlinkSync(link) === live, `гард сдвинул agent-master на ${fs.readlinkSync(link)}`);
  need(fs.existsSync(path.join(live, 'index.js')), 'прод-релиз пропал — стенд не должен трогать прошлое');
  // Стенд: активация (то, что делает deploy.sh ПОСЛЕ гарда) по-прежнему работает.
  fs.unlinkSync(link);
  fs.symlinkSync(cand, link);
  need(fs.readlinkSync(link) === cand, 'стенд активации не сработал — проверка бессмысленна');
});

// ── итог ─────────────────────────────────────────────────────────────────────
fs.rmSync(SBX, { recursive: true, force: true });
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.name}${r.ok ? (r.note ? ` (${r.note})` : '') : `\n     → ${r.reason}`}`);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${failed ? 'RED' : 'GREEN'}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
