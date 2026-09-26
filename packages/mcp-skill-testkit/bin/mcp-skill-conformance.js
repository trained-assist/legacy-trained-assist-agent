#!/usr/bin/env node
'use strict';

// CLI for the domain-skill conformance gate. Exits 1 on any violation so a
// domain repo's CI and its PR checklist can gate on it.
const { reportDomainSkillRepo } = require('../lib/conformance');

const target = process.argv[2];
if (!target) {
  console.error('Usage: mcp-skill-conformance <path-to-domain-skill-repo>');
  process.exit(2);
}

const { ok, checks } = reportDomainSkillRepo(require('path').resolve(target));
console.log(ok ? 'PASS' : 'FAIL', `(${checks.filter((c) => !c.ok).length} failing checks)`);
process.exit(ok ? 0 : 1);
