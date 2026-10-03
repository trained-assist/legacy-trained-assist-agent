const fs = require('fs');
const path = require('path');
const os = require('os');
const skillsEnforce = require('./skills/enforce');
const { SKILL_SIBLINGS, siblingPaths: siblingPathsOf } = require('./skill-siblings');
const { engineeringWorkspaceRoot, engineeringMirrorsRoot, tokensRoot } = require('./data-paths');
const { atomicJson } = require('./atomic-json');
const { readCredentialFile, masterKeyHex } = require('./credential-store');

// Services whose cookies we know how to inject into Playwright
const COOKIE_DOMAINS = {
  github:  { domain: '.github.com',  cookies: ['user_session', 'dotcom_user', 'logged_in', '__Host-user_session_same_site'] },
  figma:   { domain: '.figma.com',   cookies: ['figma_session', 'figma_user_id'] },
  notion:  { domain: '.notion.so',   cookies: ['token_v2', 'notion_user_id'] },
  linear:  { domain: '.linear.app',  cookies: [] }, // full dump
  slack:   { domain: '.slack.com',   cookies: ['b', 'd'] },
  // nalog uses sessionStorage, not cookies — handled separately in buildNalogOrigins()
};

// nalog.ru stores auth in sessionStorage, not cookies.
// Playwright storageState supports sessionStorage via origins[].sessionStorage.
function buildNalogOrigins(tokenFile) {
  try {
    const raw = readCredentialFile(tokenFile).trim();
    const parsed = JSON.parse(raw);
    if (!parsed.auth_token) return [];
    const items = [
      { name: 'auth.token',         value: parsed.auth_token },
      { name: 'refresh.token',      value: parsed.refresh_token || '' },
      { name: 'auth.token.expires', value: parsed.expires || '' },
    ].filter(i => i.value);
    return [{
      origin: 'https://lknpd.nalog.ru',
      localStorage: [],
      sessionStorage: items,
    }];
  } catch {
    return [];
  }
}

function parseCookieString(str) {
  return str.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return null;
    return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  }).filter(Boolean);
}

function buildStorageState(tokensDir) {
  const cookies = [];
  try {
    for (const [label, config] of Object.entries(COOKIE_DOMAINS)) {
      const tokenFile = path.join(tokensDir, label);
      if (!fs.existsSync(tokenFile)) continue;
      const cookieStr = readCredentialFile(tokenFile).trim();
      const parsed = parseCookieString(cookieStr);
      for (const { name, value } of parsed) {
        if (!value) continue;
        cookies.push({
          name,
          value,
          domain: config.domain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, // 30 days
        });
      }
    }
  } catch (e) {
    console.error('[browser] buildStorageState error:', e.message);
  }
  return { cookies, origins: [] };
}

// ── Per-run config files (issue #76 L1, turn-intent mount) ───────────────────
// A narrowed mount differs per turn, but .mcp.json / .skills-effective.json are ONE
// pair of files per profile, rewritten by every run (see the NO AGENT_SESSION_FILE
// note below). Parallel runs of the same profile — several chats share one profile
// by design — would clobber each other's server set: run A's engine would start with
// run B's sections. So a run that narrows the mount writes
// `<workDir>/.mcp-runs/<runId>.*` instead; every consumer takes the PATH it was
// handed (engine argv, SKILLS_RESOLVED env, buildDomainBlock, shadow), so nothing
// else changes. Stale files of crashed runs are GC'd on the next write.
const RUNS_DIR = '.mcp-runs';
const RUN_FILE_TTL_MS = 6 * 3600 * 1000;

function sanitizeRunId(runId) {
  return String(runId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || null;
}

function runConfigPaths(workDir, runId) {
  const id = sanitizeRunId(runId);
  if (!id) return { mcp: path.join(workDir, '.mcp.json'), effective: null, dir: null, id: null };
  const dir = path.join(workDir, RUNS_DIR);
  return { mcp: path.join(dir, `${id}.mcp.json`), effective: path.join(dir, `${id}.skills-effective.json`), dir, id };
}

function gcRunConfigFiles(dir, keepId) {
  if (!dir) return;
  try {
    const cutoff = Date.now() - RUN_FILE_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      if (keepId && name.startsWith(`${keepId}.`)) continue;
      const p = path.join(dir, name);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* raced with a parallel writer */ }
    }
  } catch { /* no dir yet */ }
}

/**
 * Writes per-user MCP config with Playwright MCP scoped to this user's Chrome profile.
 * If the user has captured service cookies (via Chrome extension), injects them via --storage-state.
 *
 * `siblingPaths` (optional, test seam): overrides for the sibling checkout entrypoints
 * below; production always uses the computed repo-relative paths.
 *
 * `siblings: false` mounts only `playwright` + `trained-skills`. Used by the headless
 * research run (hermes-tools-run.js): a researcher must not see the domain servers that
 * carry mutating tools — engineering's `github_create_pr`/`spawn_workspace`, the hh
 * posting tools and so on (measured 2026-09-28: a nested Hermes did create 2 PRs).
 */
// The env every MCP server process gets (trained-skills and each domain sibling).
// A pure function of its inputs + process.env, so the credential contract
// (scripts/check-credential-reachability.js, #1891) can check the REAL object that
// reaches a skill instead of grepping this file.
function buildMcpToolEnv({ userId, workDir, userName, userHandle, skillsFile, toolSecrets, extraEnv } = {}) {
  return {
    USER_ID: String(userId || ''),
    WORK_DIR: workDir,
    HOME: os.homedir(),
    PATH: process.env.PATH || '',
    // INN enrichment credentials — pass-through from process env (loaded via secrets.env)
    ...(process.env.INN_DADATA_TOKEN  ? { INN_DADATA_TOKEN:       process.env.INN_DADATA_TOKEN }  : {}),
    ...(process.env.INN_DADATA_SECRET ? { INN_DADATA_SECRET:      process.env.INN_DADATA_SECRET } : {}),
    ...(process.env.INN_CHECKO_KEY    ? { INN_CHECKO_KEY:         process.env.INN_CHECKO_KEY }    : {}),
    ...(process.env.INN_RUSPROFILE_COOKIE ? { INN_RUSPROFILE_COOKIE: process.env.INN_RUSPROFILE_COOKIE } : {}),
    // Serper (Google SERP) key for search_serper — the backup web-search engine shipped
    // by the search-skills sibling (epic #1792). Same bypass pattern as INN_*: it only
    // ever reaches the MCP child through this map, so a deploy without the GitHub secret
    // makes the tool answer "serper не сконфигрирован: нужен SERPER_API_KEY" instead of
    // taking the server down.
    ...(process.env.SERPER_API_KEY ? { SERPER_API_KEY: process.env.SERPER_API_KEY } : {}),
    // HH OAuth app (hh-skills 91c-hh-sync) — declared in config/credentials.json, was
    // never passed before the credential contract (#1891) caught it.
    // #2046: canonical SYSTEM_HEADHUNTER_* names are handed to the MCP servers;
    // the legacy HH_CLIENT_* env the hh-skill reads is satisfied from the same value.
    ...(process.env.SYSTEM_HEADHUNTER_CLIENT_ID     ? { SYSTEM_HEADHUNTER_CLIENT_ID:     process.env.SYSTEM_HEADHUNTER_CLIENT_ID }     : {}),
    ...(process.env.SYSTEM_HEADHUNTER_CLIENT_SECRET ? { SYSTEM_HEADHUNTER_CLIENT_SECRET: process.env.SYSTEM_HEADHUNTER_CLIENT_SECRET } : {}),
    ...(process.env.HH_CLIENT_ID     ? { HH_CLIENT_ID:     process.env.HH_CLIENT_ID }     : {}),
    ...(process.env.HH_CLIENT_SECRET ? { HH_CLIENT_SECRET: process.env.HH_CLIENT_SECRET } : {}),
    // Token root (a path, not a secret): siblings resolve profile token files through
    // their data-paths copy; without it they fall back to $HOME/agent-tokens.
    AGENT_TOKENS_DIR: tokensRoot(),
    ...(process.env.GOOGLE_OAUTH_CLIENT_ID     ? { GOOGLE_OAUTH_CLIENT_ID:     process.env.GOOGLE_OAUTH_CLIENT_ID }     : {}),
    ...(process.env.GOOGLE_OAUTH_CLIENT_SECRET ? { GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET } : {}),
    ...(process.env.AGENT_PUBLIC_URL ? { AGENT_PUBLIC_URL: process.env.AGENT_PUBLIC_URL } : {}),
    ...(process.env.AGENT_SECRET    ? { AGENT_SECRET:    process.env.AGENT_SECRET }    : {}),
    // Master key for the encrypted credential store (#1789 C4): MCP tools read and
    // write credential files server-side, so they need to decrypt them too.
    ...(masterKeyHex() ? { CRED_ENCRYPTION_KEY: masterKeyHex() } : {}),
    ...(process.env.GCP_PROJECT     ? { GCP_PROJECT:     process.env.GCP_PROJECT }     : {}),
    ...(process.env.GCP_REGION      ? { GCP_REGION:      process.env.GCP_REGION }      : {}),
    ...(userName       ? { AGENT_USER_NAME:    userName }       : {}),
    ...(userHandle     ? { AGENT_USER_HANDLE: userHandle }     : {}),
    // Engineering workspaces + mirrors inside this profile (issue #1649, src/data-paths.js).
    ...(userId ? {
      ENGINEERING_WORKSPACE_ROOT: engineeringWorkspaceRoot(String(userId)),
      ENGINEERING_MIRRORS_ROOT: engineeringMirrorsRoot(String(userId)),
    } : {}),
    // Registry (src/mcp-skills/registry.js) skips the catalog modules hidden by this file.
    ...(skillsFile ? { SKILLS_RESOLVED: skillsFile } : {}),
    // Per-run flags for the MCP server processes themselves (HERMES_DEPTH). This env
    // wins over the engine's env — see the note below — so it is the one place a run
    // can stamp a fact the server must see.
    // Platform keys from the loaded secrets (#1892: HH OAuth client for token refresh,
    // bot/Deepgram/Cloudflare tokens). Only writeRunMcpConfig(bridged) passes them — the
    // specs stay in memory there; writeMcpConfig writes .mcp.json, which the engine reads.
    ...(toolSecrets || {}),
    ...(extraEnv || {}),
    // NO AGENT_SESSION_FILE here: .mcp.json is ONE file per profile, rewritten by every run,
    // and config env overrides the engine's env — parallel sessions of a profile (different
    // chats) would read each other's session file and get_chat_history would answer for the
    // wrong chat. Per-run identity travels in the engine process env only (runEngineProcess;
    // codex via env_vars in codexMcpArgs).
  };
}

function buildMcpConfig(workDir, userId, { userName, userHandle, siblingPaths, extraEnv, toolSecrets, siblings = true, skillsPlan: planOverride, runId } = {}) {
  // Note: --user-data-dir creates a persistent context, which is incompatible
  // with --storage-state (Playwright limitation). We rely on --storage-state
  // for both cookie injection and session persistence. Per-user isolation is
  // maintained via separate state files in each user's workDir.

  const stateFile = path.join(workDir, 'playwright-storage-state.json');

  // Merge captured extension cookies into existing storage state
  let existing = { cookies: [], origins: [] };
  if (fs.existsSync(stateFile)) {
    try { existing = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { /* corrupt state file — start fresh */ }
  }

  if (userId) {
    const tokensDir = path.join(os.homedir(), 'agent-tokens', String(userId));
    if (fs.existsSync(tokensDir)) {
      const fresh = buildStorageState(tokensDir);
      if (fresh.cookies.length > 0) {
        // Merge: fresh cookies override matching existing ones by name+domain
        const existingMap = new Map(existing.cookies.map(c => [`${c.name}@@${c.domain}`, c]));
        for (const c of fresh.cookies) existingMap.set(`${c.name}@@${c.domain}`, c);
        existing.cookies = Array.from(existingMap.values());
        console.log(`[browser] injected ${fresh.cookies.length} cookies for userId=${userId}`);
      }

      // Inject nalog.ru sessionStorage (auth token stored there, not in cookies)
      const nalogFile = path.join(tokensDir, 'nalog');
      if (fs.existsSync(nalogFile)) {
        const nalogOrigins = buildNalogOrigins(nalogFile);
        if (nalogOrigins.length > 0) {
          // Merge with existing origins by origin URL
          const originMap = new Map((existing.origins || []).map(o => [o.origin, o]));
          for (const o of nalogOrigins) originMap.set(o.origin, o);
          existing.origins = Array.from(originMap.values());
          console.log(`[browser] injected nalog sessionStorage for userId=${userId}`);
        }
      }
    }
  }

  fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2));

  const playwrightArgs = [
    '@playwright/mcp',
    '--headless',
    '--no-sandbox',
    '--storage-state', stateFile,
  ];

  // Profile skills (#1537 PR-B) + turn-intent mount (#76 L1): the runner precomputes
  // the plan (it needs the same numbers for the mount note and prompt audit) and
  // passes it in — `skillsPlan: undefined` = absent = compute it here as before,
  // `skillsPlan: null` = legacy (nothing hidden), an object = use as-is.
  let skillsPlan = planOverride !== undefined ? planOverride : skillsEnforce.planFor(workDir);
  const run = runConfigPaths(workDir, runId);
  gcRunConfigFiles(run.dir, run.id);
  const skillsFile = skillsPlan ? skillsEnforce.writeEffective(workDir, skillsPlan, { file: run.effective }) : null;
  if (skillsPlan && !skillsFile) skillsPlan = null;
  // No plan, or the plan went to a per-run file: a leftover profile-level effective
  // file is inert (no env points at it) but misleading — drop it either way.
  if (!skillsPlan || run.effective) { try { fs.rmSync(path.join(workDir, skillsEnforce.EFFECTIVE_FILE), { force: true }); } catch { /* stale file is inert: no env points at it */ } }

  const mcpToolEnv = buildMcpToolEnv({ userId, workDir, userName, userHandle, skillsFile, toolSecrets, extraEnv });

  const config = {
    mcpServers: {
      playwright: { command: 'npx', args: playwrightArgs },
      'trained-skills': {
        command: 'node',
        args: [path.join(__dirname, 'mcp-skills', 'index.js')],
        env: mcpToolEnv,
      },
    },
  };

  // Domain skill siblings (hh, freelance, engineering) live in their own repos
  // checked out next to this one (deploy.sh syncs them and links them next to
  // every release). They are the single source of each domain's tools (#1470).
  const siblingIndexes = {
    ...Object.fromEntries(SKILL_SIBLINGS.map(sib => [sib.mcpServerId, siblingPathsOf(sib).indexPath])),
    ...(siblingPaths || {}),
  };
  // Profile skills (#1537 PR-B): only with workDir/skills.json; a sibling whose catalog
  // section is off is not mounted. No skills.json
  // or any error → plan null → legacy, nothing hidden.
  const hiddenSiblings = new Set(skillsPlan ? skillsPlan.hidden.siblings : []);
  for (const [serverId, indexPath] of Object.entries(siblingIndexes)) {
    if (!siblings) continue;
    if (hiddenSiblings.has(serverId)) continue;
    if (fs.existsSync(indexPath)) {
      config.mcpServers[serverId] = { command: 'node', args: [indexPath], env: mcpToolEnv };
    }
  }

  if (skillsPlan) {
    const where = run.dir ? `${RUNS_DIR}/${run.id}` : '.mcp.json';
    console.log(`[skills] ${path.basename(workDir)}: sections=${skillsPlan.sections.join(',')} via=${where} hidden sib=${skillsPlan.hidden.siblings.join('|') || '-'} mod=${skillsPlan.hidden.modules.length} dom=${skillsPlan.hidden.domains.length}${skillsPlan.intent ? ` intent=${skillsPlan.intent.applied ? skillsPlan.sections.length + ' sections' : 'fell-open'}` : ''}`);
  }

  return config;
}

function writeMcpConfig(workDir, userId, opts = {}) {
  const config = buildMcpConfig(workDir, userId, opts);
  // 0660, not atomicJson's default 0600: the run's claude reads this file as the
  // profile's slot user. A 0600 file gets ACL mask --- and stays unreadable until
  // shareServiceFiles() fixes it before a run — but a parallel run of the same
  // profile rewrites the file in between, and the first run's claude then dies on
  // start with «EACCES … .mcp.json» (exit code 1). The profile gate still keeps
  // other profiles out. A runId (narrowed mount, #76) routes to .mcp-runs/<id>.mcp.json
  // so two parallel runs never share the file at all.
  const configPath = runConfigPaths(workDir, opts.runId).mcp;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicJson(configPath, config, { space: 2, mode: 0o660 });
  return configPath;
}

// Engine-facing MCP config for one run (issue #1649).
// bridged=false → exactly writeMcpConfig; servers=null.
// bridged=true  → the real server specs (with their server-side env) stay in memory
//   and are returned as `servers` for src/agent-mcp-bridge.js; the file the engine
//   reads only names the bridge client, so it carries no secrets and the MCP
//   servers keep running as the service user, not as the run-as slot.
function writeRunMcpConfig(workDir, userId, opts = {}, { bridged = false } = {}) {
  if (!bridged) return { mcpConfig: writeMcpConfig(workDir, userId, opts), servers: null };
  const { bridgedMcpConfig } = require('./agent-mcp-bridge');
  // The tool bot token must be the bot of THIS run's audience (runner passes the
  // taskDelivery token): tg_send_file / get_group_file in a freelance or recruiter
  // chat with the classic bot's token hit a chat that bot is not in, and a
  // file_id minted for one bot cannot be fetched with another.
  const { TOOL_BOT_TOKEN_ENV } = require('./channels/telegram-files');
  const { botToken, ...rest } = opts;
  const toolSecrets = { ...require('./secrets').toolPlatformEnv(), ...(botToken ? { [TOOL_BOT_TOKEN_ENV]: String(botToken) } : {}) };
  const real = buildMcpConfig(workDir, userId, { ...rest, toolSecrets });
  const configPath = runConfigPaths(workDir, rest.runId).mcp;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicJson(configPath, bridgedMcpConfig(real), { space: 2 });
  return { mcpConfig: configPath, servers: real.mcpServers };
}

module.exports = { writeMcpConfig, buildMcpConfig, buildMcpToolEnv, writeRunMcpConfig, buildNalogOrigins };
