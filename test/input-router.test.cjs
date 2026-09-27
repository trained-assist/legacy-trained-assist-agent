// Input router SHADOW (epic #1542, P1): compression, section hint, output
// validation, and the hard guarantee that shadow never throws / never blocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'input-router-'));
process.env.AGENT_DATA_DIR = tmp;

const ir = require('../src/input-router');
const report = require('../scripts/input-router-report');

function fakeFetch(content, extra = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }], ...extra }), text: async () => '' };
  };
  fn.calls = calls;
  return fn;
}

const GOOD = JSON.stringify({
  route: 'agent', quick_handler: null, ready: 'ready', supplement_to_running: false,
  sections: ['software-engineering'], tools_hint: ['engineering_spawn_workspace'], confidence: 0.8,
});

test('short input passes through unchanged', () => {
  const s = 'x'.repeat(ir.SHORT_LIMIT);
  const c = ir.compressInput(s);
  assert.equal(c.compressed, false);
  assert.equal(c.text, s);
});

test('long input → head 400 + tail 400 + digest of the middle', () => {
  const middle = ' см. https://github.com/org/repo/pull/77 и #1537, файл src/runner/index.js, тул hh_list_responses, '
    + 'деплой деплой деплой роутер роутер ' + 'бла '.repeat(400);
  const s = 'H'.repeat(400) + middle + 'T'.repeat(400);
  const c = ir.compressInput(s);
  assert.equal(c.compressed, true);
  assert.ok(c.text.startsWith('H'.repeat(400)));
  assert.ok(c.text.endsWith('T'.repeat(400)));
  assert.ok(c.text.length < s.length);
  for (const k of ['https://github.com/org/repo/pull/77', '#1537', 'src/runner/index.js', 'hh_list_responses', 'деплой', 'роутер']) {
    assert.ok(c.digest.includes(k), `digest must include ${k}: ${c.digest.join(',')}`);
  }
  assert.ok(!c.digest.includes('бла'), 'short noise words are not keywords');
});

test('section candidates are a regex hint', () => {
  assert.deepEqual(ir.sectionCandidates('создай PR и задеплой'), ['software-engineering']);
  assert.ok(ir.sectionCandidates('покажи отклики на вакансию hh').includes('hh'));
  assert.deepEqual(ir.sectionCandidates('привет'), []);
});

test('validateRouterOutput clamps and rejects garbage', () => {
  assert.equal(ir.validateRouterOutput(null), null);
  assert.equal(ir.validateRouterOutput([]), null);
  assert.equal(ir.validateRouterOutput({ route: 'maybe', ready: 'ready' }), null);
  assert.equal(ir.validateRouterOutput({ route: 'agent', ready: 'soon' }), null);
  const v = ir.validateRouterOutput({
    route: 'quick', quick_handler: 'hh_status', ready: 'awaiting_more', supplement_to_running: 'yes',
    sections: ['hh', 'hh', 42, 'bad name!', 'a', 'b', 'c', 'd', 'e'], tools_hint: 'nope', confidence: 7,
  });
  assert.deepEqual(v, {
    route: 'quick', quick_handler: 'hh_status', ready: 'awaiting_more', supplement_to_running: false,
    sections: ['hh', 'a', 'b', 'c', 'd'], tools_hint: [], confidence: 1,
  });
  // quick_handler is meaningless for agent route
  assert.equal(ir.validateRouterOutput({ route: 'agent', quick_handler: 'hh_status', ready: 'ready', confidence: -1 }).quick_handler, null);
  assert.equal(ir.validateRouterOutput({ route: 'agent', ready: 'ready', confidence: 'x' }).confidence, 0);
});

test('routeInput: one OpenRouter call with json response_format, validated output', async () => {
  const f = fakeFetch('```json\n' + GOOD + '\n```', { usage: { prompt_tokens: 500, completion_tokens: 60, cost: 0.0003 } });
  const out = await ir.routeInput('создай PR', { openrouterKey: 'k', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.response_format.type, 'json_object');
  // Service-LLM ladder (src/service-llm.js); no Go key in the test env → the OpenRouter last rung.
  assert.equal(f.calls[0].body.model, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(out.route, 'agent');
  assert.deepEqual(out.tools_hint, ['engineering_spawn_workspace']);
  assert.deepEqual(out.usage, { in: 500, out: 60, cost: 0.0003 });
});

test('routeInput returns null on every failure mode', async () => {
  const savedKey = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY; // hermetic: '' must not fall back to a real env key
  try {
  assert.equal(await ir.routeInput('x', { openrouterKey: '' , fetchImpl: fakeFetch(GOOD) }), null);
  assert.equal(await ir.routeInput('', { openrouterKey: 'k', fetchImpl: fakeFetch(GOOD) }), null);
  assert.equal(await ir.routeInput('x', { openrouterKey: 'k', fetchImpl: async () => { throw new Error('net'); } }), null);
  assert.equal(await ir.routeInput('x', { openrouterKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }), null);
  assert.equal(await ir.routeInput('x', { openrouterKey: 'k', fetchImpl: fakeFetch('not json') }), null);
  assert.equal(await ir.routeInput('x', { openrouterKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) }), null);
  } finally { if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey; }
});

test('shadow: disabled by INPUT_ROUTER_SHADOW=0, no call', () => {
  process.env.INPUT_ROUTER_SHADOW = '0';
  try {
    const f = fakeFetch(GOOD);
    const s = ir.startShadow({ text: 'hi', source: 'quick', openrouterKey: 'k', ctx: { fetchImpl: f } });
    s.record({ quick: false });
    assert.equal(f.calls.length, 0);
  } finally { delete process.env.INPUT_ROUTER_SHADOW; }
  assert.equal(ir.shadowEnabled(''), !!process.env.OPENROUTER_API_KEY);
  assert.equal(ir.shadowEnabled('k'), true);
});

test('shadow never throws, even when fetch throws synchronously or the log is unwritable', async () => {
  ir._cache.clear();
  const boom = () => { throw new Error('sync boom'); };
  const logFile = path.join(tmp, 'nope', '\0bad');
  const s = ir.startShadow({ text: 'sync fail', source: 'quick', openrouterKey: 'k', ctx: { fetchImpl: boom, logFile } });
  assert.doesNotThrow(() => s.record({ quick: false }));
  assert.doesNotThrow(() => s.record({ quick: true })); // double record is a no-op
  assert.doesNotThrow(() => ir.startShadow(null).record());
  assert.doesNotThrow(() => ir.startShadow({ text: undefined }).record());
  await new Promise(r => setTimeout(r, 20));
});

test('shadow does not block the caller and logs router + legacy; same text routed once', async () => {
  ir._cache.clear();
  const logFile = path.join(tmp, 'shadow.jsonl');
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const slowFetch = async (url, init) => {
    calls.push(init);
    await gate;
    return { ok: true, json: async () => ({ choices: [{ message: { content: GOOD } }] }) };
  };
  const t0 = Date.now();
  const s1 = ir.startShadow({ text: 'создай PR', source: 'intake-gate', user: 'u1', openrouterKey: 'k', ctx: { fetchImpl: slowFetch, logFile } });
  s1.record({ completeness: 'clear', complete: true });
  const s2 = ir.startShadow({ text: 'создай PR ', source: 'quick', user: 'u1', sessionId: 's1', openrouterKey: 'k', ctx: { fetchImpl: slowFetch, logFile } });
  s2.record({ quick: false, attempted: true });
  assert.ok(Date.now() - t0 < 50, 'startShadow/record must return immediately');
  assert.equal(fs.existsSync(logFile), false, 'nothing logged before the router answers');
  release();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls.length, 1, 'identical text routed once (cache)');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].hash, lines[1].hash);
  const q = lines.find(l => l.source === 'quick');
  assert.equal(q.user, 'u1');
  assert.equal(q.sessionId, 's1');
  assert.equal(q.len, 'создай PR'.length);
  assert.equal(q.router.route, 'agent');
  assert.deepEqual(q.legacy, { quick: false, attempted: true });
  assert.deepEqual(q.sections_hint, ['software-engineering']);
});

test('report computes quick/ready agreement', () => {
  const recs = [
    { source: 'quick', ms: 800, router: { route: 'quick', ready: 'ready', usage: { cost: 0.0002 } }, legacy: { quick: true } },
    { source: 'quick', ms: 900, router: { route: 'quick', ready: 'ready' }, legacy: { quick: false } },
    { source: 'quick', ms: 1000, router: { route: 'agent', ready: 'ready' }, legacy: { quick: false } },
    { source: 'intake-gate', ms: 1200, router: { route: 'agent', ready: 'ready' }, legacy: { completeness: 'likely' } },
    { source: 'intake-gate', ms: 1300, router: { route: 'agent', ready: 'ready' }, legacy: { completeness: 'insufficient' } },
    { source: 'quick', router: null, legacy: { quick: true } },
  ];
  const s = report.computeStats(recs);
  assert.equal(s.routerNull, 1);
  assert.deepEqual(s.quick, { n: 3, tp: 1, tn: 1, routerOnly: 1, legacyOnly: 0 });
  assert.deepEqual(s.ready, { n: 2, bothReady: 1, bothWait: 0, routerReadyLegacyWait: 1, routerWaitLegacyReady: 0 });
  assert.equal(s.latency.p95, 1300);
  assert.match(report.formatReport(s), /agreement 66\.7%/);
  const f = path.join(tmp, 'r.jsonl');
  fs.writeFileSync(f, recs.map(r => JSON.stringify(r)).join('\n') + '\n{corrupt\n');
  assert.equal(report.readRecords([f, path.join(tmp, 'missing')]).length, recs.length);
});
