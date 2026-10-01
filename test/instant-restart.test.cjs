// A restart must be instant and silent: no pause gate, no status chatter, tasks cut off by
// the restart are re-run by the next process, and the user hears only about failures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const serverSrc = read('src/server.js');

test('no pause/drain gate or restart chatter survives in the runtime', () => {
  for (const f of ['src/server.js', 'src/runner/index.js', 'src/admission-status.js']) {
    const src = read(f);
    for (const re of [/maintenance\.(paused|acquire|pause|request|beginRecovery)/, /После рестарта проверю актуальность/,
                      /Рестарт завершён/, /waitForIdle|currentExecution/]) {
      assert.ok(!re.test(src), `${f} must not match ${re}`);
    }
  }
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src/maintenance.js')), false);
});

test('/maintenance still advertises durableIngress: 1 — the bot outbox holds every task without it', () => {
  const start = serverSrc.indexOf("url.pathname === '/maintenance'");
  const body = serverSrc.slice(start, serverSrc.indexOf("'/restart/activity'", start));
  assert.match(body, /durableIngress: 1/);
  assert.match(body, /paused: false/);
});

test('SIGTERM handler flags the restart and exits without draining', () => {
  const start = serverSrc.indexOf('let shuttingDown = false;');
  const end = serverSrc.indexOf("process.once('SIGINT'", start);
  const body = serverSrc.slice(start, end);
  assert.match(body, /interruptForRestart\(\)/);
  assert.match(body, /process\.exit\(0\)/);
  // No drain: the handler must not pause admission or wait on active tasks.
  assert.doesNotMatch(body, /drain|paused|maintenance\.pause/);
});

const { isTaskResumable, resumeSinkOf, resolvePendingWorkDir } = require('../src/pending-task-resume');

function resumeHarness({ admission = {}, pending, now = Date.now(), retryDelayMs = () => 0, engineSessionIds = {}, secrets = { BOT_TOKEN: 'tok' } }) {
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  const end = serverSrc.indexOf('async function main()', start);
  const calls = [], runs = [], cleared = [], delays = [], resumeKinds = [], releases = [];
  const sandbox = {
    ...require('./helpers/resume-admission.cjs')(admission),
    taskDelivery: require('../src/bot-delivery').taskDelivery,
    path, console: { log() {}, error() {}, warn() {} }, Date: class extends Date { static now() { return now; } },
    BASE_USERS_DIR: '/users', AbortSignal, Promise,
    setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; },
    process: { env: {} }, isTaskResumable, resumeSinkOf, resolvePendingWorkDir, MAX_RESUME_ATTEMPTS: 3,
    getRetryDelayMs: attempt => retryDelayMs(attempt),
    getPendingTasks: () => pending,
    clearPendingTask: id => cleared.push(id),
    // Journal hygiene (#1239): drop pings, don't resume them.
    isNonTaskMessage: require('../src/resume-hygiene').isNonTaskMessage,
    // Resume metric (#1240): capture kind/engine so tests can assert it.
    recordResume: (kind, engine) => resumeKinds.push({ kind, engine }),
    // Native-resume id lookup (#1234). Default: none on disk → fallback path (the pre-#1234
    // behavior these tests were written for). Tests that exercise native resume pass ids here.
    getEngineSessionId: (workDir, sessionId, engine) => engineSessionIds[engine] || null,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return {}; },
    runTask: opts => { runs.push(opts); return Promise.resolve(); },
  };
  // releaseChat() calls require('./gateway-callback') from inside the sandbox
  // slice; expose a stub so the harness needs no real module resolution.
  const webCloses = [], durableReplies = [];
  sandbox.require = (m) => {
    if (m === './web-routes') return { completeWebMutation: (...a) => webCloses.push(a) };
    if (m === './gtd-controller') return {
      reconcileOrphanedRunning: () => 0,
      resumeDurableReply: async (sink, reply) => { durableReplies.push({ sink, reply }); },
      resumeDurableCrash: async () => {},
      settleResumedGtd: () => {},
    };
    return { notifyRunFinished: async (p) => { releases.push(p); return true; } };
  };
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, end)}; this.resume = resumePendingTasks;`, sandbox);
  return { resume: () => sandbox.resume(secrets), calls, runs, cleared, delays, resumeKinds, releases, now, webCloses, durableReplies };
}

const task = (over = {}) => ({ taskId: 'alice-1', username: 'alice', userId: 42, task: 'work', initialMsgId: 7,
  startedAt: Date.now() - 30_000, sessionId: 's1', engine: 'claude', ...over });

test('interrupted Claude task is re-run silently and its old journal entry is dropped', async () => {
  const h = resumeHarness({ pending: [task()] });
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].sessionId, 's1');
  assert.equal(h.runs[0].initialMsgId, 7);
  assert.equal(h.runs[0].resumedAfterRestart, true, 'runner must know this attempt followed a restart');
  assert.equal(h.runs[0].resumeAttempts, 1);
  assert.deepEqual(h.calls, [], 'no Telegram message on a successful resume');
  assert.deepEqual(h.cleared, ['alice-1'], 'old entry cleared so a second restart does not re-run it');
});

test('a task whose resume count is past MAX_RESUME_ATTEMPTS is not resumed again', async () => {
  const h = resumeHarness({ pending: [task({ resumeAttempts: 4 })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'must not fire another resume attempt');
  assert.deepEqual(h.cleared, ['alice-1']);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /сбой сервера/);
});

test('codex/opencode tasks resume the same way claude does, on their own engine', async () => {
  const h = resumeHarness({ pending: [task({ engine: 'codex' })] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'codex must resume, not dead-end on "no resume capability"');
  assert.equal(h.runs[0].engine, 'codex', 'resume must keep the original engine, not fall back to claude');
  assert.equal(h.runs[0].resumedAfterRestart, true);
  assert.deepEqual(h.calls, [], 'no Telegram message on a successful resume');
  assert.deepEqual(h.cleared, ['alice-1']);
});

test('opencode resume also honors the MAX_RESUME_ATTEMPTS guard (no special-cased dead-end)', async () => {
  const h = resumeHarness({ pending: [task({ engine: 'opencode', resumeAttempts: 4 })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'must not fire another resume attempt');
  assert.deepEqual(h.cleared, ['alice-1']);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].body.text, /сбой сервера/);
});

test('resume waits out the shared backoff schedule before firing, per attempt number', async () => {
  const seen = [];
  const h = resumeHarness({ pending: [task({ resumeAttempts: 2 })], retryDelayMs: attempt => { seen.push(attempt); return 180_000; } });
  await h.resume();
  assert.deepEqual(seen, [2], 'the journaled attempt number drives the backoff');
  assert.ok(h.delays.includes(180_000), 'the computed backoff delay is actually passed to setTimeout');
  assert.equal(h.runs.length, 1, 'fake setTimeout still runs the callback synchronously in tests');
});

// The attempt counter is owned by the runner, which advances it only on a GENUINE resume failure.
// A restart that kills an in-flight resume must NOT advance it — otherwise a deploy flurry
// (34 restarts/day) burns the whole budget on interruptions and a perfectly resumable task
// "gives up" without a single real failure. Live prod 2026-09-24 showed exactly this.
test('a resume interrupted by another restart keeps its attempt number (no budget burn)', async () => {
  const h = resumeHarness({ pending: [task({ resumedAfterRestart: true, resumeAttempts: 3 })] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'an interrupted 3rd attempt is retried, not abandoned');
  assert.equal(h.runs[0].resumeAttempts, 3, 'attempt number is reused, not incremented on boot');
  assert.deepEqual(h.calls, [], 'no give-up notice for an interrupted attempt');
  assert.deepEqual(h.cleared, ['alice-1']);
});

// forceClaude callbacks («🔎 Разобраться подробнее» and other no-task taps) journal an empty
// task; the runner re-derives it from the session. They must resume like any other task instead
// of producing a spurious "Задача была прервана перезапуском и не возобновилась. Повтори запрос."
test('a forceClaude callback with no task text resumes from its session, not a bogus notice', async () => {
  const h = resumeHarness({ pending: [task({ task: '', forceClaude: true, mode: 'deep' })] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'the callback must be resumed, not abandoned');
  assert.equal(h.runs[0].sessionId, 's1');
  assert.equal(h.runs[0].forceClaude, true, 'forceClaude must survive so the runner re-derives the task');
  assert.match(h.runs[0].task, /ПРОДОЛЖЕНИЕ/, 'an empty task is replaced by a continuation prompt');
  assert.deepEqual(h.calls, [], 'no "не возобновилась" notice');
  assert.deepEqual(h.cleared, ['alice-1']);
});

test('a resumed task that fails to start tells the user', async () => {
  const h = resumeHarness({ pending: [task()] });
  const start = serverSrc.indexOf('const RESUME_WINDOW_MS');
  // Same harness but runTask rejects.
  const pending = [task()];
  const calls = [];
  const sandbox = {
    ...require('./helpers/resume-admission.cjs')(),
    taskDelivery: require('../src/bot-delivery').taskDelivery,
    path, console: { log() {}, error() {}, warn() {} }, BASE_USERS_DIR: '/users', AbortSignal, Promise,
    setTimeout: fn => { fn(); return 0; }, process: { env: {} }, isTaskResumable, resumeSinkOf, resolvePendingWorkDir, MAX_RESUME_ATTEMPTS: 3,
    getRetryDelayMs: () => 0,
    getPendingTasks: () => pending, clearPendingTask() {},
    getEngineSessionId: () => null,
    isNonTaskMessage: require('../src/resume-hygiene').isNonTaskMessage,
    recordResume: () => {},
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return {}; },
    runTask: () => Promise.reject(new Error('boom')),
  };
  sandbox.require = () => ({ notifyRunFinished: async () => true });
  vm.createContext(sandbox);
  vm.runInContext(`${serverSrc.slice(start, serverSrc.indexOf('async function main()', start))}; this.resume = resumePendingTasks;`, sandbox);
  await sandbox.resume({ BOT_TOKEN: 'tok' });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Не удалось продолжить/);
  void h;
});

test('stale entries are cleared; recent-but-expired ones notify, very old ones stay quiet', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'recent-expired', startedAt: Date.now() - 3 * 3600_000 }),  // past 2h resume window, within 6h notice window
    task({ taskId: 'ancient', startedAt: Date.now() - 7 * 3600_000 }),         // past 6h notice window
    task({ taskId: 'gtd', startedAt: Date.now() - 3 * 3600_000, internalGtd: true }),
  ] });
  await h.resume();
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.cleared, ['recent-expired', 'ancient', 'gtd']);
  assert.equal(h.calls.length, 1, 'only the recent user task is announced');
  assert.match(h.calls[0].body.text, /не возобновилась/);
});

// ── Gateway release on restart (epic #1527 follow-up) ──────────────────────────────────────
// The restart kills the run's own run-finished push, and resumePendingTasks is the only
// component that knows the task is never coming back. Without these releases the chat stays
// `busy` on the gateway and «▶️ Запустить агента» answers «уже идёт прогон» after every deploy.

test('a stale (never-resumed) task releases its chat on the gateway', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'stale-1', userId: -5578467476, startedAt: Date.now() - 3 * 3600_000 }),
  ] });
  await h.resume();
  assert.equal(h.runs.length, 0);
  assert.equal(h.releases.length, 1, 'the chat must be released, not left busy');
  assert.equal(h.releases[0].chatId, -5578467476, 'negative group id delivered (#1534)');
});

test('a give-up after MAX_RESUME_ATTEMPTS releases its chat', async () => {
  const h = resumeHarness({ pending: [task({ taskId: 'giveup-1', userId: -5039573935, resumeAttempts: 4 })] });
  await h.resume();
  assert.equal(h.runs.length, 0);
  assert.equal(h.releases.length, 1);
  assert.equal(h.releases[0].chatId, -5039573935);
});

test('internal GTD turns never push a gateway release (no user chat hold)', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'gtd-2', userId: -5039573935, startedAt: Date.now() - 3 * 3600_000, internalGtd: true }),
  ] });
  await h.resume();
  assert.equal(h.releases.length, 0);
});

test('a natively-resumed task does NOT release the chat — the run owns the hold', async () => {
  const h = resumeHarness({ pending: [task({ taskId: 'live-1', userId: -5578467476 })], engineSessionIds: { claude: 'sid' } });
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.releases.length, 0, 'a live re-run keeps busy until its own run-finished');
});

// ── Native resume (#1234 Sub-2) — degradation guards ───────────────────────────────────────
// These exist so a refactor of resumePendingTasks cannot silently drop native resume back to a
// lossy context rebuild (invisible at runtime — it "works", just badly).

test('native resume: known engine session id → resumeSessionId passed + a short continuation prompt', async () => {
  const h = resumeHarness({ pending: [task()], engineSessionIds: { claude: 'sid-from-disk' } });
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].resumeSessionId, 'sid-from-disk', 'the engine session id must be handed to the runner');
  assert.match(h.runs[0].task, /ПРОДОЛЖЕНИЕ/, 'native resume sends a continuation prompt, not the replayed task');
  assert.notEqual(h.runs[0].task, 'work', 'original task must not be replayed on a native resume');
  assert.deepEqual(h.calls, [], 'still silent on success');
  assert.deepEqual(h.resumeKinds, [{ kind: 'native', engine: 'claude' }], 'metric records a native resume (#1240)');
});

test('native resume: journal id wins over the durable session record', async () => {
  const h = resumeHarness({
    pending: [task({ engineSessionId: 'sid-from-journal' })],
    engineSessionIds: { claude: 'sid-from-disk' },
  });
  await h.resume();
  assert.equal(h.runs[0].resumeSessionId, 'sid-from-journal', 'the freshest id (journal, written mid-run) must win');
});

test('fallback: no engine session id anywhere → null resumeSessionId + original task replayed', async () => {
  const h = resumeHarness({ pending: [task()] }); // engineSessionIds defaults to {}
  await h.resume();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].resumeSessionId, null, 'no id → no --resume (fresh run, pre-#1234 behavior)');
  assert.equal(h.runs[0].task, 'work', 'fallback replays the original task');
  assert.deepEqual(h.resumeKinds, [{ kind: 'fallback', engine: 'claude' }], 'metric records a fallback (#1240)');
});

test('native resume: claude, codex and opencode are all wired', async () => {
  const hc = resumeHarness({ pending: [task({ engine: 'codex' })], engineSessionIds: { codex: 'thr-x' } });
  await hc.resume();
  assert.equal(hc.runs[0].resumeSessionId, 'thr-x', 'codex native resume must be wired');
  assert.equal(hc.runs[0].engine, 'codex');

  const ho = resumeHarness({ pending: [task({ engine: 'opencode' })], engineSessionIds: { opencode: 'ses-x' } });
  await ho.resume();
  assert.equal(ho.runs[0].resumeSessionId, 'ses-x', 'opencode native resume must be wired (Sub-4)');
  assert.equal(ho.runs[0].engine, 'opencode');
});

// ── Journal hygiene (#1239) — degradation guards ───────────────────────────────────────────
test('a ping journaled at restart time is dropped, not resumed as a task', async () => {
  const h = resumeHarness({ pending: [task({ task: '[Сообщение 1]\nдвижется?' })] });
  await h.resume();
  assert.equal(h.runs.length, 0, 'a ping must never be replayed to the engine');
  assert.deepEqual(h.cleared, ['alice-1'], 'the non-task journal entry is dropped');
  assert.deepEqual(h.calls, [], 'dropping a ping is silent (re-pinging is trivial)');
});

test('a real task alongside pings is still resumed', async () => {
  const h = resumeHarness({ pending: [
    task({ taskId: 'ping', task: 'упало?' }),
    task({ taskId: 'real', task: 'сделай отчёт по продажам за неделю' }),
  ] });
  await h.resume();
  assert.equal(h.runs.length, 1, 'exactly the real task resumes');
  assert.equal(h.runs[0].task, 'сделай отчёт по продажам за неделю');
  assert.ok(h.cleared.includes('ping'), 'the ping entry is dropped');
  assert.ok(h.cleared.includes('real'), 'the resumed real task entry is cleared after handoff (as before)');
});

test('restart retains recruiter audience and failure notices never use the classic bot',async()=>{
 const secrets={BOT_TOKEN:'classic',RECRUITER_BOT_TOKEN:'recruiter'};
 const h=resumeHarness({pending:[task({audience:'recruiter'})],secrets});await h.resume();
 assert.equal(h.runs[0].user.audience,'recruiter');
 const failure=resumeHarness({pending:[task({audience:'recruiter',resumeAttempts:4})],secrets});await failure.resume();
 assert.equal(failure.calls.length,1);assert.match(failure.calls[0].url,/botrecruiter\//);
 const missing=resumeHarness({pending:[task({audience:'recruiter',resumeAttempts:4})]});await missing.resume();
 assert.equal(missing.calls.length,0);
});

test('restart retains freelance audience (3rd bot, issue #1302) and failure notices never use the classic bot',async()=>{
 const secrets={BOT_TOKEN:'classic',FREELANCE_BOT_TOKEN:'freelance'};
 const h=resumeHarness({pending:[task({audience:'freelance'})],secrets});await h.resume();
 assert.equal(h.runs[0].user.audience,'freelance');
 const failure=resumeHarness({pending:[task({audience:'freelance',resumeAttempts:4})],secrets});await failure.resume();
 assert.equal(failure.calls.length,1);assert.match(failure.calls[0].url,/botfreelance\//);
 // Missing FREELANCE_BOT_TOKEN: the pending record is retained (still cleared like any
 // terminal resume outcome above), but never silently falls back to the classic bot —
 // no Telegram call is made at all, matching the recruiter case above.
 const missing=resumeHarness({pending:[task({audience:'freelance',resumeAttempts:4})]});await missing.resume();
 assert.equal(missing.calls.length,0);
});

// Epic #1365 CH-08: recovery must not mint a new request identity.
test('restart-resume carries the original rootTaskId and requestId into the new attempt', async () => {
  const h = resumeHarness({ pending: [task({ taskId: 'alice-req9', requestId: 'req9' })] });
  await h.resume();
  assert.equal(h.runs[0].rootTaskId, 'alice-req9');
  assert.equal(h.runs[0].requestId, 'req9');
  const h2 = resumeHarness({ pending: [task({ taskId: 'alice-resume-1', rootTaskId: 'alice-req9', requestId: 'req9' })] });
  await h2.resume();
  assert.equal(h2.runs[0].rootTaskId, 'alice-req9', 'second restart keeps the FIRST id, not the resume id');
});

// #1671 — resume is not Telegram-only.
test('web task resumes WITHOUT a bot token and closes its receipt when done', async () => {
  const h = resumeHarness({ secrets: {}, runTaskReply: 'ok', pending: [task({ taskId: 'alice-web-r1', userId: 0,
    resumeSink: { kind: 'web', username: 'alice', requestId: 'r1' } })] });
  await h.resume();
  await new Promise(r => setImmediate(r));
  assert.equal(h.runs.length, 1, 'web task was resumed');
  assert.equal(typeof h.runs[0].outputCallback, 'function', 'resumed web run never streams to Telegram');
  assert.deepEqual(h.webCloses.map(a => [a[0], a[1], a[2].state]), [['alice', 'r1', 'done']]);
  assert.equal(h.calls.length, 0, 'no Telegram message for a web task');
});

test('durable plan step resumes in its engine session and its reply settles the step', async () => {
  const sink = { kind: 'durable', taskId: 't1', itemId: 'i1', executionId: 'e1', profileId: 'alice' };
  const h = resumeHarness({ secrets: {}, pending: [task({ taskId: 'durable-alice-i1-1', userId: null, internalGtd: true,
    resumeSink: sink, engine: 'opencode', engineSessionId: 'ses_1', ocProfile: 'free', ocRole: 'build' })] });
  await h.resume();
  await new Promise(r => setImmediate(r));
  assert.equal(h.runs.length, 1, 'durable step was resumed');
  assert.equal(h.runs[0].resumeSessionId, 'ses_1', 'same engine session');
  assert.deepEqual([h.runs[0].ocProfile, h.runs[0].ocRole], ['free', 'build'], 'same engine profile/role');
  assert.deepEqual(h.durableReplies.map(d => d.sink), [sink]);
});

for (const profileEngine of ['opencode', 'codex']) {
  test(`suspended Claude resumes on ${profileEngine} without reusing the Claude session`, async () => {
    const h = resumeHarness({
      admission: { blocked: true, profileEngine },
      pending: [task({ engine: 'claude', engineSessionId: 'claude-private-id' })],
      engineSessionIds: { [profileEngine]: 'target-session-id' },
    });
    await h.resume();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].engine, profileEngine);
    assert.equal(h.runs[0].resumeSessionId, 'target-session-id');
    assert.equal(h.calls.length, 0, 'suspension is silent');
  });
}

test('suspended Claude without a target session replays the task instead of a foreign native id', async () => {
  const h = resumeHarness({ admission: { blocked: true },
    pending: [task({ engine: 'claude', engineSessionId: 'claude-private-id' })] });
  await h.resume();
  assert.equal(h.runs[0].engine, 'opencode');
  assert.equal(h.runs[0].resumeSessionId, null);
  assert.equal(h.runs[0].task, 'work');
});

test('legacy journal without an engine never defaults to Claude', async () => {
  const h = resumeHarness({ pending: [task({ engine: undefined, engineSessionId: 'unknown-engine-id' })] });
  await h.resume();
  assert.equal(h.runs[0].engine, 'opencode');
  assert.equal(h.runs[0].resumeSessionId, null);
});
