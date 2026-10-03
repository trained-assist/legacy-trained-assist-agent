'use strict';

// Agent process hardening, stage T0 (issue #1649). Two independent switches,
// both OFF by default — rollout is an ops step (scripts/ops/agent-isolation-setup.sh):
//
//   AGENT_ENV_ALLOWLIST=1
//     The engine CLI (claude/codex/opencode) gets an env built from an explicit
//     allowlist (engine vars + run identity + the current profile's tokens)
//     instead of the whole service environment. Server-side secrets (bot
//     tokens, AGENT_SECRET, provider keys) never reach the engine process.
//
//   AGENT_RUN_AS_USERS=<user>[,<user>…]
//     A pool of dedicated unprivileged unix users ("slots"). Each engine run
//     leases one slot exclusively (lock file, cross-process: nested Hermes runs
//     live in a different process), is spawned via `sudo -n -u <slot>`, and can
//     only reach its own profile dir: the profile dir is a gate that carries an
//     ACL entry for that one slot only while the run lasts. Implies the env
//     allowlist. MCP servers do NOT run as the slot: they keep the service
//     user's env/files and are reached through src/agent-mcp-bridge.js, which
//     the agent can only use with a run-scoped token.
//
// What the service user can do that a slot cannot, and how the pieces fit, is
// described in docs/agent-process-isolation.md.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

function isolationConfig(env = process.env) {
  const runAsUsers = String(env.AGENT_RUN_AS_USERS || '')
    .split(',').map(s => s.trim()).filter(s => /^[a-z_][a-z0-9_-]{0,31}$/.test(s));
  const runAs = runAsUsers.length > 0;
  return {
    envAllowlist: runAs || env.AGENT_ENV_ALLOWLIST === '1',
    runAs,
    runAsUsers,
    agentGroup: env.AGENT_RUN_AS_GROUP || 'ta-agents',
    serviceUser: env.AGENT_SERVICE_USER || safeUsername(),
    serviceHome: env.AGENT_SERVICE_HOME || os.homedir(),
    sudoBin: env.AGENT_ISOLATION_SUDO || 'sudo',
    setfaclBin: env.AGENT_ISOLATION_SETFACL || 'setfacl',
    slotLockDir: env.AGENT_SLOT_LOCK_DIR
      || path.join(env.AGENT_DATA_DIR || path.join(os.homedir(), 'agent-data'), 'agent-slots'),
    slotWaitMs: Number(env.AGENT_SLOT_WAIT_MS) || 60_000,
  };
}

function safeUsername() {
  try { return os.userInfo().username; } catch { return process.env.USER || ''; }
}

// ── Env allowlist ─────────────────────────────────────────────────────────────

// Exact names the engine process may inherit. Everything else is dropped.
const ENGINE_ENV_ALLOW = new Set([
  // process basics
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR',
  // engine selection / behaviour (no credentials)
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'MCP_TOOL_TIMEOUT', 'OPENCODE_CONFIG',
  'OPENCODE_MODEL', 'DISABLE_AUTOUPDATER',
  // engine credential injected per run (short-lived access token, never the refresh token)
  'CLAUDE_CODE_OAUTH_TOKEN',
  // OpenCode's `ladder` provider key (llm-ladder worker, issue #1687)
  'OPENCODE_LADDER_TOKEN',
  // Turns on OpenCode's built-in `websearch` tool (no API key, public Exa endpoint) —
  // the only way an opencode run can search at all (see runEngineProcess).
  'OPENCODE_ENABLE_EXA',
  // run identity (not secrets)
  // (no chat id: without a bot token the engine cannot use it; MCP tools get it via the bridge)
  'AGENT_USER_ID', 'AGENT_TASK_ID', 'AGENT_THREAD_ID', 'AGENT_SESSION_ID',
  // trace labels only: opencode stamps them onto every llm-ladder call as x-ladder-* headers
  // (src/opencode-ladder-provider.js). The chat goes under its own name so nothing starts
  // reading it as a send target (epic #1365 ratchet on the chat-id env).
  'AGENT_RUN_ID', 'AGENT_TRACE_CHAT', 'AGENT_LADDER_APP',
  'AGENT_USER_NAME', 'AGENT_USER_HANDLE',
  // run-scoped callback credentials (src/agent-run-tokens.js, src/agent-mcp-bridge.js)
  'AGENT_RUN_TOKEN', 'AGENT_MCP_BRIDGE_SOCKET',
]);
const ENGINE_ENV_ALLOW_PREFIXES = ['LC_', 'CLAUDE_CODE_'];

// Names glibc's loader strips from the environment of every setuid program
// (sysdeps/generic/unsecvars.h, applied under AT_SECURE before main()). sudo is
// setuid, so these never reach the slot through the process env — whatever sudoers
// says, sudo itself never sees them (issue #1791: TMPDIR vanished this way and every
// slot fell back to the shared /tmp). Allowlisted ones travel as sudo argv
// assignments instead (see sudoArgv). Only non-secret names may ever be allowlisted
// from this list: argv is visible in `ps`.
const GLIBC_SETUID_STRIPPED_ENV = new Set([
  'GCONV_PATH', 'GETCONF_DIR', 'HOSTALIASES', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK', 'LD_HWCAP_MASK', 'LD_LIBRARY_PATH', 'LD_ORIGIN_PATH', 'LD_PRELOAD',
  'LD_PROFILE', 'LD_SHOW_AUXV', 'LD_USE_LOAD_BIAS', 'LOCALDOMAIN', 'LOCPATH', 'MALLOC_TRACE',
  'NIS_PATH', 'NLSPATH', 'RESOLV_HOST_CONF', 'RES_OPTIONS', 'TMPDIR', 'TZDIR',
]);
const ARGV_ENV = [...ENGINE_ENV_ALLOW].filter(k => GLIBC_SETUID_STRIPPED_ENV.has(k));

// Server-only names that must never reach an engine even if some other rule
// (e.g. a profile token file with a colliding name) would admit them.
const SERVER_ONLY_ENV = new Set([
  'AGENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'RECRUITER_BOT_TOKEN', 'FREELANCE_BOT_TOKEN',
  'BOT_SECRET', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY',
  'IDEOGRAM_API_KEY', 'RECRAFT_API_KEY', 'CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'OPENROUTER_API_KEY',
  'GITHUB_ISSUES_TOKEN', 'WEB_JWT_SECRET', 'WEB_VERIFY_SECRET', 'CHECKLIST_API_KEY',
  'GOOGLE_OAUTH_CLIENT_SECRET', 'HH_CLIENT_SECRET', 'ZEROCREDS_ADMIN_TOKEN', 'LLM_LADDER_TOKEN',
  'INN_DADATA_TOKEN', 'INN_DADATA_SECRET', 'INN_CHECKO_KEY', 'INN_RUSPROFILE_COOKIE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_KEEPALIVE_FILE', 'AGENT_SESSION_FILE',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);
// Bot tokens are server-only by CLASS, not by enumeration: a token missing from this
// list leaks into the engine (model) env. SALES_BOT_TOKEN was absent until 2026-10-02 —
// the same registry that loadSecrets now honours (agent#2041) also drives this, so a
// bot added tomorrow is protected without a second hand-edited list.
for (const b of require('./bot-registry').BOTS) SERVER_ONLY_ENV.add(b.token_secret_name);

/**
 * Build the engine env from the full ("legacy") env the runner would have used.
 * Keeps allowlisted names, the current profile's token names, and `extra`;
 * server-only names are always dropped.
 */
function buildAgentEnv(fullEnv, { userTokenNames = [], extra = {}, engineCredentialNames = [] } = {}) {
  const tokenNames = new Set(userTokenNames);
  const out = {};
  for (const [k, v] of Object.entries(fullEnv || {})) {
    if (v == null || SERVER_ONLY_ENV.has(k)) continue;
    if (ENGINE_ENV_ALLOW.has(k) || tokenNames.has(k) || ENGINE_ENV_ALLOW_PREFIXES.some(p => k.startsWith(p))) {
      out[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || SERVER_ONLY_ENV.has(k)) continue;
    out[k] = String(v);
  }
  // The engine's own model-provider keys (engineCredentialNames): without them the engine
  // cannot call its models at all. Deliberately allowed past the server-only list.
  for (const k of engineCredentialNames) {
    if (fullEnv?.[k] != null && fullEnv[k] !== '') out[k] = String(fullEnv[k]);
  }
  return out;
}

// Env names an engine reads its model-provider credentials from.
// opencode: every profile routes through the `ladder` provider, whose credential is
// OPENCODE_LADDER_TOKEN (admitted as an engine credential in runEngineProcess). The agent
// holds NO OpenCode Go / Zen key — those pools live in the llm-ladder — so no
// OPENCODE_API_KEY is admitted. Custom providers in opencode config files reference env
// vars as {env:NAME} or ${NAME} (e.g. gigachat → ${GIGACHAT_TOKEN}); every such reference
// is followed, which is how the ladder token above is picked up too.
// codex: OPENAI_API_KEY when it runs on an API key. claude: OAuth, nothing from env.
const ENV_REF_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function engineCredentialNames(engine, { configFiles = [] } = {}) {
  if (engine === 'codex') return ['OPENAI_API_KEY'];
  if (engine !== 'opencode') return [];
  const names = new Set();
  for (const f of configFiles) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(ENV_REF_RE)) names.add(m[1] || m[2]);
  }
  return [...names];
}

// ── Slot pool (cross-process lock files) ─────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function tryLockSlot(cfg, slot) {
  fs.mkdirSync(cfg.slotLockDir, { recursive: true, mode: 0o700 });
  const file = path.join(cfg.slotLockDir, `${slot}.lock`);
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // Held — reclaim only if the holder process is gone (restart, crash).
  let holder = NaN;
  try { holder = Number(fs.readFileSync(file, 'utf8').trim()); } catch { /* raced away */ }
  if (pidAlive(holder)) return false;
  try { fs.rmSync(file, { force: true }); } catch { return false; }
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
}

function releaseSlotLock(cfg, slot) {
  try { fs.rmSync(path.join(cfg.slotLockDir, `${slot}.lock`), { force: true }); } catch { /* best effort */ }
}

async function acquireSlot(cfg, { waitMs = cfg.slotWaitMs, pollMs = 500 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const slot of cfg.runAsUsers) if (tryLockSlot(cfg, slot)) return slot;
    if (Date.now() >= deadline) throw new Error(`agent isolation: no free run-as slot (${cfg.runAsUsers.length} configured)`);
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Profile gate ACLs ─────────────────────────────────────────────────────────
//
// A gate is a top-level directory an engine run needs (profile workDir, or a
// code cwd outside it). Inside a gate every entry carries group-ACLs for the
// agent group (inherited via default ACLs), so the ONLY thing that decides
// which slot can reach a profile is the gate's own access entry for that slot,
// added for the run and removed after it. Other profiles' gates never have it.

const GATE_MARKER = '.agent-acl-v1';

function gateDirs(workDir, cwd) {
  const gates = [path.resolve(workDir)];
  if (cwd) {
    const c = path.resolve(cwd);
    if (c !== gates[0] && !c.startsWith(gates[0] + path.sep)) gates.push(c);
  }
  return gates;
}

// Commands (argv lists) that prepare a gate once and then open/close it for a slot.
function gatePrepareCommands(cfg, gate) {
  const G = cfg.agentGroup, S = cfg.serviceUser;
  return [
    ['chmod', 'o-rwx', gate],
    // children: current entries + inherited defaults for future ones
    [cfg.setfaclBin, '-R', '-P', '-m', `g:${G}:rwX,d:g:${G}:rwX,d:u:${S}:rwX,m::rwx,d:m::rwx`, gate],
    // the gate itself: keep the defaults, drop the group's access entry
    [cfg.setfaclBin, '-x', `g:${G}`, gate],
  ];
}

function gateOpenCommand(cfg, gate, slot) { return [cfg.setfaclBin, '-m', `u:${slot}:rwx`, gate]; }

function runCmd(argv, exec = execFileSync) {
  exec(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
}

// Traverse-only (x) for the slot on a path's ancestors inside the service
// home, so it can reach the gate (or the bridge socket) without listing
// anything. A directory that is itself a gate (has the marker) is never opened
// this way — that would bypass it.
function ancestorDirs(target, serviceHome = os.homedir()) {
  const home = path.resolve(serviceHome);
  const out = [];
  for (let d = path.dirname(path.resolve(target)); d === home || d.startsWith(home + path.sep); d = path.dirname(d)) {
    if (!fs.existsSync(path.join(d, GATE_MARKER))) out.push(d);
    if (d === home) break;
  }
  return out;
}

// Files the SERVICE wrote into a profile with mode 0600 (chat/web attachments, answer
// modes, …) have ACL mask --- and are invisible to the slot of THIS profile's run. They
// are the profile's own data, so before a run the service (their owner) opens them to
// the group; other profiles stay closed by their gates. Browser profiles are skipped.
function shareServiceFiles(cfg, gate, { exec } = {}) {
  try {
    runCmd(['find', gate, '-xdev', '(', '-name', 'chrome', '-type', 'd', ')', '-prune', '-o',
      '-type', 'f', '-user', cfg.serviceUser, '!', '-perm', '-g+r', '-exec', 'chmod', 'g+rw', '{}', '+'], exec);
  } catch (e) { console.warn(`[isolation] could not share service files in ${gate}: ${e.message}`); }
}

// Fix ACL masks on files left by ANY slot. When a slot creates files (e.g.,
// SQLite's opencode.db), the file-creation mode (0644) intersects with the
// default ACL mask (rwx) to produce mask r-- — too restrictive for the NEXT slot.
// shareSlotFiles only fixes files owned by the current slot, so cross-slot files
// stay broken. Running as root (service user has passwordless sudo) lets us fix
// any file regardless of owner.
function fixSlotFileMasks(cfg, gate, { exec } = {}) {
  const home = path.join(gate, '.agent-home');
  if (!fs.existsSync(home)) return;
  try {
    // Files: ensure group has read+write
    runCmd([cfg.sudoBin, '-n', 'find', home, '-xdev',
      '(', '-name', 'chrome', '-type', 'd', ')', '-prune', '-o',
      '-type', 'f', '!', '-perm', '-g+rw', '-exec', 'chmod', 'g+rw', '{}', '+'], exec);
    // Directories: ensure group has read+write+traverse
    runCmd([cfg.sudoBin, '-n', 'find', home, '-xdev',
      '(', '-name', 'chrome', '-type', 'd', ')', '-prune', '-o',
      '-type', 'd', '!', '-perm', '-g+rwx', '-exec', 'chmod', 'g+rwx', '{}', '+'], exec);
  } catch (e) { console.warn(`[isolation] could not fix slot file masks in ${gate}: ${e.message}`); }
}

function prepareGate(cfg, gate, { exec } = {}) {
  fs.mkdirSync(gate, { recursive: true, mode: 0o700 });
  const marker = path.join(gate, GATE_MARKER);
  if (fs.existsSync(marker)) return;
  for (const argv of gatePrepareCommands(cfg, gate)) runCmd(argv, exec);
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
}

// Every path that got an ACL entry for a slot is journaled BEFORE the entry is
// added, so a run that never reached release() (restart/KillMode, crash) is
// cleaned up by the next lease of that slot instead of leaving a profile open.
function journalPath(cfg, slot) { return path.join(cfg.slotLockDir, `${slot}.acl.json`); }

function revokePaths(cfg, slot, paths, { exec } = {}) {
  for (const p of paths) {
    try { runCmd([cfg.setfaclBin, '-x', `u:${slot}`, p], exec); }
    catch (e) { if (fs.existsSync(p)) console.error(`[isolation] FAILED to revoke ${slot} on ${p}: ${e.message}`); }
  }
}

function recoverSlot(cfg, slot, { exec } = {}) {
  const file = journalPath(cfg, slot);
  let paths = [];
  try { paths = JSON.parse(fs.readFileSync(file, 'utf8')).paths || []; } catch { return; }
  console.warn(`[isolation] ${slot}: revoking ${paths.length} ACL entr(ies) left by an interrupted run`);
  // The interrupted run's gates are the paths it could write (its traverse-only
  // ancestors are skipped by find's -user filter at no cost).
  shareSlotFiles(cfg, slot, paths.filter(p => fs.existsSync(path.join(p, GATE_MARKER))), { exec });
  revokePaths(cfg, slot, paths, { exec });
  fs.rmSync(file, { force: true });
}

// Files a slot creates carry the mode the program asked for (sqlite, most CLIs: 0644).
// With the gate's default ACL that mode becomes the ACL mask, so the group entry is
// cut to read-only and the NEXT run — another slot — cannot write them (opencode's
// session DB failed exactly like that). Only the owner may change it, so the slot
// itself opens its files to the group before its access to the gate is revoked.
function shareSlotFiles(cfg, slot, dirs, { exec } = {}) {
  for (const d of dirs) {
    try {
      // chrome/: the live browser profile — service-owned, huge, never the slot's.
      runCmd([cfg.sudoBin, '-n', '-u', slot, '--', 'find', d, '-xdev',
        '(', '-name', 'chrome', '-type', 'd', ')', '-prune', '-o',
        '-user', slot, '!', '-type', 'l',
        '(', '!', '-perm', '-g+rw', '-o', '-type', 'd', '!', '-perm', '-g+x', ')',
        '-exec', 'chmod', 'g+rwX', '{}', '+'], exec);
    } catch (e) { console.warn(`[isolation] ${slot}: could not share its files in ${d}: ${e.message}`); }
  }
}

// Kill everything the slot user still runs (background jobs the agent left behind).
// The slot is leased exclusively, so this only ever hits this run's leftovers.
function reapSlot(cfg, slot, { exec } = {}) {
  try { runCmd([cfg.sudoBin, '-n', '-u', slot, '--', 'pkill', '-KILL', '-u', slot], exec); }
  catch { /* pkill exits 1 when nothing matched */ }
}

// ── Engine home (per profile, inside the gate) ───────────────────────────────
//
// A slot cannot read the service user's ~/.claude, ~/.codex or opencode dirs.
// The engine runs with HOME=<workDir>/.agent-home (persistent per profile, so
// native resume and CLI state survive across slots) and gets the minimum it
// needs: claude — a short-lived OAuth access token via env (never the refresh
// token: the host broker scripts/claude-token-refresh.js stays the only refresher);
// codex/opencode — copies of their config/auth files.

function engineHomeDir(workDir) { return path.join(workDir, '.agent-home'); }

function engineStagePlan(engine, serviceHome = os.homedir()) {
  const h = serviceHome;
  if (engine === 'claude') return [{ src: path.join(h, '.claude', 'settings.json'), dest: path.join('.claude', 'settings.json') }];
  if (engine === 'codex') {
    return [
      { src: path.join(h, '.codex', 'config.toml'), dest: path.join('.codex', 'config.toml') },
      // codex refreshes its own token; write a rotated one back so the host copy stays current.
      { src: path.join(h, '.codex', 'auth.json'), dest: path.join('.codex', 'auth.json'), syncBack: true },
    ];
  }
  if (engine === 'opencode') {
    return [
      { src: path.join(h, '.config', 'opencode', 'opencode.json'), dest: path.join('.config', 'opencode', 'opencode.json') },
      { src: path.join(h, '.local', 'share', 'opencode', 'auth.json'), dest: path.join('.local', 'share', 'opencode', 'auth.json') },
    ];
  }
  return [];
}

function readClaudeAccessToken(serviceHome = os.homedir()) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(serviceHome, '.claude', '.credentials.json'), 'utf8'));
    return creds?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

// TMPDIR of a run: <home>/tmp/<slot>. Per slot, not per profile: two runs of one
// profile may overlap, and each clears its own dir on release (clearSlotTmp) — a
// shared dir would delete the other run's files. A slot is leased exclusively, so
// <slot> is unique among live runs.
function engineTmpDir(workDir, slot) { return path.join(engineHomeDir(workDir), 'tmp', slot || 'run'); }

function stageEngineHome(engine, workDir, { serviceHome = os.homedir(), slot } = {}) {
  const home = engineHomeDir(workDir);
  fs.mkdirSync(home, { recursive: true, mode: 0o770 });
  const staged = [];
  for (const item of engineStagePlan(engine, serviceHome)) {
    if (!fs.existsSync(item.src)) continue;
    const dest = path.join(home, item.dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o770 });
    const content = fs.readFileSync(item.src);
    // Replace, don't overwrite: an engine may have re-created the file as the slot
    // user, and only the owner could chmod it. 0660: the group class is the ACL mask.
    fs.rmSync(dest, { force: true });
    fs.writeFileSync(dest, content, { mode: 0o660 });
    staged.push({ ...item, dest, original: content });
  }
  writeAgentGitConfig(home, serviceHome);
  const tmp = engineTmpDir(workDir, slot); // not the shared /tmp: other slots could read it
  fs.mkdirSync(tmp, { recursive: true, mode: 0o770 });
  const env = { HOME: home, TMPDIR: tmp };
  if (engine === 'claude') {
    const tok = readClaudeAccessToken(serviceHome);
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  return { home, env, staged };
}

// git under a slot: the repos in a profile belong to the service user, so without
// safe.directory git refuses them ("dubious ownership"). Commit identity comes from the
// service's git config; pushes use THIS profile's GitHub token (GH_TOKEN in the engine
// env), never the service's credential helper.
function readGitIdentity(serviceHome) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(serviceHome, '.gitconfig'), 'utf8');
    let section = '';
    for (const line of text.split('\n')) {
      const sec = /^\s*\[([^\]]+)\]/.exec(line);
      if (sec) { section = sec[1].trim().toLowerCase(); continue; }
      const kv = /^\s*(name|email)\s*=\s*(.+?)\s*$/.exec(line);
      if (section === 'user' && kv) out[kv[1]] = kv[2];
    }
  } catch { /* no service git config */ }
  return out;
}

function writeAgentGitConfig(home, serviceHome) {
  const id = readGitIdentity(serviceHome);
  const lines = [
    '# written per run by src/agent-isolation.js (issue #1649)',
    '[safe]', '\tdirectory = *',
    ...(id.name || id.email ? ['[user]', ...(id.name ? [`\tname = ${id.name}`] : []), ...(id.email ? [`\temail = ${id.email}`] : [])] : []),
    '[credential "https://github.com"]',
    '\thelper = "!f() { [ -n \\"$GH_TOKEN\\" ] || exit 0; echo username=x-access-token; echo password=$GH_TOKEN; }; f"',
  ];
  const file = path.join(home, '.gitconfig');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o660 });
}

function syncBackEngineHome(staged) {
  for (const item of staged || []) {
    if (!item.syncBack) continue;
    try {
      const now = fs.readFileSync(item.dest);
      if (now.equals(item.original)) continue;
      JSON.parse(now.toString('utf8')); // never write back a torn/partial file
      const tmp = `${item.src}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, now, { mode: 0o600 });
      fs.renameSync(tmp, item.src);
    } catch (e) { console.warn(`[isolation] sync-back ${item.src}: ${e.message}`); }
  }
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

function resolveBin(bin, envPath = process.env.PATH || '') {
  if (bin.includes('/')) return path.resolve(bin);
  for (const dir of envPath.split(':').filter(Boolean)) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return bin;
}

// argv for running `bin args…` as `slot`. The env travels through the process
// environment (sudoers: !env_reset for the slot users) — except the allowlisted
// names glibc strips from setuid programs (ARGV_ENV, i.e. TMPDIR): sudo would never
// see those, so they go as `NAME=value` assignments, which sudo applies itself.
function sudoArgv(cfg, slot, bin, args, env = {}) {
  const assign = ARGV_ENV.filter(k => env[k] != null && env[k] !== '').map(k => `${k}=${env[k]}`);
  return [cfg.sudoBin, ['-n', '-u', slot, ...assign, '--', resolveBin(bin), ...args]];
}

// Temp files of a run: the engine (opencode/bun) unpacks a ~5.5 MB native lib per
// start, plus whatever tools write. /tmp was wiped by reboots; the profile's tmp is
// persistent, so it is emptied on every release — and, on lease, the leftovers of
// a crashed run of this slot plus day-old dirs of other slots. Run AS the slot
// (it owns those files; no privileged rm inside a dir slots can write), while the
// gate is still open; best effort.
function clearSlotTmp(cfg, slot, tmpDir, { exec, stale = false } = {}) {
  const runAsSlot = (argv) => runCmd([cfg.sudoBin, '-n', '-u', slot, '--', ...argv], exec);
  try { runAsSlot(['find', tmpDir, '-xdev', '-mindepth', '1', '-delete']); }
  catch (e) { if (fs.existsSync(tmpDir)) console.warn(`[isolation] ${slot}: could not clear ${tmpDir}: ${e.message}`); }
  if (!stale) return;
  try {
    runAsSlot(['find', path.dirname(tmpDir), '-xdev', '-mindepth', '1', '-maxdepth', '1', '!', '-name', path.basename(tmpDir),
      '-mmin', '+1440', '-exec', 'rm', '-rf', '--one-file-system', '{}', '+']);
  } catch (e) { console.warn(`[isolation] ${slot}: could not sweep stale temp dirs in ${path.dirname(tmpDir)}: ${e.message}`); }
}

/**
 * Lease a slot, open the gates and return what the caller needs to spawn the
 * engine as that slot, plus a release() that undoes everything (idempotent).
 * `reach`: extra paths (the MCP bridge socket) the slot must be able to reach —
 * traverse-only on their ancestors, for this run.
 */
async function prepareIsolatedRun(cfg, { workDir, cwd, engine, exec, serviceHome = cfg.serviceHome || os.homedir(), reach = [] } = {}) {
  const slot = await acquireSlot(cfg);
  const gates = gateDirs(workDir, cwd);
  let stage = { env: {}, staged: [] };
  let aclPaths = [];
  let gateOpen = false;
  const undo = () => {
    reapSlot(cfg, slot, { exec });
    if (gateOpen && stage.env.TMPDIR) clearSlotTmp(cfg, slot, stage.env.TMPDIR, { exec });
    if (aclPaths.length) shareSlotFiles(cfg, slot, gates, { exec }); // while the gate is still open
    revokePaths(cfg, slot, aclPaths, { exec });
    fs.rmSync(journalPath(cfg, slot), { force: true });
  };
  try {
    reapSlot(cfg, slot, { exec });
    recoverSlot(cfg, slot, { exec });
    stage = stageEngineHome(engine, workDir, { serviceHome, slot });
    for (const gate of gates) { prepareGate(cfg, gate, { exec }); shareServiceFiles(cfg, gate, { exec }); fixSlotFileMasks(cfg, gate, { exec }); }
    const traverse = [...new Set([...gates, ...reach].flatMap(p => ancestorDirs(p, serviceHome)))]
      .filter(d => !gates.includes(d));
    aclPaths = [...traverse, ...gates];
    fs.writeFileSync(journalPath(cfg, slot), JSON.stringify({ pid: process.pid, paths: aclPaths }), { mode: 0o600 });
    for (const d of traverse) runCmd([cfg.setfaclBin, '-m', `u:${slot}:x`, d], exec);
    for (const gate of gates) runCmd(gateOpenCommand(cfg, gate, slot), exec);
    gateOpen = true;
    clearSlotTmp(cfg, slot, stage.env.TMPDIR, { exec, stale: true });
  } catch (e) {
    undo();
    releaseSlotLock(cfg, slot);
    throw e;
  }
  let released = false;
  const runEnv = { ...stage.env, USER: slot, LOGNAME: slot };
  return {
    slot,
    gates,
    aclPaths,
    env: runEnv,
    // env: the final engine env; defaults to this run's own part (HOME/TMPDIR/…).
    spawnArgv: (bin, args, env = runEnv) => sudoArgv(cfg, slot, bin, args, env),
    release() {
      if (released) return;
      released = true;
      undo();
      syncBackEngineHome(stage.staged);
      releaseSlotLock(cfg, slot);
    },
  };
}

module.exports = {
  isolationConfig,
  buildAgentEnv,
  engineCredentialNames,
  ENGINE_ENV_ALLOW,
  SERVER_ONLY_ENV,
  GLIBC_SETUID_STRIPPED_ENV,
  ARGV_ENV,
  acquireSlot,
  releaseSlotLock,
  tryLockSlot,
  gateDirs,
  gatePrepareCommands,
  gateOpenCommand,
  prepareGate,
  shareServiceFiles,
  fixSlotFileMasks,
  ancestorDirs,
  journalPath,
  recoverSlot,
  reapSlot,
  shareSlotFiles,
  engineHomeDir,
  engineTmpDir,
  clearSlotTmp,
  engineStagePlan,
  stageEngineHome,
  syncBackEngineHome,
  writeAgentGitConfig,
  readClaudeAccessToken,
  resolveBin,
  sudoArgv,
  prepareIsolatedRun,
  GATE_MARKER,
};
