const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated OPENCODE_MODEL_HEALTH_FILE per test run — same pattern as test/auth-flag.test.cjs —
// so this never touches the real ~/.config/opencode/model-health.json. The state path is resolved
// lazily by src/model-health.js on each call, so re-requiring opencode-ladder.js is enough to pick
// up the fresh path (issue #1467: health is per-model, one shared store).
function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-ladder-test-'));
  process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(dir, 'model-health.json');
  delete require.cache[require.resolve('../src/opencode-ladder')];
  return { mod: require('../src/opencode-ladder'), dir };
}

function writeProfile(dir, name, json) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(json));
}

test('classifyError sorts quota vs config vs unrecognized text', () => {
  const { mod } = freshModule();
  assert.equal(mod.classifyError('rate limit exceeded').class, 'quota');
  assert.equal(mod.classifyError('HTTP 429 Too Many Requests').class, 'quota');
  assert.equal(mod.classifyError('usage limit reached').class, 'quota');
  assert.equal(mod.classifyError('quota exceeded for this key').class, 'quota');
  assert.equal(mod.classifyError('subscription required').class, 'config');
  assert.equal(mod.classifyError('this model requires Global regions').class, 'config');
  assert.equal(mod.classifyError('Insufficient account funds').class, 'config');
  assert.equal(mod.classifyError('some unrelated engine crash'), null);
});

test('classifyError catches retired/unavailable model slugs and provider overload as quota-class (skip the rung, do not dead-stop the task)', () => {
  const { mod } = freshModule();
  const unavailable = mod.classifyError('This model is unavailable for free. The paid version is available now - use this slug instead: xiaomi/mimo-v2.5');
  assert.equal(unavailable.class, 'quota');
  assert.ok(unavailable.ttlMs > 24 * 60 * 60 * 1000, 'retired-slug TTL should be long (effectively permanent), not a short quota window');

  assert.equal(mod.classifyError('model not found').class, 'quota');
  assert.equal(mod.classifyError('No endpoints found matching your data policy').class, 'quota');

  const overloaded = mod.classifyError('Upstream error from Nvidia: Service temporarily overloaded');
  assert.equal(overloaded.class, 'quota');
  assert.ok(overloaded.ttlMs <= 15 * 60 * 1000, 'overload TTL should be short — this is transient provider congestion, retry soon');

  assert.equal(mod.classifyError('HTTP 503 Service Unavailable').class, 'quota');
});

test('classifyError recognizes opencode\'s generic "Unexpected server error" (dead model slug) as a per-rung quota failure', () => {
  const { mod } = freshModule();
  // Confirmed live 2026-09-24: an invalid opencode-go slug (gpt-6-astra) returned exactly this,
  // while the valid sibling (gpt-6-luna) worked. Must degrade the ladder, not dead-end on the rung.
  const v = mod.classifyError('{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}}');
  assert.equal(v.class, 'quota');
  assert.ok(v.ttlMs > 0, 'short TTL, not permanent');
});

test('classifyError recognizes context-overflow text as its own class, distinct from quota/config', () => {
  const { mod } = freshModule();
  assert.equal(mod.classifyError('This model\'s maximum context length is 128000 tokens').class, 'context');
  assert.equal(mod.classifyError('context_length_exceeded').class, 'context');
  assert.equal(mod.classifyError('prompt is too long: 250000 tokens > 200000 maximum').class, 'context');
  assert.equal(mod.classifyError('input too long for requested model').class, 'context');
  assert.equal(mod.classifyError('too many tokens in the request').class, 'context');
});

test('recordFailure does NOT persist exhaustion for context-overflow (unlike quota/config) — it must not block other tasks sharing the rung', () => {
  const { mod } = freshModule();
  const verdict = mod.recordFailure('p', 'build', 'big-model', 'Error: context_length_exceeded');
  assert.deepEqual(verdict, { class: 'context', model: 'big-model', alertNeeded: false });
  // A fresh task with no skip list still resolves the same model — nothing was marked exhausted.
  assert.equal(mod.resolveModel({ ladder: { build: ['big-model', 'other-model'] } }, 'p', 'build'), 'big-model');
});

test('resolveModel skipModels excludes a rung for one call without touching persisted state', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2', 'm3'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build', ['m1']), 'm2');
  // Unaffected call (no skipModels) still resolves m1 — the skip was never persisted.
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
});

test('buildOcProfileOverrides skipModels only affects the build role, not other roles', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'p', {
    ladder: { build: ['m1', 'm2'], review: ['m1', 'm3'] },
  });
  const resolved = mod.buildOcProfileOverrides('p', dir, { skipModels: ['m1'] });
  assert.equal(resolved.agent.build.model, 'm2', 'build role skips m1 per opts.skipModels');
  assert.equal(resolved.agent.review.model, 'm1', 'review role ignores build-only skipModels');
});

test('resolveModel degrades to the next rung once the first is marked exhausted', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2', 'm3'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');

  mod.markExhausted('p', 'build', 'm1', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2');

  mod.markExhausted('p', 'build', 'm2', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm3');
});

test('quota-class exhaustion clears itself once the TTL has passed', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  mod.markExhausted('p', 'build', 'm1', -1); // already-expired TTL
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
});

test('config-class exhaustion (ttlMs null) never auto-clears', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  mod.markExhausted('p', 'build', 'm1', null);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2');
  // simulate time passing — still exhausted, unlike the TTL case above
  mod.markExhausted('p', 'build', 'm2', 60_000);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2', 'degrades to the last rung rather than looping forever when every rung is exhausted');
});

test('free-profile retry-storm: every rung exhausted still resolves a model, never undefined', () => {
  const { mod } = freshModule();
  const ladder = { build: ['a', 'b', 'c'] };
  for (const m of ladder.build) mod.markExhausted('free', 'build', m, 60_000);
  const resolved = mod.resolveModel({ ladder }, 'free', 'build');
  assert.equal(resolved, 'c', 'falls back to the last rung instead of returning null/undefined so callers cannot loop indefinitely on a missing model');
});

test('clearExhausted removes one model, one role, or the whole profile', () => {
  const { mod } = freshModule();
  mod.markExhausted('p', 'build', 'm1', 60_000);
  mod.markExhausted('p', 'plan', 'm2', 60_000);

  mod.clearExhausted('p', 'build', 'm1');
  assert.equal(mod.resolveModel({ ladder: { build: ['m1'] } }, 'p', 'build'), 'm1');
  assert.equal(mod.resolveModel({ ladder: { plan: ['m2', 'm3'] } }, 'p', 'plan'), 'm3');

  mod.clearExhausted('p');
  assert.equal(mod.resolveModel({ ladder: { plan: ['m2', 'm3'] } }, 'p', 'plan'), 'm2');
});

test('recordFailure marks the rung exhausted and reports the error class', () => {
  const { mod } = freshModule();
  const quota = mod.recordFailure('p', 'build', 'm1', 'rate limit exceeded');
  assert.deepEqual(quota, { class: 'quota', model: 'm1', alertNeeded: false });
  assert.equal(mod.resolveModel({ ladder: { build: ['m1', 'm2'] } }, 'p', 'build'), 'm2');

  const config = mod.recordFailure('p', 'plan', 'x1', 'subscription required for this model');
  assert.deepEqual(config, { class: 'config', model: 'x1', alertNeeded: true });
});

test('recordFailure returns null for errors outside the ladder-degradation classes (e.g. total auth loss)', () => {
  const { mod } = freshModule();
  assert.equal(mod.recordFailure('p', 'build', 'm1', 'not logged in'), null);
  assert.equal(mod.recordFailure('p', 'build', 'm1', 'some random crash'), null);
});

test('buildOcProfileOverrides resolves every role and carries rolePrompts along unchanged', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'russian', {
    ladder: {
      build: ['gigachat/GigaChat-Pro'],
      review: ['gigachat/GigaChat-Max', 'gigachat/GigaChat-Pro'],
    },
    rolePrompts: { review: 'strict reviewer prompt' },
  });

  const resolved = mod.buildOcProfileOverrides('russian', dir);
  assert.equal(resolved.model, 'gigachat/GigaChat-Pro');
  assert.equal(resolved.agent.build.model, 'gigachat/GigaChat-Pro');
  assert.equal(resolved.agent.review.model, 'gigachat/GigaChat-Max');
  assert.equal(resolved.agent.review.prompt, 'strict reviewer prompt');
  assert.equal(resolved.agent.build.prompt, undefined);
});

test('buildOcProfileOverrides degrades review to its next rung once GigaChat-Max is exhausted', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'russian', {
    ladder: { build: ['gigachat/GigaChat-Pro'], review: ['gigachat/GigaChat-Max', 'gigachat/GigaChat-Pro'] },
  });
  mod.markExhausted('russian', 'review', 'gigachat/GigaChat-Max', 60_000);
  const resolved = mod.buildOcProfileOverrides('russian', dir);
  assert.equal(resolved.agent.review.model, 'gigachat/GigaChat-Pro');
});

test('a legacy profile without `ladder` (flat model/agent) still resolves as a single-rung ladder', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'legacy', {
    model: 'top-level-model',
    agent: { build: { model: 'build-model' } },
  });

  const resolved = mod.buildOcProfileOverrides('legacy', dir);
  assert.equal(resolved.agent.build.model, 'build-model');
  assert.equal(resolved.model, 'build-model');
});

test('MAX_LADDER_ATTEMPTS caps how many rungs a single task may burn through', () => {
  const { mod } = freshModule();
  assert.equal(typeof mod.MAX_LADDER_ATTEMPTS, 'number');
  assert.ok(mod.MAX_LADDER_ATTEMPTS > 0 && mod.MAX_LADDER_ATTEMPTS < 20);
});

test('forceAdvance degrades to the next rung without any error classification (blind crash-retry alternation)', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1', 'm2'] };
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1');
  mod.forceAdvance('p', 'build', 'm1');
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm2', 'forceAdvance marks m1 exhausted even though no error text was classified');
});

test('forceAdvance is a bounded-TTL exhaustion (RETRY_FORCE_TTL_MS), not permanent', () => {
  const { mod } = freshModule();
  assert.equal(typeof mod.RETRY_FORCE_TTL_MS, 'number');
  assert.ok(mod.RETRY_FORCE_TTL_MS > 0);
});

test('forceAdvance is a no-op when profile or model is missing', () => {
  const { mod } = freshModule();
  const ladder = { build: ['m1'] };
  mod.forceAdvance(null, 'build', 'm1');
  mod.forceAdvance('p', 'build', null);
  assert.equal(mod.resolveModel({ ladder }, 'p', 'build'), 'm1', 'neither malformed call should have marked anything exhausted');
});

test('real free profile: every role ladder ends on a paid rung, not another :free model', () => {
  const routing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-routing.json'), 'utf8'));
  for (const [role, ladder] of Object.entries(routing.ladders.free)) {
    const lastRung = ladder[ladder.length - 1];
    assert.ok(!lastRung.endsWith(':free'), `${role}'s last rung (${lastRung}) must be a paid model — if every :free rung is rate-limited/dead, there must be one guaranteed-to-work fallback left`);
  }
});

test('classifyError recognizes an intermittent "Bad Request" model rejection as its own transient class', () => {
  const { mod } = freshModule();
  // Observed live 2026-09-25 on opencode-go/deepseek-v4.1-flash: the top rung intermittently
  // rejects the request while its siblings serve fine. This must NOT skip the rung immediately —
  // retrying the same model is the point (owner: "частенько багует, нужны ретраи грамотные").
  const v = mod.classifyError('❌ OpenCode ошибка: Bad Request: {"model":"deepseek-v4.1-flash"}');
  assert.equal(v.class, 'transient');
  const v2 = mod.classifyError('Bad Request: {"model":"deepseek-v4.1-flash"}');
  assert.equal(v2.class, 'transient');
  // A more specific signal in the same string still wins (429/usage limit → quota, not transient).
  assert.equal(mod.classifyError('Bad Request: rate limit exceeded').class, 'quota');
});

// Replaced (issue #1467, owner decision 2026-09-26): the old test asserted a transient "Bad
// Request" never touches shared state ("must not poison the rung for other tasks"). That contract
// is superseded — the owner asked for a unified PER-MODEL health with a short exponential backoff,
// so a flaky model IS skipped briefly (shared across profiles) and then retried on that schedule.
test('recordFailure gives a transient Bad Request a SHORT shared per-model backoff (issue #1467)', () => {
  const { mod } = freshModule();
  const verdict = mod.recordFailure('p', 'build', 'flaky-model', 'Bad Request: {"model":"flaky-model"}');
  assert.equal(verdict.class, 'transient');
  assert.equal(verdict.model, 'flaky-model');
  assert.equal(verdict.alertNeeded, false);
  // "первый откат короткий (15с), далее ×2": the runner retries the SAME model on this schedule.
  assert.ok(verdict.retryAfterMs >= 14000 && verdict.retryAfterMs <= 16000,
    `expected ~15s first backoff, got ${verdict.retryAfterMs}ms`);
  assert.equal(mod.resolveModel({ ladder: { build: ['flaky-model', 'sibling'] } }, 'p', 'build'), 'sibling',
    'while the model is in its short backoff the ladder skips it — one shared health for all profiles');
  // A success clears the record, so the model comes straight back.
  mod.recordSuccess('flaky-model');
  assert.equal(mod.resolveModel({ ladder: { build: ['flaky-model', 'sibling'] } }, 'p', 'build'), 'flaky-model');
});

test('deepseek-go profile: config-driven ladder, top rung deepseek-v4.1-flash, degrading to deepseek and mimo siblings on the same Go gateway', () => {
  const routing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-routing.json'), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.opencode', 'profiles', 'deepseek-go.json'), 'utf8'));
  assert.equal(profile.ladderRef, 'deepseek-go', 'profile must be config-driven (ladderRef), not hardcode the model list');
  const ladder = routing.ladders['deepseek-go'];
  assert.ok(Array.isArray(ladder?.build) && ladder.build.length >= 2,
    'deepseek-go must carry a real ladder — the old single-uniform-model shape could only flip the gateway');
  assert.equal(ladder.build[0], 'opencode-go/deepseek-v4.1-flash');
  assert.ok(ladder.build.includes('opencode-go/mimo-v2.6-flash'),
    'the sibling alternative for a flaky deepseek rung must be a same-gateway model (mimo-v2.6-flash)');
  for (const rung of ladder.build) assert.ok(rung.startsWith('opencode-go/'), `deepseek-go rung ${rung} must stay on the Go gateway`);
});

test('deepseek-openrouter profile: config-driven ladder on the OpenRouter gateway with a mimo sibling', () => {
  const routing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-routing.json'), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.opencode', 'profiles', 'deepseek-openrouter.json'), 'utf8'));
  assert.equal(profile.ladderRef, 'deepseek-openrouter');
  const ladder = routing.ladders['deepseek-openrouter'];
  assert.ok(Array.isArray(ladder?.build) && ladder.build.length >= 2);
  assert.equal(ladder.build[0], 'openrouter/deepseek/deepseek-v4-flash-0731');
  assert.ok(ladder.build.includes('openrouter/xiaomi/mimo-v2.6-flash'));
  assert.ok(!ladder.build.some(m => m.includes('glm')), 'the expensive GLM rung was replaced by the cheap mimo sibling (owner 2026-09-26)');
});

test('buildOcProfileOverrides resolves a ladderRef from config/model-routing.json (issue #1467)', () => {
  const { mod, dir } = freshModule();
  writeProfile(dir, 'by-ref', { ladderRef: 'max' });
  const resolved = mod.buildOcProfileOverrides('by-ref', dir);
  assert.equal(resolved.agent.build.model, 'opencode-go/gpt-6-luna');
});
