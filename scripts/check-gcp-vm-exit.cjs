#!/usr/bin/env node
// Narrow guard for executable deployment configuration. Historical docs and
// GCS/Secret Manager usage remain allowed during the VM exit.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github/workflows');
const historicalJobs = new Set(['ci.yml', 'deploy-manual.yml']);
const oldTarget = /(?:alesa-vm|gcp-main|136[.-]65[.-]7[.-]197|secrets\.VM_HOST\b|DEPLOY_ENV=gcp)/;

for (const name of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/.test(file))) {
  const file = path.join(workflowDir, name);
  const source = fs.readFileSync(file, 'utf8');
  const historical = source.match(/^  deploy-gcp:\n(?<body>(?:^(?:    |\s*$).*(?:\n|$))*)/m);
  if (historicalJobs.has(name) && (!historical || !/^    if: false\s*$/m.test(historical.groups.body))) {
    console.error(`${name}: historical deploy-gcp job must remain disabled during VM exit`);
    process.exitCode = 1;
  }
  // The known IDs and commands may appear only inside the two disabled jobs.
  // A new active workflow or a second job in either file fails this guard.
  const executable = historical && historicalJobs.has(name)
    ? source.slice(0, historical.index) + source.slice(historical.index + historical[0].length)
    : source;
  if (oldTarget.test(executable)) {
    console.error(`${name}: old GCP VM target found outside disabled historical job`);
    process.exitCode = 1;
  }
  if (name === 'deploy-manual.yml' && /^(?:\s+- (?:gcp|both)\s*)$/m.test(source)) {
    console.error(`${name}: manual target must not include the old GCP VM`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log('Old GCP VM deployment targets are disabled');
