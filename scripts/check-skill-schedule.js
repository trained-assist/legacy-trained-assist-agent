'use strict';

// check-skill-schedule.js — schedule-declaration half of the skill contract (#1489 S3.3).
//
// A sibling provider's src/action-manifest.js is what the cron engine registers
// (cron-runtime.js). A revision whose manifest the core registry rejects would
// silently drop the provider from the scheduler, so deploy.sh runs this on the
// new revision BEFORE switching the live checkout (same gate as MCP conformance).
//
// Only an actual rejection by ActionProviderRegistry.register fails the check. A
// repo without a manifest passes (not schedulable yet). A manifest that cannot be
// loaded in the probe (e.g. a dependency not yet installed for the new revision)
// is a warning, not a block — the registry validation is what this gate owns.
//
// Usage: NODE_PATH=<sibling>/node_modules node scripts/check-skill-schedule.js <path-to-skill-repo>
// Exit code 0 = pass, 1 = the core registry rejects the manifest.

const fs = require('fs');
const path = require('path');
const { ActionProviderRegistry } = require('../src/action-provider-registry');

function checkSkillSchedule(repoPath) {
  const manifestPath = path.join(repoPath, 'src', 'action-manifest.js');
  if (!fs.existsSync(manifestPath)) return { ok: true, errors: [], warnings: ['no src/action-manifest.js — provider is not schedulable'] };
  let manifest;
  try { manifest = require(manifestPath).buildManifest(); }
  catch (e) { return { ok: true, errors: [], warnings: [`manifest not loadable in probe: ${String(e.message).split('\n')[0]}`] }; }
  try {
    const actions = new ActionProviderRegistry().register(manifest);
    const scheduled = actions.filter(a => a.schedule).map(a => a.name);
    return { ok: true, errors: [], warnings: [], scheduled };
  } catch (e) {
    return { ok: false, errors: [`core registry rejects ${manifest && manifest.providerId} manifest: ${e.message}`], warnings: [] };
  }
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/check-skill-schedule.js <path-to-skill-repo>');
    process.exit(2);
  }
  const { ok, errors, warnings, scheduled } = checkSkillSchedule(path.resolve(target));
  for (const w of warnings) console.error(`[warn] ${w}`);
  for (const e of errors) console.error(`[error] ${e}`);
  console.log(ok ? 'PASS' : 'FAIL', scheduled ? `(schedulable defaults: ${scheduled.join(', ') || 'none'})` : '');
  // Tool modules may start timers at require time; never let them hold the deploy.
  process.exit(ok ? 0 : 1);
}

module.exports = { checkSkillSchedule };
