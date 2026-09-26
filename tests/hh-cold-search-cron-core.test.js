// #1489 S7.1: core reaches the cold-search schedule only through the provider's
// hh_proactive_schedule tool (cron jobs), never through the removed legacy run loop.
// Replaces the core runDueSearches loop tests removed with the loop.
import { it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
let root, old, calls, reply;

function stubMcp() {
  const id = require.resolve('../src/mcp-action');
  const real = require(id);
  require.cache[id].exports = { ...real, runMcpTool: async (opts) => { calls.push(opts); return JSON.stringify(reply(opts.params)); } };
  return () => { require.cache[id].exports = real; };
}
function fakeRes() {
  const r = { status: 0, body: '', headers: {} };
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = b => { r.body = String(b || ''); r.done = true; };
  return r;
}
function post(url, body) { const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = url; req.headers = {}; return req; }
let restore;
beforeEach(() => {
  old = { AGENT_SECRET: process.env.AGENT_SECRET, AGENT_DATA_DIR: process.env.AGENT_DATA_DIR };
  delete process.env.AGENT_SECRET;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-core-'));
  process.env.AGENT_DATA_DIR = path.join(root, 'data');
  const ctx = path.join(root, 'users', 'u1', 'contexts', 'hh'); fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'active_vacancies.json'), JSON.stringify({ value: [{ id: 'A' }] }));
  calls = []; reply = () => ({ ok: true, enabled: true, next_run: '2026-09-27T05:23:00.000Z', last_status: 'succeeded', last_run: '2026-09-26T05:23:00.000Z' });
  restore = stubMcp();
});
afterEach(() => { restore(); for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; fs.rmSync(root, { recursive: true, force: true }); });

async function vacancyState(action) {
  const { handleHhPublic } = require('../src/handlers/hh');
  const res = fakeRes(); const req = post('/api/hh/proactive/vacancy-state', { username: 'u1', vacancy_id: 'A', action });
  await handleHhPublic(req, new URL('http://x/api/hh/proactive/vacancy-state'), res, { BASE_USERS_DIR: path.join(root, 'users'), getSecretsCache: () => ({}) });
  return { status: res.status, body: JSON.parse(res.body) };
}

it('monitor disable/archive stop the cron job via the provider; star never touches the schedule', async () => {
  let r = await vacancyState('disable');
  expect(r.status).toBe(200);
  expect(calls.map(c => [c.tool, c.params.action, c.params.vacancy_id, c.username])).toEqual([
    ['hh_proactive_schedule', 'disable', 'A', 'u1'], ['hh_proactive_schedule', 'status', 'A', 'u1']]);
  calls = []; r = await vacancyState('archive');
  expect(calls[0].params).toEqual({ action: 'disable', vacancy_id: 'A' });
  expect(r.body.state).toMatchObject({ archived: true, enabled: true, status: 'succeeded', next_run: '2026-09-27T05:23:00.000Z' });
  calls = []; await vacancyState('star');
  expect(calls.map(c => c.params.action)).toEqual(['status']);
  const legacy = require('../src/hh-proactive-search').loadSchedule('u1');
  expect(legacy.vacancies.A).toMatchObject({ starred: true, archived: true });
  expect(legacy.vacancies.A.enabled).toBeUndefined(); // schedule is not kept in the legacy file
});

it('a provider error is surfaced, not reported as success', async () => {
  reply = () => ({ error: 'Не удалось обратиться к планировщику агента: ECONNREFUSED' });
  const r = await vacancyState('disable');
  expect(r.status).toBe(502);
  expect(r.body.error).toMatch(/ECONNREFUSED/);
});

it('"выключи автопоиск" disables through the provider and reports its failure honestly', async () => {
  const { runQuickAnswer } = require('../src/runner/intent-engine');
  const work = path.join(root, 'users', 'u1');
  expect(await runQuickAnswer('выключи автопоиск', 'u1', work)).toMatch(/Автопоиск выключен/);
  expect(calls.at(-1)).toMatchObject({ tool: 'hh_proactive_schedule', params: { action: 'disable' }, username: 'u1' });
  reply = () => ({ error: 'down' });
  expect(await runQuickAnswer('выключи автопоиск', 'u1', work)).toMatch(/Не удалось/);
});

it('core has no cold-search timer left', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  expect(src('server.js')).not.toMatch(/scheduleProactiveSearchRuns/);
  expect(src('hh-negotiations.js')).not.toMatch(/scheduleProactiveSearchRuns|runDueSearches/);
  expect(src('hh-cold-search-schedule.js')).not.toMatch(/runDueSearches/);
});
