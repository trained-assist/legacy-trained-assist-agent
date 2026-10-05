// Ratchet: one source of truth per host's identity (issue #2114 P0.2/P0.3).
//
// The defect this locks shut: systemd/assist-agent.service is shared by every VM,
// and it carried VM_NAME, AGENT_PUBLIC_URL, HH_PLATFORM_URL, CRON_SCHEDULER_ROLE
// and MAX_CONCURRENT_TASKS — values that describe ONE machine. A second box
// therefore started as `gcp-main` with GCP's public URLs (every connect-link it
// minted pointed at the host that is being shut down) and with
// CRON_SCHEDULER_ROLE=primary (every cron job, twice). Both were corrected only
// by a hand-written drop-in on the one host that knew about it — i.e. by nothing
// at all on a fresh box.
//
// These assertions fail if a host-specific value creeps back into the shared unit
// or if a host's drop-in drifts from the manifest that documents it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'infra/env-manifest.json'), 'utf8'));
const baseUnit = fs.readFileSync(path.join(ROOT, 'systemd/assist-agent.service'), 'utf8');
const hostDir = path.join(ROOT, 'infra/systemd/host');

function envOf(unitFile) {
  const out = {};
  for (const line of unitFile.split('\n')) {
    const m = /^Environment=([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Everything systemd applies, base unit plus drop-ins, in systemd's own order
// (drop-ins win — that is why a hand-written 20-host-identity.conf did work).
function effectiveUnit(vmName) {
  const merged = envOf(baseUnit);
  const dirs = [
    path.join(ROOT, 'infra/systemd/assist-agent.service.d'),
    hostDir,
  ];
  const files = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.endsWith('.conf')) continue;
      if (d === hostDir && path.basename(f, '.conf') !== vmName) continue;
      files.push(path.join(d, f));
    }
  }
  for (const f of files) Object.assign(merged, envOf(fs.readFileSync(f, 'utf8')));
  return merged;
}

const HOST_SPECIFIC = [
  'VM_NAME',
  'AGENT_PUBLIC_URL',
  'HH_PLATFORM_URL',
  'CRON_SCHEDULER_ROLE',
  'MAX_CONCURRENT_TASKS',
];

test('the shared unit carries no per-host identity', () => {
  const base = envOf(baseUnit);
  for (const key of HOST_SPECIFIC) {
    assert.ok(!(key in base), `${key} is per-host and belongs in infra/systemd/host/<vm-name>.conf, not systemd/assist-agent.service`);
  }
});

test('the shared unit keeps the fleet-wide values', () => {
  const base = envOf(baseUnit);
  for (const key of ['PORT', 'NODE_ENV', 'AGENT_PAGES_URL', 'AGENT_DATA_DIR', 'USERS_DIR', 'AGENT_TOKENS_DIR']) {
    assert.ok(key in base, `${key} is the same on every host and belongs in systemd/assist-agent.service`);
  }
});

test('every agent host in the manifest has a drop-in, and vice versa', () => {
  const hosts = Object.entries(manifest.vms)
    .filter(([, v]) => v.service === 'assist-agent')
    .map(([key, v]) => ({ key, name: v.vm_name }));
  assert.ok(hosts.length >= 2, 'expected at least gcp-main and contabo-vm2');

  const onDisk = fs.existsSync(hostDir)
    ? fs.readdirSync(hostDir).filter(f => f.endsWith('.conf')).map(f => path.basename(f, '.conf')).sort()
    : [];
  for (const h of hosts) {
    assert.ok(onDisk.includes(h.name), `infra/env-manifest.json → vms.${h.key}.vm_name=${h.name} has no infra/systemd/host/${h.name}.conf`);
  }
  for (const name of onDisk) {
    assert.ok(hosts.some(h => h.name === name), `infra/systemd/host/${name}.conf describes a host the manifest does not list`);
  }
});

test('each host drop-in declares its own VM_NAME and nothing else claims it', () => {
  for (const f of fs.readdirSync(hostDir).filter(f => f.endsWith('.conf'))) {
    const name = path.basename(f, '.conf');
    const env = envOf(fs.readFileSync(path.join(hostDir, f), 'utf8'));
    assert.equal(env.VM_NAME, name, `${f} must set VM_NAME=${name}`);
  }
});

test('VM2 uses the service-readable WIF external-account config for GCS, without a key-file credential', () => {
  const vm2 = effectiveUnit('contabo-vm2');
  assert.equal(vm2.GOOGLE_APPLICATION_CREDENTIALS, '/opt/wif/credentials.json');
  assert.equal(effectiveUnit('gcp-main').GOOGLE_APPLICATION_CREDENTIALS, undefined,
    'VM2 WIF config must not leak into the shared unit or GCP host');
  const provision = fs.readFileSync(path.join(ROOT, 'scripts/ops/configure-vm2-wif-archive.sh'), 'utf8');
  assert.match(provision, /"type": "json"/);
  assert.match(provision, /"subject_token_field_name": "access_token"/);
  assert.match(provision, /service_account_impersonation_url/);
  assert.match(provision, /chmod 0640/);
  assert.doesNotMatch(provision, /private\.pem/,
    'the generated ADC config must not include or copy the issuer private key');
});

// The defect that made every per-host value a no-op while this file's other
// assertions stayed green: `envOf` greps Environment= lines without caring about
// sections, so a drop-in missing its [Service] header parses perfectly here — while
// systemd applies it OUTSIDE any section and logs "Assignment outside of section.
// Ignoring." for every line. Both files in this directory shipped that way, so
// installing the fix on VM2 changed nothing and the box kept VM_NAME=gcp-main with
// GCP's public origins. A drop-in is only a drop-in if it has a section.
test('every host drop-in has a [Service] header, so systemd applies it at all', () => {
  for (const f of fs.readdirSync(hostDir).filter(f => f.endsWith('.conf'))) {
    const body = fs.readFileSync(path.join(hostDir, f), 'utf8');
    assert.match(
      body,
      /^\s*\[Service\]\s*$/m,
      `infra/systemd/host/${f} has no [Service] header — systemd ignores an unsectioned drop-in entirely, so the file would install and do nothing`,
    );
    // Order matters: the header must precede the first Environment= line.
    const header = body.search(/^\s*\[Service\]\s*$/m);
    const firstEnv = body.search(/^\s*Environment=/m);
    assert.ok(
      firstEnv === -1 || header < firstEnv,
      `infra/systemd/host/${f}: Environment= appears before [Service] — those lines are outside any section`,
    );
  }
});

test('effective config per host: identity, origins, cron role', () => {
  for (const [key, v] of Object.entries(manifest.vms)) {
    if (v.service !== 'assist-agent') continue;
    const env = effectiveUnit(v.vm_name);
    assert.equal(env.VM_NAME, v.vm_name, `${key}: VM_NAME`);
    assert.equal(env.AGENT_PUBLIC_URL, `https://${v.sslip}/agent`, `${key}: AGENT_PUBLIC_URL must be this box's own origin — a link minted here must not lead to the host being shut down (#2114 trap 1)`);
    assert.equal(env.HH_PLATFORM_URL, `https://${v.sslip}/agent`, `${key}: HH_PLATFORM_URL`);
    assert.ok(env.CRON_SCHEDULER_ROLE, `${key}: CRON_SCHEDULER_ROLE must be set explicitly — unset means "primary", i.e. every cron job runs twice`);
    assert.ok(Number(env.MAX_CONCURRENT_TASKS) > 0, `${key}: MAX_CONCURRENT_TASKS`);
    if (manifest.systemd_env_vars?.[v.vm_name]) {
      for (const entry of manifest.systemd_env_vars[v.vm_name]) {
        assert.equal(env[entry.name], entry.value, `${key}: ${entry.name} differs from infra/env-manifest.json → systemd_env_vars.${v.vm_name}`);
      }
    }
  }
});

test('exactly one host in the fleet ticks crons', () => {
  const primaries = Object.entries(manifest.vms)
    .filter(([, v]) => v.service === 'assist-agent')
    .filter(([key]) => effectiveUnit(manifest.vms[key].vm_name).CRON_SCHEDULER_ROLE === 'primary')
    .map(([key]) => key);
  assert.deepEqual(primaries, ['gcp'], 'the primary cron host is a fleet decision that moves only in P2 (#2114 trap 6)');
});
