'use strict';

// POST /internal/cron/jobs — the scheduling API core offers to skill providers
// (#1489 S7.1, #1514). A skill's compatibility wrapper (e.g. hh_proactive_schedule)
// manages its jobs through this endpoint and never reads cron tables itself.
//
// Body: { op: 'upsert'|'list'|'delete', profileId, projectId?, action?, name?,
//         schedule?, timezone?, arguments?, enabled? }
// - upsert: one job per (profile, project, action, name); creation policy is the
//   engine's (cron trigger, settingsSchema, minIntervalMinutes, approval gate).
// - list:   jobs of the scope, optionally narrowed to one action.
// - delete: jobs of the scope with this action + name.
// Every answer carries scheduler_role: a job stored on a host that does not tick
// must be reported as not running, never as "enabled".
//
// Auth is the caller's (server.js: Bearer AGENT_SECRET, as every internal route).

const STATUS = { INVALID_ARGUMENTS: 400, ACTION_NOT_FOUND: 404, NOT_FOUND: 404, FORBIDDEN: 403, APPROVAL_REQUIRED: 403 };

function publicJob(j) {
  return {
    id: j.id, name: j.name, action: j.action, arguments: j.arguments, schedule: j.schedule,
    timezone: j.timezone, enabled: j.enabled, projectId: j.projectId,
    next_run_at: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
    last_run_at: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
    last_status: j.lastStatus, last_error: j.lastError,
  };
}

function handleCronJobs(body, { service, role }) {
  const b = body && typeof body === 'object' ? body : {};
  const scope = { profileId: b.profileId, projectId: b.projectId ?? null };
  try {
    if (typeof b.profileId !== 'string' || !/^[\w.@-]+$/.test(b.profileId)) {
      throw Object.assign(new Error('profileId required'), { code: 'INVALID_ARGUMENTS' });
    }
    let data;
    if (b.op === 'upsert') {
      data = { job: publicJob(service.upsertJob({ ...scope, name: b.name, schedule: b.schedule,
        timezone: b.timezone || 'UTC', action: b.action, arguments: b.arguments || {}, enabled: b.enabled !== false })) };
    } else if (b.op === 'list') {
      data = { jobs: service.listJobs(scope).filter(j => !b.action || j.action === b.action).map(publicJob) };
    } else if (b.op === 'delete') {
      data = { deleted: service.deleteJobsByName({ ...scope, action: b.action, name: b.name }).length };
    } else {
      throw Object.assign(new Error('op must be upsert|list|delete'), { code: 'INVALID_ARGUMENTS' });
    }
    return { status: 200, body: { ok: true, scheduler_role: role, ...data } };
  } catch (err) {
    const code = err.code || 'INTERNAL';
    return { status: STATUS[code] || 500, body: { ok: false, scheduler_role: role, code, error: String(err.message).slice(0, 300) } };
  }
}

module.exports = { handleCronJobs, publicJob };
