'use strict';

// Playbook validator registry (issue #1372, slice P3d-1).
//
// The machine-checkable half of the playbook contract. A step's `validation`
// object names one or more validation KEYS ({ci_green: true}, {file_exists:
// "dist/app.js"}, {command_exit_zero: "npm test"}, …); a key maps to an async
// validator that answers `pass` / `fail` / `inconclusive` with `subject` and
// `evidence`. No new orchestration is invented here: the GitHub reads mirror
// `checklistCheapPrecheck` in gtd-controller (PR → head.sha → check-runs), the
// two local checks are deterministic and timeout-bounded, and every unknown key
// is inconclusive — a step must never silently pass because a validator is
// missing.
//
// The registry is injectable: `runDueDurable` takes a `registry` param, so tests
// substitute fakes and never touch the network, the filesystem or a shell.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PR_REF_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_STAT_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_CHARS = 200_000;

// ── validation_mode (P3d-1b) ────────────────────────────────────────────────
// Configurable strictness. The mode selects whether a cheap LLM validator may
// fill the gaps the deterministic registry leaves:
//   programmatic              — deterministic validators only.
//   programmatic+llm          — DEFAULT. Deterministic first; where a key has no
//                               validator OR returns inconclusive, an LLM decides.
//   programmatic+llm-fastpass — like +llm with a more forgiving prompt: it may
//                               look around the provided docs, tolerate trivial
//                               misses and supplement missing context. Still
//                               never a blind pass.
const VALIDATION_MODES = ['programmatic', 'programmatic+llm', 'programmatic+llm-fastpass'];
const DEFAULT_VALIDATION_MODE = 'programmatic+llm';
const DEFAULT_VALIDATION_MODEL = 'google/gemini-2.5-flash';
const LLM_VALIDATOR_TIMEOUT_MS = 15_000;
const MAX_DOC_FILES = 8;
const MAX_DOC_CHARS = 1200;
const MAX_DOC_TOTAL_CHARS = 8000;
const DOC_ROOTS = ['.', 'docs', 'docs/user-scenarios', 'user-scenarios', 'requirements'];

// ── fast-pass escape (P3d-1c) ───────────────────────────────────────────────
// The loosest mode carries one extra affordance: the step may SKIP its
// validations. It does so explicitly, by writing a final line
//   VALIDATION: fastpass-skip: <reason>
// in its reply. The skip is only honoured when the step's effective mode is
// `programmatic+llm-fastpass`, and it is always recorded in the audit trail
// (status 'pass' + evidence {skipped:true, reason, mode}) — never a silent pass.
const FASTPASS_SKIP_MODE = 'programmatic+llm-fastpass';
const FASTPASS_SKIP_RE = /VALIDATION:\s*fastpass-skip:\s*([^\n\r]+)/i;

function parseFastpassSkip(reply) {
  const m = String(reply || '').match(FASTPASS_SKIP_RE);
  if (!m) return null;
  const reason = m[1].trim();
  return reason || 'unspecified';
}

function inconclusive(reason, extra = {}) {
  return { status: 'inconclusive', subject: null, evidence: { reason, ...extra } };
}

// The PR URL may live anywhere the step carries text: an explicit validation
// value (`{"ci_green": "<PR url>"}` — what an agent's task_item_wait passes),
// the step's title/instructions/evidence, the evidence of EARLIER steps of the
// same plan (`ctx.planText` — "Open PR" records the URL, "Wait for CI" reads it;
// the most recent URL wins there), and finally the task goal.
function extractPrRef(ctx) {
  const toRef = m => (m ? { owner: m[1], repo: m[2], number: m[3], url: m[0] } : null);
  const v = ctx.validation;
  const explicit = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.pr === 'string' ? v.pr : null);
  if (explicit && PR_REF_RE.test(explicit)) return toRef(explicit.match(PR_REF_RE));
  const item = ctx.item || {};
  const own = [item.title, item.instructions, item.evidence_json].filter(Boolean).join('\n').match(PR_REF_RE);
  if (own) return toRef(own);
  if (typeof ctx.planText === 'string' && ctx.planText) {
    const all = [...ctx.planText.matchAll(new RegExp(PR_REF_RE.source, 'g'))];
    if (all.length) return toRef(all[all.length - 1]);
  }
  return toRef(String((ctx.task && ctx.task.goal) || '').match(PR_REF_RE));
}

// Default GitHub helpers delegate to gtd-controller (the checklist pre-check
// already owns token lookup + the fetch shape). Required lazily: gtd-controller
// requires this module at load time, so a top-level require would be circular.
function defaultGhToken(profileId) {
  try {
    const { _ghToken } = require('./gtd-controller');
    return _ghToken(profileId);
  } catch { return null; }
}

function defaultGhFetch(url, token) {
  const { _ghFetch } = require('./gtd-controller');
  return _ghFetch(url, token);
}

// Terminal conclusions that are NOT a failure: `skipped`/`neutral` belong to
// CONDITIONAL jobs (autofix only runs on a red PR, notify-merge-queue only on a
// push to main, close-original only on autofix PRs) — they are green-by-design,
// and counting them as red made every ci_green verdict in a repo with such jobs
// fail forever (PR #1782: ci+staging-gate+merge+deploy all success, verdict
// fail on 3 skips). Failure/timed_out/cancelled/stale/action_required stay red.
const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

// One shared verdict over check-runs / workflow-runs, used by the ci_green
// validator and by gtd-controller's checklist precheck — the rule must live in
// exactly one place, or the two drift and one of them blacks out again.
//   true  — at least one run succeeded and none is red or unfinished
//   false — a run is red or still running
//   null  — no evidence: no runs at all, or every run skipped/neutral
function checkRunsGreen(runs) {
  if (!Array.isArray(runs) || !runs.length) return null;
  if (runs.some(r => !(r.status === 'completed' && GREEN_CONCLUSIONS.has(r.conclusion)))) return false;
  if (!runs.some(r => r.status === 'completed' && r.conclusion === 'success')) return null;
  return true;
}

// ci_green / ci_and_staging_green — every check-run on the PR head must be
// completed with a non-failing conclusion. With no check-runs, no PR URL, or a
// head where EVERY run skipped (nothing actually ran), the answer is
// inconclusive, not pass: "no evidence" is not "green". The staging half has no
// shared health endpoint yet, so a green CI with `staging:true` stays inconclusive.
function makeCiValidator({ ghToken, ghFetch, staging = false }) {
  return async function ciValidator(ctx) {
    const ref = extractPrRef(ctx);
    if (!ref) return inconclusive('no-pr-url');
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token');
    let pr;
    try { pr = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    if (!pr) return inconclusive('pr-not-found', { pr: ref.url });
    if (!pr.head || !pr.head.sha) return inconclusive('no-head-sha', { pr: ref.url });
    let checks;
    try { checks = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${pr.head.sha}/check-runs`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    let runs = (checks && checks.check_runs) || [];
    let source = 'check-runs';
    // The Checks API is closed to fine-grained PATs (403 → ghFetch null), so a repo
    // whose token is a fine-grained PAT never shows check-runs even with green CI.
    // GitHub Actions runs for the same head SHA are readable with Actions:read.
    if (!runs.length) {
      let actions = null;
      try { actions = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/actions/runs?head_sha=${pr.head.sha}&per_page=50`, token); }
      catch { /* keep the check-runs verdict below */ }
      runs = ((actions && actions.workflow_runs) || []).map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
      source = 'actions-runs';
    }
    if (!runs.length) return inconclusive('no-check-runs', { pr: ref.url, sha: pr.head.sha });
    const subject = { pr: ref.url, sha: pr.head.sha, staging };
    const evidence = { source, checks: runs.map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion })) };
    const failing = runs.filter(r => !(r.status === 'completed' && GREEN_CONCLUSIONS.has(r.conclusion)));
    // `final` marks a verdict that more waiting cannot change: every run finished
    // and at least one is red. A durable wait wakes on it instead of polling a red
    // CI to its timeout; runs still in progress are a plain (non-final) fail.
    const pendingRuns = failing.filter(r => r.status !== 'completed');
    if (failing.length) {
      return { status: 'fail', subject, evidence: { ...evidence, failing: failing.map(r => r.name), final: pendingRuns.length === 0 } };
    }
    // Nothing actually ran (every run skipped/neutral) — no evidence, so no pass.
    if (checkRunsGreen(runs) !== true) {
      return inconclusive('all-runs-skipped', { pr: ref.url, sha: pr.head.sha });
    }
    if (staging) return { status: 'inconclusive', subject, evidence: { ...evidence, reason: 'staging-unverified' } };
    return { status: 'pass', subject, evidence };
  };
}

// merged / pr_merged / merged_and_deployed — GitHub PR `merged:true`. An unmerged
// PR is a hard fail. The deploy half has no cross-repo signal, so
// `deployed:true` reports the merge pass but stays inconclusive overall.
function makeMergedValidator({ ghToken, ghFetch, deployed = false }) {
  return async function mergedValidator(ctx) {
    const ref = extractPrRef(ctx);
    if (!ref) return inconclusive('no-pr-url');
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token');
    let pr;
    try { pr = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token); }
    catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
    if (!pr) return inconclusive('pr-not-found', { pr: ref.url });
    const merged = pr.merged === true;
    const subject = { pr: ref.url, merged };
    if (!merged) return { status: 'fail', subject, evidence: { state: pr.state || null, merged_at: pr.merged_at || null } };
    const evidence = { merged_at: pr.merged_at || null, merge_commit_sha: pr.merge_commit_sha || null };
    if (deployed) return { status: 'inconclusive', subject, evidence: { ...evidence, reason: 'deploy-unverified' } };
    return { status: 'pass', subject, evidence };
  };
}

// ci_run_green — a manually dispatched workflow run on a BRANCH has finished
// green. This is the durable-wait key of the «прогон тестов в облаке» flow (the
// `ci-run` playbook): `{ci_run_green: {repo: "owner/name", run_id: 123456}}`.
// Unlike ci_green this is one explicit run the agent itself started, so the
// verdict is per-run, not per-check-run:
//   completed + success  → pass (wake: the suite is green)
//   completed + anything else → fail with evidence.final:true — a finished run
//        never changes its mind, so waiting longer is pointless and the step
//        must wake to show the failed jobs / log tail («никогда не зелёный
//        молча»: skipped/neutral for a manual run means nothing actually ran);
//   queued / in_progress → inconclusive, keep polling;
//   missing repo/run_id, no token, run not found, API down → inconclusive —
//        «no evidence» is never «green», and a flaky API must not abort the wait.
function makeCiRunGreenValidator({ ghToken, ghFetch }) {
  return async function ciRunGreen(ctx) {
    const v = ctx.validation;
    const spec = v && typeof v === 'object' ? v : null;
    const repo = spec && typeof spec.repo === 'string' ? spec.repo : (typeof v === 'string' ? v : null);
    const runId = spec ? (spec.run_id ?? spec.runId) : null;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return inconclusive('no-repo', { validation: v });
    if (!runId || !/^\d+$/.test(String(runId))) return inconclusive('no-run-id', { repo });
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token', { repo, run_id: runId });
    let run;
    try {
      run = await ghFetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, token);
    } catch (e) {
      return inconclusive('github-unreachable', { error: e.message, repo, run_id: runId });
    }
    if (!run) return inconclusive('run-not-found', { repo, run_id: runId });
    const subject = { repo, run_id: runId, url: run.html_url || null };
    const evidence = { status: run.status || null, conclusion: run.conclusion || null };
    if (run.status !== 'completed') return inconclusive('run-not-finished', { ...subject, ...evidence });
    if (run.conclusion === 'success') return { status: 'pass', subject, evidence };
    return { status: 'fail', subject, evidence: { ...evidence, final: true } };
  };
}

// ── pr_opened (P3d follow-up, #1449) ────────────────────────────────────────
// Deterministic "a PR exists" check, so the engineering playbook's "Open PR"
// step no longer needs an LLM. Resolution, in order:
//   1. an explicit PR URL anywhere on the step (title/instructions/evidence/goal)
//      — verify it exists via `GET /repos/{owner}/{repo}/pulls/{n}`;
//   2. validation spec `{ repo: "owner/name", branch: "..." }`;
//   3. otherwise discover repo + current branch from the step's git checkout.
// A URL that 404s, or no PR for the branch, is a hard fail; missing inputs are
// inconclusive (never a silent pass). `gitInfo` is injectable so tests never
// shell out.
const GIT_REMOTE_RE = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;

function gitRemoteRepo(url) {
  const m = String(url || '').trim().match(GIT_REMOTE_RE);
  return m ? `${m[1]}/${m[2]}` : null;
}

function defaultGitInfo(projectDir) {
  if (!projectDir) return null;
  const run = args => {
    try {
      const r = spawnSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', timeout: DEFAULT_STAT_TIMEOUT_MS });
      return r.status === 0 ? (r.stdout || '').trim() : null;
    } catch { return null; }
  };
  const repo = gitRemoteRepo(run(['remote', 'get-url', 'origin']));
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!repo || !branch || branch === 'HEAD') return null;
  return { repo, branch };
}

function makePrOpenedValidator({ ghToken, ghFetch, gitInfo = defaultGitInfo }) {
  return async function prOpenedValidator(ctx) {
    const token = ghToken(ctx.profileId);
    if (!token) return inconclusive('no-github-token');

    // 1. An explicit PR reference: confirm it exists.
    const ref = extractPrRef(ctx);
    if (ref) {
      let pr;
      try { pr = await ghFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token); }
      catch (e) { return inconclusive('github-unreachable', { error: e.message, pr: ref.url }); }
      if (!pr) return inconclusive('pr-not-found', { pr: ref.url });
      return {
        status: 'pass',
        subject: { pr: ref.url, number: ref.number, repo: `${ref.owner}/${ref.repo}` },
        evidence: { state: pr.state || null, merged: pr.merged === true, head: (pr.head && pr.head.ref) || null },
      };
    }

    // 2/3. Look up a PR for this repo + head branch.
    const spec = typeof ctx.validation === 'object' && ctx.validation ? ctx.validation : {};
    let repo = typeof spec.repo === 'string' ? spec.repo : null;
    let branch = typeof spec.branch === 'string' ? spec.branch : null;
    if ((!repo || !branch) && typeof gitInfo === 'function') {
      let info = null;
      try { info = gitInfo(ctx.projectDir); } catch { info = null; }
      if (info) { repo = repo || info.repo || null; branch = branch || info.branch || null; }
    }
    if (!repo || !branch) return inconclusive('no-pr-reference', { repo: repo || null, branch: branch || null });

    const owner = repo.split('/')[0];
    let prs;
    try {
      prs = await ghFetch(`https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`, token);
    } catch (e) { return inconclusive('github-unreachable', { error: e.message, repo, branch }); }
    const list = Array.isArray(prs) ? prs : [];
    if (!list.length) return { status: 'fail', subject: { repo, branch }, evidence: { reason: 'no-pr-for-branch' } };
    const pr = list[0];
    return {
      status: 'pass',
      subject: { repo, branch, number: pr.number || null, pr: pr.html_url || null },
      evidence: { state: pr.state || null, merged: pr.merged_at != null, head: (pr.head && pr.head.ref) || null },
    };
  };
}

// file_exists — subject is a repo-relative path resolved against the step's
// project/workDir. Deterministic, no model, no network.
async function fileExists(ctx) {
  const validation = ctx.validation;
  const rel = typeof validation === 'string' ? validation : validation && validation.path;
  if (!rel) return inconclusive('no-path');
  if (!ctx.projectDir) return inconclusive('no-project-dir', { path: rel });
  const target = path.isAbsolute(rel) ? rel : path.join(ctx.projectDir, rel);
  const subject = { path: target, relative: rel };
  try {
    const stat = await fs.promises.stat(target, { signal: AbortSignal.timeout(DEFAULT_STAT_TIMEOUT_MS) });
    if (stat.isFile() || stat.isDirectory()) return { status: 'pass', subject, evidence: { size: stat.size } };
    return { status: 'fail', subject, evidence: { reason: 'not-a-file' } };
  } catch (e) {
    return { status: 'fail', subject, evidence: { reason: 'missing', error: e.code || e.message } };
  }
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise(resolve => {
    const subject = { command, cwd };
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn(command, { cwd, shell: true, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      done({ status: 'fail', subject, evidence: { error: e.message } });
      return;
    }
    child.stdout.on('data', d => { if (stdout.length < MAX_CAPTURE_CHARS) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < MAX_CAPTURE_CHARS) stderr += d; });
    child.on('error', e => done({
      status: 'fail', subject,
      evidence: { error: e.name === 'AbortError' ? 'timeout' : e.message, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) },
    }));
    child.on('close', code => {
      const evidence = { exit_code: code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
      done(code === 0 ? { status: 'pass', subject, evidence } : { status: 'fail', subject, evidence });
    });
  });
}

// command_exit_zero — success is the exit code, not a model's judgement. cwd is
// the step's project/workDir; the child is hard-killed by an AbortSignal timeout.
async function commandExitZero(ctx) {
  const validation = ctx.validation;
  const command = typeof validation === 'string' ? validation : validation && validation.command;
  if (!command) return inconclusive('no-command');
  const timeoutMs = Number.isFinite(validation && validation.timeout_ms) && validation.timeout_ms > 0
    ? validation.timeout_ms : DEFAULT_COMMAND_TIMEOUT_MS;
  const cwd = ctx.projectDir || process.cwd();
  return runCommand(String(command), cwd, timeoutMs);
}

// credential_present — the profile has a stored credential for a service
// (~/agent-tokens/<profile>/<service>, a non-empty file or directory). This is
// what a step waiting for the user to connect GitHub / paste an API key polls.
const SERVICE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
async function credentialPresent(ctx) {
  const v = ctx.validation;
  const service = typeof v === 'string' ? v : v && v.service;
  if (!service || !SERVICE_RE.test(service) || service.includes('..')) return inconclusive('bad-service', { service: service || null });
  if (!ctx.profileId) return inconclusive('no-profile');
  const { tokenPath } = require('./data-paths');
  const target = tokenPath(ctx.profileId, service);
  const subject = { service };
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(target);
      return entries.length ? { status: 'pass', subject, evidence: { kind: 'dir', entries: entries.length } }
        : { status: 'fail', subject, evidence: { reason: 'empty' } };
    }
    return stat.size > 0 ? { status: 'pass', subject, evidence: { kind: 'file' } }
      : { status: 'fail', subject, evidence: { reason: 'empty' } };
  } catch {
    return { status: 'fail', subject, evidence: { reason: 'missing' } };
  }
}

// http_ok — GET a URL; pass on 2xx, optionally also requiring `contains` in the
// body (e.g. a /health endpoint that reports the deployed commit SHA). A network
// error is inconclusive (retry on the next poll), a wrong status/body is a fail.
const HTTP_TIMEOUT_MS = 15_000;
function makeHttpOkValidator({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  return async function httpOk(ctx) {
    const v = ctx.validation;
    const url = typeof v === 'string' ? v : v && v.url;
    if (!url || !/^https?:\/\//i.test(url)) return inconclusive('no-url');
    const contains = v && typeof v === 'object' && v.contains != null ? String(v.contains) : null;
    const subject = { url, contains };
    let res;
    let body = '';
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      body = await res.text();
    } catch (e) {
      return inconclusive('unreachable', { url, error: e.message });
    }
    const evidence = { http_status: res.status, body: body.slice(0, 500) };
    if (!res.ok) return { status: 'fail', subject, evidence };
    if (contains != null && !body.includes(contains)) return { status: 'fail', subject, evidence: { ...evidence, reason: 'text-not-found' } };
    return { status: 'pass', subject, evidence };
  };
}

// task_done — another durable plan (same profile) reached `done`. Lets a step
// wait for a parallel plan (a research plan, a sibling feature) instead of polling
// it by hand. A missing task is a fail; failed/cancelled is a fail with its status.
function makeTaskDoneValidator({ getTask = null } = {}) {
  return async function taskDone(ctx) {
    const v = ctx.validation;
    const taskId = typeof v === 'string' ? v : v && v.task_id;
    if (!taskId) return inconclusive('no-task-id');
    if (!ctx.profileId) return inconclusive('no-profile');
    let task;
    try {
      const lookup = getTask || ((id, profileId) => {
        const { durableStore } = require('./gtd-controller');
        return durableStore().getTask(id, profileId);
      });
      task = lookup(taskId, ctx.profileId);
    } catch (e) { return inconclusive('store-error', { error: e.message }); }
    if (!task) return { status: 'fail', subject: { task_id: taskId }, evidence: { reason: 'not-found' } };
    return { status: task.status === 'done' ? 'pass' : 'fail', subject: { task_id: taskId }, evidence: { task_status: task.status } };
  };
}

// ── mode resolution (P3d-1b, per-step P3d-1c) ───────────────────────────────
// Precedence: per-step task_items.validation_mode > per-plan
// durable_tasks.execution_policy_json.validation_mode > env PLAYBOOK_VALIDATION_MODE
// > default 'programmatic+llm'. An unknown value at any level is ignored (falls
// through) rather than silently accepted.
function resolveValidationMode({ task = null, item = null, env = process.env } = {}) {
  const fromStep = item && item.validation_mode;
  if (VALIDATION_MODES.includes(fromStep)) return fromStep;
  let fromPlan = null;
  if (task && task.execution_policy_json) {
    try {
      const policy = JSON.parse(task.execution_policy_json);
      if (policy && typeof policy.validation_mode === 'string') fromPlan = policy.validation_mode;
    } catch { /* malformed policy → fall through to env/default */ }
  }
  if (VALIDATION_MODES.includes(fromPlan)) return fromPlan;
  const fromEnv = env && env.PLAYBOOK_VALIDATION_MODE;
  if (VALIDATION_MODES.includes(fromEnv)) return fromEnv;
  return DEFAULT_VALIDATION_MODE;
}

// ── LLM validator (P3d-1b) ──────────────────────────────────────────────────
// A bounded, cheap OpenRouter call used only when the deterministic registry has
// no answer. It is injected everywhere (runDueDurable's `llmValidate` param) so
// tests never touch the network. On any error / unparseable verdict the answer
// is `inconclusive` — never a blind pass.

// Bounded excerpt set of the repo docs most likely to carry step evidence. Reads
// only markdown from a few known roots; hard caps on file count and chars keep
// the prompt small and the read cheap.
// What the plan actually has in git: the plan works in ONE engineering workspace
// whose branch ends with plan-<id8> (one workspace per plan). The judge sees the
// committed history of that branch and — the key signal — anything left uncommitted
// (an artifact that never reached the branch does not exist for the next step).
const PLAN_EVIDENCE_MAX_CHARS = 4000;
function collectPlanWorkspaceEvidence({ profileId, taskId, root = null } = {}) {
  if (!profileId || !taskId) return null;
  let base = root;
  if (!base) {
    try { base = require('./data-paths').engineeringWorkspacesDir(profileId); } catch { return null; }
  }
  const suffix = `plan-${String(taskId).slice(0, 8)}`;
  const git = (dir, args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: DEFAULT_STAT_TIMEOUT_MS });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  };
  let repos = [];
  try { repos = fs.readdirSync(base); } catch { return null; }
  for (const repo of repos) {
    let wss = [];
    try { wss = fs.readdirSync(path.join(base, repo)).filter(d => d.startsWith('ws-')); } catch { continue; }
    for (const ws of wss) {
      const dir = path.join(base, repo, ws, 'code');
      const branch = git(dir, ['branch', '--show-current']);
      if (!branch || !branch.endsWith(suffix)) continue;
      const status = git(dir, ['status', '--short']);
      const log = git(dir, ['log', '-6', '--stat', '--format=%h %s']);
      const text = [
        `Plan branch: ${branch} (${repo})`,
        `Uncommitted in the plan workspace: ${status ? `\n${status}` : 'nothing'}`,
        `Recent commits on the plan branch:\n${log || '(none)'}`,
      ].join('\n');
      return text.slice(0, PLAN_EVIDENCE_MAX_CHARS);
    }
  }
  return null;
}

function collectDocExcerpts(projectDir) {
  if (!projectDir) return [];
  const files = [];
  for (const rel of DOC_ROOTS) {
    const dir = rel === '.' ? projectDir : path.join(projectDir, rel);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && /\.md$/i.test(e.name)) files.push(path.join(dir, e.name));
    }
  }
  const excerpts = [];
  let total = 0;
  for (const f of [...new Set(files)].sort()) {
    if (excerpts.length >= MAX_DOC_FILES || total >= MAX_DOC_TOTAL_CHARS) break;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const trimmed = text.slice(0, MAX_DOC_CHARS);
    total += trimmed.length;
    excerpts.push({ path: path.relative(projectDir, f), text: trimmed });
  }
  return excerpts;
}

function describeValidation(key, value) {
  if (value === true) return `${key} (must be true)`;
  if (typeof value === 'string') return `${key}: ${value}`;
  try { return `${key}: ${JSON.stringify(value)}`; } catch { return key; }
}

// The prompt is where the softening auto-resolver is declared: the judge is told
// to accept a near-equivalent reference and to count a repo scenario doc as proof
// for `user_value_*` checks. The deterministic post-check below backs it up.
function buildLlmValidatorPrompt(ctx) {
  const task = ctx.task || {};
  const item = ctx.item || {};
  const forgiving = ctx.mode === 'programmatic+llm-fastpass';
  const system = [
    'You are a strict but fair validation judge for an automated task step.',
    'Decide whether the step SATISFIES the named validation key using only the provided evidence and repo excerpts.',
    'Reply with STRICT JSON only: {"status":"pass"|"fail"|"inconclusive","reason":"<short>"}.',
    'Use "inconclusive" when the context is insufficient to decide — never guess a pass.',
    'SOFTENING: if the check names an explicit reference (e.g. pr_opened) and it is not stated verbatim, accept a near-equivalent that is present (e.g. a referenced or existing PR for this step) and cite it.',
    'For user_value_* checks a referenced repo scenario doc counts as proof when it states the user value and lists at least two ordered steps.',
    forgiving
      ? 'FASTPASS: tolerate trivial wording misses; look around the provided excerpts and supplement missing context before deciding. Still never a blind pass.'
      : '',
  ].filter(Boolean).join(' ');

  const parts = [
    `Task goal: ${task.goal || '(none)'}`,
    `Step: ${item.title || '(untitled)'}`,
    item.instructions ? `Step instructions: ${item.instructions}` : '',
    `Validation key: ${ctx.key}`,
    `Validation expectation: ${describeValidation(ctx.key, ctx.validation)}`,
    item.evidence_json ? `Step evidence: ${String(item.evidence_json).slice(0, 4000)}` : '',
    // The agent's own reply for THIS run — validation runs before the reply is stored
    // as evidence, so without this the judge never saw what the step did.
    ctx.reply ? `Agent reply for this step:\n${String(ctx.reply).slice(-4000)}` : '',
    ctx.planEvidence ? `Plan workspace (git) — what is really committed:\n${ctx.planEvidence}` : 'Plan workspace (git): (not found)',
    ctx.planText ? `Earlier steps of this plan (tail):\n${String(ctx.planText).slice(-2000)}` : '',
  ].filter(Boolean);
  const excerpts = Array.isArray(ctx.excerpts) ? ctx.excerpts : [];
  parts.push(excerpts.length
    ? `Relevant repo docs:\n${excerpts.map(ex => `--- ${ex.path} ---\n${ex.text}`).join('\n')}`
    : 'Relevant repo docs: (none)');
  return { system, user: parts.join('\n') };
}

function parseJsonLoose(raw) {
  const s = String(raw || '').replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch { return null; }
}

// Default `llmValidate`: one bounded request on the service-LLM ladder (src/service-llm.js: Go
// rungs → OpenRouter last) returning a verdict object. With no provider key it short-circuits to
// inconclusive without a request.
function makeLlmValidate({ fetchImpl = null, apiKey = null, timeoutMs = LLM_VALIDATOR_TIMEOUT_MS } = {}) {
  return async function llmValidate(ctx) {
    const serviceLlm = require('./service-llm');
    if (!serviceLlm.available(apiKey)) return { status: 'inconclusive', reason: 'no-llm-key' };
    const { system, user } = buildLlmValidatorPrompt(ctx);
    const r = await serviceLlm.serviceChat({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      json: true, maxTokens: 200, timeoutMs, apiKey, source: 'playbook-validator', fetchImpl,
      // D1 attribution (#1917): the ids this call actually has — the plan task, the
      // execution that fired the step, the profile that owns them.
      ctx: {
        trace: ctx.task && ctx.task.id,
        run: ctx.executionId,
        user: ctx.profileId,
      },
    });
    if (!r) return { status: 'inconclusive', reason: 'llm-unavailable' };
    const obj = r.value;
    if (!obj || typeof obj !== 'object') return { status: 'inconclusive', reason: 'llm-bad-json' };
    return { status: obj.status, reason: obj.reason };
  };
}

let _defaultLlmValidate = null;
function getDefaultLlmValidate() {
  if (!_defaultLlmValidate) _defaultLlmValidate = makeLlmValidate();
  return _defaultLlmValidate;
}

function normalizeLlmVerdict(res) {
  if (!res || typeof res !== 'object') return null;
  if (!['pass', 'fail', 'inconclusive'].includes(res.status)) return null;
  return { status: res.status, reason: res.reason == null ? null : String(res.reason) };
}

async function llmDecide(key, ctx, { llmValidate = null, mode = DEFAULT_VALIDATION_MODE } = {}) {
  const decide = typeof llmValidate === 'function' ? llmValidate : getDefaultLlmValidate();
  let raw;
  try {
    raw = await decide({ ...ctx, key, mode });
  } catch (e) {
    return inconclusive('llm-error', { source: 'llm', error: e && e.message });
  }
  const verdict = normalizeLlmVerdict(raw);
  if (!verdict) return inconclusive('llm-invalid-verdict', { source: 'llm' });
  return { status: verdict.status, subject: { key }, evidence: { source: 'llm', reason: verdict.reason } };
}

// Softening auto-resolver (orthogonal to the mode): before a missing explicit
// reference is allowed to hard-fail a check, look for a concrete near-equivalent
// already present in the step (e.g. a PR URL for a `pr_*` / `ci_*` / `*merged*`
// key). A near-equivalent downgrades the verdict from `fail` to `inconclusive`
// and is recorded as evidence — it never auto-passes and never hides the reason.
const MISSING_REFERENCE_RE = /(not\s+(?:stated|provided|referenced|found|present|mentioned)|missing|no\s+(?:pr|reference|evidence|proof|mention)|отсутств|не\s+указан|нет\s+ссылк)/i;
const REFERENCE_KEY_RE = /(^|[_-])(pr|pull|merge|ci)($|[_-])/i;

function findNearEquivalent(key, ctx) {
  if (!REFERENCE_KEY_RE.test(key)) return null;
  const ref = extractPrRef(ctx);
  return ref ? { kind: 'pr', ...ref } : null;
}

function softenLlmVerdict(key, result, ctx) {
  if (!result || result.status !== 'fail') return result;
  const reason = (result.evidence && result.evidence.reason) || '';
  if (!MISSING_REFERENCE_RE.test(reason)) return result;
  const near = findNearEquivalent(key, ctx);
  if (!near) return result;
  return {
    status: 'inconclusive',
    subject: result.subject,
    evidence: { source: 'llm', reason: 'softened-near-equivalent', near_equivalent: near, llm_reason: reason },
  };
}

// One-line RU note per registry key, kept next to the registry so the authoring
// prompt (Hermes) documents exactly what the runtime can actually check. A key
// without a note still appears in the catalog (empty note) — the source of truth
// for WHICH keys exist is always the registry itself (never this map).
const VALIDATOR_NOTES = {
  ci_green: 'CI-прогон PR зелёный (по ссылке на PR)',
  ci_and_staging_green: 'CI и staging-гейт по PR зелёные',
  merged: 'PR смержен',
  pr_merged: 'PR смержен (то же, что merged)',
  merged_and_deployed: 'PR смержен и задеплоен',
  pr_opened: 'PR открыт (в тексте есть ссылка на PR)',
  file_exists: 'файл по указанному пути существует',
  command_exit_zero: 'команда завершилась с кодом 0',
  credential_present: 'нужный ключ/креденшл сохранён у профиля',
  http_ok: 'URL отвечает 2xx (и содержит подстроку, если задана)',
  task_done: 'другой durable-план завершён',
  fanout_joined: 'все элементы пачки завершены или пропущены',
};

/**
 * The catalog of real validation keys, derived from the registry (single source
 * of truth, C3) plus the RU note from VALIDATOR_NOTES. Consumed by the authoring
 * prompt and the authoring semantic check — never a hardcoded list.
 */
function listValidatorCatalog(registry) {
  const reg = registry || getDefaultRegistry();
  return Object.keys(reg).map(key => ({ key, note: VALIDATOR_NOTES[key] || '' }));
}

/**
 * Build a registry of the initial validation keys. `ghToken` / `ghFetch` are
 * overridable so tests drive the GitHub validators with fakes.
 */
function createDefaultRegistry({ ghToken = defaultGhToken, ghFetch = defaultGhFetch, gitInfo = defaultGitInfo, fetchImpl, getTask } = {}) {
  return {
    ci_green: makeCiValidator({ ghToken, ghFetch, staging: false }),
    ci_and_staging_green: makeCiValidator({ ghToken, ghFetch, staging: true }),
    // A dispatched branch run (ci-run playbook): {repo, run_id}. Registered so
    // task_item_wait's `until` accepts it — an unknown key is rejected there.
    ci_run_green: makeCiRunGreenValidator({ ghToken, ghFetch }),
    merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    pr_merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    merged_and_deployed: makeMergedValidator({ ghToken, ghFetch, deployed: true }),
    pr_opened: makePrOpenedValidator({ ghToken, ghFetch, gitInfo }),
    file_exists: fileExists,
    command_exit_zero: commandExitZero,
    credential_present: credentialPresent,
    http_ok: makeHttpOkValidator(fetchImpl ? { fetchImpl } : {}),
    task_done: makeTaskDoneValidator({ getTask }),
    // #1752: a fanout step is joined — every element of the batch done or skipped.
    fanout_joined: require('./playbook-fanout').makeFanoutJoinedValidator(),
  };
}

let _defaultRegistry = null;
function getDefaultRegistry() {
  if (!_defaultRegistry) _defaultRegistry = createDefaultRegistry();
  return _defaultRegistry;
}

/** Evaluate one validation key. Unknown key → inconclusive, never a silent pass. */
function evaluateValidation(key, ctx, registry) {
  const reg = registry || getDefaultRegistry();
  const fn = reg && reg[key];
  if (typeof fn !== 'function') {
    return Promise.resolve({ status: 'inconclusive', subject: null, evidence: { reason: 'no-validator', key } });
  }
  return Promise.resolve().then(() => fn(ctx));
}

function parseValidation(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* not json */ }
  }
  return {};
}

/**
 * Evaluate every key declared by an item's `validation` object.
 * @returns {Promise<Array<{key,status,subject,evidence}>>}
 */
async function evaluateItemValidations(item, { task = null, profileId = null, projectDir = null, registry = null, planText = null } = {}) {
  // task_items stores the contract as `validation_json`; accept a raw `validation`
  // object too so unit tests can pass items without a DB round-trip.
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const validation = parseValidation(raw);
  const results = [];
  for (const [key, value] of Object.entries(validation)) {
    const ctx = { task, item, profileId, projectDir, validation: value, key, planText };
    const res = await evaluateValidation(key, ctx, registry);
    results.push({ key, ...res });
  }
  return results;
}

/**
 * Mode-aware evaluation (P3d-1b). `programmatic` is the P3d-1 path exactly.
 * In either +llm mode the deterministic validator runs first and only an
 * inconclusive verdict (including "no validator") is handed to `llmValidate`.
 */
async function evaluateItemValidationsModeAware(item, {
  task = null, profileId = null, projectDir = null, registry = null,
  mode = DEFAULT_VALIDATION_MODE, llmValidate = null, planText = null, reply = null,
  // #1917: forwarded into the LLM judge's x-ladder-run (D1 ladder_calls.run_id).
  executionId = null,
} = {}) {
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const validation = parseValidation(raw);
  const entries = Object.entries(validation);
  const useLlm = mode !== 'programmatic' && entries.length > 0;
  let excerpts = null;
  let planEvidence;
  const results = [];
  for (const [key, value] of entries) {
    const ctx = { task, item, profileId, projectDir, validation: value, key, planText, executionId };
    let res = await evaluateValidation(key, ctx, registry);
    if (useLlm && res.status === 'inconclusive') {
      if (excerpts === null) excerpts = collectDocExcerpts(projectDir);
      if (planEvidence === undefined) planEvidence = collectPlanWorkspaceEvidence({ profileId, taskId: task && task.id });
      const llmCtx = { ...ctx, excerpts, mode, reply, planEvidence };
      const decided = await llmDecide(key, llmCtx, { llmValidate, mode });
      res = softenLlmVerdict(key, decided, ctx);
    }
    results.push({ key, ...res });
  }
  return results;
}

module.exports = {
  collectPlanWorkspaceEvidence,
  createDefaultRegistry, getDefaultRegistry, evaluateValidation, evaluateItemValidations,
  evaluateItemValidationsModeAware, resolveValidationMode,
  parseValidation, collectDocExcerpts, buildLlmValidatorPrompt, makeLlmValidate, getDefaultLlmValidate,
  makePrOpenedValidator, defaultGitInfo, gitRemoteRepo, extractPrRef, checkRunsGreen,
  credentialPresent, makeHttpOkValidator, makeTaskDoneValidator,
  VALIDATOR_NOTES, listValidatorCatalog,
  PR_REF_RE, DEFAULT_COMMAND_TIMEOUT_MS,
  VALIDATION_MODES, DEFAULT_VALIDATION_MODE, DEFAULT_VALIDATION_MODEL, LLM_VALIDATOR_TIMEOUT_MS,
  FASTPASS_SKIP_MODE, FASTPASS_SKIP_RE, parseFastpassSkip,
};
