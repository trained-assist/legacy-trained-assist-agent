'use strict';

// check-skill-schedule.js — schedule-declaration half of the skill contract (#1489 S3.3).
//
// A sibling provider's action-provider-manifest.json is what the cron engine registers
// (cron-runtime.js). A revision whose manifest the core registry rejects would
// silently drop the provider from the scheduler, so deploy.sh runs this on the
// new revision BEFORE switching the live checkout (same gate as MCP conformance).
//
// A repo without the manifest passes (provider not schedulable yet); an existing
// manifest that is not JSON or that ActionProviderRegistry.register rejects fails.
// Static JSON on purpose: the gate runs no provider code and needs no dependencies.
//
// Usage: node scripts/check-skill-schedule.js <path-to-skill-repo>
// Exit code 0 = pass, 1 = the core registry rejects the manifest.

const fs = require('fs');
const path = require('path');
const { ActionProviderRegistry } = require('../src/action-provider-registry');

const MANIFEST = 'action-provider-manifest.json';

function checkSkillSchedule(repoPath) {
  const manifestPath = path.join(repoPath, MANIFEST);
  if (!fs.existsSync(manifestPath)) return { ok: true, errors: [], warnings: [`no ${MANIFEST} — provider is not schedulable`] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, errors: [`${MANIFEST} is not valid JSON: ${e.message}`], warnings: [] }; }
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
  process.exit(ok ? 0 : 1);
}

module.exports = { checkSkillSchedule, MANIFEST };
