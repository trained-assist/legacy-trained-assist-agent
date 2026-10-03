'use strict';
// Token naming scheme {SCOPE}_{SERVICE}_{TYPE} (issue #2046).
//
// The rename is ADDITIVE: canonical names are introduced alongside the legacy
// ones, and every legacy name must keep resolving. A host whose Secret Manager
// still holds only CF_API_TOKEN has to keep deploying — the whole point of the
// scheme is that it survives the migration, not that it forces one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── 1. Canonical names are loadable ──────────────────────────────────────────
test('secrets.js OPTIONAL carries every canonical name', () => {
  const { OPTIONAL } = require('../src/secrets');
  for (const n of [
    'ADMIN_CLOUDFLARE_API_TOKEN',
    'SYSTEM_DEEPGRAM_API_KEY',
    'ADMIN_GITHUB_API_TOKEN',
    'SYSTEM_HEADHUNTER_CLIENT_ID',
    'SYSTEM_HEADHUNTER_CLIENT_SECRET',
  ]) {
    assert.ok(OPTIONAL.includes(n), `${n} is not in OPTIONAL — it can never be fetched`);
  }
});

// ── 2. Canonical wins, legacy alias is the fallback ─────────────────────────
test('canonical name wins; legacy alias is the fallback', async () => {
  const { loadSecrets } = require('../src/secrets');

  // Only the legacy name present → both fields resolve to it (backward compat).
  const legacyOnly = await withEnv({
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 't', AGENT_SECRET: 'a',
    CF_API_TOKEN: 'legacy-cf',
    DEEPGRAM_API_KEY: 'legacy-dg',
    GITHUB_ISSUES_TOKEN: 'legacy-gh',
    HH_CLIENT_ID: 'legacy-hh-id', HH_CLIENT_SECRET: 'legacy-hh-secret',
  }, () => loadSecrets());

  assert.equal(legacyOnly.CF_API_TOKEN, 'legacy-cf');
  assert.equal(legacyOnly.ADMIN_CLOUDFLARE_API_TOKEN, 'legacy-cf');
  assert.equal(legacyOnly.DEEPGRAM_API_KEY, 'legacy-dg');
  assert.equal(legacyOnly.SYSTEM_DEEPGRAM_API_KEY, 'legacy-dg');
  assert.equal(legacyOnly.GITHUB_ISSUES_TOKEN, 'legacy-gh');
  assert.equal(legacyOnly.ADMIN_GITHUB_API_TOKEN, 'legacy-gh');
  assert.equal(legacyOnly.HH_CLIENT_ID, 'legacy-hh-id');
  assert.equal(legacyOnly.SYSTEM_HEADHUNTER_CLIENT_ID, 'legacy-hh-id');

  // Both present → canonical wins, legacy field mirrors it.
  const both = await withEnv({
    SECRETS_SOURCE: 'env',
    TELEGRAM_BOT_TOKEN: 't', AGENT_SECRET: 'a',
    ADMIN_CLOUDFLARE_API_TOKEN: 'canon-cf', CF_API_TOKEN: 'legacy-cf',
    SYSTEM_DEEPGRAM_API_KEY: 'canon-dg', DEEPGRAM_API_KEY: 'legacy-dg',
    ADMIN_GITHUB_API_TOKEN: 'canon-gh', GITHUB_ISSUES_TOKEN: 'legacy-gh',
    SYSTEM_HEADHUNTER_CLIENT_ID: 'canon-hh-id', HH_CLIENT_ID: 'legacy-hh-id',
  }, () => loadSecrets());

  assert.equal(both.ADMIN_CLOUDFLARE_API_TOKEN, 'canon-cf');
  assert.equal(both.CF_API_TOKEN, 'canon-cf', 'legacy field must mirror the canonical value');
  assert.equal(both.SYSTEM_DEEPGRAM_API_KEY, 'canon-dg');
  assert.equal(both.DEEPGRAM_API_KEY, 'canon-dg');
  assert.equal(both.ADMIN_GITHUB_API_TOKEN, 'canon-gh');
  assert.equal(both.GITHUB_ISSUES_TOKEN, 'canon-gh');
  assert.equal(both.SYSTEM_HEADHUNTER_CLIENT_ID, 'canon-hh-id');
  assert.equal(both.HH_CLIENT_ID, 'canon-hh-id');
});

// ── 3. cf-pages.js resolves canonical-first ──────────────────────────────────
test('cf-pages resolveCredential: canonical ADMIN_ wins, CF_API_TOKEN is the fallback', async () => {
  const { resolveCredential } = require('../src/cf-pages');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-naming-'));
  process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

  // No profile token, only legacy env → shared from legacy.
  const legacy = resolveCredential('nobody', {
    env: { CF_API_TOKEN: 'legacy-cf', CF_ACCOUNT_ID: 'acc' }, tokensRoot: TMP,
  });
  assert.equal(legacy.source, 'shared');
  assert.equal(legacy.token, 'legacy-cf');

  // Canonical present → wins over the legacy value.
  const canon = resolveCredential('nobody', {
    env: { ADMIN_CLOUDFLARE_API_TOKEN: 'canon-cf', CF_API_TOKEN: 'legacy-cf', CF_ACCOUNT_ID: 'acc' },
    tokensRoot: TMP,
  });
  assert.equal(canon.token, 'canon-cf');

  // Profile's own token beats both.
  fs.mkdirSync(path.join(TMP, 'carol'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'carol', 'cloudflare'), JSON.stringify({ value: 'own', account_id: 'acc-own' }));
  const own = resolveCredential('carol', {
    env: { ADMIN_CLOUDFLARE_API_TOKEN: 'canon-cf' }, tokensRoot: TMP,
  });
  assert.equal(own.source, 'own');
  assert.equal(own.token, 'own');
});

// ── 4. MCP tool env hands out canonical names ────────────────────────────────
test('TOOL_PLATFORM_KEYS maps tool env names to canonical secret fields', () => {
  const { TOOL_PLATFORM_KEYS } = require('../src/secrets');
  assert.equal(TOOL_PLATFORM_KEYS.CLOUDFLARE_API_TOKEN, 'ADMIN_CLOUDFLARE_API_TOKEN');
  assert.equal(TOOL_PLATFORM_KEYS.DEEPGRAM_API_KEY, 'SYSTEM_DEEPGRAM_API_KEY');
  assert.equal(TOOL_PLATFORM_KEYS.HH_CLIENT_ID, 'SYSTEM_HEADHUNTER_CLIENT_ID');
  assert.equal(TOOL_PLATFORM_KEYS.HH_CLIENT_SECRET, 'SYSTEM_HEADHUNTER_CLIENT_SECRET');
});

// ── 5. Registry declares canonical env with legacy aliases ───────────────────
test('credentials.json declares canonical names with legacy aliases', () => {
  const reg = require('../src/credential-registry.js').load();
  const has = (canon, alias) => reg.credentials.some(
    c => (c.env || []).includes(canon) && (!alias || (c.aliases || []).includes(alias)));

  assert.ok(has('ADMIN_CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'), 'cloudflare canonical + legacy alias');
  assert.ok(has('SYSTEM_DEEPGRAM_API_KEY', 'DEEPGRAM_API_KEY'), 'deepgram canonical + legacy alias');
  assert.ok(has('ADMIN_GITHUB_API_TOKEN', 'GITHUB_ISSUES_TOKEN'), 'github canonical + legacy alias');
  assert.ok(has('SYSTEM_HEADHUNTER_CLIENT_ID', 'HH_CLIENT_ID'), 'hh client id canonical + legacy alias');
  assert.ok(has('SYSTEM_HEADHUNTER_CLIENT_SECRET', 'HH_CLIENT_SECRET'), 'hh client secret canonical + legacy alias');

  // The per-profile user token is declared as a profile credential.
  assert.ok(reg.credentials.some(c => c.consumer === 'core:cloudflare-user'
    && (c.files || []).includes('cloudflare')), 'per-profile cloudflare token declared');
});
