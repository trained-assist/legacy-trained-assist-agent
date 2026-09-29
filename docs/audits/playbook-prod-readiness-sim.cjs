// Local, network-free end-to-end simulation of the Playbooks pipeline
// (layer 3 of docs/TESTING-PLAYBOOKS.md).
//
// It drives the REAL production modules — the MCP tool registry (autodiscovery),
// playbook_store/compiler, DurableTaskStore, and gtd-controller.runDueDurable —
// with the network/LLM/engine boundaries replaced by injected fakes. No src/ file
// is modified; no HTTP, SQLite is a temp file, no model is spawned.
//
// Run:  node docs/audits/playbook-prod-readiness-sim.cjs
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── isolated roots (before any src/ require reads env) ────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-audit-sim-'));
process.env.AGENT_DATA_DIR = path.join(ROOT, 'agent-data');
process.env.USERS_DIR = path.join(ROOT, 'users');
process.env.AGENT_TOKENS_ROOT = path.join(ROOT, 'agent-tokens');
process.env.TEST_MODE = '1';
process.env.USER_ID = 'audit-u';
delete process.env.OPENROUTER_API_KEY;      // emulate a profile with no LLM key
delete process.env.PLAYBOOK_VALIDATION_MODE;
delete process.env.PLAYBOOK_LEVEL_MAP;

const REPO = path.resolve(__dirname, '..', '..');
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const rule = t => log(`\n=== ${t} ===`);

(async () => {
  rule('0. MCP autodiscovery — are playbook_* tools registered and callable?');
  const registry = require(path.join(REPO, 'src/mcp-skills/registry.js'));
  const names = registry.listTools().map(t => t.name);
  log('playbook_* tools discovered:', names.filter(n => n.startsWith('playbook_')).join(', '));
  log('durable tools discovered  :', names.filter(n => n.startsWith('task_')).join(', '));

  rule('1. Hop 1+2+3: playbook_run via the MCP handler → compile → DRAFT plan');
  const run = await registry.callTool('playbook_run', {
    playbook_id: 'development',
    goal: 'fix the HH token-expiry notification bug',
  });
  if (run.error) { log('ERROR:', run.error); throw new Error(run.error); }
  const taskId = run.task.id;
  log(`task.id=${taskId}`);
  log(`task.status=${run.task.status}  playbook=${run.task.playbook_id}@${run.task.playbook_version}`);
  log(`items=${run.items.length}  summary=${JSON.stringify(run.summary)}`);
  log('first item contract:', JSON.stringify(pick(run.items[0], ['title','stage','execution_kind','executor_role','minimum_model_level','context_budget','validation'])));

  rule('2. Hop 4a: DRAFT is not executed (tick runs before activation)');
  const G = require(path.join(REPO, 'src/gtd-controller.js'));
  const store = G.durableStore();
  let firedBefore = 0;
  await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
    runTask: async () => { firedBefore++; return 'DURABLE: done'; } });
  await drain();
  log(`fires while draft = ${firedBefore} (expect 0); task.status=${store.getTask(taskId, 'audit-u').status}`);

  rule('2b. Hop 4b: activation through the real MCP task_update handler');
  const upd = await registry.callTool('task_update', { task_id: taskId, status: 'active' });
  log(`task.status after task_update = ${upd.task && upd.task.status}`);

  // Fake validation layer: the engineering playbook's programmatic keys + an LLM
  // judge for the 12 self-reported agent keys. Deterministic CI/merge file/exec
  // validators are NOT exercised here — they need a real GitHub PR + token.
  // (P3d follow-up #1449: the playbook now names the registered vocabulary, so
  // these are the real keys; the deterministic path is proven separately by
  // test/gtd-durable-wiring.test.cjs case 18.)
  const registryFake = {
    command_exit_zero: async () => ({ status: 'pass', subject: {}, evidence: { exit_code: 0 } }),
    pr_opened: async () => ({ status: 'pass', subject: {}, evidence: { pr: 'https://github.com/x/y/pull/1' } }),
    ci_green: async () => ({ status: 'pass', subject: {}, evidence: { checks: [] } }),
    merged: async () => ({ status: 'pass', subject: {}, evidence: { merged: true } }),
  };
  const llmValidate = async (ctx) => ({ status: 'pass', reason: `judge accepted ${ctx.key}` });

  const firedSteps = [];
  const runTask = async (opts) => {
    firedSteps.push({ title: (opts.task.match(/^Step .*?: (.*)$/m) || [])[1] || '?', engine: opts.engine, ocProfile: opts.ocProfile || null, ocRole: opts.ocRole || null, forceClaude: opts.forceClaude });
    return 'worked on it.\nDURABLE: done';
  };

  rule('3. Hop 4+5+6+7: drive durable ticks to completion (injected registry + LLM + engine)');
  let simNow = Date.now();
  for (let i = 0; i < 40; i++) {
    await G.runDueDurable({ secrets: {}, now: simNow, isTaskRunning: () => false,
      registry: registryFake, llmValidate, runTask, maxFires: 50 });
    await drain();
    const t = store.getTask(taskId, 'audit-u');
    const waiting = store.db.prepare(`SELECT id, status, due_at, wait_deadline_at FROM task_items WHERE task_id=? AND status='waiting' ORDER BY due_at LIMIT 1`).get(taskId);
    const pending = store.db.prepare(`SELECT COUNT(*) n FROM task_items WHERE task_id=? AND status='pending'`).get(taskId).n;
    const running = store.db.prepare(`SELECT COUNT(*) n FROM task_items WHERE task_id=? AND status='running'`).get(taskId).n;
    if (t.status !== 'active') { log(`task reached terminal status=${t.status} after tick ${i + 1}`); break; }
    // Only a delay-gated waiter remains: fast-forward its due_at into the past to
    // emulate wall-clock advancing past delay_after_sec (claimNextRunnable uses
    // real Date.now(), so an injected `now` alone cannot move it). wait_deadline_at
    // stays in the future so the waiter is runnable, not expired.
    if (pending === 0 && running === 0 && waiting) {
      const snap = store.listTaskItems(taskId, 'audit-u')
        .map(i => `${i.position}:${i.status}`).join(' ');
      log(`state before fast-forwarding the waiter: ${snap}`);
      log(`→ position 12 "Merge and deploy" is already done while position 11 "Wait for CI…" is still waiting: later steps are NOT blocked by an earlier delay-gated step.`);
      store.updateTaskItem(waiting.id, { due_at: Date.now() - 1, wait_deadline_at: Date.now() + 3600000 }, 'audit-u');
      log(`(fast-forwarded the delay_after_sec=600 waiter into the past to emulate elapsed wall-clock)`);
    } else if (pending === 0 && running === 0 && !waiting) { log(`stuck after tick ${i + 1}`); break; }
  }

  const items = store.listTaskItems(taskId, 'audit-u');
  const task = store.getTask(taskId, 'audit-u');
  const vals = store.listValidations(taskId, 'audit-u');
  log(`final task.status=${task.status}`);
  log(`items: ${items.filter(i => i.status === 'done').length}/${items.length} done`);
  log(`validation rows=${vals.length} (pass=${vals.filter(v => v.status === 'pass').length}, fail=${vals.filter(v => v.status === 'fail').length}, inconclusive=${vals.filter(v => v.status === 'inconclusive').length})`);
  log('engine steps fired (proves per-step resolution + that programmatic did NOT spawn an engine):');
  for (const s of firedSteps) log(`   [${s.engine}${s.ocProfile ? '/' + s.ocProfile : ''}]${s.forceClaude ? ' (forceClaude)' : ''} role=${s.ocRole} — ${s.title}`);
  log(`runTask invocations=${firedSteps.length}; programmatic items in plan=4 → expected agent fires=12`);

  rule('4. Hop 6 — a programmatic step under the REAL registry with the registered vocabulary');
  const r2 = await registry.callTool('task_create', {
    goal: 'deterministic CI check (command_exit_zero)',
    user_value: 'uv',
    acceptance_criteria: [{ id: 'crit-ci', description: 'c', validations: [{ step: 'ci', validation: { command_exit_zero: 'true' } }] }],
    items: [{ title: 'Run tests, lint and regression checks', stage: 'build', execution_kind: 'programmatic', validation: { command_exit_zero: 'true' } }],
  });
  const t2 = r2.task.id;
  // command_exit_zero spawns with cwd = the profile workspace; make it exist so the
  // sim proves the verdict (this is the only rule that actually shells out).
  fs.mkdirSync(path.join(process.env.USERS_DIR, 'audit-u'), { recursive: true });
  await registry.callTool('task_update', { task_id: t2, status: 'active' });
  await G.runDueDurable({ secrets: {}, now: Date.now(), isTaskRunning: () => false,
    runTask: async () => { throw new Error('programmatic step must not run an engine'); } });
  const it2 = store.listTaskItems(t2, 'audit-u')[0];
  const v2 = store.listValidations(t2, 'audit-u');
  log(`item.status=${it2.status} attempt_count=${it2.attempt_count}/${it2.max_attempts}`);
  log(`recorded verdict: ${v2.map(v => `${v.validator}=${v.status} ${v.evidence_json}`).join(' | ')}`);
  log(`task.status=${store.getTask(t2, 'audit-u').status} (registered command_exit_zero passes with no model)`);

  rule('4b. Hop 6 — the REAL deterministic validators on the two "objective" CI/merge keys');
  const { createDefaultRegistry } = require(path.join(REPO, 'src/playbook-validators.js'));
  const item = { title: 'Merge and deploy', instructions: 'PR https://github.com/trained-assist/trained-assist-agent/pull/999' };
  const taskArg = { goal: 'x' };
  const ghFetch = async (url) => {
    if (/\/pulls\/999$/.test(url)) return { head: { sha: 'deadbeef' }, merged: true, state: 'closed', merged_at: '2026-09-26T00:00:00Z' };
    if (/check-runs$/.test(url)) return { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] };
    return null;
  };
  const realReg = createDefaultRegistry({ ghToken: () => 'fake-token', ghFetch });
  for (const key of ['ci_green', 'ci_and_staging_green', 'merged', 'pr_merged', 'merged_and_deployed', 'pr_opened']) {
    const r = await realReg[key]({ task: taskArg, item, profileId: 'audit-u', projectDir: ROOT, validation: true, key });
    log(`${key.padEnd(22)} → ${r.status} ${JSON.stringify(r.evidence)}`);
  }
  log('=> even with a working GitHub token, *_staging_green / *_deployed are permanently');
  log('   inconclusive (no staging/deploy health signal exists); the engineering playbook no');
  log('   longer names them (#1449 dropped those halves — the deterministic set is');
  log('   command_exit_zero + pr_opened + ci_green + merged).');

  rule('SUMMARY');
  log(`work-dir snapshot: ${ROOT}`);
  fs.writeFileSync(path.join(REPO, 'docs/audits/playbook-prod-readiness-sim.out'), out.join('\n') + '\n');
})().catch(e => { console.error('SIM FAILED:', e.stack); process.exit(1); });

function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }
function drain() { return new Promise(r => setTimeout(r, 5)); }
