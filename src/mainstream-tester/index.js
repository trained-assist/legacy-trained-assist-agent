'use strict';
// Entry point for the mainstream tester.
//
// Modes:
//   1. External agent (AGENT_URL set): sends requests to an already-running agent.
//      The agent must have TELEGRAM_API_URL pointing to THIS process's fake server.
//      Use when running the tester on the same VM as the production agent in test mode.
//
//   2. Spawned agent (default): starts a fresh isolated agent subprocess with
//      fake Telegram wired up automatically. Clean, no production interference.
//
// Env vars:
//   AGENT_URL          — use external agent instead of spawning one
//   AGENT_SECRET       — required
//   ANTHROPIC_API_KEY  — required (for spawned agent)
//   OPENROUTER_API_KEY — required (for mainstream-decider LLM calls)
//   MAINSTREAM_STEPS   — steps per path (default 7)
//   MAINSTREAM_RUNS    — number of full test runs (default 1)

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { FakeTelegram } = require('./fake-telegram');
const { Orchestrator } = require('./orchestrator');

const SPAWNED_AGENT_PORT = 3099;
// Each tester invocation gets its own timestamped data dir → no GTD spillover
// from previous runs. Bugs are written to a per-invocation file.
const SESSION_TAG = Date.now();
const TEST_DATA_ROOT = path.join(os.homedir(), 'agent-data');
const TEST_DATA_DIR = path.join(TEST_DATA_ROOT, `mainstream-test-${SESSION_TAG}`);
const KEEP_RUN_DIRS = 12; // ~2 days at one run per 4h

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`[mainstream] Required env var missing: ${name}`); process.exit(1); }
  return v;
}

// Env of the spawned test agent. Everything that the agent persists per profile
// must point inside the per-run testDataDir: before USERS_DIR was set here, every
// run created two real profiles mt<tag>h / mt<tag>a in ~/users (64 by 2026-09-29).
function buildTestAgentEnv(testDataDir, fakeTgPort) {
  return {
    ...process.env,
    PORT: String(SPAWNED_AGENT_PORT),
    TELEGRAM_API_URL: `http://127.0.0.1:${fakeTgPort}`,
    TELEGRAM_BOT_TOKEN: 'fake-mainstream-token',
    AGENT_DATA_DIR: testDataDir,
    USERS_DIR: path.join(testDataDir, 'users'),
    // Isolate agent tokens to the test dir so test users don't pollute ~/agent-tokens.
    // Set BOTH names: data-paths/hh-* read AGENT_TOKENS_DIR, user-tokens.js reads AGENT_TOKENS_ROOT.
    AGENT_TOKENS_DIR: path.join(testDataDir, 'tokens'),
    AGENT_TOKENS_ROOT: path.join(testDataDir, 'tokens'),
    NODE_ENV: 'test',
    TEST_MODE: '1',
    // Force env-var secrets loading (skip GCP Secret Manager)
    SECRETS_SOURCE: 'env',
  };
}

// Per-run data dirs (mainstream-test-<ts>) accumulate every 4h via cron. Keep the
// newest `keep`; the durable cross-run logs live in mainstream-test/ and are untouched.
function pruneOldRunDirs(root, keep = KEEP_RUN_DIRS) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const runs = names.filter(n => /^mainstream-test-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  const removed = runs.slice(keep);
  for (const n of removed) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return removed;
}

async function spawnTestAgent(fakeTgPort) {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const agentPath = path.join(__dirname, '..', 'server.js');
  const env = buildTestAgentEnv(TEST_DATA_DIR, fakeTgPort);

  const proc = spawn(process.execPath, [agentPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout.on('data', d => process.stdout.write(`[test-agent] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[test-agent] ${d}`));

  // Wait for "listening" line
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test agent startup timeout (30s)')), 30_000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Test agent exited prematurely with code ${code}`));
    });
  });

  console.log(`[mainstream] Test agent ready on :${SPAWNED_AGENT_PORT}`);
  return proc;
}

async function main() {
  const agentSecret = requiredEnv('AGENT_SECRET');
  const openrouterKey = requiredEnv('OPENROUTER_API_KEY');
  const maxSteps = parseInt(process.env.MAINSTREAM_STEPS || '7', 10);
  const maxRuns = parseInt(process.env.MAINSTREAM_RUNS || '1', 10);
  const externalAgentUrl = process.env.AGENT_URL;

  // 1. Start fake Telegram server
  const fakeTg = new FakeTelegram();
  const fakeTgPort = await fakeTg.start();

  // 2. Start (or connect to) the agent
  let agentProc = null;
  let agentUrl = externalAgentUrl;

  if (!agentUrl) {
    agentProc = await spawnTestAgent(fakeTgPort);
    agentUrl = `http://127.0.0.1:${SPAWNED_AGENT_PORT}`;
  } else {
    console.log(`[mainstream] Using external agent at ${agentUrl}`);
    console.log(`[mainstream] ⚠ Make sure the agent has TELEGRAM_API_URL=http://127.0.0.1:${fakeTgPort}`);
  }

  // 3. Create orchestrator
  const orchestrator = new Orchestrator({
    agentUrl,
    agentSecret,
    openrouterKey,
    maxSteps,
    stateDir: TEST_DATA_DIR,
  });

  // Wire fake Telegram → orchestrator
  fakeTg.on('message_final', msg => orchestrator.onFinalMessage(msg));

  // 4. Run test cycles
  let totalBugs = 0;
  let totalDriverErrors = 0;
  for (let i = 0; i < maxRuns; i++) {
    console.log(`\n[mainstream] ══════ Run ${i + 1}/${maxRuns} ══════`);
    fakeTg.reset();
    const result = await orchestrator.startRun();
    const driverErrors = result.bugs.filter(b => b.type === 'driver_error').length;
    totalBugs += result.bugs.length - driverErrors;
    totalDriverErrors += driverErrors;

    if (i < maxRuns - 1) await new Promise(r => setTimeout(r, 5_000));
  }

  // 5. Cleanup
  agentProc?.kill();
  await fakeTg.stop();

  // Remove stray test-user token dirs from ~/agent-tokens (mt* pattern)
  const agentTokensDir = path.join(os.homedir(), 'agent-tokens');
  try {
    for (const entry of fs.readdirSync(agentTokensDir)) {
      if (/^mt[0-9a-z]+[ha]$/.test(entry)) {
        fs.rmSync(path.join(agentTokensDir, entry), { recursive: true, force: true });
      }
    }
  } catch {}

  const pruned = pruneOldRunDirs(TEST_DATA_ROOT);
  if (pruned.length) console.log(`[mainstream] Pruned ${pruned.length} old run dirs`);

  console.log(`\n[mainstream] All done. Total bugs: ${totalBugs} (product) + ${totalDriverErrors} driver errors`);
  console.log(`[mainstream] Bug log: ${orchestrator.bugsFile}`);
  console.log(`[mainstream] State: ${orchestrator.stateFile}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[mainstream] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { buildTestAgentEnv, pruneOldRunDirs };
