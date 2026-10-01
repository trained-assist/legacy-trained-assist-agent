'use strict';

// Subject vocabulary for event-driven durable waits (issue #1846).
//
// A durable wait may name an EXTERNAL thing to wait for:
//   {issue_pr_merged:      "trained-assist/agent#1846"}
//   {issue_pr_ci_green:    "trained-assist/agent#1846"}
//   {workflow_run_green:   "trained-assist/agent/actions/runs/987654321"}
//   {workflow_job_completed: "trained-assist/agent/actions/runs/987654321/jobs/42"}
// A GitHub webhook delivers ONE event; this module answers the only question
// the wake path needs: which subscribed subjects does it match?
//
// Pure logic — no network, no store. The webhook handler stays a thin adapter,
// and the matcher is unit-testable on its own.
//
// Deliberately conservative: a subject that cannot be parsed yields NO subject
// (the event matches nothing) rather than a wildcard. "Wake every waiting step"
// on an unrecognised payload is exactly the failure mode this guards against —
// a wrong wake spends a model run on a step whose condition does not hold.

const ISSUE_KEYS = ['issue_pr_merged', 'issue_pr_ci_green'];
const RUN_KEYS = ['workflow_run_completed', 'workflow_run_green'];
const JOB_KEYS = ['workflow_job_completed'];

/** Every validator key that names an external GitHub event. */
const EVENT_VALIDATOR_KEYS = [...ISSUE_KEYS, ...RUN_KEYS, ...JOB_KEYS];

const REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;
const ISSUE_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const RUN_RE = /^([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)$/;
const JOB_RE = /^([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)\/jobs\/(\d+)$/;
const NUM_RE = /^\d+$/;

/** "owner/repo" → {owner, repo}; null when it is not a repo name. */
function parseRepo(value) {
  const m = REPO_RE.exec(String(value == null ? '' : value).trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The subject of an issue/PR-scoped wait: "owner/repo#N" or {repo, number}.
 * @returns {{owner:string,repo:string,number:number}|null}
 */
function parseIssueSubject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = parseRepo(value.repo);
    const n = Number(value.number ?? value.pr ?? value.issue);
    if (!r || !Number.isInteger(n) || n <= 0) return null;
    return { ...r, number: n };
  }
  const m = ISSUE_RE.exec(String(value == null ? '' : value).trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/**
 * The subject of a run-scoped wait: "owner/repo/actions/runs/<id>" or
 * {repo, run_id}. A bare "<id>" is accepted (run ids are globally unique on
 * GitHub) — the validator still needs a repo for the API call and will report
 * inconclusive when there is none; the matcher only needs the number.
 * @returns {{owner:string|null,repo:string|null,runId:number}|null}
 */
function parseRunSubject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = parseRepo(value.repo);
    const id = Number(value.run_id ?? value.runId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return { owner: r ? r.owner : null, repo: r ? r.repo : null, runId: id };
  }
  const s = String(value == null ? '' : value).trim();
  const m = RUN_RE.exec(s);
  if (m) return { owner: m[1], repo: m[2], runId: Number(m[3]) };
  return NUM_RE.test(s) ? { owner: null, repo: null, runId: Number(s) } : null;
}

/**
 * The subject of a job-scoped wait: "…/actions/runs/<id>/jobs/<jobId>" or
 * {repo, run_id, job_id} / {repo, job_id}. A bare number is a JOB id (GitHub
 * job ids are unique per repo but not globally — it is stored and compared, not
 * resolved, so it still works as a wait subject).
 * @returns {{owner:string|null,repo:string|null,runId:number|null,jobId:number}|null}
 */
function parseJobSubject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const r = parseRepo(value.repo);
    const runId = Number(value.run_id ?? value.runId);
    const jobId = Number(value.job_id ?? value.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) return null;
    return {
      owner: r ? r.owner : null, repo: r ? r.repo : null,
      runId: Number.isInteger(runId) && runId > 0 ? runId : null, jobId,
    };
  }
  const s = String(value == null ? '' : value).trim();
  const m = JOB_RE.exec(s);
  if (m) return { owner: m[1], repo: m[2], runId: Number(m[3]), jobId: Number(m[4]) };
  return NUM_RE.test(s) ? { owner: null, repo: null, runId: null, jobId: Number(s) } : null;
}

/** Canonical string forms — what a delivery is compared against. */
function issueKey(s) { return `${s.owner}/${s.repo}#${s.number}`; }
function runKey(s) { return `${s.owner}/${s.repo}/actions/runs/${s.runId}`; }
function jobKey(s) { return `${s.owner}/${s.repo}/actions/runs/${s.runId}/jobs/${s.jobId}`; }

const repoFullName = (payload) => {
  const full = payload && payload.repository && payload.repository.full_name;
  if (typeof full === 'string' && REPO_RE.test(full)) return full;
  const r = parseRepo(full);
  return r ? `${r.owner}/${r.repo}` : null;
};

/**
 * The subjects ONE GitHub delivery speaks about. Returns only what the payload
 * actually asserts:
 *   • pull_request closed AND merged → its issue subject (an opened/closed-unmerged
 *     PR asserts nothing — waiting for a merge must keep waiting);
 *   • workflow_run completed → its run subject;
 *   • workflow_job completed → its job subject (plus the parent run, so a
 *     job-scoped and a run-scoped wait both hear about it).
 * @returns {{issues:string[], runs:string[], jobs:string[]}}
 */
function subjectsFromDelivery(event, payload) {
  const out = { issues: [], runs: [], jobs: [] };
  const repo = repoFullName(payload);
  if (!repo) return out;
  if (event === 'pull_request' || event === 'pull_request_review' || event === 'pull_request_target') {
    const pr = payload.pull_request;
    // merged === true is the assertion; action/state alone is not enough
    // (a closed-unmerged PR will never become merged).
    if (pr && pr.merged === true && Number.isInteger(Number(pr.number))) {
      out.issues.push(`${repo}#${Number(pr.number)}`);
    }
    return out;
  }
  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    if (run && run.status === 'completed' && Number.isInteger(Number(run.id))) {
      out.runs.push(`${repo}/actions/runs/${Number(run.id)}`);
    }
    return out;
  }
  if (event === 'workflow_job') {
    const job = payload.workflow_job;
    if (job && job.status === 'completed' && Number.isInteger(Number(job.id))) {
      const runId = Number(job.run_id);
      if (Number.isInteger(runId) && runId > 0) {
        out.jobs.push(`${repo}/actions/runs/${runId}/jobs/${Number(job.id)}`);
        out.runs.push(`${repo}/actions/runs/${runId}`);
      } else {
        out.jobs.push(`${repo}/actions/jobs/${Number(job.id)}`);
      }
    }
    return out;
  }
  return out;
}

function sameIssue(a, b) {
  return a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}
function sameRun(a, b) {
  return a.runId === b.runId
    // A subject with no repo (bare id) matches any repo — run ids are global.
    && (!a.owner || !b.owner || (a.owner === b.owner && a.repo === b.repo));
}
function sameJob(a, b) {
  return a.jobId === b.jobId
    && (!a.owner || !b.owner || (a.owner === b.owner && a.repo === b.repo));
}

/**
 * Which keys of a wait's `until` does this delivery match?
 * @param {object} until a wait's condition ({validator_key: subject})
 * @param {string} event `x-github-event`
 * @param {object} payload parsed webhook body
 * @returns {Array<{key:string,subject:string}>} matched keys (deduped, empty = nothing to wake)
 */
function matchUntil(until, event, payload) {
  if (!until || typeof until !== 'object' || Array.isArray(until)) return [];
  const delivered = subjectsFromDelivery(event, payload);
  if (!delivered.issues.length && !delivered.runs.length && !delivered.jobs.length) return [];
  const hits = [];
  const seen = new Set();
  const add = (key, subject) => { if (!seen.has(key)) { seen.add(key); hits.push({ key, subject }); } };
  for (const [key, raw] of Object.entries(until)) {
    if (ISSUE_KEYS.includes(key)) {
      const want = parseIssueSubject(raw);
      if (!want) continue;
      if (delivered.issues.some((d) => sameIssue(want, parseIssueSubject(d)))) add(key, issueKey(want));
    } else if (RUN_KEYS.includes(key)) {
      const want = parseRunSubject(raw);
      if (!want) continue;
      if (delivered.runs.some((d) => sameRun(want, parseRunSubject(d)))) add(key, runKey(want));
    } else if (JOB_KEYS.includes(key)) {
      const want = parseJobSubject(raw);
      if (!want) continue;
      if (delivered.jobs.some((d) => sameJob(want, parseJobSubject(d)))) add(key, jobKey(want));
    }
  }
  return hits;
}

module.exports = {
  EVENT_VALIDATOR_KEYS, ISSUE_KEYS, RUN_KEYS, JOB_KEYS,
  parseRepo, parseIssueSubject, parseRunSubject, parseJobSubject,
  issueKey, runKey, jobKey,
  subjectsFromDelivery, matchUntil,
};