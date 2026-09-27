// Playbook e2e API (src/durable-e2e.js + /internal/e2e/* routes in handlers/internal.js):
// start a plan with a per-plan level map, report it, answer a step that waits for the
// user, poll this plan's waits now. The live driver (scripts/e2e/playbooks-e2e.js
// --remote) uses exactly these calls.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_PARENT = resolve(HERE, '..', '..', '..');
const SIBLING = ['software-engineering-playbooks', 'trained-assist-engineering']
  .map(d => join(REPO_PARENT, d)).find(d => existsSync(join(d, 'playbooks', 'feature.json')));
const ROOTS = process.env.PLAYBOOK_SIBLING_ROOTS || SIBLING || null;

const MODS = ['gtd-controller', 'durable-task-store', 'durable-task-migrations', 'data-paths', 'playbook-store',
  'playbook-compiler', 'playbook-executor', 'durable-e2e', 'handlers/internal'].map(m => `../../src/${m}.js`);
const KEYS = ['USERS_DIR', 'AGENT_DATA_DIR', 'AGENT_TOKENS_DIR', 'AGENT_TOKENS_ROOT', 'PLAYBOOK_SIBLING_ROOTS'];
let root; const saved = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  if (ROOTS) process.env.PLAYBOOK_SIBLING_ROOTS = ROOTS;
  root = mkdtempSync(join(tmpdir(), 'e2e-api-'));
  process.env.USERS_DIR = join(root, 'u'); process.env.AGENT_DATA_DIR = join(root, 'd');
  process.env.AGENT_TOKENS_DIR = join(root, 't'); process.env.AGENT_TOKENS_ROOT = join(root, 't');
  for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ } }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

function fakeHttp(method, pathAndQuery, body) {
  const url = new URL(`http://x${pathAndQuery}`);
  const req = { method };
  let out = null;
  const res = {};
  const ctx = {
    json: (_res, status, data) => { out = { status, data }; },
    readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    BASE_USERS_DIR: process.env.USERS_DIR,
    getGtdTickNow: () => async () => {},
  };
  return { req, url, res, ctx, result: () => out };
}

async function call(method, p, body) {
  const { handleInternal } = require('../../src/handlers/internal.js');
  const h = fakeHttp(method, p, body);
  await handleInternal(h.req, h.url, h.res, h.ctx);
  return h.result();
}

const suite = ROOTS ? describe : describe.skip;

suite('playbook e2e API', () => {
  it('starts a plan over HTTP with the e2e level map and reports it', async () => {
    const started = await call('POST', '/internal/e2e/plans', { profile: 'p1', playbook_id: 'feature', goal: 'api e2e' });
    expect(started.status).toBe(200);
    // researcher steps go to the Gemini research profile (role map, #1618); the rest follow the e2e level map
    const routes = started.data.routing.map(r => r.route);
    expect(routes.some(r => /^opencode\/free /.test(r))).toBe(true);
    expect(routes.filter(r => r !== 'programmatic').every(r => /^opencode\/(free|research|deepseek) /.test(r))).toBe(true);
    const id = started.data.plan.id;
    const rep = await call('GET', `/internal/e2e/plans/${id.slice(0, 8)}?profile=p1`);
    expect(rep.status).toBe(200);
    expect(rep.data.plan.status).toBe('active');
    expect(rep.data.current.n).toBe(1);
    const list = await call('GET', '/internal/e2e/plans?profile=p1');
    expect(list.data.plans.map(p => p.id)).toContain(id);
    // another profile cannot see it
    expect((await call('GET', `/internal/e2e/plans/${id}?profile=other`)).status).toBe(404);
  });

  it('answers a step that waits for the user and accelerates the plan waits on tick', async () => {
    const e2e = require('../../src/durable-e2e.js');
    const { durableStore } = require('../../src/gtd-controller.js');
    const { plan } = e2e.startPlan({ profile: 'p1', playbookId: 'feature', goal: 'wake me' });
    const store = durableStore();
    const [first] = store.listTaskItems(plan.id, 'p1');
    store.db.prepare(`UPDATE task_items SET status='waiting', due_at=?, wait_json=? WHERE id=?`)
      .run(Date.now() + 3600_000, JSON.stringify({ awaiting_user: true, reason: 'нужен ответ', poll_every_sec: 300 }), first.id);

    const rep = await call('GET', `/internal/e2e/plans/${plan.id}?profile=p1`);
    expect(rep.data.current.wait.awaiting_user).toBe(true);

    const tick = await call('POST', '/internal/gtd/tick', { accelerate: { plan_id: plan.id, profile: 'p1' } });
    expect(tick.data.accelerated).toBe(1);
    expect(store.getTaskItem(first.id).due_at).toBeLessThanOrEqual(Date.now());

    const woke = await call('POST', `/internal/durable/items/${first.id}/wake`, { profile: 'p1', message: 'да, делай' });
    expect(woke.status).toBe(200);
    expect(JSON.parse(store.getTaskItem(first.id).wait_json).wake_message).toBe('да, делай');
    // not waiting any more after a real wake is handled; a wrong profile is refused
    expect((await call('POST', `/internal/durable/items/${first.id}/wake`, { profile: 'other', message: 'x' })).status).toBe(409);
  });

  it('rejects bad input', async () => {
    expect((await call('POST', '/internal/e2e/plans', { profile: '../x', playbook_id: 'feature', goal: 'g' })).status).toBe(400);
    expect((await call('POST', '/internal/e2e/plans', { profile: 'p1', playbook_id: 'nope', goal: 'g' })).status).toBe(404);
    expect((await call('POST', '/internal/e2e/plans', { profile: 'p1' })).status).toBe(400);
  });
});

describe('driver helpers', () => {
  it('finds the latest PR url across step summaries', () => {
    const { latestPr } = require('../../scripts/e2e/playbooks-e2e.js');
    expect(latestPr({ steps: [
      { summary: 'issue https://github.com/o/r/issues/1' },
      { summary: 'PR: https://github.com/o/r/pull/2' },
      { summary: 'fix PR: https://github.com/o/r/pull/5' },
    ] })).toBe('https://github.com/o/r/pull/5');
  });
});
