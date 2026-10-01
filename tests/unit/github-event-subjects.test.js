// GitHub event subjects + webhook wake (#1846): the matcher must never wake a
// step on a delivery that does not actually assert its subject, and the webhook
// must be fail-closed (HMAC over the raw body) while only ever nudging the poll —
// the verdict stays with the validator. Pure logic + a fake req/res, no server.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const {
  parseIssueSubject, parseRunSubject, parseJobSubject, matchUntil, subjectsFromDelivery,
} = require('../../src/github-event-subjects');
const { handleGithubWebhook, resolveSecret, signatureValid } = require('../../src/handlers/github-webhook');

const REPO = 'trained-assist/trained-assist-agent';
const N = 1846;
const RUN = 987654321;

const prPayload = ({ repo = REPO, number = N, merged = true, action = merged ? 'closed' : 'opened' } = {}) => ({
  action,
  repository: { full_name: repo, name: repo.split('/')[1], owner: { login: repo.split('/')[0] } },
  pull_request: { number, merged, merged_at: merged ? '2026-10-01T00:00:00Z' : null, state: merged ? 'closed' : 'open', head: { sha: 'deadbeef' } },
});
const runPayload = ({ repo = REPO, id = RUN, conclusion = 'success' } = {}) => ({
  action: 'completed',
  repository: { full_name: repo, owner: { login: repo.split('/')[0] }, name: repo.split('/')[1] },
  workflow_run: { id, conclusion, status: 'completed' },
});
const jobPayload = ({ repo = REPO, id = 42, runId = RUN } = {}) => ({
  action: 'completed',
  repository: { full_name: repo, owner: { login: repo.split('/')[0] }, name: repo.split('/')[1] },
  workflow_job: { id, run_id: runId, status: 'completed', conclusion: 'success' },
});

describe('github-event-subjects', () => {
  it('parses the three subject forms and rejects junk', () => {
    expect(parseIssueSubject(`${REPO}#${N}`)).toMatchObject({ owner: 'trained-assist', repo: 'trained-assist-agent', number: N });
    expect(parseRunSubject(`${REPO}/actions/runs/${RUN}`)).toMatchObject({ runId: RUN });
    expect(parseRunSubject(String(RUN))).toMatchObject({ runId: RUN, owner: null });
    expect(parseJobSubject(`${REPO}/actions/runs/${RUN}/jobs/42`)).toMatchObject({ runId: RUN, jobId: 42 });
    expect(parseIssueSubject('not-a-subject')).toBeNull();
    expect(parseRunSubject('')).toBeNull();
  });

  it('a merged PR matches its issue subject; an opened or foreign PR does not', () => {
    expect(matchUntil({ issue_pr_merged: `${REPO}#${N}` }, 'pull_request', prPayload()).map((h) => h.key))
      .toEqual(['issue_pr_merged']);
    expect(matchUntil({ issue_pr_merged: `${REPO}#${N}` }, 'pull_request', prPayload({ merged: false }))).toEqual([]);
    expect(matchUntil({ issue_pr_merged: `${REPO}#${N}` }, 'pull_request', prPayload({ repo: 'someone/other' }))).toEqual([]);
    expect(matchUntil({ issue_pr_merged: `${REPO}#${N}` }, 'pull_request', prPayload({ number: 9999 }))).toEqual([]);
  });

  it('a completed run matches both run keys regardless of conclusion', () => {
    expect(matchUntil({ workflow_run_green: `${REPO}/actions/runs/${RUN}` }, 'workflow_run', runPayload({ conclusion: 'failure' })).map((h) => h.key))
      .toEqual(['workflow_run_green']);
    expect(matchUntil({ workflow_run_completed: String(RUN) }, 'workflow_run', runPayload()).map((h) => h.key))
      .toEqual(['workflow_run_completed']);
  });

  it('a completed job matches the job subject', () => {
    expect(matchUntil({ workflow_job_completed: `${REPO}/actions/runs/${RUN}/jobs/42` }, 'workflow_job', jobPayload()).map((h) => h.key))
      .toEqual(['workflow_job_completed']);
  });

  it('a non-event key or unrecognised payload matches nothing', () => {
    expect(matchUntil({ ci_green: `${REPO}#${N}` }, 'pull_request', prPayload())).toEqual([]);
    expect(subjectsFromDelivery('ping', {})).toEqual({ issues: [], runs: [], jobs: [] });
    expect(matchUntil({ issue_pr_merged: 'garbage' }, 'pull_request', prPayload())).toEqual([]);
  });
});

// ── webhook handler ─────────────────────────────────────────────────────────
const SECRET = 'test-webhook-secret';
const sigOf = (body, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

function deliver({ body, headers = {}, ctx = {} } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1', ...headers },
    url: '/webhooks/github',
  };
  const url = new URL('http://127.0.0.1:3001/webhooks/github');
  const rec = { status: null, body: null };
  const host = {
    json: (_res, status, data) => { rec.status = status; rec.body = data; return true; },
    readBodyBuffer: async (_req, max = 1_048_576) => { if (raw.length > max) throw new Error('body too large'); return raw; },
    secrets: { GITHUB_WEBHOOK_SECRET: SECRET },
    getGtdTickNow: () => async () => {},
    ...ctx,
  };
  return handleGithubWebhook(req, url, { writeHead() { return this; }, end() { return this; } }, host)
    .then((handled) => ({ ...rec, handled }));
}

describe('github-webhook', () => {
  it('route mismatch returns false', async () => {
    const r = await handleGithubWebhook({ method: 'POST', headers: {} }, new URL('http://x/other'), {}, {});
    expect(r).toBe(false);
  });

  it('no secret configured → 404 (fail closed)', async () => {
    const r = await deliver({ body: prPayload(), ctx: { secrets: {} } });
    expect(r.status).toBe(404);
  });

  it('oversized body → 413', async () => {
    const raw = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const r = await deliver({ body: raw, headers: { 'x-hub-signature-256': sigOf(raw) } });
    expect(r.status).toBe(413);
  });

  it('wrong signature → 401; the raw body was still read', async () => {
    const r = await deliver({ body: prPayload(), headers: { 'x-hub-signature-256': sigOf(Buffer.from('x'), 'other-secret') } });
    expect(r.status).toBe(401);
  });

  it('valid signature but non-JSON → 400', async () => {
    const raw = Buffer.from('not json');
    const r = await deliver({ body: raw, headers: { 'x-hub-signature-256': sigOf(raw) } });
    expect(r.status).toBe(400);
  });

  it('valid delivery with no matching wait → 202, nothing woken', async () => {
    const r = await deliver({ body: prPayload(), headers: { 'x-hub-signature-256': sigOf(Buffer.from(JSON.stringify(prPayload()))) } });
    expect(r.status).toBe(202);
  });

  it('signatureValid is constant-time and rejects wrong length', () => {
    const raw = Buffer.from('{}');
    expect(signatureValid(raw, sigOf(raw), SECRET)).toBe(true);
    expect(signatureValid(raw, 'sha256=short', SECRET)).toBe(false);
  });

  it('resolveSecret reads ctx then env', () => {
    expect(resolveSecret({ GITHUB_WEBHOOK_SECRET: 'a' })).toBe('a');
    expect(resolveSecret({})).toBeNull();
  });
});
