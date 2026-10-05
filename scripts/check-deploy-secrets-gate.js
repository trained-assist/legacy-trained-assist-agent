#!/usr/bin/env node
/**
 * Pre-deploy secrets gate (epic #1885, after the 01.10.2026 SALES_BOT_TOKEN incident).
 *
 * Runs the credential checks against the TARGET release while the previous one is still
 * serving, so a red guard means "this release does not go live" instead of "this release
 * went live and then the pipeline turned red". That was the defect: check-bot-secrets.js sat
 * AFTER deploy.sh in ci.yml, so a383f63 was live while the job was already failing.
 *
 *   node scripts/check-deploy-secrets-gate.js [--release <dir>] [--env gcp|ru|vm2]
 *
 *   1. check-credential-reachability.js — static contract, no values, runs everywhere:
 *      declared ⊆ provided AND host-enabled consumers declared (bots.registry).
 *   2. check-bot-secrets.js — the value half: does every enabled bot really resolve its
 *      token (Secret Manager first, host env fallback). gcp only: ru-edge has no runner and
 *      vm2 has no bot delivery yet (issue #2114 — bot identities move there in P2/P3), so
 *      both legitimately hold no bot tokens (same reasoning as secrets.js auditBots:false).
 *
 * This script writes nothing, restarts nothing and never moves ~/agent-master — deploy.sh
 * calls it before the release is activated. Exit 0 gate open · 1 gate closed.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const o = { release: null, env: process.env.DEPLOY_ENV || 'gcp', skipBots: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release') o.release = argv[++i];
    else if (a === '--env') o.env = argv[++i];
    else if (a === '--skip-bot-secrets') o.skipBots = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function run(release, script, label) {
  console.log(`==> pre-deploy gate: ${label}`);
  const r = spawnSync(process.execPath, [path.join(release, 'scripts', script)], {
    cwd: release, stdio: 'inherit', env: process.env,
  });
  if (r.error) {
    console.error(`  ❌ ${label} could not run: ${r.error.message}`);
    return 1;
  }
  return r.status === 0 ? 0 : 1;
}

function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const release = opts.release ? path.resolve(opts.release) : path.join(__dirname, '..');

  let bad = run(release, 'check-credential-reachability.js', 'credential contract (declared ⊆ provided, both directions)');
  const bots = opts.env === 'gcp' && !opts.skipBots;
  if (bots) bad += run(release, 'check-bot-secrets.js', 'bot tokens really resolve on this host');
  else console.log('==> pre-deploy gate: bot-token probe skipped (host has no runner/bot delivery)');

  if (bad) {
    console.error(`\n❌ pre-deploy gate closed (${bad} failing check(s)) — NOT activating ${path.basename(release)}.`);
    console.error('   The previous release keeps serving; restore the secret in GCP Secret Manager');
    console.error('   (infra/env-manifest.json → gcp_secret_manager_only) or fix the registry and redeploy.');
    return 1;
  }
  console.log(`\n✅ pre-deploy gate open — ${path.basename(release)} may be activated.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));