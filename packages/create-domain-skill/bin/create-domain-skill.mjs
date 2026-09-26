#!/usr/bin/env node
// create-domain-skill <domain> [--name "Human Name"] [--repo org/repo] [--dir path]
//
// Scaffolds a domain-skill repo that already follows
// docs/domain-skill-repo-test-rules.md (3-layer CI + testkit + suites.json).
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(import.meta.url));
const { createDomainSkill } = require('../lib/scaffold.js');

const argv = process.argv.slice(2);
const opts = { overwrite: argv.includes('--overwrite') };
let domain;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') opts.domainName = argv[++i];
  else if (a === '--repo') opts.repository = argv[++i];
  else if (a === '--dir') opts.targetDir = argv[++i];
  else if (a === '--overwrite') { /* consumed */ }
  else if (!a.startsWith('--')) domain = a;
}

if (!domain) {
  console.error('Usage: create-domain-skill <domain> [--name "Human Name"] [--repo org/repo] [--dir path] [--overwrite]');
  process.exit(2);
}

try {
  const result = createDomainSkill({ ...opts, targetDir: opts.targetDir ? resolve(opts.targetDir) : undefined, domain });
  console.log(`Scaffolded ${result.repository} into ${result.targetDir}`);
  console.log(`  ${result.files.length} files, artifactDigest=${result.artifactDigest.slice(0, 12)}…`);
  console.log('Next: npm install && npm test && npm run test:staging');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
