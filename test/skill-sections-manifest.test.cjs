'use strict';
// Domain section manifest contract (#1753 P0): contracts/skill-sections.schema.json +
// src/skills/section-manifest.js. The core catalog, split into "core skeleton + one
// manifest per sibling", must validate against the schema and merge back into a catalog
// that resolves identically — so the contract can express today's catalog without loss
// before any domain repo starts shipping its own manifest.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Ajv = (m => m.default || m)(require('ajv'));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'skill-sections.schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const { splitCatalog, mergeManifests } = require('../src/skills/section-manifest');
const { resolve } = require('../src/skills/resolve');
const { loadDomains } = require('../src/prompt-domains');

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'skill-catalog.json'), 'utf8'));
const coreDomains = new Set(loadDomains(path.join(ROOT, 'src', 'prompt-domains')).map(d => d.name));
const { core, manifests } = splitCatalog(raw, coreDomains);

const sorted = a => [...a].sort();
function normalize(sections) {
  const out = {};
  for (const id of Object.keys(sections).sort()) {
    const s = sections[id];
    const n = {};
    for (const k of Object.keys(s).sort()) {
      const v = s[k];
      if (Array.isArray(v)) n[k] = sorted(v);
      else if (k === 'pinned') n[k] = Object.fromEntries(Object.keys(v).sort().map(x => [x, sorted(v[x])]));
      else n[k] = v;
    }
    out[id] = n;
  }
  return out;
}
const errs = () => JSON.stringify(validate.errors);

test('every sibling share of the current catalog is a schema-valid manifest', () => {
  assert.ok(Object.keys(manifests).length > 0, 'catalog has no sibling payload at all');
  for (const [server, m] of Object.entries(manifests)) {
    assert.strictEqual(raw.servers[server]?.kind, 'sibling', `${server} is not a registered sibling`);
    assert.ok(validate(m), `${server}: ${errs()}`);
  }
});

test('core skeleton after the split references no foreign server', () => {
  for (const [id, s] of Object.entries(core.sections)) {
    for (const mod of s.modules || []) assert.ok(!mod.includes('/'), `${id}: ${mod}`);
    assert.ok(!s.siblings, `${id}: siblings`);
    for (const server of Object.keys(s.pinned || {})) assert.strictEqual(server, 'trained-skills', `${id}: pinned ${server}`);
    for (const d of s.promptDomains || []) assert.ok(coreDomains.has(d), `${id}: foreign prompt domain ${d}`);
  }
  assert.deepStrictEqual(Object.keys(core.sections), Object.keys(raw.sections), 'section ids stay in core');
  assert.deepStrictEqual(core.servers, raw.servers);
  assert.deepStrictEqual(core.audienceDefaults, raw.audienceDefaults);
});

test('merge(split(catalog)) is the catalog: sections equal, no warnings', () => {
  const { catalog, warnings } = mergeManifests(core, Object.values(manifests));
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(normalize(catalog.sections), normalize(raw.sections));
});

test('merge(split(catalog)) resolves identically for legacy, recruiter and each section alone', () => {
  const { catalog } = mergeManifests(core, Object.values(manifests));
  const domains = Object.fromEntries(loadDomains().map(d => [d.name, { server: d.server, module: d.module, when: d.when }]));
  const before = { ...raw, domains };
  const after = { ...catalog, domains };
  const profiles = [null, { enabled: ['recruiting'], disabled: [] }, { enabled: [], disabled: [] }]
    .concat(Object.keys(raw.sections).map(id => ({ enabled: [id], disabled: [] })));
  const norm = r => ({ ...r, sections: sorted(r.sections), modules: sorted(r.modules), setupOnly: sorted(r.setupOnly),
    siblings: sorted(r.siblings), promptDomains: sorted(r.promptDomains),
    pinned: Object.fromEntries(Object.keys(r.pinned).sort().map(k => [k, sorted(r.pinned[k])])) });
  // Every sibling attached with unknown per-module readiness, plus one unlisted module per
  // sibling (only a `mount` section exposes it) — so sibling modules, mounts, pinned tools
  // and sibling prompt domains all take part in the comparison.
  const readiness = {};
  for (const [id, s] of Object.entries(raw.servers)) {
    if (s.kind !== 'sibling') continue;
    readiness[id] = true;
    readiness[`${id}/*`] = null;
    readiness[`${id}/zz-unlisted.js`] = true;
  }
  const full = resolve(before, null, readiness);
  assert.ok(full.modules.some(m => m.startsWith('hh-skills/')), 'fixture exposes no sibling module — comparison would be vacuous');
  assert.ok(full.siblings.length >= 4, `siblings: ${full.siblings}`);
  for (const p of profiles) {
    for (const r of [{}, readiness]) {
      assert.deepStrictEqual(norm(resolve(after, p, r)), norm(resolve(before, p, r)), JSON.stringify(p));
    }
  }
});

test('schema rejects what the domain does not own', () => {
  const ok = { version: 1, server: 'hh-skills', sections: { 'recruiting/hh': { modules: ['90-hh.js'] } } };
  assert.ok(validate(ok), errs());
  const bad = [
    ['server-prefixed module', { modules: ['hh-skills/90-hh.js'] }],
    ['always (core only)', { modules: ['90-hh.js'], always: true }],
    ['siblings (use mount)', { modules: ['90-hh.js'], siblings: ['hh-skills'] }],
    ['empty payload', { title: 'x' }],
    ['mount:false alone', { mount: false }],
    ['pinned as core map', { modules: ['90-hh.js'], pinned: { 'hh-skills': ['hh_status'] } }],
  ];
  for (const [why, section] of bad) {
    assert.ok(!validate({ ...ok, sections: { 'recruiting/hh': section } }), why);
  }
  assert.ok(!validate({ ...ok, version: 2 }), 'version');
  assert.ok(!validate({ ...ok, sections: { 'Recruiting/HH': { modules: ['90-hh.js'] } } }), 'section id format');
});

const base = {
  servers: { 'trained-skills': { kind: 'local' }, 'a-skills': { kind: 'sibling', repo: 'a' }, 'b-skills': { kind: 'sibling', repo: 'b' } },
  sections: {
    core: { always: true, modules: ['00-meta.js'] },
    mixed: { title: 'Смешанная', modules: ['95-video.js'] },
    foreign: {},
  },
};

test('merge is a union: a mixed section keeps its core module, core title wins, mount → siblings', () => {
  const { catalog, warnings } = mergeManifests(base, [
    { version: 1, server: 'a-skills', sections: {
      mixed: { title: 'Другое', modules: ['99-x.js'], pinned: ['a_tool'] },
      foreign: { title: 'Чужая', mount: true, promptDomains: ['a'] },
    } },
  ]);
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(catalog.sections.mixed, { title: 'Смешанная', modules: ['95-video.js', 'a-skills/99-x.js'], pinned: { 'a-skills': ['a_tool'] } });
  assert.deepStrictEqual(catalog.sections.foreign, { title: 'Чужая', siblings: ['a-skills'], promptDomains: ['a'] });
  assert.deepStrictEqual(base.sections.mixed, { title: 'Смешанная', modules: ['95-video.js'] }, 'input not mutated');
});

test('merge skips (warns) unknown sections and unregistered servers', () => {
  const { catalog, warnings } = mergeManifests(base, [
    { version: 1, server: 'a-skills', sections: { nope: { modules: ['1.js'] } } },
    { version: 1, server: 'ghost-skills', sections: { foreign: { modules: ['1.js'] } } },
  ]);
  assert.strictEqual(warnings.length, 2, JSON.stringify(warnings));
  assert.ok(!('nope' in catalog.sections));
  assert.deepStrictEqual(catalog.sections.foreign, {});
});

test('merge throws on a prompt-domain name with two owners', () => {
  const withCoreDomain = { ...base, sections: { ...base.sections, core: { ...base.sections.core, promptDomains: ['shared'] } } };
  assert.throws(() => mergeManifests(withCoreDomain, [
    { version: 1, server: 'a-skills', sections: { foreign: { promptDomains: ['shared'] } } },
  ]), /'shared' claimed by core \(section core\) and a-skills/);
  assert.throws(() => mergeManifests(base, [
    { version: 1, server: 'a-skills', sections: { foreign: { promptDomains: ['d'] } } },
    { version: 1, server: 'b-skills', sections: { mixed: { promptDomains: ['d'] } } },
  ]), /'d' claimed by a-skills \(section foreign\) and b-skills \(section mixed\)/);
});
