import { it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);

const gw = require('../src/llm-gateway');

let root, cfgPath, statePath;
let goSrv, orSrv;
let goPort, orPort;
// Per-test upstream behaviour: handler functions per provider.
let goHandler, orHandler;

function startServer(handlerRef) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      handlerRef.fn(req, res, parsed);
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function sse(res, events, { status = 200, delayMs = 0 } = {}) {
  res.writeHead(status, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const send = () => {
    if (i >= events.length) { res.end(); return; }
    res.write(`data: ${typeof events[i] === 'string' ? events[i] : JSON.stringify(events[i])}\n\n`);
    i++;
    setTimeout(send, delayMs);
  };
  send();
}

const chunk = (content) => ({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
const done = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  goHandler = { fn: (req, res) => res.writeHead(500).end('unconfigured') };
  orHandler = { fn: (req, res) => res.writeHead(500).end('unconfigured') };
  goSrv = await startServer(goHandler);
  orSrv = await startServer(orHandler);
  goPort = goSrv.address().port;
  orPort = orSrv.address().port;

  cfgPath = path.join(root, 'config.json');
  statePath = path.join(root, 'state.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    modelId: 'free-ladder',
    ttfbTimeoutMs: 2000,
    interChunkTimeoutMs: 2000,
    totalTimeoutMs: 5000,
    sweepIdleMs: 1000,
    catalogIntervalMs: 43200000,
    go: { baseURL: `http://127.0.0.1:${goPort}` },
    openrouter: { baseURL: `http://127.0.0.1:${orPort}` },
    rungs: [
      { provider: 'go', model: 'rung-a' },
      { provider: 'go', model: 'rung-b' },
      { provider: 'openrouter', model: 'org/rung-c:free' },
    ],
  }));

  process.env.LLM_GATEWAY_CONFIG = cfgPath;
  process.env.LLM_GATEWAY_STATE_FILE = statePath;
  process.env.LLM_GATEWAY_TOKEN = 'test-gw-token';
  process.env.LLM_GATEWAY_NO_TIMERS = '1';
  process.env.OPENCODE_GO_API_KEY = 'oc_sk_test';
  process.env.OPENROUTER_API_KEY = 'or_test_key';
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(root, 'health.json');
});

afterAll(() => {
  goSrv?.close();
  orSrv?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  goHandler.fn = (req, res) => res.writeHead(500).end('unconfigured');
  orHandler.fn = (req, res) => res.writeHead(500).end('unconfigured');
  fs.writeFileSync(process.env.OPENCODE_MODEL_HEALTH_FILE, '{}');
  gw._internal.rungTraffic.clear();
  gw._internal.rungLastPing.clear();
});

// Minimal harness: run one chat completion through the gateway's route().
async function callChat(body, { token = 'test-gw-token' } = {}) {
  const chunks = [];
  let headers = null;
  let statusCode = null;
  const req = {
    headers: { authorization: token ? `Bearer ${token}` : '' },
    method: 'POST',
    on: (ev, cb) => { if (ev === 'close') { req._closeCb = cb; } },
    destroy: () => {},
  };
  let reqBody = JSON.stringify(body);
  // Emulate a readable request stream for readBody().
  Object.assign(req, {
    on(ev, cb) {
      if (ev === 'close') { req._closeCb = cb; return; }
      if (ev === 'error') { req._errCb = cb; return; }
      if (ev === 'data') {
        queueMicrotask(() => { cb(Buffer.from(reqBody)); });
      }
      if (ev === 'end') {
        queueMicrotask(() => { cb(); });
      }
    },
    destroy: () => {},
  });
  const res = {
    statusCode: 200,
    headers: {},
    destroyed: false,
    writableEnded: false,
    writeHead(code, hdrs) { statusCode = code; headers = hdrs || {}; return this; },
    write(chunk) { chunks.push(Buffer.from(chunk).toString()); return true; },
    end(payload) {
      if (payload) chunks.push(Buffer.from(payload).toString());
      this.writableEnded = true;
      if (res._onEnd) res._onEnd();
      return this;
    },
    _onEnd: null,
  };
  const url = new URL('http://localhost/v1/chat/completions');
  const handled = await gw.route(req, res, url);
  expect(handled).toBe(true);
  return {
    get status() { return statusCode; },
    get headers() { return headers; },
    get body() { return chunks.join(''); },
    json() { return JSON.parse(chunks.join('')); },
  };
}

it('503 without configured token, 401 on wrong token, 401 on missing auth', async () => {
  const saved = process.env.LLM_GATEWAY_TOKEN;
  delete process.env.LLM_GATEWAY_TOKEN;
  // token file does not exist in the temp root ⇒ no token at all
  const savedTokens = process.env.AGENT_TOKENS_DIR;
  process.env.AGENT_TOKENS_DIR = path.join(root, 'no-tokens');
  const r1 = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] }, { token: null });
  expect(r1.status).toBe(503);
  process.env.AGENT_TOKENS_DIR = savedTokens;
  process.env.LLM_GATEWAY_TOKEN = saved;

  const r2 = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] }, { token: 'wrong' });
  expect(r2.status).toBe(401);
});

it('404 for unknown model id, 400 for empty messages', async () => {
  const r1 = await callChat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] });
  expect(r1.status).toBe(404);
  const r2 = await callChat({ model: 'free-ladder', messages: [] });
  expect(r2.status).toBe(400);
});

it('non-stream: first rung 429 ⇒ same-rung retry with backoff ⇒ success', async () => {
  let calls = 0;
  goHandler.fn = (req, res, body) => {
    calls++;
    if (calls === 1) { res.writeHead(429, { 'retry-after': '0' }).end('rate limited'); return; }
    expect(body.model).toBe('rung-a');
    sse(res, [chunk('hello from rung-a'), done]);
  };
  const started = Date.now();
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  const out = r.json();
  expect(out.choices[0].message.content).toBe('hello from rung-a');
  expect(out.model).toBe('free-ladder');
  expect(calls).toBe(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1400); // 429 backoff ≥1.5s
});

it('non-stream: rung-a hard-fails ⇒ degrade to rung-b', async () => {
  goHandler.fn = (req, res, body) => {
    if (body.model === 'rung-a') { res.writeHead(500).end('boom'); return; }
    sse(res, [chunk('hello from rung-b'), done]);
  };
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  expect(r.json().choices[0].message.content).toBe('hello from rung-b');
  expect(r.json()['x-ladder-rung']).toBe('opencode-go/rung-b');
});

it('non-stream: bad-json guard (response_format) skips rung to next', async () => {
  goHandler.fn = (req, res, body) => {
    if (body.model === 'rung-a') {
      // prose instead of JSON
      sse(res, [chunk('Sure, here is what I think about that.'), done]);
      return;
    }
    sse(res, [chunk('{"answer":42}'), done]);
  };
  const r = await callChat({
    model: 'free-ladder',
    messages: [{ role: 'user', content: 'json please' }],
    response_format: { type: 'json_object' },
  });
  expect(r.status).toBe(200);
  expect(r.json().choices[0].message.content).toBe('{"answer":42}');
  expect(r.json()['x-ladder-rung']).toBe('opencode-go/rung-b');
});

it('non-stream: refusal prose guard skips rung', async () => {
  goHandler.fn = (req, res, body) => {
    if (body.model === 'rung-a') {
      sse(res, [chunk("I'm sorry, but I can't do that."), done]);
      return;
    }
    sse(res, [chunk('ok, doing it'), done]);
  };
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  expect(r.json().choices[0].message.content).toBe('ok, doing it');
});

it('rf-400: response_format rejected ⇒ same-rung retry without it', async () => {
  let calls = 0;
  let sawRf = false;
  goHandler.fn = (req, res, body) => {
    calls++;
    if (body.response_format) { sawRf = true; res.writeHead(400).end('does not support feature: structured-outputs'); return; }
    sse(res, [chunk('{"ok":true}'), done]);
  };
  const r = await callChat({
    model: 'free-ladder',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  });
  expect(r.status).toBe(200);
  expect(sawRf).toBe(true);
  expect(calls).toBe(2);
  expect(r.json()['x-ladder-rung']).toBe('opencode-go/rung-a');
});

it('stream: SSE relayed verbatim after first token, header is text/event-stream', async () => {
  goHandler.fn = (req, res, body) => {
    sse(res, [chunk('Hel'), chunk('lo'), done], { delayMs: 5 });
  };
  const chunks = [];
  let headers = null;
  const req = { method: 'POST', headers: { authorization: 'Bearer test-gw-token' }, destroy: () => {} };
  let reqBody = JSON.stringify({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }], stream: true });
  Object.assign(req, {
    on(ev, cb) {
      if (ev === 'close') return;
      if (ev === 'data') queueMicrotask(() => cb(Buffer.from(reqBody)));
      if (ev === 'end') queueMicrotask(() => cb());
    },
  });
  const res = {
    destroyed: false, writableEnded: false,
    writeHead(code, hdrs) { headers = hdrs; return this; },
    write(c) { chunks.push(Buffer.from(c).toString()); return true; },
    end() { this.writableEnded = true; if (res._onEnd) res._onEnd(); return this; },
    _onEnd: null,
  };
  const donePromise = new Promise(resolve => { res._onEnd = resolve; });
  await gw.route(req, res, new URL('http://localhost/v1/chat/completions'));
  await donePromise;
  expect(headers['Content-Type']).toBe('text/event-stream');
  expect(headers['X-Accel-Buffering']).toBe('no');
  const text = chunks.join('');
  expect(text).toContain('Hel');
  expect(text).toContain('[DONE]');
});

it('ttfb timeout: silent rung-a ⇒ degrade to rung-b within budget', async () => {
  goHandler.fn = (req, res, body) => {
    if (body.model === 'rung-a') {
      // Headers OK, but never a single SSE byte (dead model).
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return; // connection stays open, no data
    }
    sse(res, [chunk('saved by rung-b'), done]);
  };
  const started = Date.now();
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  expect(r.json().choices[0].message.content).toBe('saved by rung-b');
  expect(Date.now() - started).toBeLessThan(4500); // ttfb 2s + margin, not 60s
});

it('all rungs dead ⇒ 502 with ladder summary', async () => {
  goHandler.fn = (req, res) => res.writeHead(500).end('boom');
  orHandler.fn = (req, res) => res.writeHead(500).end('boom');
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(502);
  expect(r.json().error.message).toContain('all rungs failed');
});

it('health: failures are recorded in shared model-health and skip rungs', async () => {
  goHandler.fn = (req, res, body) => {
    if (body.model === 'rung-a') { res.writeHead(500).end('boom'); return; }
    sse(res, [chunk('b says hi'), done]);
  };
  await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  const health = JSON.parse(fs.readFileSync(process.env.OPENCODE_MODEL_HEALTH_FILE, 'utf8'));
  expect(health['opencode-go/rung-a']).toBeTruthy();
  expect(health['opencode-go/rung-a'].failures).toBeGreaterThanOrEqual(1);
  // Next call skips rung-a entirely (single upstream call to rung-b).
  let calls = 0;
  goHandler.fn = (req, res, body) => { calls++; sse(res, [chunk('b again'), done]); };
  await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(calls).toBe(1);
});

it('sweep: idle rung pinged; 404 parks it until next sweep window', async () => {
  let pings = 0;
  goHandler.fn = (req, res, body) => {
    pings++;
    if (body.model === 'rung-a') { res.writeHead(404).end('model not found'); return; }
    sse(res, [chunk('ok'), done]);
  };
  // Make rung-a stale for the sweep (no traffic ever, lastPing 0 ⇒ idle).
  await new Promise(r => setTimeout(r, 1100)); // sweepIdleMs = 1000
  await gw.sweepIdleRungs();
  expect(pings).toBeGreaterThanOrEqual(1);
  const health = JSON.parse(fs.readFileSync(process.env.OPENCODE_MODEL_HEALTH_FILE, 'utf8'));
  expect(health['opencode-go/rung-a']).toBeTruthy();
  expect(health['opencode-go/rung-a'].skipUntil).toBeTruthy();
});

it('/v1/models lists exactly the configured model id', async () => {
  let out = null;
  const req = { method: 'GET', headers: { authorization: 'Bearer test-gw-token' }, on: () => {}, destroy: () => {} };
  const res = {
    writeHead(code) { this.code = code; return this; },
    end(payload) { out = JSON.parse(payload); },
  };
  const handled = await gw.route(req, res, new URL('http://localhost/v1/models'));
  expect(handled).toBe(true);
  expect(res.code).toBe(200);
  expect(out.data.map(m => m.id)).toEqual(['free-ladder']);
});

it('guard unit: tryParseJson is tolerant (fences, prose-wrapped, truncated)', () => {
  expect(gw.tryParseJson('{"a":1}')).toBe(true);
  expect(gw.tryParseJson('```json\n{"a":1}\n```')).toBe(true);
  expect(gw.tryParseJson('Here you go: {"a": [1,2,3]} hope it helps')).toBe(true);
  expect(gw.tryParseJson('no json at all')).toBe(false);
  expect(gw.tryParseJson('{"a": truncat')).toBe(false);
});

// ── Ladder call/limit log (src/ladder-log.js) ─────────────────────────────────
const ladderLog = require('../src/ladder-log');
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

it('call log: records which rung (1-based) answered, attempts and tier; log lives next to health file, not in prod', async () => {
  expect(ladderLog.logDir().startsWith(root)).toBe(true);
  fs.rmSync(ladderLog.logDir(), { recursive: true, force: true });
  goHandler.fn = (req, res) => { res.writeHead(500).end('boom'); };
  orHandler.fn = (req, res) => sse(res, [chunk('hello from rung-c'), done]);
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  expect(r.json()['x-ladder-rung-index']).toBe(3);
  const [line] = readLines(ladderLog.callsFile());
  expect(line.source).toBe('gateway');
  expect(line.rung).toBe(3);
  expect(line.rungsTotal).toBe(3);
  expect(line.model).toBe('openrouter/org/rung-c:free');
  expect(line.tier).toBe('free');
  expect(line.reachedPaid).toBe(false);
  expect(line.attempts.map(a => [a.rung, a.outcome])).toEqual([[1, 'error'], [2, 'error'], [3, 'ok']]);
  expect(line.attempts[0].tier).toBe('subscription');
});

it('limit log: 429 on a rung is written to the SEPARATE limits file, even when the retry succeeds', async () => {
  fs.rmSync(ladderLog.logDir(), { recursive: true, force: true });
  let calls = 0;
  goHandler.fn = (req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(429, { 'retry-after': '0' }).end('Rate limit exceeded: free-models-per-day'); return; }
    sse(res, [chunk('ok'), done]);
  };
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(200);
  const limits = readLines(ladderLog.limitsFile());
  expect(limits.length).toBe(1);
  expect(limits[0].model).toBe('opencode-go/rung-a');
  expect(limits[0].kind).toBe('daily_quota');
  expect(limits[0].status).toBe(429);
  const s = ladderLog.summary();
  expect(s.calls).toBe(1);
  expect(s.limits).toBe(1);
  expect(s.byRung['gateway#1']).toBe(1);
});

it('all rungs fail ⇒ call logged as all_failed; 401 parks go through model-health into limits log', async () => {
  fs.rmSync(ladderLog.logDir(), { recursive: true, force: true });
  goHandler.fn = (req, res) => { res.writeHead(401).end('invalid key'); };
  orHandler.fn = (req, res) => { res.writeHead(402).end('insufficient credits'); };
  const r = await callChat({ model: 'free-ladder', messages: [{ role: 'user', content: 'hi' }] });
  expect(r.status).toBe(502);
  const [line] = readLines(ladderLog.callsFile());
  expect(line.outcome).toBe('all_failed');
  expect(line.rung).toBe(null);
  const kinds = readLines(ladderLog.limitsFile()).map(l => l.kind);
  expect(kinds).toContain('auth');
});
