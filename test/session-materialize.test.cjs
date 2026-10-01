'use strict';
// Issue #1916 PR-C — materialize on read (epic #1784 M2, red-team B6 / #1808).
//
// What this file owns:
//   · the ADMISSION ORDER — an archived session must come back BEFORE
//     resolveChatSession reads it, otherwise `getSession → null` adopts the id
//     for a brand-new blank session and the accumulated context is lost;
//   · HONEST FAILURE — a GCS outage rejects with a typed error the runner turns
//     into a user-facing message; it is never a silent null that reads as
//     «session does not exist»;
//   · native RESUME — the engine transcript is restored into the project
//     directory Claude derives from cwd (its slug ≠ the blob key's slugCwd);
//   · session_search — archived sessions are searched byte-identically to local
//     ones, with NO session body left on disk afterwards;
//   · the readers used by the web UI (getSessionFor) leave nothing behind either.
//
// No live GCS: GCS_FAKE_DIR points the blob store at a temp directory (the
// file-backed backend of src/session-blob-store.js), GCS_FAKE_FAIL injects an
// outage. NODE_ENV must not be `production` — that is where the fake is refused.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// Environment BEFORE any src/ require: the fake bucket (never real GCS/ADC),
// NODE_ENV that allows it, and the profile root the readers resolve through
// data-paths — otherwise session_search would look in ~/users, not in the fixture.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-materialize-'));
const GCS = path.join(TMP, 'gcs');
process.env.NODE_ENV = 'test';
process.env.GCS_FAKE_DIR = GCS;
process.env.USERS_DIR = path.join(TMP, 'users');

const materialize = require('../src/session-materialize');
const sessions = require('../src/session-store');
const { createSessionBlobStore, createFileBackedBucket, sessionKey, transcriptKey, slugCwd } = require('../src/session-blob-store');

before(() => {
  materialize._resetBlob();
});
after(() => {
  delete process.env.GCS_FAKE_DIR;
  delete process.env.USERS_DIR;
  materialize._resetBlob();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const gzip = (data) => zlib.gzipSync(Buffer.from(data));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// Same layout the real readers resolve: USERS_DIR/<profile> (src/data-paths.js).
function profileRoot(name = 'alice') {
  const dir = path.join(process.env.USERS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Put `body` into the fake bucket under the profile's session key and record
 *  the marker in the index — i.e. run the POST-RUN state of PR-B: local file
 *  gone, bytes only in GCS. */
function archiveSessionBody(root, profile, sessionId, body, { withLocalCopy = false, indexExtra = {} } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const gz = gzip(raw);
  const key = sessionKey(profile, sessionId);
  write(path.join(GCS, key), gz);
  if (withLocalCopy) write(path.join(root, 'sessions', `${sessionId}.json`), raw);
  const indexPath = path.join(root, 'sessions.json');
  let index = [];
  if (fs.existsSync(indexPath)) index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const record = {
    id: sessionId, topic: 'из архива', audience: 'default',
    createdAt: Date.now() - 1000, lastAt: Date.now(), messageCount: 2,
    lastUserMessage: 'привет', ...indexExtra,
    archived: { key, sha256: sha(gz), size: gz.length, at: new Date().toISOString() },
  };
  const at = index.findIndex(r => r && r.id === sessionId);
  if (at >= 0) index[at] = { ...index[at], ...record };
  else index.push(record);
  write(indexPath, JSON.stringify(index, null, 2));
  return { key, raw, gz };
}

function archiveTranscript(root, profile, cwd, engineSessionId, content) {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-'); // Claude's own project dir name
  const rel = `.agent-home/.claude/projects/${slug}/${engineSessionId}.jsonl`;
  const gz = gzip(content);
  const key = transcriptKey(profile, slugCwd(cwd), engineSessionId);
  write(path.join(GCS, key), gz);
  // The local copy is gone — this is the between-runs state.
  const local = path.join(root, rel);
  if (fs.existsSync(local)) fs.rmSync(local);
  return { key, rel, content };
}

const SESSION_BODY = {
  id: 's-arch', topic: 'архивная сессия', audience: 'default', liveChatId: 777,
  createdAt: Date.now() - 5000, lastAt: Date.now(), messageCount: 2,
  messages: [
    { role: 'user', content: 'обсудили вакансию React', at: Date.now() - 4000 },
    { role: 'assistant', content: 'вот шаблон вакансии', at: Date.now() - 3000 },
  ],
};

// ── admission order: archived → materialize → resolve, never a blank session ──

test('admission: без materialize resolveChatSession принимает archived-ид за отсутствующий — с хуком сессия живая', async () => {
  const root = profileRoot('order');
  archiveSessionBody(root, 'order', 's-arch', SESSION_BODY);

  // 1. The bug this hook exists for: no local body ⇒ the id resolves to null and
  //    the caller would create a BLANK session with the same id.
  assert.equal(sessions.getSession(root, 's-arch'), null, 'precondition: между ранами тела нет');
  assert.equal(
    sessions.resolveChatSession(root, 's-arch', 777, 'default', null),
    null,
    'без materialize резолв падает в «новая сессия» — ровно red-team B6',
  );

  // 2. What the runner's admission hook does before that read.
  const out = await materialize.materializeRunSessions({
    workDir: root, profile: 'order', sessionId: 's-arch', chatId: 777, audience: 'default', threadId: null,
  });
  assert.deepEqual(out.materialized, ['s-arch'], 'тело должно быть именно записано на диск');

  // 3. Now resolution finds the SAME session, with its history intact.
  assert.equal(sessions.resolveChatSession(root, 's-arch', 777, 'default', null), 's-arch');
  const body = sessions.getSession(root, 's-arch');
  assert.equal(body.messages.length, 2, 'контекст собран из восстановленного тела');
  assert.match(sessions.buildContext(root, 's-arch') || '', /вакансию React/);

  // 4. Idempotent: a second admission does not rewrite or duplicate anything.
  const again = await materialize.materializeRunSessions({
    workDir: root, profile: 'order', sessionId: 's-arch', chatId: 777, audience: 'default', threadId: null,
  });
  assert.deepEqual(again.materialized, [], 'повторный вызов ничего не качает');
});

test('admission: current-session pointer тоже материализуется, forceNew — нет', async () => {
  const root = profileRoot('pointer');
  archiveSessionBody(root, 'pointer', 's-cur', { ...SESSION_BODY, id: 's-cur', liveChatId: 5 });
  sessions.setCurrentSessionId(root, 's-cur', 5, 'default', null);

  // No explicit sessionId — the chat continues its pointer, so that is the body
  // the run needs.
  const out = await materialize.materializeRunSessions({
    workDir: root, profile: 'pointer', sessionId: null, chatId: 5, audience: 'default', threadId: null,
  });
  assert.deepEqual(out.materialized, ['s-cur']);

  // forceNew means "this id is supposed to be a NEW session" — never resurrect.
  archiveSessionBody(root, 'pointer', 's-new', { ...SESSION_BODY, id: 's-new', liveChatId: 5 });
  const fresh = await materialize.materializeRunSessions({
    workDir: root, profile: 'pointer', sessionId: 's-new', chatId: 5, audience: 'default', threadId: null, forceNew: true,
  });
  assert.deepEqual(fresh.materialized, [], 'forceNew не поднимает архив');
  assert.equal(sessions.getSession(root, 's-new'), null, 'и файл не создан');
});

// ── honest failure: GCS down ≠ «такой сессии нет» ─────────────────────────────

test('архив недоступен (GCS падает): честная ошибка, не silent null, и сессия НЕ пересоздаётся', async () => {
  const root = profileRoot('down');
  archiveSessionBody(root, 'down', 's-arch', SESSION_BODY);
  const indexPath = path.join(root, 'sessions.json');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');

  // Injected outage: every blob download throws.
  process.env.GCS_FAKE_FAIL = 'download';
  materialize._resetBlob();
  try {
    await assert.rejects(
      materialize.materializeRunSessions({
        workDir: root, profile: 'down', sessionId: 's-arch', chatId: 777, audience: 'default', threadId: null,
      }),
      (e) => e.code === 'ARCHIVE_UNAVAILABLE',
      'run-путь обязан получить типизированную ошибку, а не null',
    );
    await assert.rejects(
      materialize.readSessionMaybeArchived({ workDir: root, sessionId: 's-arch' }),
      (e) => e.code === 'ARCHIVE_UNAVAILABLE',
      'веб-читатель обязан получить ошибку, а не «session not found»',
    );
    // The one thing the hook exists to prevent: no blind replacement.
    assert.equal(fs.existsSync(path.join(root, 'sessions', 's-arch.json')), false, 'слепая новая сессия не создана');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'индекс не тронут');
    assert.equal(
      sessions.resolveChatSession(root, 's-arch', 777, 'default', null),
      null,
      'резолв по-прежнему пуст — но вызывающий уже получил ошибку и остановился',
    );
  } finally {
    delete process.env.GCS_FAKE_FAIL;
    materialize._resetBlob();
  }
});

test('объект пропал из архива: ARCHIVE_MISSING — тоже ошибка, а не «сессии не было»', async () => {
  const root = profileRoot('gone');
  archiveSessionBody(root, 'gone', 's-arch', SESSION_BODY);
  // The object is not there at all (marker says archived, bucket disagrees).
  fs.rmSync(path.join(GCS, sessionKey('gone', 's-arch')));

  await assert.rejects(
    materialize.materializeRunSessions({
      workDir: root, profile: 'gone', sessionId: 's-arch', chatId: 777, audience: 'default', threadId: null,
    }),
    (e) => e.code === 'ARCHIVE_MISSING',
  );
  await assert.rejects(
    materialize.readSessionMaybeArchived({ workDir: root, sessionId: 's-arch' }),
    (e) => e.code === 'ARCHIVE_MISSING',
    'тихий null здесь читался бы как «диалог никогда не существовал»',
  );
  assert.equal(sessions.getSession(root, 's-arch'), null);
});

test('нет записи в индексе ⇒ null (это действительно «нет такой сессии», не архив)', async () => {
  const root = profileRoot('empty');
  assert.equal(await materialize.readSessionMaybeArchived({ workDir: root, sessionId: 's-nope' }), null);
  const out = await materialize.materializeRunSessions({
    workDir: root, profile: 'empty', sessionId: 's-nope', chatId: 1, audience: 'default', threadId: null,
  });
  assert.deepEqual(out.materialized, []);
  assert.deepEqual(out.checked, ['s-nope'], 'кандидат проверен по индексу');
});

// ── native resume: транскрипт возвращается туда, куда смотрит `claude --resume` ─

test('resume: транскрипт материализуется в слаг КЛОУДА от cwd (не в слаг ключа) и байт-в-байт', async () => {
  const root = profileRoot('resume');
  const cwd = '/home/vova/users/resume/projects/web';
  const content = [
    '{"type":"last-prompt","leafUuid":"d","sessionId":"aaa-bbb-ccc"}',
    JSON.stringify({ type: 'user', cwd, sessionId: 'aaa-bbb-ccc', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', cwd, sessionId: 'aaa-bbb-ccc', message: { role: 'assistant', content: 'ok' } }),
  ].join('\n');
  const { rel } = archiveTranscript(root, 'resume', cwd, 'aaa-bbb-ccc', content);
  assert.equal(fs.existsSync(path.join(root, rel)), false, 'precondition: между ранами транскрипта нет');

  const out = await materialize.materializeTranscriptForResume({
    workDir: root, profile: 'resume', cwd, engineSessionId: 'aaa-bbb-ccc',
  });
  assert.equal(out.status, 'written');
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), content, 'байт-в-байт');
  // The dest directory is CLAUDE's slug (`-` for every non-alnum, leading dash
  // kept); the blob KEY uses slugCwd (dots/underscores kept, edges trimmed).
  // They are different entities and confusing them writes where --resume never looks.
  const destDir = path.basename(path.dirname(path.join(root, rel)));
  assert.equal(destDir, '-home-vova-users-resume-projects-web', 'dest = Claude project slug');
  assert.notEqual(destDir, slugCwd(cwd), 'slug ключа и слаг каталога Клоуда не совпадают');

  // Already local (whatever directory it sits in) → no download at all.
  const exists = await materialize.materializeTranscriptForResume({
    workDir: root, profile: 'resume', cwd, engineSessionId: 'aaa-bbb-ccc',
  });
  assert.equal(exists.status, 'exists');
});

test('resume: объекта нет в архиве ⇒ status missing (идём как раньше), авария GCS ⇒ честная ошибка', async () => {
  const root = profileRoot('resume2');
  const cwd = '/home/vova/users/resume2/projects/web';

  const missing = await materialize.materializeTranscriptForResume({
    workDir: root, profile: 'resume2', cwd, engineSessionId: 'never-archived',
  });
  assert.equal(missing.status, 'missing', 'неarchived-транскрипт не блокирует ран — как до PR-C');

  archiveTranscript(root, 'resume2', cwd, 'u-1', '{"type":"user","cwd":"x"}');
  process.env.GCS_FAKE_FAIL = 'download';
  materialize._resetBlob();
  try {
    await assert.rejects(
      materialize.materializeTranscriptForResume({
        workDir: root, profile: 'resume2', cwd, engineSessionId: 'u-1',
      }),
      (e) => e.code === 'ARCHIVE_UNAVAILABLE',
      'GCS упал — тихий fallback в новую engine-сессию потерял бы контекст',
    );
    assert.equal(
      fs.existsSync(path.join(root, '.agent-home/.claude/projects/-home-vova-users-resume2-projects-web/u-1.jsonl')),
      false,
    );
  } finally {
    delete process.env.GCS_FAKE_FAIL;
    materialize._resetBlob();
  }
});

test('контракт: _runTask материализует транскрипт ДО buildEngineCommand и только для claude', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner', 'index.js'), 'utf8');
  const matAt = src.indexOf('await materializeTranscriptForResume(');
  const cmdAt = src.indexOf('const [engineBin, engineArgs] = buildEngineCommand({');
  assert.ok(matAt > 0 && cmdAt > 0, 'обе точки должны быть в runner');
  assert.ok(matAt < cmdAt, 'materialize транскрипта — до спавна с --resume');
  assert.ok(
    /if \(resumeSessionId && engine === 'claude'\)/.test(src),
    'в M2 архивируются только claude-транскрипты — hook ограничен ими',
  );
  // The admission hook must not move the journal write off the sync path:
  // runTask() journals before returning (test/stop-trace.test.cjs depends on it).
  const start = src.indexOf('async function _runTaskInner(opts) {');
  const journal = src.indexOf('savePendingTask(opts.taskId, {', start);
  const startHook = src.indexOf('const sessionMaterialize = materializeRunSessions({', start);
  const awaitHook = src.indexOf('const materializeErr = await awaitSessionMaterialize();', start);
  assert.ok(startHook > start && startHook < journal, 'хук стартует после профиль-лока, но БЕЗ await — иначе журнал уедет на другой тик');
  assert.ok(!/await materializeRunSessions\(/.test(src.slice(start, journal)), 'до журнала materialize не ждётся');
  assert.ok(awaitHook > journal, 'тело ждём внутри admission-колбэка — до resolveChatSession');
  const runTaskAt = src.indexOf('return await _runTask(opts);', journal);
  assert.ok(awaitHook < runTaskAt, 'и точно ДО первого чтения тела в _runTask');
});

// ── session_search: archived ищется так же, без остатков на диске ─────────────

function searchTool() {
  return require('../src/mcp-skills/tools/05-session.js').tools.session_search;
}

test('session_search находит совпадения в archived-сессии и не оставляет тело на VM', async () => {
  const root = profileRoot('search');
  process.env.AGENT_USER_ID = 'search';
  // Archived dialog with a distinctive phrase.
  archiveSessionBody(root, 'search', 's-arch', SESSION_BODY);
  // A local side session (⚡) the index does not know — must still be searched.
  write(path.join(root, 'sessions', 'qa-local.json'), JSON.stringify({
    id: 'qa-local', topic: 'боковая', messages: [{ role: 'assistant', content: 'готово, отправил отчёт' }],
  }));
  const indexPath = path.join(root, 'sessions.json');
  const indexBefore = fs.readFileSync(indexPath, 'utf8');

  try {
    const res = await searchTool().handler({ pattern: 'ваканс', limit: 10 });
    assert.equal(res.error, undefined, JSON.stringify(res));
    assert.ok(res.matches.some(m => m.sessionId === 's-arch'),
      'archived-сессия должна найтись — результат идентичен неархивной');
    const hit = res.matches.find(m => m.sessionId === 's-arch');
    assert.equal(hit.role, 'user');
    assert.equal(hit.context.next, 'вот шаблон вакансии', 'контекст вокруг совпадения собирается как обычно');

    const local = await searchTool().handler({ pattern: 'отчёт', limit: 10 });
    assert.ok(local.matches.some(m => m.sessionId === 'qa-local'),
      'локальная боковая сессия (не в индексе) тоже находится');

    // Reading must leave NOTHING behind (owner contract: между ранами тел нет).
    assert.equal(fs.existsSync(path.join(root, 'sessions', 's-arch.json')), false,
      'session_search не должен записывать тело сессии на диск');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'индекс не переписан');
  } finally {
    delete process.env.AGENT_USER_ID;
  }
});

test('session_search: GCS упал — явный archiveUnavailable, а не «ничего не найдено»', async () => {
  const root = profileRoot('search-down');
  process.env.AGENT_USER_ID = 'search-down';
  archiveSessionBody(root, 'search-down', 's-arch', SESSION_BODY);

  process.env.GCS_FAKE_FAIL = 'download';
  materialize._resetBlob();
  try {
    const res = await searchTool().handler({ pattern: 'ваканс', limit: 10 });
    assert.equal(res.archiveUnavailable, true, 'тихий пустой результат врал бы владельцу');
    assert.ok(res.archiveError, 'причина обязана быть названа');
    assert.ok(!res.matches.some(m => m.sessionId === 's-arch'), 'недоступная сессия не выдаётся за прочитанную');
  } finally {
    delete process.env.GCS_FAKE_FAIL;
    materialize._resetBlob();
    delete process.env.AGENT_USER_ID;
  }
});

// ── web reader: тело приходит в память и НЕ остаётся на VM ────────────────────

test('getSessionFor отдаёт archived-сессию из буфера и не пишет файл на диск', async () => {
  try {
    const { userWorkDir } = require('../src/data-paths');
    const root = userWorkDir('webread');
    fs.mkdirSync(root, { recursive: true });
    archiveSessionBody(root, 'webread', 's-arch', SESSION_BODY);
    const { getSessionFor } = require('../src/web-routes');

    const got = await getSessionFor('webread', 's-arch');
    assert.equal(got.id, 's-arch');
    assert.equal(got.messages.length, 2, 'сообщения отданы как обычно');
    assert.equal(fs.existsSync(path.join(root, 'sessions', 's-arch.json')), false,
      'чтение из веба не оставляет тело на VM — контракт владельца');

    assert.equal(await getSessionFor('webread', 's-nope'), null, 'нет записи в индексе → ровно null (404)');

    // Outage: an honest error the route maps to 503, never a 404 «deleted».
    process.env.GCS_FAKE_FAIL = 'download';
    materialize._resetBlob();
    await assert.rejects(getSessionFor('webread', 's-arch'), (e) => e.code === 'ARCHIVE_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(root, 'sessions', 's-arch.json')), false, 'и после ошибки файл не появился');
  } finally {
    delete process.env.GCS_FAKE_FAIL;
    materialize._resetBlob();
  }
});

// ── chat-history warm-up: топ-N последних archived при старте рана ────────────

test('warm-up материализует топ-5 последних archived, старые и живые пропускает, сбои собирает в failed', async () => {
  const root = profileRoot('warm');
  const now = Date.now();
  const index = [];
  for (let i = 0; i < 7; i++) {
    const id = `s-w${i}`;
    archiveSessionBody(root, 'warm', id, { ...SESSION_BODY, id },
      { indexExtra: { lastAt: now - i * 60_000 } });
    index.push({ id });
  }
  // One archived record older than the 24h window — out of scope for the block.
  archiveSessionBody(root, 'warm', 's-old', { ...SESSION_BODY, id: 's-old' },
    { indexExtra: { lastAt: now - 48 * 3600_000 } });
  // One non-archived (local) record — must not be touched.
  sessions.createSession(root, { task: 'живая', id: 's-live', chatId: 1 });

  const out = await materialize.materializeRecentArchivedSessions({
    workDir: root, profile: 'warm', limit: 5, now,
  });
  assert.equal(out.materialized.length, 5, 'ровно топ-5 по recency');
  assert.ok(out.materialized.every(id => /^s-w[0-6]$/.test(id)), out.materialized.join(','));
  assert.equal(fs.existsSync(path.join(root, 'sessions', 's-old.json')), false, 'старше окна не трогаем');
  for (const id of out.materialized) {
    assert.ok(fs.existsSync(path.join(root, 'sessions', `${id}.json`)), `${id} должна стать локальной`);
  }

  // Failure never throws out of the warm-up — it reports and the run continues.
  process.env.GCS_FAKE_FAIL = 'download';
  materialize._resetBlob();
  try {
    fs.rmSync(path.join(root, 'sessions', 's-w0.json'));
    const failed = await materialize.materializeRecentArchivedSessions({ workDir: root, profile: 'warm', limit: 5, now });
    assert.ok(failed.failed.length >= 1, 'сбой попадает в failed, а не роняет ран');
    assert.equal(failed.failed[0].code, 'ARCHIVE_UNAVAILABLE');
  } finally {
    delete process.env.GCS_FAKE_FAIL;
    materialize._resetBlob();
  }
});

test('sessionIdsForSearch: индекс (включая archived) + локальные боковые, без current-session и digest', () => {
  const root = profileRoot('ids');
  archiveSessionBody(root, 'ids', 's-arch', SESSION_BODY);
  write(path.join(root, 'sessions', 'qa-side.json'), JSON.stringify({ id: 'qa-side', messages: [] }));
  write(path.join(root, 'sessions', 'current-session-1.json'), JSON.stringify({ id: 'x', lastAt: 1 }));
  write(path.join(root, 'sessions', 's-arch.digest.json'), JSON.stringify({ key: 'k' }));

  const ids = materialize.sessionIdsForSearch(root);
  assert.ok(ids.includes('s-arch'), 'archived обязан входить в выборку');
  assert.ok(ids.includes('qa-side'), 'неиндексированная боковая сессия входит');
  assert.ok(!ids.includes('x'), 'pointer-файл — не сессия');
  assert.ok(!ids.some(i => i.endsWith('.digest')), 'кэш дайджеста не сессия');
  assert.equal(ids[0], 's-arch', 'порядок — по recency из индекса');
});

// ── blob store reuse: без реального GCS ни в одном из путей ───────────────────

test('контракт: все читатели зовут один ленивый blob-store (ADC не читается при require)', () => {
  const files = ['src/session-materialize.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/require\('@google-cloud\/storage'\)/.test(src), `${f}: клиент поднимается только лениво через session-archive`);
    assert.ok(/archive\.createBlobStore\(\)/.test(src), `${f}: store создаётся через session-archive`);
  }
  // The fake must be reachable: GCS_FAKE_DIR was set for this whole file and no
  // test above touched a real bucket (proves the file-backed backend is used).
  const probe = createSessionBlobStore({ bucket: createFileBackedBucket(GCS, {}) });
  assert.equal(typeof probe.upload, 'function');
  assert.equal(typeof probe.download, 'function');
});
