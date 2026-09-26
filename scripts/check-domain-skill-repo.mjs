#!/usr/bin/env node
// Domain-skill repo conformance gate (issue #1440). Thin CLI over the
// @trained-assist/mcp-skill-testkit checker so core CI / a domain repo's PR
// checklist can gate on the same rules as docs/domain-skill-repo-test-rules.md.
//
//   node scripts/check-domain-skill-repo.mjs <path-to-domain-repo> [--schema <path>]
//
// Exit 0 = conforms, 1 = violations, 2 = bad usage.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { reportDomainSkillRepo } = require('../packages/mcp-skill-testkit/lib/conformance.js');

const argv = process.argv.slice(2);
const opts = {};
let target;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--schema') { opts.schemaPath = argv[++i]; }
  else target = argv[i];
}

if (!target) {
  console.error('Usage: node scripts/check-domain-skill-repo.mjs <path-to-domain-repo> [--schema <path>]');
  process.exit(2);
}

const { ok, checks } = reportDomainSkillRepo(resolve(target), opts);
console.log(ok ? 'PASS' : 'FAIL', `(${checks.filter((c) => !c.ok).length} failing checks)`);
process.exit(ok ? 0 : 1);
