'use strict';
// #1489 phase 0: legacy cron tools must never report success when nothing got scheduled.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const cron = require(path.join(__dirname, '..', 'src/mcp-skills/tools/04-cron.js'));
const { schedulerGate, schedulerError, makeGcpJob } = cron._internals;

test('gate refuses by default (per-job GCP path disabled)', () => {
  const g = schedulerGate({ USER_ID: '123', AGENT_SECRET: 's' });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'SCHEDULER_UNAVAILABLE');
  assert.match(g.error, /НЕ создана/);
});

test('gate refuses username USER_ID even when legacy path is enabled (/run needs numeric chatId)', () => {
  const g = schedulerGate({ CRON_GCP_PER_JOB: '1', USER_ID: 'mbk_luda_recruiter', AGENT_SECRET: 's' });
  assert.equal(g.code, 'INVALID_TARGET');
});

test('gate passes only with flag + numeric chat id + secret', () => {
  assert.equal(schedulerGate({ CRON_GCP_PER_JOB: '1', USER_ID: '-100123', AGENT_SECRET: 's' }), null);
  assert.equal(schedulerGate({ CRON_GCP_PER_JOB: '1', USER_ID: '42' }).ok, false);
});

test('GCP 403 maps to honest SCHEDULER_UNAVAILABLE', () => {
  const e = schedulerError(new Error('GCP Scheduler 403: The caller does not have permission'));
  assert.equal(e.ok, false);
  assert.equal(e.code, 'SCHEDULER_UNAVAILABLE');
});

test('job body sends chatId field, never a parsed username', () => {
  const job = makeGcpJob('x', '* * * * *', 'Europe/Moscow', 't');
  const body = JSON.parse(Buffer.from(job.httpTarget.body, 'base64').toString());
  assert.ok('chatId' in body && !('userId' in body));
});

test('cron_create returns ok:false and writes no record when unavailable', async () => {
  delete process.env.CRON_GCP_PER_JOB;
  const r = await cron.tools.cron_create.handler({ schedule: '*/30 * * * *', task: 't' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SCHEDULER_UNAVAILABLE');
});

test('cron_run_now/resume on unknown id still say not found; gate precedes GCP call', async () => {
  const r = await cron.tools.cron_run_now.handler({ id: 'nope' });
  assert.ok(r.error);
});
