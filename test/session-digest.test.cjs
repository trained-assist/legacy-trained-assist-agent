'use strict';
// «📋 Сжатый лог» (web digest) — sandbox for issue #1777 / plan 4d331bae.
//
// Walks the owner's scenario through the real blocks: an opencode-shaped engine db
// on disk → readTrace → digest (pass A: time buckets + artifacts incl. phone/PI,
// pass B: one LLM call with a strict JSON contract and a graceful fallback) →
// on-disk cache with a freshness key → the cookie/bearer endpoint twins.
// The LLM is injected (no network): the free-model ladder itself is the
// transport's job; here we pin the contract and the fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

delete process.env.OPENCODE_DB_PATH;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
process.env.HOME = ROOT;
process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
process.env.USERS_DIR = path.join(ROOT, 'users');
for (const k of Object.keys(require.cache)) {
  if (/\/src\/(data-paths|web-routes|session-trace|session-digest)\.js$/.test(k)) delete require.cache[k];
}

const ENGINE_DB_REL = path.join('.agent-home', '.local', 'share', 'opencode', 'opencode.db');
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 28, 10, 0, 0);

function digestMod() { return require('../src/session-digest'); }

function makeDb(file, sessionId, parts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY);'
    + 'CREATE TABLE IF NOT EXISTS part (session_id TEXT, data TEXT, time_created INTEGER);');
  db.prepare('INSERT OR IGNORE INTO session (id) VALUES (?)').run(sessionId);
  const ins = db.prepare('INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)');
  for (const p of parts) ins.run(sessionId, JSON.stringify(p), (p.time || p.state.time).created || p.state.time.start);
  db.close();
}

// Real opencode shape: a tool part has no top-level `time`, only state.time.{start,end}.
const tool = (name, input, output, at) => ({
  type: 'tool', tool: name, state: { status: 'completed', input, output, time: { start: at, end: at + 1000 } },
});

// Fixed trace: 20 min on files, 30 min on the web, 5 min of tests, then the answer.
const PARTS = [
  tool('read', { filePath: '/home/u/projects/x/brief.md' }, 'Клиент: ООО «Ромашка», тел. +7 (916) 123-45-67, mail ivan@romashka.ru', T0),
  tool('read', { filePath: '/home/u/projects/x/notes.md' }, 'server 10.20.30.40, ticket #1777', T0 + 10 * MIN),
  tool('webfetch', { url: 'https://checko.ru/company/romashka' }, 'ИНН 7701234567', T0 + 20 * MIN),
  tool('bash', { command: 'npm test' }, 'PASS 12 tests', T0 + 50 * MIN),
  { type: 'text', text: 'Готово: отчёт опубликован.', time: { created: T0 + 55 * MIN } },
];

const SESSION_MESSAGES = [
  { role: 'user', content: 'Разбери клиента Ромашка и прогони тесты', at: T0 - MIN },
  { role: 'assistant', content: 'Готово: отчёт опубликован.', at: T0 + 55 * MIN },
];

function traceEvents() {
  // Same shape readTrace produces (kind/tool/input/output/at).
  const { readTrace } = require('../src/session-trace');
  const wd = fs.mkdtempSync(path.join(ROOT, 'wd-'));
  makeDb(path.join(wd, ENGINE_DB_REL), 'ses_fixed', PARTS);
  const r = readTrace(wd, { engineSessions: { opencode: 'ses_fixed' }, messages: SESSION_MESSAGES });
  assert.equal(r.ok, true, `fixture trace must read: ${r.error}`);
  return r.events;
}

const minutesOf = (d, family) => (d.activities.find(a => a.family === family) || {}).minutes || 0;

// ── Slice 1: detectors ─────────────────────────────────────────────────────
test('detectPhones: RU and international numbers, not dates/INN/ids', () => {
  const { detectPhones } = digestMod();
  const found = detectPhones('звони +7 (916) 123-45-67 или 8 916 765 43 21, офис +44 20 7946 0958');
  assert.deepEqual(found.sort(), ['+442079460958', '+79161234567', '+79167654321'].sort());
  assert.deepEqual(detectPhones('ИНН 7701234567, дата 2026-09-28, pid 123456, v1.2.3'), []);
});

test('classifyArtifacts: phone/e-mail/IP are PI; links/docs/tickets are attributes; keys never PI', () => {
  const { classifyArtifacts } = digestMod();
  const groups = classifyArtifacts([
    { type: 'contact', kind: 'phone', value: '+79161234567' },
    { type: 'contact', kind: 'email', value: 'ivan@romashka.ru' },
    { type: 'ip', value: '10.20.30.40' },
    { type: 'url', value: 'https://checko.ru/company/romashka' },
    { type: 'file', value: '/home/u/projects/x/brief.md' },
    { type: 'ticket', value: '#1777' },
    { type: 'api_key', value: 'sk-****abcd' },
  ]);
  const vals = g => groups[g].map(a => a.value).sort();
  assert.deepEqual(vals('pi'), ['+79161234567', '10.20.30.40', 'ivan@romashka.ru'].sort());
  assert.ok(vals('attributes').includes('https://checko.ru/company/romashka'));
  assert.ok(vals('attributes').includes('#1777'));
  assert.ok(!vals('pi').some(v => v.startsWith('sk-')), 'masked keys are not PI');
});

// ── Slice 2: pass A buckets (deterministic) ────────────────────────────────
test('buildDigest: fixed trace → fixed minutes per tool family + PI split', () => {
  const { buildDigest } = digestMod();
  const d = buildDigest({ events: traceEvents(), messages: SESSION_MESSAGES });
  assert.equal(minutesOf(d, 'files'), 20);
  assert.equal(minutesOf(d, 'web'), 30);
  assert.equal(minutesOf(d, 'code'), 5);
  const pi = d.artifacts.pi.map(a => a.value);
  assert.ok(pi.includes('+79161234567'), 'phone from a tool output is PI');
  assert.ok(pi.includes('ivan@romashka.ru'));
  assert.ok(d.artifacts.attributes.some(a => /checko\.ru/.test(a.value)));
  // Deterministic: same input → identical output.
  assert.deepEqual(buildDigest({ events: traceEvents(), messages: SESSION_MESSAGES }), d);
});

test('buildDigest: messages-only fallback caps idle gaps — days of thread ≠ days of «Переписка»', () => {
  const { buildDigest } = digestMod();
  const DAY = 24 * 60 * MIN;
  // Two replies a minute apart, then a 4-day pause, then another minute apart.
  const d = buildDigest({ events: [], messages: [
    { role: 'user', content: 'a', at: T0 },
    { role: 'assistant', content: 'b', at: T0 + MIN },
    { role: 'user', content: 'c', at: T0 + 4 * DAY },
    { role: 'assistant', content: 'd', at: T0 + 4 * DAY + MIN },
  ] });
  // 1 + min(4 days → 120) + 1 = 122 — the pause contributes its cap, not 5760.
  assert.equal(minutesOf(d, 'messages'), 122);
  // A purely empty-of-activity thread (one gap far above the cap) is capped too.
  const quiet = buildDigest({ events: [], messages: [
    { role: 'user', content: 'hi', at: T0 },
    { role: 'assistant', content: 'hi', at: T0 + 10 * DAY },
  ] });
  assert.equal(minutesOf(quiet, 'messages'), 120);
});

// ── Slice 3: pass B contract ──────────────────────────────────────────────
test('familyOf: MCP tools come prefixed with their server name', () => {
  const { familyOf } = digestMod();
  const f = (tool) => familyOf({ kind: 'tool', tool });
  assert.equal(f('trained-skills_publish_page'), 'send');
  assert.equal(f('engineering-skills_github_pr_checks'), 'code');
  assert.equal(f('engineering-skills_engineering_spawn_workspace'), 'code');
  assert.equal(f('playwright_browser_click'), 'web');
  assert.equal(f('trained-skills_ru_browser_fetch'), 'web');
  assert.equal(f('web_search'), 'web', 'an un-prefixed underscore name stays intact');
});

test('parseDigestJson: strips thinking garbage and fences, validates shape', () => {
  const { parseDigestJson } = digestMod();
  const raw = '<think>надо посчитать {не json}</think>\nОк, вот:\n```json\n'
    + '{"activities":[{"label":"Разбор клиента","minutes":20}],"summary":"Разобрал клиента. Прогнал тесты."}\n```';
  const out = parseDigestJson(raw);
  assert.deepEqual(out.activities, [{ label: 'Разбор клиента', minutes: 20 }]);
  assert.match(out.summary, /Разобрал клиента/);
  assert.equal(parseDigestJson('рассуждаю без json'), null);
  assert.equal(parseDigestJson('{"activities":"x","summary":1}'), null, 'wrong shape → null');
});

test('summarizeDigest: one LLM call on a compact projection, retry once, then degrade without error', async () => {
  const { buildDigest, summarizeDigest } = digestMod();
  const base = buildDigest({ events: traceEvents(), messages: SESSION_MESSAGES });

  const prompts = [];
  const good = await summarizeDigest(base, { llm: async (p) => { prompts.push(p); return '{"activities":[{"label":"Работа с файлами","minutes":20}],"summary":"Разобрал бриф. Проверил компанию."}'; } });
  assert.equal(prompts.length, 1, 'exactly one LLM call when it answers');
  assert.ok(JSON.stringify(prompts[0]).length < 6000, 'LLM gets the compact projection, not the raw trace');
  assert.equal(good.degraded, false);
  assert.match(good.summary, /Разобрал бриф/);

  let calls = 0;
  const bad = await summarizeDigest(base, { llm: async () => { calls++; throw new Error('429 free slug down'); } });
  assert.equal(calls, 2, 'one retry, no more');
  assert.equal(bad.degraded, true);
  assert.equal(bad.summary, null);
  assert.equal(minutesOf(bad, 'web'), 30, 'deterministic part survives the LLM failure');
});

// ── Slice 4 + 6: endpoint core with cache and degradation ──────────────────
test('getDigestFor: real on-disk session → ok, cached on repeat, recomputed when the session grows', async () => {
  const { userWorkDir } = require('../src/data-paths');
  const { getDigestFor } = digestMod();
  const wd = userWorkDir('alice');
  makeDb(path.join(wd, ENGINE_DB_REL), 'ses_live', PARTS);
  const sfile = path.join(wd, 'sessions', 's_live.json');
  fs.mkdirSync(path.dirname(sfile), { recursive: true });
  const sess = { id: 's_live', engineSessions: { opencode: 'ses_live' }, messages: SESSION_MESSAGES };
  fs.writeFileSync(sfile, JSON.stringify(sess));

  let llmCalls = 0;
  const llm = async () => { llmCalls++; return '{"activities":[{"label":"Файлы","minutes":20}],"summary":"Сделал разбор. Прогнал тесты."}'; };

  const first = await getDigestFor('alice', 's_live', { llm });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.engine, 'opencode');
  assert.equal(first.cached, false);
  assert.ok(first.activities.length > 0);
  assert.ok(first.summary);
  assert.ok(fs.existsSync(path.join(wd, 'sessions', 's_live.digest.json')), 'cache lives next to the session file');

  const second = await getDigestFor('alice', 's_live', { llm });
  assert.equal(second.cached, true);
  assert.equal(llmCalls, 1, 'cache hit spends no LLM call');

  sess.messages = [...SESSION_MESSAGES, { role: 'user', content: 'ещё', at: T0 + 60 * MIN }];
  fs.writeFileSync(sfile, JSON.stringify(sess));
  const third = await getDigestFor('alice', 's_live', { llm });
  assert.equal(third.cached, false, 'freshness key changed → recompute');
  assert.equal(llmCalls, 2);

  assert.equal((await getDigestFor('alice', '../etc', { llm })).ok, false, 'invalid id rejected');
});

test('getDigestFor: session without an opencode trace degrades to a messages-only digest', async () => {
  const { userWorkDir } = require('../src/data-paths');
  const { getDigestFor } = digestMod();
  const wd = userWorkDir('bob');
  fs.mkdirSync(path.join(wd, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(wd, 'sessions', 's_claude.json'), JSON.stringify({
    id: 's_claude', engineSessions: { claude: 'af7111d2' },
    messages: [{ role: 'user', content: 'позвони +7 916 123-45-67', at: T0 }, { role: 'assistant', content: 'Записал.', at: T0 + MIN }],
  }));
  const r = await getDigestFor('bob', 's_claude', { llm: async () => { throw new Error('down'); } });
  assert.equal(r.ok, true, 'never an error for a missing trace');
  assert.equal(r.engine, null);
  assert.ok(r.artifacts.pi.some(a => a.value === '+79161234567'), 'artifacts still come from messages');

  // A transient LLM outage must not pin a summary-less digest for the whole TTL.
  assert.equal(r.degraded, true);
  assert.ok(!fs.existsSync(path.join(wd, 'sessions', 's_claude.digest.json')), 'degraded digest is not cached');
  const again = await getDigestFor('bob', 's_claude', { llm: async () => '{"activities":[],"summary":"Записал телефон."}' });
  assert.equal(again.cached, false);
  assert.equal(again.summary, 'Записал телефон.', 'next click retries the LLM once it is back');
});

test('getDigestFor: a cache written by an older digest format is not trusted', async () => {
  const crypto = require('node:crypto');
  const { userWorkDir } = require('../src/data-paths');
  const { getDigestFor, freshnessKey } = digestMod();
  const wd = userWorkDir('carol');
  fs.mkdirSync(path.join(wd, 'sessions'), { recursive: true });
  const messages = [
    { role: 'user', content: 'привет', at: T0 },
    { role: 'assistant', content: 'привет', at: T0 + MIN },
  ];
  fs.writeFileSync(path.join(wd, 'sessions', 's_old.json'), JSON.stringify({ id: 's_old', messages }));

  // A cache entry from BEFORE the format version existed: content-only key,
  // carrying the number the buggy pass A produced («Переписка 999999 минут»).
  const legacyKey = crypto.createHash('sha1')
    .update(`0|0|2|${T0 + MIN}`).digest('hex').slice(0, 16);
  assert.notEqual(freshnessKey([], messages), legacyKey, 'the versioned key must differ from the legacy one');
  fs.writeFileSync(path.join(wd, 'sessions', 's_old.digest.json'), JSON.stringify({
    key: legacyKey, createdAt: Date.now(),
    digest: {
      ok: true, engine: null, sessionId: 's_old',
      activities: [{ family: 'messages', minutes: 999999, label: 'Переписка' }],
      artifacts: { pi: [], attributes: [], other: [] },
      summary: 'закэшированное враньё', degraded: false, cached: false, ttlMs: 1,
    },
  }));

  let llmCalls = 0;
  const r = await getDigestFor('carol', 's_old', { llm: async () => { llmCalls++; return '{"activities":[],"summary":"свежая сводка"}'; } });
  assert.equal(r.cached, false, 'stale cache from another format version must not be served');
  assert.equal(llmCalls, 1, 'recompute spends the one LLM call');
  assert.equal(r.summary, 'свежая сводка');
  assert.equal(minutesOf(r, 'messages'), 1, 'numbers come from the current format, not from the cache');
});

// ── Slice 4: wiring of the endpoint twins (same pattern as trace) ──────────
test('endpoint twins are wired: cookie GET, bearer POST, server whitelist', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/web-routes.js'), /\\\/digest\$/, 'GET /web/session/:id/digest route');
  assert.match(read('src/handlers/web.js'), /\/web\/session-digest/, 'POST /web/session-digest bearer twin');
  assert.match(read('src/server.js'), /'\/web\/session-digest'/, 'bearer path whitelisted in server.js');
});
