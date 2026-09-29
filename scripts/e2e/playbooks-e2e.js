#!/usr/bin/env node
'use strict';

// Live end-to-end driver for the engineering playbooks (feature / debugging / new-software).
//
// Runs against the REAL durable executor. Two backends, same commands:
//   • local  (default): on the VM that hosts the server — calls src/durable-e2e.js and
//                       ticks http://127.0.0.1:$PORT (AGENT_SECRET from env or ~/secrets.env)
//   • remote (--remote https://host/agent): from anywhere (a Mac, CI) over the
//                       /internal/e2e/* API with AGENT_SECRET — no SSH needed
//
//   start  --playbook new-software --goal "…" [--repo owner/name] [--profile playbooks-e2e] [--level-map '{…}']
//   status <plan> | report <plan> [--json] [--verbose] | list | cancel <plan> | kick
//   wake   <step-id> --message "…"                      — answer a step waiting for the user
//   run    <plan> [--every 20] [--stall-min 15] [--auto-answer "…"] [--auto-merge] [--record out.json]
//          drive the plan: tick (and poll this plan's waits now) in a loop; act where a human
//          would — answer awaiting_user steps, merge a green PR the plan waits on (via gh);
//          stop on done / failed / stall; print the report; optionally save it for replay.
//
// Default e2e level map: doctor → opencode deepseek, master/bachelor → opencode free.
// Quality of what the agents build is NOT the point — that the process runs end to end
// and every failure is visible is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROFILE = 'playbooks-e2e';
const DEFAULT_AUTO_ANSWER = 'Это автоматический e2e: пользователь недоступен. Прими разумное допущение, запиши его в итог шага и продолжай.';
const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function agentSecret() {
  if (process.env.AGENT_SECRET) return process.env.AGENT_SECRET;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), 'secrets.env'), 'utf8').match(/^AGENT_SECRET=(.*)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch { return null; }
}

// ── backends ─────────────────────────────────────────────────────────────────
function httpBackend(base) {
  const secret = agentSecret();
  if (!secret) throw new Error('AGENT_SECRET not in env or ~/secrets.env');
  const call = async (method, p, body) => {
    const res = await fetch(`${base.replace(/\/$/, '')}${p}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${data.error || text.slice(0, 200)}`);
    return data;
  };
  const q = profile => `profile=${encodeURIComponent(profile)}`;
  return {
    start: (o) => call('POST', '/internal/e2e/plans', { profile: o.profile, playbook_id: o.playbookId, goal: o.goal, vars: o.vars, level_map: o.levelMap }),
    report: (id, profile) => call('GET', `/internal/e2e/plans/${encodeURIComponent(id)}?${q(profile)}`),
    list: async (profile) => (await call('GET', `/internal/e2e/plans?${q(profile)}`)).plans,
    cancel: (id, profile) => call('POST', `/internal/e2e/plans/${encodeURIComponent(id)}/cancel`, { profile }),
    wake: (itemId, profile, message) => call('POST', `/internal/durable/items/${encodeURIComponent(itemId)}/wake`, { profile, message }),
    tick: (accelerate) => call('POST', '/internal/gtd/tick', accelerate ? { accelerate } : {}),
  };
}

function localBackend() {
  const e2e = require(path.join(ROOT, 'src', 'durable-e2e'));
  const http = httpBackend(`http://127.0.0.1:${process.env.PORT || 8080}`);
  return {
    start: async (o) => e2e.startPlan(o),
    report: async (id, profile) => e2e.planReport(id, profile),
    list: async (profile) => e2e.listPlans(profile),
    cancel: async (id, profile) => e2e.cancelPlan(id, profile),
    wake: async (itemId, profile, message) => e2e.wakeStep(itemId, profile, message),
    tick: (accelerate) => http.tick(accelerate), // the tick must run inside the server process
  };
}

// ── printing ─────────────────────────────────────────────────────────────────
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function currentLine(r) {
  const cur = r.current;
  if (!cur) return 'all steps finished';
  return `${cur.n}. ${cur.title} [${cur.status}${cur.wait && cur.wait.awaiting_user ? ' · awaiting user' : ''}] ${cur.engines.join(', ')}${cur.last_error ? ` — ${String(cur.last_error).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

function printReport(r, { verbose = false } = {}) {
  console.log(`# e2e report — ${r.plan.playbook} ${r.plan.id}`);
  console.log(`status: ${r.plan.status} | created ${new Date(r.plan.created_at).toISOString()} | ${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(' ')}\n`);
  console.log('| # | stage | step | status | level | ran on | runs | time | error |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const s of r.steps) {
    const lvl = s.kind === 'programmatic' ? 'prog' : `${s.level}${s.current_level && s.current_level !== s.level ? `→${s.current_level}` : ''}`;
    const err = s.last_error ? String(s.last_error).replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 140) : '';
    console.log(`| ${s.n} | ${s.stage} | ${s.title} | ${s.status}${s.wait ? ' ⏳' : ''} | ${lvl} | ${s.engines.join(', ') || '—'} | ${s.executions} | ${fmtDur(s.duration_ms)} | ${err} |`);
  }
  console.log(`\nengines used: ${[...new Set(r.steps.flatMap(s => s.engines))].join(', ') || '—'}`);
  if (verbose) for (const s of r.steps.filter(x => x.summary)) console.log(`\n## ${s.n}. ${s.title}\n${s.summary}`);
}

// ── acting where a human would ───────────────────────────────────────────────
const REPO_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/\d+/g;

function latestPr(report) {
  const urls = report.steps.flatMap(s => [s.summary || '', JSON.stringify(s.wait || {})].join('\n').match(PR_RE) || []);
  return urls.length ? urls[urls.length - 1] : null;
}

// Step summaries are truncated, so the PR url may be missing. Every plan works on
// ONE branch eng/<profile>-plan-<id8> (one workspace per plan): find the open PR of
// that branch in the repo the plan's issue/PR links point at.
function findPlanPr(report, gh = defaultGh) {
  const direct = latestPr(report);
  if (direct) return direct;
  const text = report.steps.map(s => s.summary || '').join('\n');
  const repos = [...new Set([...text.matchAll(REPO_RE)].map(m => m[1]))];
  const suffix = `plan-${String(report.plan.id).slice(0, 8)}`;
  for (const repo of repos) {
    try {
      const prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'url,headRefName']));
      const hit = prs.find(p => String(p.headRefName || '').endsWith(suffix));
      if (hit) return hit.url;
    } catch { /* try the next repo */ }
  }
  return null;
}

function defaultGh(args) { return execFileSync('gh', args, { encoding: 'utf8' }); }

// The plan waits on a merge the repo cannot do itself (no auto-merge): merge a PR
// whose checks are all green, like the owner would. Uses the local `gh` auth.
function tryAutoMerge(report) {
  const cur = report.current;
  if (!cur || cur.status !== 'waiting' && cur.status !== 'pending') return null;
  const waitsOnMerge = (cur.wait && cur.wait.until && Object.hasOwn(cur.wait.until, 'merged')) || /смерж|merged/i.test(cur.title);
  if (!waitsOnMerge) return null;
  const pr = findPlanPr(report);
  if (!pr) return null;
  try {
    const info = JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'state,statusCheckRollup'], { encoding: 'utf8' }));
    if (info.state !== 'OPEN') return null;
    const checks = info.statusCheckRollup || [];
    const green = checks.length > 0 && checks.every(c => (c.conclusion || c.state) === 'SUCCESS');
    if (!green) return null;
    execFileSync('gh', ['pr', 'merge', pr, '--squash'], { stdio: 'ignore' });
    return pr;
  } catch (e) { console.log(`auto-merge ${pr}: ${e.message.split('\n')[0]}`); return null; }
}

// ── commands ─────────────────────────────────────────────────────────────────
async function start(b, a) {
  const out = await b.start({
    profile: a.profile || DEFAULT_PROFILE, playbookId: a.playbook, goal: a.goal,
    vars: a.repo ? { repo: a.repo } : null,
    levelMap: a['level-map'] ? JSON.parse(a['level-map']) : null,
  });
  console.log(`plan ${out.plan.id} (${out.plan.playbook}) active for profile ${out.plan.profile}`);
  for (const r of out.routing) console.log(`  ${String(r.n).padStart(2)}. ${r.title}  →  ${r.route}`);
  console.log('\nDrive it with: run <plan>');
}

async function status(b, a) {
  const r = await b.report(a._[1], a.profile || DEFAULT_PROFILE);
  console.log(`${r.plan.id.slice(0, 8)} ${r.plan.playbook} ${r.plan.status} | ${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`current: ${currentLine(r)}`);
}

async function report(b, a) {
  const r = await b.report(a._[1], a.profile || DEFAULT_PROFILE);
  if (a.json) console.log(JSON.stringify(r, null, 2)); else printReport(r, { verbose: !!a.verbose });
}

async function list(b, a) {
  for (const p of await b.list(a.profile || DEFAULT_PROFILE)) {
    console.log(`${p.id}  ${p.playbook || '-'}  ${p.status}  ${new Date(p.created_at).toISOString()}  ${p.goal.slice(0, 70)}`);
  }
}

async function cancel(b, a) { console.log(JSON.stringify(await b.cancel(a._[1], a.profile || DEFAULT_PROFILE))); }

async function kick(b) {
  const r = await b.tick(null);
  console.log(`tick ok, last finish ${r.heartbeat && r.heartbeat.lastFinishAt ? new Date(r.heartbeat.lastFinishAt).toISOString() : '—'}`);
}

async function wake(b, a) {
  console.log(JSON.stringify(await b.wake(a._[1], a.profile || DEFAULT_PROFILE, a.message || DEFAULT_AUTO_ANSWER)));
}

async function run(b, a) {
  const profile = a.profile || DEFAULT_PROFILE;
  const every = Number(a.every || 20) * 1000;
  const stallMs = Number(a['stall-min'] || 15) * 60 * 1000;
  const autoAnswer = a['auto-answer'] === true ? DEFAULT_AUTO_ANSWER : a['auto-answer'] || null;
  const planId = a._[1];
  const started = Date.now();
  let last = ''; let lastChange = Date.now(); let r = null;
  const answered = new Set();
  for (;;) {
    try { await b.tick({ plan_id: planId, profile }); } catch (e) { console.log(`tick failed: ${e.message}`); }
    try { r = await b.report(planId, profile); } catch (e) { console.log(`report failed: ${e.message}`); await sleep(every); continue; }
    const snap = r.steps.map(s => `${s.n}:${s.status}`).join(' ');
    if (snap !== last) {
      console.log(`[+${((Date.now() - started) / 60000).toFixed(1)}m] ${r.plan.status} | ${currentLine(r)}`);
      last = snap; lastChange = Date.now();
    }
    // act where a human would
    const cur = r.current;
    if (autoAnswer && cur && cur.status === 'waiting' && cur.wait && cur.wait.awaiting_user && !answered.has(`${cur.id}:${cur.attempts}`)) {
      answered.add(`${cur.id}:${cur.attempts}`);
      try { await b.wake(cur.id, profile, autoAnswer); console.log(`  ↳ answered step ${cur.n} (awaiting user)`); }
      catch (e) { console.log(`  ↳ answer failed: ${e.message}`); }
    }
    if (a['auto-merge']) {
      const merged = tryAutoMerge(r);
      if (merged) console.log(`  ↳ merged ${merged} (green CI, no auto-merge in repo)`);
    }
    if (['done', 'failed', 'cancelled'].includes(r.plan.status)) break;
    if (r.steps.some(s => s.status === 'failed')) { console.log('a step failed'); break; }
    if (Date.now() - lastChange > stallMs) { console.log(`stalled ${a['stall-min'] || 15} min`); break; }
    await sleep(every);
  }
  if (r) {
    printReport(r, { verbose: true });
    if (a.record) {
      fs.writeFileSync(a.record, JSON.stringify({ recorded_at: new Date().toISOString(), ...r }, null, 2));
      console.log(`\nrecorded → ${a.record}`);
    }
    if (r.plan.status !== 'done') process.exitCode = 1;
  }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

const COMMANDS = { start, status, report, list, cancel, kick, wake, run };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = COMMANDS[args._[0]];
  if (!cmd) {
    console.error('usage: playbooks-e2e.js start|status|report|list|cancel|kick|wake|run … [--remote https://host/agent] (see header)');
    process.exit(2);
  }
  let backend;
  try { backend = args.remote ? httpBackend(String(args.remote)) : localBackend(); }
  catch (e) { console.error(e.message); process.exit(1); }
  Promise.resolve().then(() => cmd(backend, args)).then(
    () => process.exit(process.exitCode || 0),
    e => { console.error(e.message); process.exit(1); });
}

module.exports = { parseArgs, latestPr, findPlanPr, tryAutoMerge, httpBackend };
