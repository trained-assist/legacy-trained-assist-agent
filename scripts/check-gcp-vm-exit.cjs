#!/usr/bin/env node
// Narrow guard for executable deployment configuration. Historical docs and
// GCS/Secret Manager usage remain allowed during the VM exit.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflows = ['ci.yml', 'deploy-manual.yml'];

for (const name of workflows) {
  const file = path.join(root, '.github/workflows', name);
  const source = fs.readFileSync(file, 'utf8');
  const job = source.match(/^  deploy-gcp:\n(?<body>(?:^(?:    |\s*$).*(?:\n|$))*)/m)?.groups?.body;
  if (!job || !/^    if: false\s*$/m.test(job)) {
    console.error(`${name}: deploy-gcp must remain disabled during VM exit`);
    process.exitCode = 1;
  }
  if (name === 'deploy-manual.yml' && /^(?:\s+- (?:gcp|both)\s*)$/m.test(source)) {
    console.error(`${name}: manual target must not include the old GCP VM`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log('Old GCP VM deployment targets are disabled');
