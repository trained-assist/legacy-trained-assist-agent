#!/usr/bin/env node
// «Доехал ли плейбук» (issue #1756): thin CLI over src/playbook-reachability.js.
// No network, no LLM — core CI and a domain repo's CI (core checked out next to the
// sibling) gate on it; an author runs it on the host before merging a playbook.
//
//   node scripts/check-playbook-reachability.mjs <id>... [--all] [--profile <name>] [--audience <a>] [--json]
//
// --all checks every playbook visible to the store. Exit 0 = every id reachable,
// 1 = at least one FAIL row, 2 = bad usage.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkPlaybookReachability, formatReport } = require('../src/playbook-reachability.js');
const { PlaybookStore } = require('../src/playbook-store.js');

const argv = process.argv.slice(2);
const opts = {};
const ids = [];
let all = false;
let json = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--profile') opts.profileId = argv[++i];
  else if (a === '--audience') opts.audience = argv[++i];
  else if (a === '--all') all = true;
  else if (a === '--json') json = true;
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
  else ids.push(a);
}

if (all) {
  const { playbooks = [] } = new PlaybookStore({ profileId: opts.profileId }).list() || {};
  for (const p of playbooks) if (!ids.includes(p.id)) ids.push(p.id);
}
if (!ids.length) {
  console.error('Usage: node scripts/check-playbook-reachability.mjs <id>... [--all] [--profile <name>] [--audience <a>] [--json]');
  process.exit(2);
}

const reports = ids.map(id => checkPlaybookReachability(id, opts));
if (json) console.log(JSON.stringify(reports, null, 2));
else console.log(reports.map(formatReport).join('\n\n'));
process.exit(reports.every(r => r.ok) ? 0 : 1);
