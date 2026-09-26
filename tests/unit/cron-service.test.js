// cron-service — generic scheduler engine (#1489 P1-min).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { createCronService, nextOccurrence } = require('../../src/cron-service');
const { ActionExecutions } = require('../../src/action-executions');
const { ActionProviderRegistry } = require('../../src/action-provider-registry');
const { schedulerRole, buildRegistry } = require('../../src/cron-runtime');

const schema = { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, additionalProperties: false };
const read = { name: 'read_items', inputSchema: schema, allowedTriggers: ['user', 'cron'], effect: 'read', requiresApproval: false, retrySafety: 'read_only' };
const userOnly = { name: 'user_only', inputSchema: { type: 'object' }, allowedTriggers: ['user'], effect: 'read', requiresApproval: false, retrySafety: 'read_only' };
const send = { name: 'send_msg', inputSchema: { type: 'object' }, allowedTriggers: ['user', 'cron'], effect: 'external_message', requiresApproval: true, retrySafety: 'unsafe' };

const T0 = Date.UTC(2026, 8, 26, 10, 0, 0); // 2026-09-26 10:00 UTC
const MIN = 60_000;

function setup({ transport = async () => ({ ok: true }), dbPath = ':memory:', owner = 'w1', leaseMs } = {}) {
  const registry = new ActionProviderRegistry();
  registry.register({ version: 1, providerId: 'test', actions: [read, userOnly, send] });
  const executions = new ActionExecutions(dbPath);
  const clock = { t: T0 };
  const calls = [];
  const svc = createCronService({
    executions, registry, owner, leaseMs, now: () => clock.t,
    transport: async p => { calls.push(p); return transport(p); },
  });
  return { svc, executions, clock, calls, registry };
}
const job = (over = {}) => ({ profileId: 'alice', projectId: null, name: 'every 5', schedule: '*/5 * * * *', timezone: 'UTC', action: 'read_items', arguments: { limit: 1 }, ...over });
const checkThrow = (fn, code) => { expect(fn).toThrow(); try { fn(); } catch (e) { expect(e.code).toBe(code); } };

describe('schedule parsing', () => {
  it('computes the next occurrence in the job timezone', () => {
    // Monday 09:00 Moscow = 06:00 UTC
    expect(new Date(nextOccurrence('0 9 * * 1', 'Europe/Moscow', T0)).toISOString()).toBe('2026-09-28T06:00:00.000Z');
  });
  it('uses POSIX OR semantics when both day-of-month and day-of-week are restricted', () => {
    expect(new Date(nextOccurrence('0 0 13 * 5', 'UTC', T0)).toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });
  it.each(['* * * *', '0 * * * * *', '@daily', '0 9 * * MON', '61 * * * *'])('rejects %s', s => {
    checkThrow(() => nextOccurrence(s, 'UTC', T0), 'INVALID_ARGUMENTS');
  });
  it('rejects an unknown timezone', () => {
    checkThrow(() => nextOccurrence('0 9 * * *', 'Mars/Base', T0), 'INVALID_ARGUMENTS');
  });
});

describe('job CRUD + creation policy', () => {
  it('creates a job with next_run_at and returns parsed arguments', () => {
    const { svc } = setup();
    const j = svc.createJob(job());
    expect(j).toMatchObject({ profileId: 'alice', projectId: null, enabled: true, arguments: { limit: 1 }, nextRunAt: T0 + 5 * MIN });
  });
  it('refuses actions without the cron trigger, bad arguments, unknown actions and approval-gated actions', () => {
    const { svc } = setup();
    checkThrow(() => svc.createJob(job({ action: 'user_only', arguments: {} })), 'FORBIDDEN');
    checkThrow(() => svc.createJob(job({ arguments: { limit: 0 } })), 'INVALID_ARGUMENTS');
    checkThrow(() => svc.createJob(job({ action: 'nope' })), 'ACTION_NOT_FOUND');
    checkThrow(() => svc.createJob(job({ action: 'send_msg', arguments: {} })), 'APPROVAL_REQUIRED');
  });
  it('isolates profile and project scope (not found == inaccessible)', () => {
    const { svc } = setup();
    const a = svc.createJob(job());
    const p = svc.createJob(job({ projectId: 'proj' }));
    expect(svc.listJobs({ profileId: 'alice' }).map(j => j.id)).toEqual([a.id]);
    expect(svc.listJobs({ profileId: 'alice', projectId: 'proj' }).map(j => j.id)).toEqual([p.id]);
    checkThrow(() => svc.getJob({ profileId: 'bob', id: a.id }), 'NOT_FOUND');
    checkThrow(() => svc.getJob({ profileId: 'alice', projectId: 'proj', id: a.id }), 'NOT_FOUND');
    checkThrow(() => svc.deleteJob({ profileId: 'bob', id: a.id }), 'NOT_FOUND');
  });
  it('update recalculates next_run_at; disable stops claims; unknown fields are refused', async () => {
    const { svc, clock, calls } = setup();
    const j = svc.createJob(job());
    clock.t = T0 + 2 * MIN;
    expect(svc.updateJob({ profileId: 'alice', id: j.id, schedule: '0 * * * *' }).nextRunAt).toBe(T0 + 60 * MIN);
    checkThrow(() => svc.updateJob({ profileId: 'alice', id: j.id, nextRunAt: 1 }), 'INVALID_ARGUMENTS');
    svc.updateJob({ profileId: 'alice', id: j.id, enabled: false });
    clock.t = T0 + 120 * MIN;
    await svc.tick().done;
    expect(calls).toHaveLength(0);
  });
});

describe('tick: claim, run, history', () => {
  it('runs a due job once through invokeAction with trigger cron and records history', async () => {
    const { svc, executions, clock, calls } = setup();
    const j = svc.createJob(job());
    clock.t = T0 + 4 * MIN;
    expect(svc.tick().claimed).toBe(0);
    clock.t = T0 + 5 * MIN;
    const t = svc.tick();
    expect(t.claimed).toBe(1);
    await t.done;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'read_items', profileId: 'alice', trigger: 'cron', arguments: { limit: 1 } });
    const [row] = executions.listByScope({ profileId: 'alice' });
    expect(row).toMatchObject({ trigger: 'cron', origin: 'cron-service', cronId: j.id, scheduledAt: T0 + 5 * MIN,
      status: 'succeeded', attempt: 1, idempotencyKey: `cron:${j.id}:${T0 + 5 * MIN}` });
    expect(svc.getJob({ profileId: 'alice', id: j.id })).toMatchObject({ lastStatus: 'succeeded', nextRunAt: T0 + 10 * MIN });
    // Same instant again: nothing due.
    expect(svc.tick().claimed).toBe(0);
  });

  it('coalesces a missed backlog into one run of the most recent occurrence (restart catch-up)', async () => {
    const { svc, executions, clock, calls } = setup();
    const j = svc.createJob(job());
    clock.t = T0 + 22 * MIN; // 4 occurrences missed (5,10,15,20)
    await svc.tick().done;
    expect(calls).toHaveLength(1);
    expect(executions.listByScope({ profileId: 'alice' })[0].scheduledAt).toBe(T0 + 20 * MIN);
    expect(svc.getJob({ profileId: 'alice', id: j.id }).nextRunAt).toBe(T0 + 25 * MIN);
  });

  it('two workers on one DB never run the same occurrence twice', async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cron-')), 'ops.db');
    const a = setup({ dbPath, owner: 'a' });
    const b = setup({ dbPath, owner: 'b' });
    a.svc.createJob(job());
    a.clock.t = b.clock.t = T0 + 5 * MIN;
    const ta = a.svc.tick(); const tb = b.svc.tick();
    await Promise.all([ta.done, tb.done]);
    expect(ta.claimed + tb.claimed).toBe(1);
    expect(a.calls.length + b.calls.length).toBe(1);
  });

  it('does not overlap a job whose previous run still holds a live lease', async () => {
    let release;
    const { svc, clock, calls } = setup({ transport: () => new Promise(r => { release = r; }) });
    svc.createJob(job());
    clock.t = T0 + 5 * MIN;
    const first = svc.tick();
    await new Promise(r => setImmediate(r));
    clock.t = T0 + 10 * MIN;
    expect(svc.tick().claimed).toBe(0);
    release({ ok: true });
    await first.done;
    expect(svc.tick().claimed).toBe(1); // coalesced single catch-up after the run finished
    expect(calls).toHaveLength(2);
  });

  it('settles an expired lease as unknown (never silently succeeded) and keeps scheduling', async () => {
    const { svc, executions, clock } = setup({ transport: () => new Promise(() => {}), leaseMs: 2 * MIN });
    const j = svc.createJob(job());
    clock.t = T0 + 5 * MIN;
    svc.tick();
    await new Promise(r => setImmediate(r));
    clock.t = T0 + 8 * MIN;
    expect(svc.tick().recovered).toBe(1);
    expect(executions.listByScope({ profileId: 'alice' })[0]).toMatchObject({ status: 'unknown', error: { code: 'LEASE_EXPIRED' } });
    expect(svc.getJob({ profileId: 'alice', id: j.id })).toMatchObject({ lastStatus: 'unknown', enabled: true });
  });

  it('one failing action does not stop the others; failure is recorded on the job', async () => {
    const { svc, clock } = setup({ transport: async p => { if (p.arguments.limit === 1) throw new Error('boom'); return 1; } });
    const bad = svc.createJob(job());
    const good = svc.createJob(job({ arguments: { limit: 2 } }));
    clock.t = T0 + 5 * MIN;
    await svc.tick().done;
    expect(svc.getJob({ profileId: 'alice', id: bad.id })).toMatchObject({ lastStatus: 'failed', lastError: 'ACTION_FAILED: boom' });
    expect(svc.getJob({ profileId: 'alice', id: good.id }).lastStatus).toBe('succeeded');
  });

  it('a policy change after creation rejects the occurrence instead of running it', async () => {
    const { svc, clock, calls, executions } = setup();
    const j = svc.createJob(job());
    // Simulate the provider tightening its argument schema: stored args no longer validate.
    executions.db.prepare('UPDATE cron_jobs SET arguments_json = ? WHERE id = ?').run('{"limit":0}', j.id);
    clock.t = T0 + 5 * MIN;
    await svc.tick().done;
    expect(calls).toHaveLength(0);
    expect(executions.listByScope({ profileId: 'alice' })[0].status).toBe('rejected');
    expect(svc.getJob({ profileId: 'alice', id: j.id })).toMatchObject({ lastStatus: 'rejected', enabled: true });
  });

  it('deleting a job keeps its history', async () => {
    const { svc, clock, executions } = setup();
    const j = svc.createJob(job());
    clock.t = T0 + 5 * MIN;
    await svc.tick().done;
    svc.deleteJob({ profileId: 'alice', id: j.id });
    expect(executions.listByScope({ profileId: 'alice' })[0]).toMatchObject({ status: 'succeeded', cronId: null });
  });
});

describe('runtime role + registry', () => {
  it('ticks only on the primary host and never on staging', () => {
    expect(schedulerRole({})).toBe('off');
    expect(schedulerRole({ CRON_SCHEDULER_ROLE: 'primary' })).toBe('primary');
    expect(schedulerRole({ CRON_SCHEDULER_ROLE: 'primary', STAGING_ROOT: '/tmp/s' })).toBe('staging');
  });
  it('a bad provider manifest is skipped without taking the others down', () => {
    const r = buildRegistry({ manifests: [{ version: 1, providerId: 'bad', actions: [] }, { version: 1, providerId: 'ok', actions: [read] }] });
    expect(r.list().map(a => a.name)).toEqual(['read_items']);
  });
  it('registers every present sibling that ships a committed action manifest (S3.4)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siblings-'));
    const sibling = (repo, manifest) => {
      fs.mkdirSync(path.join(root, repo, 'src', 'mcp-skills'), { recursive: true });
      fs.writeFileSync(path.join(root, repo, 'src', 'mcp-skills', 'index.js'), '');
      if (manifest !== undefined) fs.writeFileSync(path.join(root, repo, 'action-provider-manifest.json'), manifest);
    };
    sibling('trained-assist-hh-skill', JSON.stringify({ version: 1, providerId: 'hh', actions: [read] }));
    sibling('trained-assist-freelance-skill', JSON.stringify({ version: 1, providerId: 'freelance', actions: [{ ...read, name: 'fl_items' }] }));
    sibling('trained-assist-engineering', '{not json');   // unreadable → logged, others still load
    const logs = [];
    const r = buildRegistry({ root, log: m => logs.push(m) });
    expect(r.list().map(a => a.name).sort()).toEqual(['fl_items', 'read_items']);
    expect(logs.some(l => l.includes('engineering'))).toBe(true);
  });
});

describe('provider schedule declaration (#1489 S3.1–3.2)', () => {
  const sched = { defaultCron: '0 */6 * * *', minIntervalMinutes: 60, delivery: 'silent', costClass: 'cheap_llm', label: 'Items',
    settingsSchema: { type: 'object', properties: { limit: { type: 'integer', maximum: 10 } }, required: ['limit'] } };
  const scheduled = { ...read, name: 'sched_items', schedule: sched };
  const reg = (actions) => new ActionProviderRegistry().register({ version: 1, providerId: 'p', actions });

  it('accepts a valid declaration and keeps it in the descriptor', () => {
    expect(reg([scheduled])[0].schedule).toEqual(sched);
  });
  it.each([
    ['cron trigger missing', { ...scheduled, allowedTriggers: ['user'] }],
    ['default for an approval-gated action', { ...send, schedule: sched }],
    ['default faster than its own minimum', { ...scheduled, schedule: { ...sched, defaultCron: '*/5 * * * *' } }],
    ['unparseable default', { ...scheduled, schedule: { ...sched, defaultCron: 'every day' } }],
    ['bad settings schema', { ...scheduled, schedule: { ...sched, settingsSchema: { type: 'object', properties: { x: { type: 'nope' } } } } }],
    ['unknown delivery', { ...scheduled, schedule: { ...sched, delivery: 'loud' } }],
    ['unknown field', { ...scheduled, schedule: { ...sched, extra: 1 } }],
  ])('rejects a provider whose schedule is invalid: %s', (_, action) => {
    checkThrow(() => reg([action]), 'INVALID_ARGUMENTS');
  });
  it('job creation enforces settingsSchema and minIntervalMinutes (create and update)', () => {
    const registry = new ActionProviderRegistry();
    registry.register({ version: 1, providerId: 'p', actions: [scheduled] });
    const svc = createCronService({ executions: new ActionExecutions(':memory:'), registry, now: () => T0, transport: async () => ({}) });
    const base = job({ action: 'sched_items', schedule: '0 * * * *', arguments: { limit: 5 } });
    checkThrow(() => svc.createJob({ ...base, arguments: { limit: 50 } }), 'INVALID_ARGUMENTS');
    checkThrow(() => svc.createJob({ ...base, schedule: '*/30 * * * *' }), 'INVALID_ARGUMENTS');
    const j = svc.createJob(base);
    checkThrow(() => svc.updateJob({ profileId: 'alice', id: j.id, schedule: '0,15 * * * *' }), 'INVALID_ARGUMENTS');
    checkThrow(() => svc.updateJob({ profileId: 'alice', id: j.id, arguments: {} }), 'INVALID_ARGUMENTS');
    expect(svc.updateJob({ profileId: 'alice', id: j.id, schedule: '0 */2 * * *' }).schedule).toBe('0 */2 * * *');
  });
});
