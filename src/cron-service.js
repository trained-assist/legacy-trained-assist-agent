'use strict';

// cron-service — the generic scheduler engine (#1489 P1-min, kind=action only).
//
// Canonical state is the core SQLite (cron_jobs + action_executions, owned by
// ActionExecutions). A tick claims due jobs inside one BEGIN IMMEDIATE
// transaction, then runs each claimed occurrence through invokeAction with
// trigger:'cron' — the same registration/validation/history path as a user
// call. No setInterval per domain, no GCP job per schedule.
//
// Guarantees (docs/architecture/action-cron-contract-v1.md, "Generic cron"):
// - schedule = five numeric POSIX fields + IANA timezone, parsed by croner;
// - missed occurrences coalesce into ONE run of the most recent due occurrence;
//   next_run_at advances atomically with the claim (no backlog replay);
// - occurrence identity cron:<jobId>:<scheduledAt> is unique, so two workers /
//   a double tick can never run the same occurrence twice;
// - no overlap: a job with a live (unexpired lease) execution is not claimed;
// - an expired lease is settled as 'unknown' (outcome of a killed run is not
//   known — never silently 'succeeded', never blindly replayed);
// - one failing action never stops the other claimed jobs.
//
// Scope: every job read/write is filtered by profile_id AND project_id
// (NULL via IS NULL, never a wildcard). Not found and inaccessible look the same.

const crypto = require('crypto');
const { Cron } = require('croner');

const FIELD = /^[0-9*,/-]+$/;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PER_TICK = 50;
const DEFAULT_CONCURRENCY = 4;
const MAX_COALESCE_STEPS = 10_000;

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseSchedule(schedule, timezone) {
  if (typeof schedule !== 'string' || typeof timezone !== 'string' || !timezone) {
    throw serviceError('INVALID_ARGUMENTS', 'schedule and timezone are required');
  }
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every(f => FIELD.test(f))) {
    throw serviceError('INVALID_ARGUMENTS', 'schedule must be five numeric cron fields (min hour dom month dow)');
  }
  let cron;
  try {
    cron = new Cron(fields.join(' '), { timezone, paused: true });
    cron.nextRun(new Date(0)); // forces timezone resolution
  } catch (err) {
    throw serviceError('INVALID_ARGUMENTS', `Invalid schedule/timezone: ${String(err.message).slice(0, 200)}`);
  }
  return cron;
}

// Next occurrence strictly after `afterMs` (UTC ms), or null if the pattern never fires again.
function nextOccurrence(schedule, timezone, afterMs) {
  const next = parseSchedule(schedule, timezone).nextRun(new Date(afterMs));
  return next ? next.getTime() : null;
}

// Smallest gap (minutes) between consecutive occurrences over a sample window.
// 400 runs cover a full year for daily-or-faster patterns, so an irregular
// pattern like "0,5 * * * *" is judged by its tightest pair, not its average.
function minGapMinutes(schedule, timezone = 'UTC', fromMs = Date.UTC(2026, 0, 1)) {
  const runs = parseSchedule(schedule, timezone).nextRuns(400, new Date(fromMs)).map(d => d.getTime());
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i] - runs[i - 1]) / 60000);
  return min;
}

function createCronService({ executions, registry, transport, invoker = null, now = () => Date.now(),
  owner = `${require('os').hostname()}:${process.pid}`, leaseMs = DEFAULT_LEASE_MS,
  maxPerTick = DEFAULT_MAX_PER_TICK, concurrency = DEFAULT_CONCURRENCY, log = () => {} } = {}) {
  if (!executions || !registry) throw new Error('createCronService requires { executions, registry }');
  const db = executions.db;
  const { invokeAction } = invoker || require('./action-invoke').createActionInvoker({ registry, executions, transport, now });
  const heartbeat = { lastTickAt: null, lastTickFinishedAt: null, lastClaimed: 0, lastRecovered: 0, lastError: null, ticks: 0 };

  const scope = (profileId, projectId) => {
    if (typeof profileId !== 'string' || !profileId) throw serviceError('INVALID_ARGUMENTS', 'profileId required');
    return { profileId, projectId: projectId == null ? null : String(projectId) };
  };
  const SCOPE_SQL = 'profile_id = ? AND project_id IS ?';

  function row(r) {
    if (!r) return null;
    return {
      id: r.id, profileId: r.profile_id, projectId: r.project_id, name: r.name,
      schedule: r.schedule, timezone: r.timezone, action: r.action,
      arguments: JSON.parse(r.arguments_json), enabled: r.enabled === 1,
      lastRunAt: r.last_run_at, nextRunAt: r.next_run_at, lastStatus: r.last_status,
      lastError: r.last_error, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // Policy at creation time: the action must be registered, allow the cron
  // trigger and accept these arguments. Approval-gated actions (external
  // messages, destructive) are refused until a creation-time grant exists (D3).
  function checkAction(action, args) {
    const descriptor = registry.validateCall(action, args, 'cron');
    if (descriptor.requiresApproval) {
      throw serviceError('APPROVAL_REQUIRED', 'Action requires an explicit grant to run on a schedule');
    }
    // The provider's declared settings (S3.1) narrow what a job may carry; the
    // provider itself never reads cron tables, it only receives these arguments.
    if (!registry.validateSettings(action, args)) {
      throw serviceError('INVALID_ARGUMENTS', 'Job arguments do not match the action settings schema');
    }
    return descriptor;
  }

  // A provider may declare how often its action is allowed to run (S3.2).
  function checkInterval(action, schedule, timezone) {
    const min = registry.get(action).schedule?.minIntervalMinutes;
    if (min && minGapMinutes(schedule, timezone) < min) {
      throw serviceError('INVALID_ARGUMENTS', `Schedule runs more often than the action allows (every ${min} min)`);
    }
  }

  function createJob({ profileId, projectId = null, name, schedule, timezone = 'UTC', action, arguments: args = {} }) {
    const s = scope(profileId, projectId);
    if (typeof name !== 'string' || !name.trim()) throw serviceError('INVALID_ARGUMENTS', 'name required');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw serviceError('INVALID_ARGUMENTS', 'arguments must be an object');
    checkAction(action, args);
    checkInterval(action, schedule, timezone);
    const t = now();
    const next = nextOccurrence(schedule, timezone, t);
    if (next == null) throw serviceError('INVALID_ARGUMENTS', 'schedule never fires');
    const id = 'cron-' + crypto.randomUUID();
    db.prepare(`INSERT INTO cron_jobs (id, profile_id, project_id, name, schedule, timezone, action,
      arguments_json, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, s.profileId, s.projectId, name.trim(), schedule.trim().split(/\s+/).join(' '), timezone,
        action, JSON.stringify(args), next, t, t);
    return getJob({ ...s, id });
  }

  function getJob({ profileId, projectId = null, id }) {
    const s = scope(profileId, projectId);
    const r = db.prepare(`SELECT * FROM cron_jobs WHERE id = ? AND ${SCOPE_SQL}`).get(id, s.profileId, s.projectId);
    if (!r) throw serviceError('NOT_FOUND', 'Cron job not found');
    return row(r);
  }

  function listJobs({ profileId, projectId = null }) {
    const s = scope(profileId, projectId);
    return db.prepare(`SELECT * FROM cron_jobs WHERE ${SCOPE_SQL} ORDER BY created_at`)
      .all(s.profileId, s.projectId).map(row);
  }

  // Only name/schedule/timezone/arguments/enabled are settable. A schedule or
  // re-enable change recalculates next_run_at from now (no retroactive runs).
  function updateJob({ profileId, projectId = null, id, ...patch }) {
    const job = getJob({ profileId, projectId, id });
    const allowed = ['name', 'schedule', 'timezone', 'arguments', 'enabled'];
    const unknown = Object.keys(patch).filter(k => !allowed.includes(k));
    if (unknown.length) throw serviceError('INVALID_ARGUMENTS', `Unsupported fields: ${unknown.join(', ')}`);
    const next = { ...job, ...patch };
    if (typeof next.name !== 'string' || !next.name.trim()) throw serviceError('INVALID_ARGUMENTS', 'name required');
    if (patch.arguments !== undefined) checkAction(job.action, next.arguments);
    const t = now();
    const reschedule = patch.schedule !== undefined || patch.timezone !== undefined ||
      (patch.enabled === true && !job.enabled);
    let nextRunAt = job.nextRunAt;
    if (patch.schedule !== undefined || patch.timezone !== undefined) checkInterval(job.action, next.schedule, next.timezone);
    if (reschedule) {
      nextRunAt = nextOccurrence(next.schedule, next.timezone, t);
      if (nextRunAt == null) throw serviceError('INVALID_ARGUMENTS', 'schedule never fires');
    }
    db.prepare(`UPDATE cron_jobs SET name = ?, schedule = ?, timezone = ?, arguments_json = ?, enabled = ?,
      next_run_at = ?, updated_at = ? WHERE id = ? AND ${SCOPE_SQL}`)
      .run(next.name.trim(), next.schedule.trim().split(/\s+/).join(' '), next.timezone,
        JSON.stringify(next.arguments), next.enabled ? 1 : 0, nextRunAt, t, id, job.profileId, job.projectId);
    return getJob({ profileId, projectId, id });
  }

  // Deletion stops new claims; history rows keep (cron_id → NULL); a run already
  // in flight is not killed.
  function deleteJob({ profileId, projectId = null, id }) {
    const job = getJob({ profileId, projectId, id });
    db.prepare(`DELETE FROM cron_jobs WHERE id = ? AND ${SCOPE_SQL}`).run(id, job.profileId, job.projectId);
    return { id, deleted: true };
  }

  // Most recent occurrence <= t, walking forward from the stored next_run_at.
  function coalesce(job, t) {
    let scheduledAt = job.next_run_at;
    const cron = parseSchedule(job.schedule, job.timezone);
    for (let i = 0; i < MAX_COALESCE_STEPS; i++) {
      const n = cron.nextRun(new Date(scheduledAt));
      if (!n || n.getTime() > t) break;
      scheduledAt = n.getTime();
    }
    const n = cron.nextRun(new Date(Math.max(t, scheduledAt)));
    return { scheduledAt, nextRunAt: n ? n.getTime() : null };
  }

  // Expired leases: the worker died or hung past the lease. Outcome unknown.
  const recoverTx = () => {
    const t = now();
    const stale = db.prepare(`SELECT id, cron_id FROM action_executions WHERE trigger = 'cron'
      AND status IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ?`).all(t);
    const error = JSON.stringify({ code: 'LEASE_EXPIRED', message: 'Run did not finish before its lease expired', retryable: false });
    for (const s of stale) {
      db.prepare(`UPDATE action_executions SET status = 'unknown', error_json = ?, finished_at = ? WHERE id = ?`)
        .run(error, t, s.id);
      if (s.cron_id) {
        db.prepare(`UPDATE cron_jobs SET last_status = 'unknown', last_error = 'LEASE_EXPIRED', updated_at = ? WHERE id = ?`)
          .run(t, s.cron_id);
      }
    }
    return stale.length;
  };

  function claimDueTx() {
    const t = now();
    const due = db.prepare(`SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at LIMIT ?`).all(t, maxPerTick);
    const claims = [];
    for (const job of due) {
      const live = db.prepare(`SELECT 1 FROM action_executions WHERE cron_id = ?
        AND status IN ('claimed','running') AND lease_until >= ? LIMIT 1`).get(job.id, t);
      if (live) continue; // no overlap; the job stays due and coalesces after the run
      let plan;
      try { plan = coalesce(job, t); } catch (err) {
        // A schedule that no longer parses must not block the queue: disable it visibly.
        db.prepare(`UPDATE cron_jobs SET enabled = 0, last_status = 'rejected', last_error = ?, updated_at = ? WHERE id = ?`)
          .run(String(err.message).slice(0, 300), t, job.id);
        continue;
      }
      const executionId = crypto.randomUUID();
      const idempotencyKey = `cron:${job.id}:${plan.scheduledAt}`;
      const exists = db.prepare(`SELECT 1 FROM action_executions WHERE cron_id = ? AND scheduled_at = ?`)
        .get(job.id, plan.scheduledAt);
      if (!exists) {
        executions.claimExecution({
          id: executionId, profileId: job.profile_id, projectId: job.project_id, action: job.action,
          arguments: JSON.parse(job.arguments_json), idempotencyKey, cronId: job.id,
          scheduledAt: plan.scheduledAt, leaseOwner: owner, leaseUntil: t + leaseMs, now: t,
        });
      }
      db.prepare(`UPDATE cron_jobs SET next_run_at = ?, enabled = ?, last_run_at = ?, last_status = ?,
        updated_at = ? WHERE id = ?`)
        .run(plan.nextRunAt ?? job.next_run_at, plan.nextRunAt == null ? 0 : 1, exists ? job.last_run_at : t,
          exists ? job.last_status : 'running', t, job.id);
      if (!exists) claims.push({ job: row(job), executionId, idempotencyKey, scheduledAt: plan.scheduledAt });
    }
    return claims;
  }

  async function runClaim(claim) {
    const { job, executionId, idempotencyKey } = claim;
    let status; let lastError = null;
    try {
      const res = await invokeAction({
        version: 1, profileId: job.profileId, projectId: job.projectId, action: job.action,
        arguments: job.arguments, trigger: 'cron', origin: 'cron-service', idempotencyKey,
      }, { claimedExecutionId: executionId, leaseOwner: owner });
      status = res.status;
      if (res.error) lastError = `${res.error.code}: ${res.error.message}`.slice(0, 500);
    } catch (err) {
      // Service error (policy changed since creation, provider gone): the claimed
      // occurrence is rejected, recorded, and the job keeps its schedule.
      status = 'rejected';
      lastError = `${err.code || 'ERROR'}: ${String(err.message).slice(0, 400)}`;
      db.prepare(`UPDATE action_executions SET status = 'rejected', error_json = ?, finished_at = ?
        WHERE id = ? AND status = 'claimed' AND lease_owner = ?`)
        .run(JSON.stringify({ code: err.code || 'ERROR', message: String(err.message).slice(0, 500), retryable: false }),
          now(), executionId, owner);
    }
    db.prepare(`UPDATE cron_jobs SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(status, lastError, now(), job.id);
    log(`[cron] ${job.id} ${job.action} → ${status}${lastError ? ` (${lastError})` : ''}`);
    return { jobId: job.id, executionId, status };
  }

  async function runAll(claims) {
    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < claims.length) {
        const claim = claims[i++];
        results.push(await runClaim(claim).catch(err => ({ jobId: claim.job.id, status: 'failed', error: err.message })));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, worker));
    return results;
  }

  // One tick: settle expired leases, claim due occurrences atomically, run them.
  // Returns after claiming; `done` resolves when the claimed runs finish.
  function tick() {
    heartbeat.ticks++;
    heartbeat.lastTickAt = now();
    let claims = [];
    try {
      heartbeat.lastRecovered = db.transaction(recoverTx).immediate();
      claims = db.transaction(claimDueTx).immediate();
      heartbeat.lastClaimed = claims.length;
      heartbeat.lastError = null;
    } catch (err) {
      heartbeat.lastError = String(err.message).slice(0, 300);
      log(`[cron] tick failed: ${heartbeat.lastError}`);
    }
    const done = runAll(claims).finally(() => { heartbeat.lastTickFinishedAt = now(); });
    return { claimed: claims.length, recovered: heartbeat.lastRecovered, done };
  }

  function status() {
    const t = now();
    const q = sql => db.prepare(sql).get(t).n;
    return {
      heartbeat: { ...heartbeat },
      jobs: {
        enabled: db.prepare('SELECT count(*) AS n FROM cron_jobs WHERE enabled = 1').get().n,
        due: q('SELECT count(*) AS n FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?'),
        running: q(`SELECT count(*) AS n FROM action_executions WHERE trigger = 'cron'
          AND status IN ('claimed','running') AND lease_until >= ?`),
      },
    };
  }

  return { createJob, getJob, listJobs, updateJob, deleteJob, tick, status };
}

module.exports = { createCronService, nextOccurrence, parseSchedule, minGapMinutes };
