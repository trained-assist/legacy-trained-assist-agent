const G = require('../src/gtd-controller.js');
const os = require('os'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

(async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-'));

  // 1. durable roundtrip: write → read → list → clear
  const rec = {
    sessionId: 's-1', chatId: '42', username: 'u', createdAt: 1, dueAt: 1,
    etaMinutes: 60, iterations: 0, maxIterations: 3, status: 'open',
    originalTask: 'доведи до прода', lastFiredAt: null, closedReason: null,
  };
  ok(G.writeGtd(wd, rec) === true, 'writeGtd ok');
  const back = G.readGtd(wd, 's-1');
  ok(back && back.sessionId === 's-1' && back.status === 'open', 'readGtd roundtrip');
  ok(G.listGtd(wd).length === 1, 'listGtd sees one');
  G.clearGtd(wd, 's-1');
  ok(G.readGtd(wd, 's-1') === null && G.listGtd(wd).length === 0, 'clearGtd removes');

  // 2. guards on empty/missing
  ok(G.readGtd(wd, 'nope') === null, 'missing->null');
  ok((await G.maybeSchedule({ workDir: wd, sessionId: null, task: 'x' })) === null, 'maybeSchedule guards empty id');

  // 3. intent pre-gate: no control hint / too short → wanted:false WITHOUT calling LLM
  ok((await G.detectIntent('', { apiKey: 'k' })).wanted === false, 'empty task rejected');
  ok((await G.detectIntent('просто сделай отчёт по неделе', { apiKey: 'k' })).wanted === false, 'no control hint rejected');

  // 4. reopen message carries GTD semantics: markers + attempt count
  const msg = G.buildReopenMessage({ iterations: 2, maxIterations: 3, originalTask: 'деплой' });
  ok(/GTD:\s*done/.test(msg) && /GTD:\s*continue/.test(msg), 'reopen has GTD markers (not FOLLOWUP)');
  ok(/итерация 2 из 3/.test(msg), 'reopen shows iteration count');
  ok(!/FOLLOWUP/i.test(msg), 'no legacy FOLLOWUP marker');

  // 5. runDue terminal: injected runTask replies "GTD: done" → closes done
  const wd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd2-'));
  const userDir = path.join(wd2, 'u');
  fs.mkdirSync(userDir, { recursive: true });
  G.writeGtd(userDir, { ...rec, dueAt: 100 });
  await G.runDue({
    secrets: {}, baseUsersDir: wd2, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => 'сделано, всё в проде. GTD: done',
  });
  const closed = G.readGtd(userDir, 's-1');
  ok(closed && closed.status === 'closed' && closed.closedReason === 'done', 'runDue closes on GTD: done');

  // 6. re-entrancy guard: task running → not fired, stays open
  const wd3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd3-'));
  const userDir3 = path.join(wd3, 'u');
  fs.mkdirSync(userDir3, { recursive: true });
  G.writeGtd(userDir3, { ...rec, dueAt: 100 });
  let called = false;
  await G.runDue({
    secrets: {}, baseUsersDir: wd3, now: 200,
    isTaskRunning: () => true,
    getSession: () => ({ ownerChatId: '42' }),
    runTask: async () => { called = true; return 'x'; },
  });
  const stillOpen = G.readGtd(userDir3, 's-1');
  ok(!called && stillOpen.status === 'open' && stillOpen.iterations === 0, 're-entrancy: skip while running');

  // Restart cancellation/confirmation hold must not create a new GTD execution.
  await G.runDue({secrets:{},baseUsersDir:wd3,now:200,isTaskRunning:()=>false,
    canRunSession:()=>false,getSession:()=>({ownerChatId:'42'}),runTask:async()=>{called=true;}});
  ok(!called && G.readGtd(userDir3,'s-1').iterations===0,'restart session hold blocks GTD without consuming an iteration');

  // 7. checklist.md: readChecklist parses goal + items, checklistSummary lists unchecked
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-proj-'));
  fs.writeFileSync(path.join(projDir, 'checklist.md'), [
    'Goal: довести фичу X до прода',
    '- [x] написать код',
    '- [ ] написать тесты',
    '- [ ] задеплоить',
  ].join('\n'));
  const cl = G.readChecklist(projDir);
  ok(cl && cl.goal === 'довести фичу X до прода', 'readChecklist parses goal');
  ok(cl.items.length === 3 && cl.items.filter(i => i.done).length === 1, 'readChecklist parses items/done');
  const summary = G.checklistSummary(cl);
  ok(/написать тесты/.test(summary) && /задеплоить/.test(summary) && !/написать код/.test(summary), 'checklistSummary lists only unchecked');
  ok(G.readChecklist(fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-empty-'))) === null, 'readChecklist null when no file');

  // 8. computeMaxIterations scales with unchecked checklist items (capped, no LLM call)
  ok(G.computeMaxIterations(cl) === 4, 'maxIterations scales with unchecked items (2+2)');
  ok(G.computeMaxIterations(null) === G.DEFAULT_MAX_ITERATIONS, 'no checklist -> default cap');
  const bigChecklist = { goal: null, items: Array.from({ length: 100 }, () => ({ text: 'x', done: false })) };
  ok(G.computeMaxIterations(bigChecklist) === G.CHECKLIST_MAX_ITERATIONS, 'huge checklist clamped to hard ceiling');

  // 9. buildReopenMessage injects checklist summary instead of truncated task
  const recWithChecklist = { iterations: 1, maxIterations: 4, originalTask: 'x', projectDir: projDir };
  const reopenMsg = G.buildReopenMessage(recWithChecklist);
  ok(/написать тесты/.test(reopenMsg) && /задеплоить/.test(reopenMsg), 'reopen message carries unchecked checklist items');
  ok(/Цель: довести фичу X до прода/.test(reopenMsg), 'reopen message carries goal');

  // 10. maybeSchedule end-to-end with a real checklist.md + wanted:true intent
  // (regression for #631: `checklist` was undefined in the scheduling log line,
  // throwing a ReferenceError on every successful schedule call).
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ wanted: true, etaMinutes: 30 }) } }] }),
  });
  let scheduleErr = null;
  const scheduled = await G.maybeSchedule({
    workDir: wd, sessionId: 's-checklist', task: 'доведи фичу X до конца',
    apiKey: 'k', projectDir: projDir,
  }).catch(e => { scheduleErr = e; return null; });
  global.fetch = realFetch;
  ok(scheduleErr === null, 'maybeSchedule with checklist.md does not throw');
  ok(scheduled && scheduled.maxIterations === 4, 'maybeSchedule scales maxIterations from checklist');

  // 11. scheduleFromChecklist: no LLM call, mode-independent — checklist alone is enough
  const wd4 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd4-'));
  ok((await G.scheduleFromChecklist({ workDir: wd4, sessionId: 's-2', projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-noproj-')) })) === null,
    'scheduleFromChecklist: no checklist -> null');
  const scheduledFromChecklist = await G.scheduleFromChecklist({
    workDir: wd4, sessionId: 's-2', chatId: '7', username: 'u', projectDir: projDir,
  });
  ok(scheduledFromChecklist && scheduledFromChecklist.status === 'open' && scheduledFromChecklist.maxIterations === 4,
    'scheduleFromChecklist schedules from unchecked checklist.md alone');
  ok(scheduledFromChecklist.etaMinutes === G.ETA_MIN_CLAMP, 'scheduleFromChecklist uses fast eta (build-time scale, not 60m default)');
  const notReScheduled = await G.scheduleFromChecklist({ workDir: wd4, sessionId: 's-2', projectDir: projDir });
  ok(notReScheduled.createdAt === scheduledFromChecklist.createdAt, 'scheduleFromChecklist does not reset an already-open record');

  // 12. checklistCheapPrecheck: ticks CI/merged off via GitHub API, no LLM, no Claude
  const prProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-pr-'));
  fs.writeFileSync(path.join(prProjDir, 'checklist.md'), [
    'Goal: ship fix (PR https://github.com/acme/widgets/pull/42)',
    '- [ ] CI green on https://github.com/acme/widgets/pull/42',
    '- [ ] Merged to main',
    '- [ ] Deployed to prod — verified live',
  ].join('\n'));
  const tokensRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-tokens-'));
  fs.mkdirSync(path.join(tokensRoot, 'ghuser'), { recursive: true });
  fs.writeFileSync(path.join(tokensRoot, 'ghuser', 'github'), 'ghp_fake');
  const realTokensRoot = process.env.AGENT_TOKENS_ROOT;
  process.env.AGENT_TOKENS_ROOT = tokensRoot;
  // Re-require with the env var already set, since TOKENS_ROOT is read at module load time.
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  const G2 = require('../src/gtd-controller.js');

  const realFetch2 = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/pulls/42')) {
      return { ok: true, json: async () => ({ merged: true, head: { sha: 'abc123' } }) };
    }
    if (String(url).includes('/commits/abc123/check-runs')) {
      return { ok: true, json: async () => ({ check_runs: [{ status: 'completed', conclusion: 'success' }] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const checklistNoUser = G2.readChecklist(prProjDir);
  const preNoUser = await G2.checklistCheapPrecheck(checklistNoUser, {});
  ok(preNoUser.changed === false, 'checklistCheapPrecheck: no username/token -> no-op');
  const pre = await G2.checklistCheapPrecheck(checklistNoUser, { username: 'ghuser' });
  ok(pre.changed === true, 'checklistCheapPrecheck: ticks items via GitHub API');
  ok(pre.items.find(i => /CI green/.test(i.text)).done === true, 'CI item marked done from check-runs');
  ok(pre.items.find(i => /Merged/.test(i.text)).done === true, 'Merged item marked done from pr.merged');
  ok(pre.items.find(i => /Deployed/.test(i.text)).done === false, 'Deployed-live item left for the agent (not auto-verifiable)');
  G2.writeChecklistDone(prProjDir, pre.items);
  const rewritten = fs.readFileSync(path.join(prProjDir, 'checklist.md'), 'utf8');
  ok(/- \[x\] CI green/.test(rewritten) && /- \[x\] Merged/.test(rewritten) && /- \[ \] Deployed/.test(rewritten),
    'writeChecklistDone flips only the resolved checkboxes, preserves the rest');
  ok(/Goal: ship fix/.test(rewritten), 'writeChecklistDone preserves non-checkbox lines');

  // 13. runDue: fully-resolved-by-precheck checklist closes WITHOUT calling runTask (no Claude spent)
  const wd5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd5-'));
  const userDir5 = path.join(wd5, 'ghuser');
  fs.mkdirSync(userDir5, { recursive: true });
  // Simulate precheck seeing everything already resolved (e.g. a prior tick + manual close).
  fs.writeFileSync(path.join(prProjDir, 'checklist.md'), [
    '- [x] CI green on https://github.com/acme/widgets/pull/42',
    '- [x] Merged to main',
    '- [x] Deployed to prod — verified live',
  ].join('\n'));
  G2.writeGtd(userDir5, {
    sessionId: 's-pr', chatId: '9', username: 'ghuser', createdAt: 1, dueAt: 100,
    etaMinutes: 20, iterations: 0, maxIterations: 4, status: 'open',
    originalTask: 'ship fix', projectDir: prProjDir, lastFiredAt: null, closedReason: null,
  });
  let runTaskCalled = false;
  await G2.runDue({
    secrets: {}, baseUsersDir: wd5, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '9' }),
    runTask: async () => { runTaskCalled = true; return 'x'; },
  });
  global.fetch = realFetch2;
  if (realTokensRoot === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = realTokensRoot;
  delete require.cache[require.resolve('../src/gtd-controller.js')];

  ok(!runTaskCalled, 'runDue: does not spend Claude when checklist already fully resolved');
  const closedByPrecheck = G2.readGtd(userDir5, 's-pr');
  ok(closedByPrecheck && closedByPrecheck.status === 'closed' && closedByPrecheck.closedReason === 'done-precheck',
    'runDue: closes with done-precheck reason');

  // 14. two sessions of one profile fired in the same tick must get distinct taskIds
  const wd6 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd6-'));
  const userDir6 = path.join(wd6, 'u');
  fs.mkdirSync(userDir6, { recursive: true });
  G.writeGtd(userDir6, { ...rec, sessionId: 's-a', chatId: '1', dueAt: 100 });
  G.writeGtd(userDir6, { ...rec, sessionId: 's-b', chatId: '2', dueAt: 100 });
  const firedIds = [];
  await G.runDue({
    secrets: {}, baseUsersDir: wd6, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ summary: {} }),
    runTask: async o => { firedIds.push(o.taskId); return 'x'; },
  });
  ok(firedIds.length === 2 && new Set(firedIds).size === 2, 'runDue: concurrent sessions of one profile get distinct taskIds');

  // 15. runDue pins engine:'claude' on every fire — forceClaude alone does NOT force
  // the engine (it only widens context/skips quick-answers; engine selection falls
  // back to the profile's default). GTD is unattended background work — pinning it to
  // claude keeps it on the one engine whose behavior under a mid-run server restart is
  // best understood, rather than inheriting whatever the user last picked interactively
  // (server.js resumePendingTasks can now resume codex/opencode too, but that doesn't
  // by itself make them the right default for an autonomous checklist loop).
  const wd7 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd7-'));
  const userDir7 = path.join(wd7, 'u');
  fs.mkdirSync(userDir7, { recursive: true });
  G.writeGtd(userDir7, { ...rec, sessionId: 's-engine', dueAt: 100 });
  let capturedEngine;
  await G.runDue({
    secrets: {}, baseUsersDir: wd7, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ summary: {} }),
    runTask: async o => { capturedEngine = o.engine; return 'x'; },
  });
  ok(capturedEngine === 'claude', 'runDue: fires with engine explicitly pinned to claude (not left to profile default)');

  // 16. fairness: due records are fired oldest-dueAt-first, not in filesystem-listing
  // order — otherwise the same early users/records win every tick's MAX_FIRES_PER_TICK
  // slots while later ones starve indefinitely.
  const wd8 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd8-'));
  // Deliberately write users in an order whose directory listing would put the
  // newest-due record first if unsorted (zzz sorts after aaa alphabetically on
  // most filesystems, but readdirSync order isn't guaranteed either way — the
  // point is dueAt must be what decides firing order, not listing order).
  for (const [uname, sid, due] of [['zzz-newest', 's-new', 190], ['aaa-oldest', 's-old', 100], ['mmm-mid', 's-mid', 150]]) {
    const ud = path.join(wd8, uname);
    fs.mkdirSync(ud, { recursive: true });
    G.writeGtd(ud, { ...rec, sessionId: sid, dueAt: due });
  }
  const fireOrder = [];
  await G.runDue({
    secrets: {}, baseUsersDir: wd8, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ summary: {} }),
    runTask: async o => { fireOrder.push(o.sessionId); return 'x'; },
  });
  ok(fireOrder.length === 3, 'fairness: all 3 due records fired (under the MAX_FIRES_PER_TICK cap)');
  ok(JSON.stringify(fireOrder) === JSON.stringify(['s-old', 's-mid', 's-new']),
    `fairness: fires oldest-dueAt-first regardless of directory order, got ${JSON.stringify(fireOrder)}`);

  // 17. fairness under the cap: with MORE due records than MAX_FIRES_PER_TICK, the
  // oldest-due ones win the slots this tick — a starved record isn't randomly dropped,
  // it's simply the newest and gets its turn on a later tick.
  const wd9 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd9-'));
  const dues9 = [['u-d', 's-d', 400], ['u-a', 's-a2', 100], ['u-e', 's-e', 500], ['u-b', 's-b2', 200], ['u-c', 's-c', 300]];
  for (const [uname, sid, due] of dues9) {
    const ud = path.join(wd9, uname);
    fs.mkdirSync(ud, { recursive: true });
    G.writeGtd(ud, { ...rec, sessionId: sid, dueAt: due });
  }
  const fireOrder9 = [];
  await G.runDue({
    secrets: {}, baseUsersDir: wd9, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ summary: {} }),
    runTask: async o => { fireOrder9.push(o.sessionId); return 'x'; },
  });
  ok(JSON.stringify(fireOrder9) === JSON.stringify(['s-a2', 's-b2', 's-c']),
    `fairness under cap: only the ${G.MAX_FIRES_PER_TICK} oldest-due records fire, got ${JSON.stringify(fireOrder9)}`);
  ok(G.readGtd(path.join(wd9, 'u-d'), 's-d').status === 'open', 'fairness under cap: newer-due record stays open, not dropped');
  ok(G.readGtd(path.join(wd9, 'u-e'), 's-e').status === 'open', 'fairness under cap: newest-due record stays open, not dropped');

  // ── Round 3 reliability regressions ────────────────────────────────────────

  // 18. Fire-lease: firing a session moves dueAt FORWARD (~FIRE_LEASE_MS) synchronously,
  // BEFORE runTask's async completion callback runs. Without this the record keeps
  // dueAt<=now for the whole (minutes-long) run and only isSessionRunning stops it
  // being re-fired every tick — but isSessionRunning is false the instant the process
  // is killed mid-run (systemd restart), so a lost run would hammer every tick. The
  // lease makes a lost run retry after a bounded delay instead of immediately/forever.
  const wd10 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd10-'));
  const userDir10 = path.join(wd10, 'u');
  fs.mkdirSync(userDir10, { recursive: true });
  G.writeGtd(userDir10, { ...rec, sessionId: 's-lease', dueAt: 100 });
  let resolveRun10;
  const runGate10 = new Promise(r => { resolveRun10 = r; });
  const tick10 = G.runDue({
    secrets: {}, baseUsersDir: wd10, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { await runGate10; return 'still working'; }, // never resolves until we let it
  });
  // Let the tick fire + persist, but keep runTask pending (simulates a long/lost run).
  await new Promise(r => setImmediate(r));
  const leased = G.readGtd(userDir10, 's-lease');
  ok(leased.dueAt >= 1000 + G.FIRE_LEASE_MS - 5000 && leased.iterations === 1,
    `fire-lease: dueAt pushed ~FIRE_LEASE_MS forward at fire time (got dueAt=${leased.dueAt - 1000}ms after now, iter=${leased.iterations})`);
  // A re-tick while the run is still in flight (isSessionRunning true) must NOT re-fire.
  let refireCount = 0;
  await G.runDue({
    secrets: {}, baseUsersDir: wd10, now: 1000,
    isTaskRunning: () => true,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { refireCount++; return 'x'; },
  });
  ok(refireCount === 0 && G.readGtd(userDir10, 's-lease').iterations === 1, 'fire-lease: in-flight session not re-fired by a later tick');
  resolveRun10();
  await tick10;

  // 19. Overlap guard: two runDue passes must not run concurrently (a slow GitHub
  // precheck could make one tick outlast the 5-min interval → overlapping ticks
  // both read the same due record, both see isSessionRunning=false, both fire →
  // duplicate fire + doubled iteration). The second concurrent pass is a no-op.
  // We suspend the first pass inside its awaited GitHub precheck (gated global.fetch)
  // so it is genuinely "in flight" when we launch the second, concurrent pass.
  const wd11 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd11-'));
  const userDir11 = path.join(wd11, 'u');
  fs.mkdirSync(userDir11, { recursive: true });
  const proj11 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd11-proj-'));
  fs.writeFileSync(path.join(proj11, 'checklist.md'), [
    'Goal: ship (PR https://github.com/acme/w/pull/7)',
    '- [ ] CI green https://github.com/acme/w/pull/7',
    '- [ ] Deployed live',
  ].join('\n'));
  const tokRoot11 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd11-tok-'));
  fs.mkdirSync(path.join(tokRoot11, 'u'), { recursive: true });
  fs.writeFileSync(path.join(tokRoot11, 'u', 'github'), 'ghp_x');
  const realTok11 = process.env.AGENT_TOKENS_ROOT;
  process.env.AGENT_TOKENS_ROOT = tokRoot11;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  const G11 = require('../src/gtd-controller.js');
  G11.writeGtd(userDir11, { ...rec, sessionId: 's-overlap', dueAt: 100, projectDir: proj11, username: 'u' });
  let fires11 = 0;
  let releaseFetch11;
  const fetchGate11 = new Promise(r => { releaseFetch11 = r; });
  const realFetch11 = global.fetch;
  global.fetch = async () => { await fetchGate11; return { ok: false, json: async () => ({}) }; }; // precheck no-op after gate
  const passA = G11.runDue({
    secrets: {}, baseUsersDir: wd11, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { fires11++; return 'x'; },
  });
  await new Promise(r => setImmediate(r)); // let passA reach the gated fetch inside the precheck
  const passB = G11.runDue({
    secrets: {}, baseUsersDir: wd11, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { fires11++; return 'x'; },
  });
  await passB; // returns immediately — guarded no-op (previous tick still in flight)
  releaseFetch11();
  await passA;
  await new Promise(r => setImmediate(r));
  global.fetch = realFetch11;
  if (realTok11 === undefined) delete process.env.AGENT_TOKENS_ROOT; else process.env.AGENT_TOKENS_ROOT = realTok11;
  delete require.cache[require.resolve('../src/gtd-controller.js')];
  ok(fires11 === 1 && G11.readGtd(userDir11, 's-overlap').iterations === 1,
    `overlap guard: concurrent tick is a no-op, session fired exactly once (fires=${fires11}, iter=${G11.readGtd(userDir11, 's-overlap').iterations})`);

  // 20. No-resurrection: if the record is deleted (session vanished / user-stop) WHILE
  // a run is in flight, the completion callback must NOT recreate it from the stale
  // in-memory snapshot.
  const wd12 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd12-'));
  const userDir12 = path.join(wd12, 'u');
  fs.mkdirSync(userDir12, { recursive: true });
  G.writeGtd(userDir12, { ...rec, sessionId: 's-gone', dueAt: 100 });
  let resolveRun12;
  const runGate12 = new Promise(r => { resolveRun12 = r; });
  const tick12 = G.runDue({
    secrets: {}, baseUsersDir: wd12, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { await runGate12; return 'сделал, всё готово. GTD: done'; },
  });
  await new Promise(r => setImmediate(r));
  G.clearGtd(userDir12, 's-gone'); // user-stop / session vanished mid-run
  resolveRun12();
  await tick12;
  await new Promise(r => setImmediate(r));
  ok(G.readGtd(userDir12, 's-gone') === null, 'no-resurrection: deleted record stays deleted after run completes');

  // 21. No-resurrection on error path too: a rejected runTask must not recreate a
  // record that was deleted mid-run.
  const wd13 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd13-'));
  const userDir13 = path.join(wd13, 'u');
  fs.mkdirSync(userDir13, { recursive: true });
  G.writeGtd(userDir13, { ...rec, sessionId: 's-gone-err', dueAt: 100 });
  let rejectRun13;
  const runGate13 = new Promise((_, rej) => { rejectRun13 = rej; });
  const tick13 = G.runDue({
    secrets: {}, baseUsersDir: wd13, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => { await runGate13; },
  });
  await new Promise(r => setImmediate(r));
  G.clearGtd(userDir13, 's-gone-err');
  rejectRun13(new Error('claude crashed'));
  await tick13;
  await new Promise(r => setImmediate(r));
  ok(G.readGtd(userDir13, 's-gone-err') === null, 'no-resurrection (error path): deleted record stays deleted after run rejects');

  // 22. Completion backoff is measured from run-completion time, not the stale fire-time
  // `now` — otherwise a run that took longer than etaMinutes would schedule its next
  // check in the past and re-fire on the very next tick (busy-loop). We resolve the run
  // immediately, so the new dueAt must be ~etaMinutes into the future from real time.
  const wd14 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd14-'));
  const userDir14 = path.join(wd14, 'u');
  fs.mkdirSync(userDir14, { recursive: true });
  // fire-time now=1000 is far in the past relative to Date.now(); if backoff used it,
  // dueAt would be ~1000+eta (still in the past). It must use real completion time.
  G.writeGtd(userDir14, { ...rec, sessionId: 's-backoff', etaMinutes: 30, dueAt: 100 });
  const beforeReal = Date.now();
  await G.runDue({
    secrets: {}, baseUsersDir: wd14, now: 1000,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', summary: {} }),
    runTask: async () => 'ещё не готово, продолжаю. GTD: continue',
  });
  await new Promise(r => setImmediate(r));
  const backoff = G.readGtd(userDir14, 's-backoff');
  ok(backoff.status === 'open' && backoff.dueAt >= beforeReal + 30 * 60 * 1000 - 5000,
    `backoff: next dueAt measured from completion time, not stale fire-now (got ${backoff.dueAt}, expected >= ${beforeReal + 30 * 60 * 1000 - 5000})`);

  // 23. Atomic write survives + cleans up: _atomicWrite leaves no leftover .tmp file
  // and writes complete valid JSON (fsync'd tmp → rename). listGtd must ignore any
  // tmp artifacts and only surface the real record.
  const wd15 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd15-'));
  const gtdSub15 = path.join(wd15, 'gtd');
  fs.mkdirSync(gtdSub15, { recursive: true });
  G.writeGtd(wd15, { ...rec, sessionId: 's-atomic', dueAt: 100 });
  const leftovers = fs.readdirSync(gtdSub15).filter(f => f.includes('.tmp'));
  ok(leftovers.length === 0, `atomic write: no leftover .tmp files (found ${JSON.stringify(leftovers)})`);
  // A stray .tmp artifact must not be parsed as a record by listGtd.
  fs.writeFileSync(path.join(gtdSub15, 's-atomic.json.tmp.999.0'), 'garbage-not-json');
  ok(G.listGtd(wd15).length === 1 && G.listGtd(wd15)[0].sessionId === 's-atomic',
    'atomic write: listGtd ignores .tmp artifacts, surfaces only the committed record');

  // 24. audience persistence (issue #1302 §3.3): a new GTD record created via
  // scheduleFromChecklist (deterministic — no LLM call, unlike maybeSchedule's
  // detectIntent) stores the passed audience on the record itself.
  const wd16 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd16-'));
  const projectDir16 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd16-proj-'));
  fs.writeFileSync(path.join(projectDir16, 'checklist.md'), 'Goal: x\n\n- [ ] one\n');
  const scheduledWithAudience = await G.scheduleFromChecklist({
    workDir: wd16, sessionId: 's-aud', chatId: '42', username: 'u', projectDir: projectDir16, audience: 'recruiter',
  });
  ok(scheduledWithAudience && scheduledWithAudience.audience === 'recruiter',
    `scheduleFromChecklist persists the passed audience on the record (got ${scheduledWithAudience && scheduledWithAudience.audience})`);
  const persisted = G.readGtd(wd16, 's-aud');
  ok(persisted && persisted.audience === 'recruiter', 'audience survives a write/read roundtrip on disk');

  // 25. rec.audience wins over a drifted session.audience — a session's audience
  // must never silently override an already-recorded GTD record (#1302 §3.3).
  const wd17 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd17-'));
  const userDir17 = path.join(wd17, 'u');
  fs.mkdirSync(userDir17, { recursive: true });
  G.writeGtd(userDir17, { ...rec, sessionId: 's-drift', audience: 'recruiter', dueAt: 100 });
  let routedAudience = null;
  await G.runDue({
    secrets: { RECRUITER_BOT_TOKEN: 'r-tok' }, baseUsersDir: wd17, now: 200,
    isTaskRunning: () => false,
    // Session itself now reports 'default' (drift) — the durable record's audience must win.
    getSession: () => ({ ownerChatId: '42', audience: 'default', summary: {} }),
    runTask: async (opts) => { routedAudience = opts.user.audience; return 'GTD: done'; },
  });
  ok(routedAudience === 'recruiter', `rec.audience ('recruiter') wins over drifted session.audience ('default'), got ${routedAudience}`);

  // 26. legacy GTD record (no audience field) falls back to session.audience.
  const wd18 = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd18-'));
  const userDir18 = path.join(wd18, 'u');
  fs.mkdirSync(userDir18, { recursive: true });
  const legacyRec = { ...rec, sessionId: 's-legacy', dueAt: 100 };
  delete legacyRec.audience;
  G.writeGtd(userDir18, legacyRec);
  let legacyRoutedAudience = null;
  await G.runDue({
    secrets: { RECRUITER_BOT_TOKEN: 'r-tok' }, baseUsersDir: wd18, now: 200,
    isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '42', audience: 'recruiter', summary: {} }),
    runTask: async (opts) => { legacyRoutedAudience = opts.user.audience; return 'GTD: done'; },
  });
  ok(legacyRoutedAudience === 'recruiter', `legacy record (no audience field) falls back to session.audience, got ${legacyRoutedAudience}`);

  // #1517: an appended, fully-closed section must not hide open items of the tracked goal.
  const pdG = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-goals-'));
  const clG = [
    'Goal: S3.4 transport',
    '- [x] Merged to main',
    '- [ ] Next: S7.1 cold search on cron',
    '',
    'Goal: #1509 incident',
    '- [x] Prod restored',
    '- [x] Deployed + verified live',
  ].join('\n');
  fs.writeFileSync(path.join(pdG, 'checklist.md'), clG);
  ok(G.readChecklist(pdG).items.every(i => i.done), 'legacy view: last section alone looks done (the bug)');
  const mergedG = G.readChecklist(pdG, { goals: ['S3.4 transport'] });
  ok(mergedG.goal === '#1509 incident' && mergedG.items.length === 4 && mergedG.items.filter(i => !i.done).length === 1,
    'readChecklist(goals) unions tracked section with the last one');
  const recG = { projectDir: pdG, originalTask: 'S3.4 transport' }; // legacy record: no goals field
  const trG = G.trackedChecklist(recG);
  ok(trG.items.some(i => !i.done) && recG.goals.join('|') === 'S3.4 transport|#1509 incident',
    'trackedChecklist seeds goals from originalTask and remembers the new last goal');

  const wdG = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd17-'));
  const udG = path.join(wdG, 'u17'); fs.mkdirSync(udG, { recursive: true });
  G.writeGtd(udG, { sessionId: 's-17', chatId: '17', username: 'u17', createdAt: 1, dueAt: 100, etaMinutes: 20,
    iterations: 0, maxIterations: 3, status: 'open', originalTask: 'S3.4 transport', goals: ['S3.4 transport'],
    projectDir: pdG, lastFiredAt: null, closedReason: null });
  let firedG = false;
  const realFetchG = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await G.runDue({ secrets: {}, baseUsersDir: wdG, now: 200, isTaskRunning: () => false,
    getSession: () => ({ ownerChatId: '17', summary: {} }),
    runTask: async () => { firedG = true; return 'GTD: continue'; } });
  global.fetch = realFetchG;
  const recGG = G.readGtd(udG, 's-17');
  ok(recGG.closedReason !== 'done-precheck' && firedG, `open tracked item keeps GTD alive and fires the session (got ${recGG.closedReason})`);
  ok(recGG.goals.includes('#1509 incident'), 'goal seen as last section is persisted on the record');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
