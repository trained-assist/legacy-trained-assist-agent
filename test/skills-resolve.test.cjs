'use strict';
// Skill sections × attributes: catalog + resolver + shadow (issue #1537 PR-A).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve } = require('../src/skills/resolve');
const { loadCatalog, readProfileSkills } = require('../src/skills/catalog');
const { runShadow, buildReadiness } = require('../src/skills/shadow');
const pd = require('../src/prompt-domains');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'src', 'mcp-skills', 'tools');
const catalog = loadCatalog();
const localModules = fs.readdirSync(TOOLS).filter(f => f.endsWith('.js')).sort();

// Readiness of a typical "no credentials" user with every sibling on the host.
function readiness(over = {}) {
  const r = { 'hh-skills': true, 'freelance-skills': true, 'engineering-skills': true, 'sales-skills': true };
  for (const m of localModules) r[`trained-skills/${m}`] = true;
  for (const m of ['80-getcourse.js', '81-gc-discovery.js', '10-nalog.js', '20-tilda.js',
    '85-expo.js', '86-expo-flexi.js', '87-expo-pipeline.js', '88-expo-catalog.js', '89-expo-pipeline-run.js',
    '92-flexi-sales.js', '95-illustrate.js', '96-label.js', '50-gdrive.js']) r[`trained-skills/${m}`] = false;
  Object.assign(r, { 'hh-skills/90-hh.js': true, 'hh-skills/92-hh-proactive.js': true,
    'freelance-skills/10-freelance-project.js': true, 'sales-skills/30-weeek.js': false,
    'engineering-skills/10-prepare-task.js': true, 'engineering-skills/20-workspace.js': true });
  return Object.assign(r, over);
}

test('catalog covers every local MCP module, and only real ones', () => {
  const listed = new Set(Object.values(catalog.sections).flatMap(s => s.modules || []));
  const missing = localModules.filter(m => !listed.has(m));
  assert.deepStrictEqual(missing, [], `modules not in config/skill-catalog.json: ${missing.join(', ')}`);
  const ghost = [...listed].filter(m => !localModules.includes(m));
  assert.deepStrictEqual(ghost, [], `catalog lists modules that don't exist: ${ghost.join(', ')}`);
});

test('catalog is well-formed: parents exist, siblings declared, every prompt domain owned once', () => {
  const owners = {};
  for (const [id, s] of Object.entries(catalog.sections)) {
    const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : null;
    if (parent) assert.ok(catalog.sections[parent], `${id}: parent ${parent} missing`);
    for (const sib of s.siblings || []) assert.strictEqual(catalog.servers[sib]?.kind, 'sibling', `${id}: ${sib}`);
    for (const srv of Object.keys(s.pinned || {})) assert.ok(catalog.servers[srv], `${id}: pinned server ${srv}`);
    for (const d of s.promptDomains || []) {
      assert.ok(catalog.domains[d], `${id}: no src/prompt-domains/${d}.md`);
      assert.ok(!owners[d], `${d} owned by ${owners[d]} and ${id}`);
      owners[d] = id;
    }
  }
  const orphan = Object.keys(catalog.domains).filter(d => !owners[d]);
  assert.deepStrictEqual(orphan, [], `prompt domains in no section: ${orphan.join(', ')}`);
  for (const [d, meta] of Object.entries(catalog.domains)) {
    const sec = catalog.sections[owners[d]];
    const own = meta.server === 'trained-skills' ? (sec.modules || []).includes(meta.module) : (sec.siblings || []).includes(meta.server);
    assert.ok(own, `${d}: gated by ${meta.server}/${meta.module}, which section ${owners[d]} doesn't own`);
  }
});

test('legacy mode (no skills.json) = exactly what the current code exposes', () => {
  const r = readiness();
  const res = resolve(catalog, null, r);
  assert.strictEqual(res.mode, 'legacy');
  assert.deepStrictEqual(res.sections, Object.keys(catalog.sections));
  assert.deepStrictEqual(res.siblings, ['engineering-skills', 'freelance-skills', 'hh-skills', 'sales-skills']);
  // prompt domains: same answer as src/prompt-domains selectDomains on the same probe
  const probe = {};
  for (const [k, v] of Object.entries(r)) {
    if (!k.includes('/')) continue;
    const [srv, mod] = k.split('/');
    (probe[srv] || (probe[srv] = {}))[mod] = v;
  }
  const current = pd.selectDomains(pd.loadDomains(), probe).map(d => d.name).sort();
  assert.deepStrictEqual(res.promptDomains, current);
  // unprobeable server → fail open exactly like selectDomains
  const r2 = readiness(); for (const k of Object.keys(r2)) if (k.startsWith('hh-skills/')) delete r2[k];
  r2['hh-skills/*'] = null;
  const res2 = resolve(catalog, null, r2);
  assert.deepStrictEqual(res2.promptDomains, pd.selectDomains(pd.loadDomains(), { ...probe, 'hh-skills': null }).map(d => d.name).sort());
  // sibling missing on host → not mounted, its domains dropped
  const res3 = resolve(catalog, null, readiness({ 'engineering-skills': false }));
  assert.ok(!res3.siblings.includes('engineering-skills'));
  assert.ok(!res3.promptDomains.includes('engineering'));
  assert.deepStrictEqual(res3.pinned, {});
});

test('enabled parent enables its children; other sections stay off; core always on', () => {
  const res = resolve(catalog, { enabled: ['recruiting'] }, readiness());
  assert.deepStrictEqual(res.sections, ['core', 'recruiting', 'recruiting/hh', 'recruiting/interview', 'recruiting/company']);
  assert.deepStrictEqual(res.siblings, ['hh-skills']);
  assert.ok(res.modules.includes('hh-skills/90-hh.js'));
  assert.ok(res.modules.includes('trained-skills/22-connect.js'));
  assert.ok(res.modules.includes('trained-skills/00-meta.js'));
  assert.ok(!res.modules.includes('trained-skills/60-github.js'));
  assert.ok(!res.promptDomains.includes('engineering'));
  assert.ok(!res.promptDomains.includes('github.setup'));
  assert.deepStrictEqual(res.pinned, {});
});

test('explicitly disabled child is off, siblings of it stay on', () => {
  const res = resolve(catalog, { enabled: ['recruiting'], disabled: ['recruiting/company'] }, readiness());
  assert.ok(!res.sections.includes('recruiting/company'));
  assert.ok(res.sections.includes('recruiting/hh'));
  assert.ok(!res.modules.includes('trained-skills/40-company.js'));
  // shared module stays when another enabled section owns it
  const both = resolve(catalog, { enabled: ['recruiting', 'flexi-expo'], disabled: ['recruiting/company'] }, readiness());
  assert.ok(both.modules.includes('trained-skills/40-company.js'));
});

test('disabled parent wins over an enabled child', () => {
  const res = resolve(catalog, { enabled: ['recruiting/hh'], disabled: ['recruiting'] }, readiness());
  assert.deepStrictEqual(res.sections, ['core']);
  assert.deepStrictEqual(res.siblings, []);
  assert.ok(!res.promptDomains.some(d => d.startsWith('hh')));
  // enabling only a child works when the parent isn't disabled
  const child = resolve(catalog, { enabled: ['recruiting/hh'] }, readiness());
  assert.deepStrictEqual(child.sections, ['core', 'recruiting/hh']);
});

test('setupOnly when the credential is missing: setup text, not the workflow', () => {
  const res = resolve(catalog, { enabled: ['recruiting', 'crm-weeek'] }, readiness({ 'hh-skills/90-hh.js': false }));
  assert.ok(res.setupOnly.includes('hh-skills/90-hh.js'));
  assert.ok(!res.modules.includes('hh-skills/90-hh.js'));
  assert.ok(res.setupOnly.includes('sales-skills/30-weeek.js'));
  assert.ok(res.promptDomains.includes('hh.setup') && !res.promptDomains.includes('hh'));
  assert.ok(res.promptDomains.includes('weeek.setup') && !res.promptDomains.includes('weeek'));
  assert.ok(res.promptDomains.includes('hh-notify'));
});

test('software-engineering pins spawn/release workspace and carries engineering.md', () => {
  const res = resolve(catalog, { enabled: ['software-engineering'] }, readiness());
  assert.deepStrictEqual(res.pinned, { 'engineering-skills': ['engineering_spawn_workspace', 'engineering_release_workspace'] });
  assert.ok(res.siblings.includes('engineering-skills'));
  assert.ok(res.promptDomains.includes('engineering'));
  const eng = pd.loadDomains().find(d => d.name === 'engineering');
  assert.match(eng.body, /engineering_spawn_workspace/);
  assert.match(eng.body, /engineering_release_workspace/);
  assert.match(eng.body, /git worktree add/);
});

test('unknown section ids are reported, not fatal', () => {
  const res = resolve(catalog, { enabled: ['recruiting', 'nope'], disabled: ['also/nope'] }, readiness());
  assert.deepStrictEqual(res.unknown, ['nope', 'also/nope']);
});

test('shadow: legacy profile → diff=0, writes .skills-resolved.json, audience preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-shadow-'));
  const r = readiness();
  const probe = {};
  for (const [k, v] of Object.entries(r)) if (k.includes('/')) { const [s, m] = k.split('/'); (probe[s] || (probe[s] = {}))[m] = v; }
  const picked = pd.selectDomains(pd.loadDomains(), probe).map(d => d.name);
  const mcp = path.join(dir, '.mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { playwright: {}, 'trained-skills': {}, 'hh-skills': {}, 'freelance-skills': {}, 'engineering-skills': {}, 'sales-skills': {} } }));
  const lines = [];
  const rd = buildReadiness(catalog, { probe, siblingExists: () => true });
  assert.strictEqual(rd['engineering-skills'], true);
  assert.strictEqual(rd['hh-skills/90-hh.js'], true);
  const rec = runShadow({ workDir: dir, username: 'u1', audience: 'recruiter', mcpConfigPath: mcp,
    domainReport: { probe, picked }, siblingExists: () => true,
    catalog, log: l => lines.push(l) });
  assert.ok(rec, lines.join('\n'));
  assert.deepStrictEqual(rec.diff, []);
  assert.match(lines[0], /^\[skills-shadow\] user=u1 mode=legacy diff=0 /);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.skills-resolved.json'), 'utf8'));
  assert.strictEqual(saved.resolved.mode, 'legacy');
  assert.deepStrictEqual(saved.preview.hides.siblings, ['engineering-skills', 'freelance-skills', 'sales-skills']);
  assert.ok(saved.preview.hides.promptDomains.includes('engineering'));
  assert.ok(!saved.preview.hides.promptDomains.some(d => d.startsWith('hh')));
});

test('shadow reports a real difference and never throws on garbage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-shadow-'));
  const mcp = path.join(dir, '.mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { 'trained-skills': {}, 'engineering-skills': {} } }));
  fs.writeFileSync(path.join(dir, 'skills.json'), JSON.stringify({ enabled: ['recruiting'] }));
  assert.deepStrictEqual(readProfileSkills(dir), { enabled: ['recruiting'], disabled: [] });
  const lines = [];
  const rec = runShadow({ workDir: dir, username: 'u2', mcpConfigPath: mcp, domainReport: {},
    siblingExists: p => /trained-assist-(hh-skill|engineering)\b/.test(p), catalog, log: l => lines.push(l) });
  assert.deepStrictEqual(rec.diff, ['+sib:hh-skills', '-sib:engineering-skills']);
  assert.match(lines[0], /mode=profile diff=\+sib:hh-skills,-sib:engineering-skills/);
  // corrupt skills.json / missing config / bad args → one error line, null, no throw
  fs.writeFileSync(path.join(dir, 'skills.json'), '{not json');
  const out = [];
  assert.strictEqual(runShadow({ workDir: dir, username: 'u3', mcpConfigPath: path.join(dir, 'nope.json'), catalog, log: l => out.push(l) }), null);
  assert.match(out[0], /^\[skills-shadow\] user=u3 error=/);
  assert.strictEqual(runShadow(), null);
  assert.strictEqual(runShadow({ log: () => { throw new Error('log broken'); } }), null);
});
