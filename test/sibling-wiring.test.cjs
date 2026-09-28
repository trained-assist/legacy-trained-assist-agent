'use strict';
// Wiring guard for domain-skill siblings (#1470).
//
// A sibling repo can be fully built, green and deployed on its own while core never
// loads it — trained-assist-documents-skill sat in that state until 2026-09-28: no
// entry in skill-siblings.js, no catalog server, no ensure_sibling call, no CI clone.
// Each test below pins one load point, so "the skill is written" can never again be
// mistaken for "the skill is reachable".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { SKILL_SIBLINGS } = require('../src/skill-siblings');
const { loadCatalog } = require('../src/skills/catalog');
const catalog = loadCatalog();

test('skill-siblings.js and catalog.servers list the same sibling servers, same repos', () => {
  const declared = new Set(SKILL_SIBLINGS.map(s => s.mcpServerId));
  const cataloged = new Set(
    Object.entries(catalog.servers || {}).filter(([, s]) => s.kind === 'sibling').map(([id]) => id),
  );
  for (const id of declared) {
    assert.ok(cataloged.has(id), `${id} is in SKILL_SIBLINGS but not in config/skill-catalog.json servers`);
  }
  for (const id of cataloged) {
    assert.ok(declared.has(id), `${id} is in config/skill-catalog.json servers but not in SKILL_SIBLINGS`);
  }
  for (const [id, s] of Object.entries(catalog.servers || {})) {
    if (s.kind !== 'sibling') continue;
    const sib = SKILL_SIBLINGS.find(x => x.mcpServerId === id);
    assert.strictEqual(s.repo, sib.repo, `${id}: catalog repo ${s.repo} != SKILL_SIBLINGS repo ${sib.repo}`);
  }
});

test('deploy.sh ensure_sibling covers every skill sibling', () => {
  const deploy = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8')
    .split('\n').filter(l => !/^\s*#/.test(l)).join('\n'); // a commented-out call is not a call
  const called = new Set([...deploy.matchAll(/ensure_sibling\s+(\S+)/g)].map(m => m[1]));
  for (const sib of SKILL_SIBLINGS) {
    assert.ok(
      called.has(sib.repo),
      `scripts/deploy.sh has no \`ensure_sibling ${sib.repo}\` — ${sib.mcpServerId} would never be checked out in prod`,
    );
  }
});

test('playbook-store resolves playbooks from every skill sibling', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'playbook-store.js'), 'utf8');
  const m = src.match(/const DEFAULT_SIBLING_REPOS = \[([^\]]*)\]/);
  assert.ok(m, 'DEFAULT_SIBLING_REPOS not found in src/playbook-store.js');
  const listed = new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  for (const sib of SKILL_SIBLINGS) {
    assert.ok(listed.has(sib.repo), `src/playbook-store.js DEFAULT_SIBLING_REPOS is missing ${sib.repo}`);
  }
});

test('a prompt domain core does not ship requires that sibling cloned in CI', () => {
  const coreDomains = new Set(
    fs.readdirSync(path.join(ROOT, 'src', 'prompt-domains'))
      .filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')),
  );
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const [id, sec] of Object.entries(catalog.sections || {})) {
    const foreign = (sec.promptDomains || []).filter(d => !coreDomains.has(d));
    if (!foreign.length) continue;
    const serverIds = new Set([
      ...(sec.siblings || []),
      ...(sec.modules || []).filter(m => m.includes('/')).map(m => m.split('/')[0]),
    ]);
    const repos = [...serverIds].map(sid => catalog.servers[sid]?.repo).filter(Boolean);
    assert.ok(repos.length, `${id}: prompt domains ${foreign} are not core's, but the section declares no sibling`);
    assert.ok(
      repos.some(r => ci.includes(r)),
      `${id}: prompt domains ${foreign} live in a sibling CI never clones — add one of ${repos.join(', ')} to .github/workflows/ci.yml`,
    );
  }
});
