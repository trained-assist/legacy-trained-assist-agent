const { BOTS, missingBotTokens } = require('./bot-registry');

const REQUIRED = ['TELEGRAM_BOT_TOKEN', 'AGENT_SECRET'];
// Canonical names follow {SCOPE}_{SERVICE}_{TYPE} (issue #2046). The pre-#2046
// names stay loadable as aliases so a host that has not migrated its Secret
// Manager yet keeps working — the rename is additive, never a hard cut.
//
//   ADMIN_CLOUDFLARE_API_TOKEN   ← alias CF_API_TOKEN, CLOUDFLARE_API_TOKEN
//   SYSTEM_DEEPGRAM_API_KEY      ← alias DEEPGRAM_API_KEY, DEEPGRAM_KEY
//   ADMIN_GITHUB_API_TOKEN       ← alias GITHUB_ISSUES_TOKEN
//   SYSTEM_HEADHUNTER_CLIENT_ID  ← alias HH_CLIENT_ID
//   SYSTEM_HEADHUNTER_CLIENT_SECRET ← alias HH_CLIENT_SECRET
const OPTIONAL = [
  'RECRUITER_BOT_TOKEN', 'FREELANCE_BOT_TOKEN', 'SALES_BOT_TOKEN', 'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY', 'SYSTEM_DEEPGRAM_API_KEY',
  'BOT_SECRET',
  'CF_API_TOKEN', 'ADMIN_CLOUDFLARE_API_TOKEN',
  'OPERATOR_CHAT_ID',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'HH_CLIENT_ID', 'HH_CLIENT_SECRET', 'SYSTEM_HEADHUNTER_CLIENT_ID', 'SYSTEM_HEADHUNTER_CLIENT_SECRET',
  'OPENAI_API_KEY', 'FAL_KEY', 'IDEOGRAM_API_KEY', 'RECRAFT_API_KEY', 'OPENROUTER_API_KEY',
  'GITHUB_ISSUES_TOKEN', 'ADMIN_GITHUB_API_TOKEN',
  'WEB_JWT_SECRET', 'WEB_VERIFY_SECRET', 'CHECKLIST_API_KEY',
];

// GCP Secret Manager — used when running on GCP with ADC available
async function loadFromGcp() {
  // GOOGLE_APPLICATION_CREDENTIALS may point to a Drive-only SA (no Secret Manager access).
  // Unset it for the entire duration so the SDK uses the Compute Engine metadata server
  // (which has SM access). Restored in finally after all API calls complete.
  const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const PROJECT = process.env.GCP_PROJECT || 'alesa-personal-assistent'; // GCP project name — cannot be renamed

    async function getSecret(name) {
      const [version] = await client.accessSecretVersion({
        name: `projects/${PROJECT}/secrets/${name}/versions/latest`,
      });
      return version.payload.data.toString('utf8').trim();
    }

    const names = [...REQUIRED, ...OPTIONAL];
    const results = await Promise.allSettled(names.map(n => getSecret(n)));
    // allSettled folds every per-secret rejection into `null`, which is
    // indistinguishable from "optional and intentionally unset". A genuinely
    // missing/unfetchable secret (NOT_FOUND, IAM, network) must be loud — an
    // OPTIONAL bot token silently resolving to null for weeks broke recruiter
    // delivery with zero operator signal (2026-09-24). Log every rejection's
    // code+message at boot. The `rate` is a hint that a missing OPTIONAL secret
    // is a real problem, not a deliberate "off".
    for (let i = 0; i < names.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const reason = r.reason || {};
        console.error(`[secrets] FAILED to load ${names[i]}: ${reason.code || ''} ${reason.message || r.reason}`);
      }
    }
    return Object.fromEntries(names.map((n, i) => [
      n,
      results[i].status === 'fulfilled' ? results[i].value : null,
    ]));
  } finally {
    if (savedCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
  }
}

// Env-var fallback — used on non-GCP VMs (e.g. Hostland RU VM)
function loadFromEnv() {
  const names = [...REQUIRED, ...OPTIONAL];
  return Object.fromEntries(names.map(n => [n, process.env[n] || null]));
}

// Raw values keyed by secret name (GCP Secret Manager first, env fallback).
async function loadSecretValues() {
  let values;

  if (process.env.SECRETS_SOURCE === 'env') {
    values = loadFromEnv();
  } else {
    // Try GCP first, fall back to env vars
    try {
      values = await loadFromGcp();
      // Fill missing with env vars
      for (const n of [...REQUIRED, ...OPTIONAL]) {
        if (!values[n] && process.env[n]) values[n] = process.env[n];
      }
    } catch {
      values = loadFromEnv();
    }
  }

  return values;
}

async function loadSecrets({ auditBots = true } = {}) {
  const values = await loadSecretValues();

  for (const name of REQUIRED) {
    if (!values[name]) throw new Error(`Required secret missing: ${name}`);
  }

  // An enabled bot without its token must be loud, not a silent 503 on every
  // delivery to that audience (2026-09-24 RECRUITER_BOT_TOKEN incident, epic #1342).
  // auditBots:false — for processes that never deliver to a registry audience
  // (ru-edge sends only via the classic bot): their tokens are legitimately
  // absent there, so the warning would cry wolf on every start (2 lines of
  // false "delivery will fail" in the ru-edge journal).
  const missingBots = missingBotTokens(values);
  if (auditBots) {
    for (const b of missingBots) {
      console.error(`[secrets] BOT TOKEN MISSING: bot "${b.botId}" (audience ${b.audience}) is enabled in bots.registry but ${b.token_secret_name} did not load — its delivery will fail`);
    }
  }

  return {
    MISSING_BOTS: missingBots.map(b => b.botId),
    // Delivery reads `secrets[b.token_secret_name]` per registry entry (bot-delivery.js),
    // so a hand-maintained key list below silently breaks EVERY bot added after it: on
    // 02.10.2026 SALES_BOT_TOKEN was loaded correctly from Secret Manager/env and still
    // absent here — every sales run (flexi-consult) died with "sales Telegram delivery
    // is not configured" (503), while the boot audit saw nothing missing. Derive the
    // token keys from the registry instead: a new bot now works by construction, and
    // test/secrets-bot-tokens.test.cjs fails the build if it ever stops doing so.
    ...Object.fromEntries(BOTS.map(b => [b.token_secret_name, values[b.token_secret_name] || null])),
    BOT_TOKEN: values.TELEGRAM_BOT_TOKEN,
    RECRUITER_BOT_TOKEN: values.RECRUITER_BOT_TOKEN,
    FREELANCE_BOT_TOKEN: values.FREELANCE_BOT_TOKEN,
    ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY, // not used for direct API calls — Claude Code uses OAuth; OpenRouter for LLM calls
    AGENT_SECRET: values.AGENT_SECRET,
    DEEPGRAM_API_KEY: values.SYSTEM_DEEPGRAM_API_KEY || values.DEEPGRAM_API_KEY,
    SYSTEM_DEEPGRAM_API_KEY: values.SYSTEM_DEEPGRAM_API_KEY || values.DEEPGRAM_API_KEY,
    BOT_SECRET: values.BOT_SECRET,
    // Canonical admin token wins; the legacy name is the fallback so an
    // unmigrated Secret Manager still deploys (cf-pages.js resolves the same way).
    ADMIN_CLOUDFLARE_API_TOKEN: values.ADMIN_CLOUDFLARE_API_TOKEN || values.CF_API_TOKEN,
    CF_API_TOKEN: values.ADMIN_CLOUDFLARE_API_TOKEN || values.CF_API_TOKEN,
    OPERATOR_CHAT_ID: values.OPERATOR_CHAT_ID,
    GOOGLE_OAUTH_CLIENT_ID: values.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: values.GOOGLE_OAUTH_CLIENT_SECRET,
    HH_CLIENT_ID: values.SYSTEM_HEADHUNTER_CLIENT_ID || values.HH_CLIENT_ID,
    HH_CLIENT_SECRET: values.SYSTEM_HEADHUNTER_CLIENT_SECRET || values.HH_CLIENT_SECRET,
    SYSTEM_HEADHUNTER_CLIENT_ID: values.SYSTEM_HEADHUNTER_CLIENT_ID || values.HH_CLIENT_ID,
    SYSTEM_HEADHUNTER_CLIENT_SECRET: values.SYSTEM_HEADHUNTER_CLIENT_SECRET || values.HH_CLIENT_SECRET,
    OPENAI_API_KEY: values.OPENAI_API_KEY,
    FAL_KEY: values.FAL_KEY,
    IDEOGRAM_API_KEY: values.IDEOGRAM_API_KEY,
    RECRAFT_API_KEY: values.RECRAFT_API_KEY,
    OPENROUTER_API_KEY: values.OPENROUTER_API_KEY,
    GITHUB_ISSUES_TOKEN: values.ADMIN_GITHUB_API_TOKEN || values.GITHUB_ISSUES_TOKEN,
    ADMIN_GITHUB_API_TOKEN: values.ADMIN_GITHUB_API_TOKEN || values.GITHUB_ISSUES_TOKEN,
    WEB_JWT_SECRET: values.WEB_JWT_SECRET,
    WEB_VERIFY_SECRET: values.WEB_VERIFY_SECRET,
    CHECKLIST_API_KEY: values.CHECKLIST_API_KEY,
  };
}

// Boot-time operator alert for enabled bots without a token. Sent via the classic
// bot (a REQUIRED secret, so always present) — never via the broken bot itself.
async function alertMissingBotTokens(secrets, { fetchImpl = fetch } = {}) {
  const missing = secrets?.MISSING_BOTS || [];
  const chatId = secrets?.OPERATOR_CHAT_ID || '1714048'; // same fallback as server.js operator notices
  if (!missing.length || !secrets.BOT_TOKEN) return false;
  const tgBase = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '');
  const text = `🚨 Агент стартовал без токена бота: ${missing.join(', ')}.\nДоставка этим ботам будет падать (503). Проверь секрет в GCP Secret Manager (infra/env-manifest.json → bots.registry).`;
  try {
    const res = await fetchImpl(`${tgBase}/bot${secrets.BOT_TOKEN}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return !!res?.ok;
  } catch (e) {
    console.error('[secrets] missing-bot alert failed:', e.message);
    return false;
  }
}

// Platform keys the MCP tool servers need (#1892). Loaded secrets live only in
// memory on prod (GCP Secret Manager), never in process.env, so the tools get them
// through this explicit list — tool env name → loaded-secrets field. Only the MCP
// servers receive them (bridge, in memory); the engine env strips them
// (SERVER_ONLY_ENV) and .mcp.json on disk never carries them.
const TOOL_PLATFORM_KEYS = {
  AGENT_BOT_TOKEN: 'BOT_TOKEN',
  // Canonical name is handed to the tool servers; the legacy DEEPGRAM_API_KEY
  // env some siblings still read is satisfied from the same field.
  DEEPGRAM_API_KEY: 'SYSTEM_DEEPGRAM_API_KEY',
  CLOUDFLARE_API_TOKEN: 'ADMIN_CLOUDFLARE_API_TOKEN',
  HH_CLIENT_ID: 'SYSTEM_HEADHUNTER_CLIENT_ID',
  HH_CLIENT_SECRET: 'SYSTEM_HEADHUNTER_CLIENT_SECRET',
};

let _loaded = null;
function setLoadedSecrets(s) { _loaded = s || null; }
function getLoadedSecrets() { return _loaded; }

function toolPlatformEnv(src = _loaded) {
  const out = {};
  if (!src) return out;
  for (const [envName, field] of Object.entries(TOOL_PLATFORM_KEYS)) {
    if (src[field]) out[envName] = String(src[field]);
  }
  return out;
}

module.exports = { loadSecrets, loadSecretValues, alertMissingBotTokens, REQUIRED, OPTIONAL,
  TOOL_PLATFORM_KEYS, setLoadedSecrets, getLoadedSecrets, toolPlatformEnv };
