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

// The PR URL may live anywhere the step carries text: title, instructions, or
// evidence persisted by an earlier run.
// A playbook-compiled step carries no PR URL of its own — the PR is opened by an
// earlier step and recorded in the run notebook / that step's evidence. So when
// the step itself has none, fall back to the LATEST PR URL in `ctx.runText`.
function extractPrRef(ctx) {
  const item = ctx.item || {};
  const raw = [item.title, item.instructions, item.evidence_json, ctx.task && ctx.task.goal]
    .filter(Boolean).join('\n');
  const m = raw.match(PR_REF_RE);
  if (m) return { owner: m[1], repo: m[2], number: m[3], url: m[0] };
  const all = typeof ctx.runText === 'string' ? [...ctx.runText.matchAll(new RegExp(PR_REF_RE, 'g'))] : [];
  const last = all[all.length - 1];
  return last ? { owner: last[1], repo: last[2], number: last[3], url: last[0] } : null;
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

// ci_green / ci_and_staging_green — every check-run on the PR head must be
// completed+success. With no check-runs or no PR URL the answer is inconclusive,
// not pass: "no evidence" is not "green". The staging half has no shared health
// endpoint yet, so a green CI with `staging:true` stays inconclusive.
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
    const runs = (checks && checks.check_runs) || [];
    if (!runs.length) return inconclusive('no-check-runs', { pr: ref.url, sha: pr.head.sha });
    const subject = { pr: ref.url, sha: pr.head.sha, staging };
    const evidence = { checks: runs.map(r => ({ name: r.name, status: r.status, conclusion: r.conclusion })) };
    const failing = runs.filter(r => !(r.status === 'completed' && r.conclusion === 'success'));
    if (failing.length) return { status: 'fail', subject, evidence: { ...evidence, failing: failing.map(r => r.name) } };
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

// ── durable-wait conditions ─────────────────────────────────────────────────
// Cheap, model-free probes meant for `wait` steps: they are re-polled until they
// pass, so a "not yet" answer is `fail` (keep waiting), never a crash.

// http_ok: "https://…/health" or {url, contains?, status?}. Pass when the response
// status matches (default: any 2xx) and the body contains `contains` if given —
// e.g. a deploy is live once /health reports the merged commit.
function makeHttpOkValidator({ fetchImpl = (...a) => fetch(...a) } = {}) {
  return async function httpOk(ctx) {
    const spec = typeof ctx.validation === 'string' ? { url: ctx.validation } : (ctx.validation || {});
    if (!spec.url || !/^https?:\/\//.test(String(spec.url))) return inconclusive('no-url');
    const subject = { url: spec.url };
    let res; let body = '';
    try {
      res = await fetchImpl(spec.url, { signal: AbortSignal.timeout(15_000) });
      body = await res.text();
    } catch (e) {
      return { status: 'fail', subject, evidence: { reason: 'unreachable', error: e.message } };
    }
    const statusOk = spec.status != null ? res.status === Number(spec.status) : res.ok;
    const containsOk = spec.contains == null || body.includes(String(spec.contains));
    const evidence = { http_status: res.status, body: body.slice(0, 300) };
    return { status: statusOk && containsOk ? 'pass' : 'fail', subject, evidence };
  };
}

// token_present: "github" — the profile has a non-empty credential file for that
// service (ZeroCreds/connect flows write TOKENS_ROOT/<profile>/<service>). This is
// how a plan waits for the user to hand over credentials, even days later.
function tokenPresent(ctx) {
  const service = typeof ctx.validation === 'string' ? ctx.validation : ctx.validation && ctx.validation.service;
  if (!service || !/^[\w.-]+$/.test(service)) return inconclusive('no-service');
  if (!ctx.profileId) return inconclusive('no-profile');
  const { tokenPath } = require('./data-paths');
  const file = tokenPath(ctx.profileId, service);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* absent */ }
  return { status: size > 0 ? 'pass' : 'fail', subject: { service }, evidence: { present: size > 0 } };
}

// task_done: "<durable task id>" — another durable plan of the SAME profile has
// finished. Lets one plan wait for another. Lazy require: gtd-controller requires
// this module at load time.
function makeTaskDoneValidator({ taskStatus = defaultTaskStatus } = {}) {
  return function taskDone(ctx) {
    const taskId = typeof ctx.validation === 'string' ? ctx.validation : ctx.validation && ctx.validation.task_id;
    if (!taskId) return inconclusive('no-task-id');
    const status = taskStatus(taskId, ctx.profileId);
    if (status == null) return inconclusive('task-not-found', { task_id: taskId });
    return { status: status === 'done' ? 'pass' : 'fail', subject: { task_id: taskId }, evidence: { task_status: status } };
  };
}

function defaultTaskStatus(taskId, profileId) {
  const { durableStore } = require('./gtd-controller');
  const task = durableStore().getTask(taskId, profileId);
  return task ? task.status : null;
}

// ── run-time probes (declared in the run notebook) ──────────────────────────
// A playbook TEMPLATE cannot know the concrete deploy URL or log command of a
// run. An earlier agent step declares them in the run notebook, one per line:
//   PROBE deploy_live: http_ok https://host/health contains 3f2a9c1
//   PROBE error_gone: command ! journalctl -u app --since -30min | grep -q 'TypeError'
//   PROBE staging_ok: skip no staging for this repo
// and a later (typically waiting) programmatic step checks it by name with
// {"probe": "deploy_live"} — no model involved. The LAST declaration wins, so a
// step may re-declare a probe after learning more.
const PROBE_LINE_RE = /^\s*[-*]?\s*`?PROBE\s+([\w.-]+)\s*:\s*(http_ok|command|skip)\b\s*(.*?)`?\s*$/gim;

function parseProbes(text) {
  const probes = {};
  for (const m of String(text || '').matchAll(PROBE_LINE_RE)) {
    probes[m[1]] = { kind: m[2].toLowerCase(), arg: m[3].trim() };
  }
  return probes;
}

function makeProbeValidator({ httpOk = makeHttpOkValidator() } = {}) {
  return async function probe(ctx) {
    const name = typeof ctx.validation === 'string' ? ctx.validation : ctx.validation && ctx.validation.name;
    if (!name) return inconclusive('no-probe-name');
    const spec = parseProbes(ctx.runText)[name];
    // Not declared (yet) is a "not met", not a pass: a wait keeps polling and an
    // unwaited step fails visibly, pointing at the missing declaration.
    if (!spec) return { status: 'fail', subject: { probe: name }, evidence: { reason: 'probe-not-declared' } };
    if (spec.kind === 'skip') return { status: 'pass', subject: { probe: name }, evidence: { skipped: true, reason: spec.arg || 'unspecified' } };
    if (spec.kind === 'http_ok') {
      const m = spec.arg.match(/^(\S+)(?:\s+contains\s+(.+))?$/i);
      if (!m) return inconclusive('bad-probe', { probe: name });
      const res = await httpOk({ ...ctx, validation: { url: m[1], contains: m[2] ? m[2].trim() : undefined } });
      return { ...res, subject: { probe: name, ...(res.subject || {}) } };
    }
    if (!spec.arg) return inconclusive('bad-probe', { probe: name });
    const res = await commandExitZero({ ...ctx, validation: { command: spec.arg } });
    return { ...res, subject: { probe: name, ...(res.subject || {}) } };
  };
}

// probes_declared: ["deploy_live", …] — the step that plans the run declared every
// named probe in the notebook (deterministic check for the declaring step).
function probesDeclared(ctx) {
  const names = Array.isArray(ctx.validation) ? ctx.validation
    : (typeof ctx.validation === 'string' ? [ctx.validation] : []);
  if (!names.length) return inconclusive('no-probe-names');
  const probes = parseProbes(ctx.runText);
  const missing = names.filter(n => !probes[n]);
  return { status: missing.length ? 'fail' : 'pass', subject: { probes: names }, evidence: { missing } };
}

/**
 * Build a registry of the initial validation keys. `ghToken` / `ghFetch` are
 * overridable so tests drive the GitHub validators with fakes.
 */
function createDefaultRegistry({ ghToken = defaultGhToken, ghFetch = defaultGhFetch, gitInfo = defaultGitInfo, fetchImpl, taskStatus } = {}) {
  return {
    ci_green: makeCiValidator({ ghToken, ghFetch, staging: false }),
    ci_and_staging_green: makeCiValidator({ ghToken, ghFetch, staging: true }),
    merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    pr_merged: makeMergedValidator({ ghToken, ghFetch, deployed: false }),
    merged_and_deployed: makeMergedValidator({ ghToken, ghFetch, deployed: true }),
    pr_opened: makePrOpenedValidator({ ghToken, ghFetch, gitInfo }),
    file_exists: fileExists,
    command_exit_zero: commandExitZero,
    http_ok: makeHttpOkValidator(fetchImpl ? { fetchImpl } : {}),
    token_present: tokenPresent,
    task_done: makeTaskDoneValidator(taskStatus ? { taskStatus } : {}),
    probe: makeProbeValidator(fetchImpl ? { httpOk: makeHttpOkValidator({ fetchImpl }) } : {}),
    probes_declared: probesDeclared,
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
async function evaluateItemValidations(item, { task = null, profileId = null, projectDir = null, registry = null, runText = null } = {}) {
  // task_items stores the contract as `validation_json`; accept a raw `validation`
  // object too so unit tests can pass items without a DB round-trip.
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const validation = parseValidation(raw);
  const results = [];
  for (const [key, value] of Object.entries(validation)) {
    const ctx = { task, item, profileId, projectDir, validation: value, key, runText };
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
  mode = DEFAULT_VALIDATION_MODE, llmValidate = null, runText = null,
} = {}) {
  const raw = item && item.validation_json != null ? item.validation_json : item && item.validation;
  const validation = parseValidation(raw);
  const entries = Object.entries(validation);
  const useLlm = mode !== 'programmatic' && entries.length > 0;
  let excerpts = null;
  const results = [];
  for (const [key, value] of entries) {
    const ctx = { task, item, profileId, projectDir, validation: value, key, runText };
    let res = await evaluateValidation(key, ctx, registry);
    if (useLlm && res.status === 'inconclusive') {
      if (excerpts === null) excerpts = collectDocExcerpts(projectDir);
      const llmCtx = { ...ctx, excerpts, mode };
      const decided = await llmDecide(key, llmCtx, { llmValidate, mode });
      res = softenLlmVerdict(key, decided, ctx);
    }
    results.push({ key, ...res });
  }
  return results;
}

module.exports = {
  createDefaultRegistry, getDefaultRegistry, evaluateValidation, evaluateItemValidations,
  evaluateItemValidationsModeAware, resolveValidationMode,
  parseValidation, collectDocExcerpts, buildLlmValidatorPrompt, makeLlmValidate, getDefaultLlmValidate,
  makePrOpenedValidator, defaultGitInfo, gitRemoteRepo,
  makeHttpOkValidator, tokenPresent, makeTaskDoneValidator, extractPrRef,
  parseProbes, makeProbeValidator, probesDeclared,
  PR_REF_RE, DEFAULT_COMMAND_TIMEOUT_MS,
  VALIDATION_MODES, DEFAULT_VALIDATION_MODE, DEFAULT_VALIDATION_MODEL, LLM_VALIDATOR_TIMEOUT_MS,
  FASTPASS_SKIP_MODE, FASTPASS_SKIP_RE, parseFastpassSkip,
};
