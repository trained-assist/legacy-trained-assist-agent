'use strict';
// Issue #1687: OpenCode agent runs go through the llm-ladder worker — pins "profile/level →
// ladder id" and "provider = ladder worker", and that no in-process ladder is left.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const p = require('../src/opencode-ladder-provider');
const { DEFAULT_LEVEL_MAP } = require('../src/playbook-executor');
const ROOT = path.join(__dirname, '..');

test('profile → worker ladder table', () => {
  assert.deepStrictEqual({ ...p.PROFILE_LADDER }, {
    deepseek: 'deepseek', doctor: 'doctor', free: 'free',
    max: 'doctor', value: 'deepseek', russian: 'deepseek', research: 'research',
  });
  assert.strictEqual(p.ladderFor('no-such-profile'), 'deepseek', 'unknown profile → default ladder');
});

test('playbook levels: bachelor/master → deepseek, doctor fallback (after claude → codex) → doctor', () => {
  const ladderOf = lvl => p.ladderFor(lvl.ocProfile);
  assert.strictEqual(ladderOf(DEFAULT_LEVEL_MAP.bachelor), 'deepseek');
  assert.strictEqual(ladderOf(DEFAULT_LEVEL_MAP.master), 'deepseek');
  const fb = DEFAULT_LEVEL_MAP.doctor.fallback;
  assert.deepStrictEqual(fb.map(r => r.engine), ['codex', 'opencode']);
  assert.strictEqual(ladderOf(fb[1]), 'doctor');
});

test('model id per role = ladder/<ladder>:<role>', () => {
  const o = p.buildOcProfileOverrides('deepseek');
  assert.strictEqual(o.model, 'ladder/deepseek:build');
  for (const role of p.ROLES) assert.strictEqual(o.agent[role].model, `ladder/deepseek:${role}`);
  assert.strictEqual(p.modelFor('doctor', 'review'), 'ladder/doctor:review');
  assert.strictEqual(p.modelFor('free', 'plan'), 'ladder/free:plan');
});

test('provider = the llm-ladder worker (openai-compatible, token from env), every model declared', () => {
  const o = p.buildOcProfileOverrides('free');
  const prov = o.provider.ladder;
  assert.strictEqual(prov.npm, '@ai-sdk/openai-compatible');
  assert.strictEqual(prov.options.baseURL, `${process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store'}/v1`);
  assert.strictEqual(prov.options.apiKey, '{env:OPENCODE_LADDER_TOKEN}');
  for (const role of p.ROLES) assert.ok(prov.models[`free:${role}`], `free:${role} declared`);
  assert.deepStrictEqual(Object.keys(o.provider), ['ladder'], 'one provider, no other routes');
});

test('every ladder call carries trace headers from run-identity env the engine actually gets', () => {
  const { ENGINE_ENV_ALLOW } = require('../src/agent-isolation');
  const h = p.buildOcProfileOverrides('deepseek').provider.ladder.options.headers;
  assert.deepStrictEqual(Object.keys(h).sort(),
    ['x-ladder-app', 'x-ladder-chat', 'x-ladder-run', 'x-ladder-session', 'x-ladder-trace', 'x-ladder-user']);
  for (const v of Object.values(h)) {
    const name = v.match(/^\{env:([A-Z_]+)\}$/)[1];
    assert.ok(ENGINE_ENV_ALLOW.has(name), `${name} must pass the engine env allowlist, else the header is empty`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'src/runner/claude-runner.js'), 'utf8');
  assert.match(src, /AGENT_RUN_ID: require\('crypto'\)\.randomUUID\(\)/, 'a fresh run id per spawn');
  assert.match(src, /AGENT_TRACE_CHAT: require\('\.\.\/opencode-ladder-provider'\)\.traceChat\(chatId\)/, 'the chat reaches the header (null → "", see traceChat)');
  assert.match(src, /AGENT_LADDER_APP: resolveLadderApp\(/, 'the run type reaches x-ladder-app (#1917)');
});

test('russian keeps its strict reviewer prompt; research rides the worker research ladder', () => {
  assert.match(p.buildOcProfileOverrides('russian').agent.review.prompt, /рецензент/);
  const r = p.buildOcProfileOverrides('research');
  assert.strictEqual(r.agent.explore.model, 'ladder/research:explore');
  assert.strictEqual(p.ladderFor('research'), 'research', 'research routes through the worker ladder');
  assert.strictEqual(p.modelFor('research', 'build'), 'ladder/research:build');
  // The worker research ladder is Go-first with a paid tail (llm-ladder #28): same
  // subscription economics as the old pin, but with per-key rotation, health skips and a
  // rung beneath Go — the pin had none of that and hung into the watchdog on a weekly cap
  // (incident 2026-10-01).
  assert.ok(p.PROFILES.includes('research'), 'research stays a selectable profile');
  assert.ok(!('DIRECT_MODEL' in p), 'no direct-pin escape hatch is left');
});

test('worker failure categories', () => {
  // Texts opencode 1.18 reports for a ladder/* model (captured live 2026-09-28).
  assert.strictEqual(p.classifyWorkerFailure('Cannot connect to API: Unable to connect. Is the computer able to access the url?'), 'worker_unreachable');
  assert.strictEqual(p.classifyWorkerFailure('unauthorized'), 'worker_unreachable');
  assert.strictEqual(p.classifyWorkerFailure('TypeError: fetch failed (ECONNREFUSED)'), 'worker_unreachable');
  assert.strictEqual(p.classifyWorkerFailure('unknown ladder: nope'), 'worker_unreachable');
  assert.strictEqual(p.classifyWorkerFailure('every rung failed'), 'ladder_exhausted');
  assert.strictEqual(p.classifyWorkerFailure('{"error":{"type":"ladder_error","attempts":[]}}'), 'ladder_exhausted');
  assert.strictEqual(p.classifyWorkerFailure("This model's maximum context length is 65536 tokens"), 'context');
  assert.strictEqual(p.classifyWorkerFailure('Loop guard: opencode повторил вызов'), null);
  assert.strictEqual(p.classifyWorkerFailure(''), null);
});

test('no in-process ladder left: removed modules and ladder config stay gone', () => {
  for (const f of ['src/opencode-ladder.js', 'src/model-health.js', 'src/opencode-go-keys.js', 'config/model-routing.json', '.opencode/profiles']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} must not come back`);
  }
});

test('trace chat: no chat → empty (logged as null), never the string "null"', () => {
  assert.strictEqual(p.traceChat(null), '');
  assert.strictEqual(p.traceChat(undefined), '');
  assert.strictEqual(p.traceChat(361255098), '361255098');
  assert.strictEqual(p.traceChat(0), '0');
});
