'use strict';

// Production wiring for cron-service (#1489 P1-min): which providers can be
// scheduled, how their actions are reached, and which host is allowed to tick.
//
// - Registry: action manifests of the sibling skill providers. Only actions
//   whose manifest lists 'cron' in allowedTriggers can be scheduled — nothing is
//   inferred from tool names. Today that is the HH provider; generalising the
//   headless transport to every sibling is P3 (S3.4).
// - Transport: the scoped-child router (action-transport → mcp-action), the same
//   per-call USER_ID/WORK_DIR isolation as every MCP tool call.
// - Role: only the host with CRON_SCHEDULER_ROLE=primary ticks. Staging never
//   ticks (STAGING_ROOT set by the staging isolation harness), whatever the env.

const fs = require('fs');
const path = require('path');
const { ActionProviderRegistry } = require('./action-provider-registry');
const { ActionExecutions } = require('./action-executions');
const { createMcpTransport } = require('./action-transport');
const { createCronService } = require('./cron-service');

const TICK_INTERVAL_MS = 60 * 1000;
// The provider's committed, core-valid manifest (built by its scripts/build-manifest.cjs
// and checked in CI). Static JSON: no provider code runs in core to learn its policy.
// Previously this read src/action-manifest.js, which existed only as an untracked
// file on the prod host (#1502) — a clean host would silently lose HH from cron.
const HH_MANIFEST = path.join(__dirname, '..', '..', 'trained-assist-hh-skill', 'action-provider-manifest.json');

function schedulerRole(env = process.env) {
  if (env.STAGING_ROOT) return 'staging';
  return env.CRON_SCHEDULER_ROLE === 'primary' ? 'primary' : 'off';
}

function buildRegistry({ manifests = null, log = () => {} } = {}) {
  const registry = new ActionProviderRegistry();
  const list = manifests || (fs.existsSync(HH_MANIFEST) ? [JSON.parse(fs.readFileSync(HH_MANIFEST, 'utf8'))] : []);
  for (const manifest of list) {
    // One bad provider must not take the scheduler down for the others.
    try { registry.register(manifest); }
    catch (err) { log(`[cron] provider ${manifest && manifest.providerId} not schedulable: ${err.message}`); }
  }
  return registry;
}

let service = null;
function getCronService({ log = console.log } = {}) {
  if (!service) {
    service = createCronService({
      executions: new ActionExecutions(),
      registry: buildRegistry({ log }),
      transport: createMcpTransport(),
      log,
    });
  }
  return service;
}

// In-process tick. The external alarm (systemd timer → POST /internal/cron/tick,
// P2.1) is the backup; both go through the same claim transaction, so a double
// tick can never run an occurrence twice.
function startScheduler({ env = process.env, log = console.log } = {}) {
  const role = schedulerRole(env);
  if (role !== 'primary') {
    log(`[cron] scheduler not started (role=${role})`);
    return null;
  }
  const svc = getCronService({ log });
  const timer = setInterval(() => { svc.tick(); }, TICK_INTERVAL_MS);
  timer.unref();
  log('[cron] scheduler started (role=primary, tick=60s)');
  return timer;
}

module.exports = { getCronService, startScheduler, schedulerRole, buildRegistry, TICK_INTERVAL_MS };
