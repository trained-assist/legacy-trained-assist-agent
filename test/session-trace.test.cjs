'use strict';
// «Полный лог» (web trace) — where the reader looks for the engine's SQLite db.
//
// Since the isolation architecture the engine runs with HOME=<workDir>/.agent-home
// (agent-isolation.engineHomeDir), so an isolated session's parts are written to
// the PROFILE's engine home, not the service home. Reading only the service home
// (the pre-migration default) made the web UI's «Полный лог» button answer
// "Лог процесса недоступен для этой сессии" while the data sat on disk — this file
// pins both homes so a future path refactor cannot silently break it again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { readTrace, candidateDbPaths, setDbPath, dbPath } = require('../src/session-trace');

// The reader consults this env at call time; a developer/CI shell exporting it
// would silently replace every candidate under test.
delete process.env.OPENCODE_DB_PATH;

const ENGINE_DB_REL = path.join('.local', 'share', 'opencode', 'opencode.db');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-')); }

/** Build an opencode-shaped db holding one session and its parts. */
function makeDb(file, sessionId, parts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);'
    + 'CREATE TABLE part (session_id TEXT, data TEXT, time_created INTEGER);');
  db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId);
  const ins = db.prepare('INSERT INTO part (session_id, data, time_created) VALUES (?, ?, ?)');
  (parts || []).forEach((p, i) => ins.run(sessionId, JSON.stringify(p), p.time?.created ?? i));
  db.close();
}

function profileDb(workDir) { return path.join(workDir, '.agent-home', ENGINE_DB_REL); }

const PARTS = [
  { type: 'text', text: 'готово', time: { created: 1000 } },
  { type: 'tool', tool: 'Bash', state: { status: 'completed', input: 'ls', output: 'ok' }, time: { created: 2000 } },
];

test('isolated run: reads the profile engine home, not the service home', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  const serviceHomeDb = path.join(root, 'service', ENGINE_DB_REL);
  makeDb(profileDb(workDir), 'ses_profile', PARTS);
  makeDb(serviceHomeDb, 'ses_other_profile', []); // stale service-home db: right file, wrong session
  setDbPath(serviceHomeDb);

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_profile' }, messages: [] });
  assert.equal(r.ok, true, `expected a trace from the profile engine home, got ${r.error}`);
  assert.equal(r.source, 'engine-db');
  assert.equal(r.reasoning, true);
  assert.equal(r.engine, 'opencode');
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].kind, 'text');
  assert.equal(r.events[1].tool, 'Bash');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pre-isolation session: falls back to the legacy service-home db', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile'); // no .agent-home at all
  const serviceHomeDb = path.join(root, 'service', ENGINE_DB_REL);
  makeDb(serviceHomeDb, 'ses_legacy', PARTS);
  setDbPath(serviceHomeDb);

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_legacy' }, messages: [] });
  assert.equal(r.ok, true, `expected the legacy db to serve a pre-isolation session, got ${r.error}`);
  assert.equal(r.events.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('both homes exist but neither knows the session → session-not-found', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  const serviceHomeDb = path.join(root, 'service', ENGINE_DB_REL);
  makeDb(profileDb(workDir), 'ses_a', []);
  makeDb(serviceHomeDb, 'ses_b', []);
  setDbPath(serviceHomeDb);

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_gone' }, messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'session-not-found');
  fs.rmSync(root, { recursive: true, force: true });
});

test('no db anywhere → db-unavailable', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  fs.mkdirSync(workDir, { recursive: true });
  setDbPath(path.join(root, 'service', ENGINE_DB_REL)); // does not exist

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_x' }, messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'db-unavailable');
  fs.rmSync(root, { recursive: true, force: true });
});

test('claude-only session still reports no-opencode-session (UI wording unchanged)', () => {
  const root = tmp();
  setDbPath(path.join(root, 'service', ENGINE_DB_REL));
  const r = readTrace(path.join(root, 'profile'), { engineSessions: { claude: 'af7111d2' }, messages: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-opencode-session');
  assert.equal(r.engine, 'claude');
  fs.rmSync(root, { recursive: true, force: true });
});

test('events are bucketed into the session message windows', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  makeDb(profileDb(workDir), 'ses_bucket', [
    { type: 'text', text: 'первый', time: { created: 500 } },
    { type: 'text', text: 'второй', time: { created: 1500 } },
  ]);
  setDbPath(path.join(root, 'service', ENGINE_DB_REL));

  const r = readTrace(workDir, {
    engineSessions: { opencode: 'ses_bucket' },
    messages: [{ at: 1000 }, { at: 2000 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.byMessage.length, 2);
  assert.equal(r.byMessage[0].length, 1, 'event before the first message boundary lands in window 0');
  assert.equal(r.byMessage[1].length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('candidateDbPaths: profile engine home first, legacy second; env pin wins alone', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  const legacy = path.join(root, 'service', ENGINE_DB_REL);
  makeDb(profileDb(workDir), 'ses_a', []);
  setDbPath(legacy);

  const c = candidateDbPaths(workDir);
  assert.deepEqual(c, [profileDb(workDir), legacy], 'profile engine home must be consulted before the service home');
  assert.deepEqual(candidateDbPaths(null), [legacy], 'no workDir → legacy only');

  process.env.OPENCODE_DB_PATH = path.join(root, 'pinned.db');
  try {
    assert.deepEqual(candidateDbPaths(workDir), [path.join(root, 'pinned.db')],
      'an explicit OPENCODE_DB_PATH pin replaces every candidate');
  } finally {
    delete process.env.OPENCODE_DB_PATH;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('setDbPath keeps its meaning: dbPath() reports the legacy default it replaced', () => {
  const root = tmp();
  const legacy = path.join(root, 'service', ENGINE_DB_REL);
  setDbPath(legacy);
  assert.equal(dbPath(), legacy);
  fs.rmSync(root, { recursive: true, force: true });
});

// #1893: the engine db was rotated/recreated — the durable store answers instead.
test('engine db lost the session → falls back to the durable store (source:store)', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  makeDb(profileDb(workDir), 'ses_other', []); // recreated db: knows nothing of ses_s
  setDbPath(path.join(root, 'service', ENGINE_DB_REL));
  const store = require('../src/session-trace-store');
  store.appendEvent(workDir, 'opencode', 'ses_s', { id: 'p1', type: 'text', text: 'hi', time: { created: 5 } });

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_s' }, messages: [] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, 'store');
  assert.equal(r.reasoning, false);
  assert.deepEqual(r.events.map(e => e.text), ['hi']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('engine db has rows → engine db wins, store is not merged in', () => {
  const root = tmp();
  const workDir = path.join(root, 'profile');
  makeDb(profileDb(workDir), 'ses_both', PARTS);
  setDbPath(path.join(root, 'service', ENGINE_DB_REL));
  require('../src/session-trace-store').appendEvent(workDir, 'opencode', 'ses_both', { id: 'extra', type: 'text', text: 'store-only', time: { created: 1 } });

  const r = readTrace(workDir, { engineSessions: { opencode: 'ses_both' }, messages: [] });
  assert.equal(r.source, 'engine-db');
  assert.ok(!r.events.some(e => e.text === 'store-only'));
  fs.rmSync(root, { recursive: true, force: true });
});
