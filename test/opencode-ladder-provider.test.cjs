'use strict';
// Issue #1687: OpenCode agent runs go through the llm-ladder worker — pins "profile/level →
// ladder id" and "provider = ladder worker", and that no in-process ladder is left.
// Issue #2065: a profile maps to a worker ladder PER ROLE (master walks the role ladders).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const p = require('../src/opencode-ladder-provider');
const { DEFAULT_LEVEL_MAP } = require('../src/playbook-executor');
const ROOT = path.join(__dirname, '..');

test('profile → worker ladder table (per role, #2065)', () => {
  // Profiles map to a worker ladder PER ROLE (config/ladders.json): the worker owns the rungs,
  // so a profile must never name anything it doesn't know. `master` (the default) walks the
  // role ladders — the agent no longer sends every role to `service:*`; `russian` is the one
  // non-ladder key — the service ladder plus a reviewer prompt (ROLE_PROMPTS).
  assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER.master }, {
    build: 'build', plan: 'plan', explore: 'explore', general: 'general', review: 'review',
  });
  assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER.phd }, {
    build: 'build advanced', plan: 'plan', explore: 'explore', general: 'general', review: 'review',
  });
  assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER.free }, {
    build: 'free', plan: 'plan', explore: 'explore', general: 'general', review: 'review',
  });
  for (const profile of ['service', 'doctor']) {
    assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER[profile] }, {
      build: `${profile}:build`, plan: `${profile}:plan`, explore: `${profile}:explore`,
      general: `${profile}:general`, review: `${profile}:review`,
    }, `${profile} keeps every role on its own ladder`);
  }
  // russian rides the service ladder (plus its own reviewer prompt, ROLE_PROMPTS).
  assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER.russian }, {
    build: 'service:build', plan: 'service:plan', explore: 'service:explore',
    general: 'service:general', review: 'service:review',
  });
  assert.deepStrictEqual({ ...p.PROFILE_ROLE_LADDER.research }, {
    build: 'research', plan: 'research:plan', explore: 'research:explore',
    general: 'research:general', review: 'research:review',
  });
  assert.strictEqual(p.ladderFor('no-such-profile'), 'service:build', 'unknown profile → the default service ladder, role intact');
  // Legacy names from before the ladder rename still resolve on read (stored profiles.json /
  // OPENCODE_PROFILE / /profile aliases) — a stored `max` must reach `doctor`, not `master`.
  assert.deepStrictEqual({ ...p.LEGACY_PROFILE_LADDER }, { deepseek: 'service', value: 'service', max: 'doctor' });
  assert.strictEqual(p.ladderFor('deepseek'), 'service:build', 'the ladder\'s former name');
  assert.strictEqual(p.ladderFor('max'), 'doctor:build', 'a stored max keeps its stronger ladder');
});

test('playbook levels: bachelor/master → master (per-role ladders), doctor fallback (after claude → codex) → doctor', () => {
  const ladderOf = (lvl, role = 'build') => p.ladderFor(lvl.ocProfile, role);
  assert.strictEqual(ladderOf(DEFAULT_LEVEL_MAP.bachelor), 'build');
  assert.strictEqual(ladderOf(DEFAULT_LEVEL_MAP.master), 'build');
  const fb = DEFAULT_LEVEL_MAP.doctor.fallback;
  assert.deepStrictEqual(fb.map(r => r.engine), ['codex', 'opencode']);
  assert.strictEqual(ladderOf(fb[1]), 'doctor:build');
});

test('model id per role = ladder/<ladder> — master walks the role ladders (#2065)', () => {
  // The owner's unit-test spec: modelFor('master','plan') → 'ladder/plan',
  // modelFor('phd','build') → 'ladder/build advanced', modelFor('free','build') → 'ladder/free'.
  assert.strictEqual(p.modelFor('master', 'build'), 'ladder/build');
  assert.strictEqual(p.modelFor('master', 'plan'), 'ladder/plan');
  assert.strictEqual(p.modelFor('master', 'explore'), 'ladder/explore');
  assert.strictEqual(p.modelFor('master', 'general'), 'ladder/general');
  assert.strictEqual(p.modelFor('master', 'review'), 'ladder/review');
  assert.strictEqual(p.modelFor('phd', 'build'), 'ladder/build advanced');
  assert.strictEqual(p.modelFor('phd', 'plan'), 'ladder/plan');
  assert.strictEqual(p.modelFor('free', 'build'), 'ladder/free');
  assert.strictEqual(p.modelFor('free', 'review'), 'ladder/review');
  // Unknown profile → the safe service fallback, never a local model list.
  assert.strictEqual(p.modelFor('no-such-profile', 'build'), 'ladder/service:build');
  assert.strictEqual(p.modelFor('no-such-profile', 'review'), 'ladder/service:review');
  // Single-ladder profiles keep their per-role suffixes.
  assert.strictEqual(p.modelFor('service', 'build'), 'ladder/service:build');
  assert.strictEqual(p.modelFor('doctor', 'review'), 'ladder/doctor:review');
  assert.strictEqual(p.modelFor('russian', 'review'), 'ladder/service:review', 'russian rides the service ladder');
  const o = p.buildOcProfileOverrides('master');
  assert.strictEqual(o.model, 'ladder/build');
  for (const role of p.ROLES) assert.strictEqual(o.agent[role].model, `ladder/${role}`);
});

test('provider = the llm-ladder worker (openai-compatible, token from env), every ladder declared', () => {
  const o = p.buildOcProfileOverrides('free');
  const prov = o.provider.ladder;
  assert.strictEqual(prov.npm, '@ai-sdk/openai-compatible');
  assert.strictEqual(prov.options.baseURL, `${process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store'}/v1`);
  assert.strictEqual(prov.options.apiKey, '{env:OPENCODE_LADDER_TOKEN}');
  for (const ladder of ['build', 'plan', 'explore', 'general', 'review', 'build advanced', 'free', 'service:build', 'doctor:review', 'research', 'research:plan']) {
    assert.ok(prov.models[ladder], `${ladder} declared`);
  }
  assert.deepStrictEqual(Object.keys(o.provider), ['ladder'], 'one provider, no other routes');
});

test('every ladder call carries trace headers from run-identity env the engine actually gets', () => {
  const { ENGINE_ENV_ALLOW } = require('../src/agent-isolation');
  const h = p.buildOcProfileOverrides('service').provider.ladder.options.headers;
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
  assert.strictEqual(p.modelFor('research', 'build'), 'ladder/research');
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
