#!/usr/bin/env node
/**
 * Validates that the secrets written to secrets.env in ci.yml match infra/env-manifest.json.
 *
 * Run: node scripts/check-env-sync.js
 * Used by CI — exits 1 if mismatch detected.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/env-manifest.json'), 'utf8'));
const ciYml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

let errors = 0;

function fail(msg) {
  console.error(`  ❌ ${msg}`);
  errors++;
}

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}

// Extract keys from a printf format string block in ci.yml.
// Looks for the printf '...' block between startMarker and endMarker lines.
function extractPrintfKeys(ymlContent, startMarker) {
  const lines = ymlContent.split('\n');
  const startIdx = lines.findIndex(l => l.includes(startMarker));
  if (startIdx === -1) return null;

  // Collect lines until the > /home/vova/secrets.env line
  const block = [];
  for (let i = startIdx; i < Math.min(startIdx + 40, lines.length); i++) {
    block.push(lines[i]);
    if (lines[i].includes('> /home/vova/secrets.env')) break;
  }
  const text = block.join('\n');

  // Extract KEY=%s patterns from the printf format string
  const keys = [];
  const re = /([A-Z][A-Z0-9_]+)=%s/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

// Build expected key lists from manifest (GitHub Secrets written to secrets.env)
const gcpExpected = manifest.github_actions_secrets.app
  .filter(s => s.written_to.includes('gcp'))
  .map(s => s.name)
  .sort();

// RU: GitHub Secrets written to secrets.env (excludes static values like AGENT_PUBLIC_URL)
const ruExpected = manifest.github_actions_secrets.app
  .filter(s => s.written_to.includes('ru'))
  .map(s => s.name)
  .sort();

// Keys in ci.yml printf that are NOT from GitHub Secrets (hardcoded static values or bypass-secrets vars)
const staticRuKeys = new Set([
  ...(manifest.static_values_in_secrets_env?.ru ?? []).map(s => s.name),
]);

// Extract actual key lists from ci.yml
const gcpActual = extractPrintfKeys(ciYml, 'Deploy to GCP VM');
const ruActual = extractPrintfKeys(ciYml, 'Deploy to RU VM');

console.log('\n=== check-env-sync: validating ci.yml matches infra/env-manifest.json ===\n');

// Validate GCP
console.log('[GCP VM secrets.env]');
if (!gcpActual) {
  fail('Could not find "Deploy to GCP VM" block in ci.yml');
} else {
  const gcpActualSorted = [...gcpActual].sort();
  const missing = gcpExpected.filter(k => !gcpActual.includes(k));
  const extra = gcpActual.filter(k => !gcpExpected.includes(k));
  if (missing.length === 0 && extra.length === 0) {
    ok(`GCP secrets.env matches manifest (${gcpActual.length} keys)`);
  } else {
    if (missing.length) fail(`Keys in manifest but missing from ci.yml GCP printf: ${missing.join(', ')}`);
    if (extra.length)   fail(`Keys in ci.yml GCP printf but not in manifest: ${extra.join(', ')}`);
  }
}

// Validate RU
console.log('\n[RU VM secrets.env]');
if (!ruActual) {
  fail('Could not find "Deploy to RU VM" block in ci.yml');
} else {
  // Filter out static (non-GitHub-Secret) keys before comparing
  const ruActualFiltered = ruActual.filter(k => !staticRuKeys.has(k));
  const missing = ruExpected.filter(k => !ruActualFiltered.includes(k));
  const extra = ruActualFiltered.filter(k => !ruExpected.includes(k));
  if (missing.length === 0 && extra.length === 0) {
    ok(`RU secrets.env matches manifest (${ruActualFiltered.length} GH Secret keys + ${staticRuKeys.size} static values)`);
  } else {
    if (missing.length) fail(`Keys in manifest but missing from ci.yml RU printf: ${missing.join(', ')}`);
    if (extra.length)   fail(`Keys in ci.yml RU printf but not in manifest: ${extra.join(', ')}`);
  }
}

// Validate the manual-deploy workflow against ci.yml: both write /home/vova/secrets.env on
// the same VMs, so a printf that drifted there silently DELETES keys on every Manual Deploy.
// Incident 2026-10-01: deploy-manual.yml still had the pre-#1695 key list — a Manual Deploy
// dropped CHECKLIST_API_KEY and both OPENCODE_GO_API_KEY(S) from prod while CI stayed green.
console.log('\n[deploy-manual.yml vs ci.yml]');
const manualYmlPath = path.join(ROOT, '.github/workflows/deploy-manual.yml');
if (!fs.existsSync(manualYmlPath)) {
  ok('no deploy-manual.yml — nothing to drift');
} else {
  const manualYml = fs.readFileSync(manualYmlPath, 'utf8');
  const pairs = [['GCP VM secrets.env', 'Deploy to GCP VM'], ['RU VM secrets.env', 'Deploy to RU VM']];
  for (const [label, marker] of pairs) {
    const manual = extractPrintfKeys(manualYml, marker);
    const ci = extractPrintfKeys(ciYml, marker);
    if (!manual) { fail(`Could not find "${marker}" block in deploy-manual.yml`); continue; }
    if (!ci) continue; // already reported above
    const missing = ci.filter(k => !manual.includes(k));
    const extra = manual.filter(k => !ci.includes(k));
    if (missing.length === 0 && extra.length === 0) {
      ok(`${label} printf matches ci.yml (${manual.length} keys)`);
    } else {
      if (missing.length) fail(`Keys in ci.yml but missing from deploy-manual.yml ${label} printf: ${missing.join(', ')}`);
      if (extra.length)   fail(`Keys in deploy-manual.yml ${label} printf but not in ci.yml: ${extra.join(', ')}`);
    }
  }
}

// Validate secrets.js alignment:
// Every key in secrets.js REQUIRED+OPTIONAL must appear in manifest (either github_actions_secrets or gcp_secret_manager_only).
// The manifest may have extra keys that bypass secrets.js (INN_* vars) — that is expected and not flagged.
console.log('\n[secrets.js alignment]');
const secretsJs = fs.readFileSync(path.join(ROOT, 'src/secrets.js'), 'utf8');
const reqMatch = secretsJs.match(/const REQUIRED\s*=\s*\[([^\]]+)\]/);
const optMatch = secretsJs.match(/const OPTIONAL\s*=\s*\[([^\]]+)\]/);
if (reqMatch && optMatch) {
  const allInCode = [reqMatch[1], optMatch[1]]
    .join(',')
    .match(/'([^']+)'/g)
    .map(s => s.replace(/'/g, ''));

  const allInManifest = new Set([
    ...manifest.github_actions_secrets.app.map(s => s.name),
    ...manifest.gcp_secret_manager_only.secrets.map(s => s.name),
  ]);

  const notInManifest = allInCode.filter(k => !allInManifest.has(k));

  if (notInManifest.length === 0) {
    ok(`All secrets.js entries are documented in manifest (${allInCode.length} secrets)`);
  } else {
    fail(`In secrets.js but missing from manifest: ${notInManifest.join(', ')}`);
  }
}

// Validate the bot registry (epic #1342): every bot's token must be loaded by
// secrets.js AND documented in a Secret-Manager-backed manifest section — a bot
// token that lives nowhere checkable is exactly how RECRUITER_BOT_TOKEN vanished
// silently on 2026-09-24.
console.log('\n[bot registry]');
{
  const bots = manifest.bots?.registry;
  if (!Array.isArray(bots) || bots.length === 0) {
    fail('infra/env-manifest.json: bots.registry is missing or empty');
  } else {
    const codeNames = new Set([reqMatch?.[1] || '', optMatch?.[1] || ''].join(',').match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || []);
    const inSm = new Set([
      ...manifest.github_actions_secrets.app.filter(s => s.gcp_sm).map(s => s.name),
      ...manifest.gcp_secret_manager_only.secrets.map(s => s.name),
    ]);
    const seen = { botId: new Set(), audience: new Set(), token_secret_name: new Set() };
    let botErrors = 0;
    for (const b of bots) {
      for (const f of ['botId', 'audience', 'token_secret_name']) {
        if (!b[f]) { fail(`bot ${JSON.stringify(b)}: missing ${f}`); botErrors++; continue; }
        if (seen[f].has(b[f])) { fail(`bots.registry: duplicate ${f} "${b[f]}"`); botErrors++; }
        seen[f].add(b[f]);
      }
      if (!b.token_secret_name) continue;
      if (!codeNames.has(b.token_secret_name)) { fail(`bot "${b.botId}": ${b.token_secret_name} is not loaded by src/secrets.js (add to OPTIONAL)`); botErrors++; }
      if (!inSm.has(b.token_secret_name)) { fail(`bot "${b.botId}": ${b.token_secret_name} is not in Secret Manager per manifest (gcp_sm:true or gcp_secret_manager_only)`); botErrors++; }
    }
    if (!seen.audience.has('default')) { fail('bots.registry: no "default" audience bot'); botErrors++; }
    if (botErrors === 0) ok(`All ${bots.length} registry bots are loaded by secrets.js and backed by Secret Manager`);
  }
}

// Summary
console.log('\n' + '='.repeat(60));
if (errors === 0) {
  console.log('✅ All checks passed — ci.yml matches infra/env-manifest.json\n');
  process.exit(0);
} else {
  console.error(`\n❌ ${errors} check(s) failed. Update ci.yml or infra/env-manifest.json.\n`);
  console.error('   Checklist for adding a new secret: see infra/env-manifest.json → checklist_add_new_secret\n');
  process.exit(1);
}
