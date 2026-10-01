'use strict';
// Turn-intent tool mounting (architecture issue #76 L1): the «интент → секции» map,
// its CI gates, the profile ∩ intent resolution, the per-run config files, the
// tool_escalation detector and the prompt-prefix metric inputs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TURN_INTENTS, estimateTurnIntent, buildMountNote, detectEscalation, ESCALATION_MARKER } = require('../src/skills/turn-intent');
const { resolve, sectionRelevant, normalizeIntent } = require('../src/skills/resolve');
const { loadCatalog } = require('../src/skills/catalog');
const { planFor, computePlan, EFFECTIVE_FILE } = require('../src/skills/enforce');
const { writeMcpConfig } = require('../src/browser');
const { estimateToolTokens } = require('../src/mcp-tool-tokens');

const catalog = loadCatalog();
const ROOT = path.join(__dirname, '..');

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `turn-intent-${tag}-`)); }

// Everything attached and ready — the same shape test/skills-resolve.test.cjs uses.
function readiness() {
  const r = {};
  for (const [id, s] of Object.entries(catalog.servers || {})) if (s.kind === 'sibling') r[id] = true;
  const toolsDir = path.join(ROOT, 'src', 'mcp-skills', 'tools');
  for (const m of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'))) r[`trained-skills/${m}`] = true;
  for (const [id, s] of Object.entries(catalog.sections || {})) {
    for (const mod of s.modules || []) if (mod.includes('/')) r[mod] = true;
  }
  return r;
}

// ── CI gates: the map must stay usable as the catalog evolves ─────────────────

test('CI gate: every catalog section except core is covered by at least one intent', () => {
  const uncovered = [];
  for (const id of Object.keys(catalog.sections)) {
    if (id === 'core') continue; // `always` — mounted without any intent
    // Covered when an intent names the section itself or one of its ancestors:
    // naming an ancestor mounts the whole subtree, including this section.
    const covered = TURN_INTENTS.some(e => e.sections.some(s => s === id || id.startsWith(`${s}/`)));
    if (!covered) uncovered.push(id);
  }
  assert.deepStrictEqual(uncovered, [],
    `sections no intent can ever mount (add an intent or a rule naming them): ${uncovered.join(', ')}`);
});

test('CI gate: every intent names sections that exist in the catalog', () => {
  for (const e of TURN_INTENTS) {
    assert.ok(e.sections.length, `${e.id}: no sections`);
    for (const s of e.sections) assert.ok(catalog.sections[s], `${e.id}: unknown section ${s}`);
  }
});

test('CI gate: every intent sample matches its own regex (no dead rules)', () => {
  for (const e of TURN_INTENTS) {
    assert.ok(e.sample, `${e.id}: no sample`);
    assert.ok(e.test.test(e.sample), `${e.id}: sample «${e.sample}» does not match /${e.test.source}/`);
    assert.ok(estimateTurnIntent(e.sample), `${e.id}: estimateTurnIntent misses its own sample`);
  }
});

test('intent ids are unique', () => {
  const ids = TURN_INTENTS.map(e => e.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate intent id');
});

// ── The estimator ─────────────────────────────────────────────────────────────

test('estimateTurnIntent: real turns map to their sections, unknown → null', () => {
  assert.deepStrictEqual(estimateTurnIntent('покажи мои вакансии').sections, ['recruiting/hh']);
  assert.deepStrictEqual(estimateTurnIntent('кто откликнулся на вакансию').intents, ['hh']);
  assert.deepStrictEqual(estimateTurnIntent('нужен специалист по подбору персонала').sections, ['recruiting']);
  assert.deepStrictEqual(estimateTurnIntent('покажи сделки по фамилии').sections, ['crm-weeek']);
  assert.deepStrictEqual(
    estimateTurnIntent('нужно от начала до конца проработать эту выставку: собрать компании, найти целевых, сделать каталог').sections,
    ['recruiting/company', 'flexi-expo'], 'the expo turn matches both the company and the expo intents');
  // Nothing recognised → full mount, never a guess.
  assert.strictEqual(estimateTurnIntent('посмотри всю информацию по этому номеру'), null);
  assert.strictEqual(estimateTurnIntent('сделай стрелочку заметнее'), null);
  assert.strictEqual(estimateTurnIntent(''), null);
  assert.strictEqual(estimateTurnIntent(null), null);
  // Machine prompts (continuations) that don't mention a domain → null too.
  assert.strictEqual(estimateTurnIntent('[ПРОДОЛЖЕНИЕ] продолжай'), null);
});

test('estimateTurnIntent: a turn matching several intents unions their sections, no dupes', () => {
  const r = estimateTurnIntent('собери презентацию по кандидату из гугл-дока');
  assert.ok(r.sections.includes('documents') && r.sections.includes('recruiting/hh') && r.sections.includes('gdrive'));
  assert.strictEqual(new Set(r.sections).size, r.sections.length, 'sections are deduped');
});

test('a «собери ТЗ» turn keeps software-engineering mounted (regression #1963)', () => {
  // The exact turn that lost engineering_generate_spec in production: the freelance
  // intent matched («фриланс»/«техническое задание») and narrowed the mount to the
  // freelance section alone, so 65-spec-generation.js was hidden and the bot
  // silently produced a client-template ТЗ with no sandbox block.
  const turn = estimateTurnIntent('Создай фриланс-проект "Тест С8 ТЗ генерация" с описанием: нужен личный сайт-визитка. Затем собери по нему ТЗ.');
  assert.ok(turn.intents.includes('freelance') && turn.intents.includes('spec'));
  assert.ok(turn.sections.includes('freelance'));
  assert.ok(turn.sections.includes('software-engineering'), 'ТЗ tools live in software-engineering');
  // …and the resolve layer actually exposes the spec module for that mount.
  const r = resolve(catalog, null, readiness(), { intent: turn.sections });
  assert.ok(r.siblings.includes('engineering-skills'), 'engineering-skills server mounted');
  assert.ok(r.modules.includes('engineering-skills/65-spec-generation.js'));
  // A bare «собери ТЗ» (no фриланс word) still gets both sections via the spec intent.
  const bare = estimateTurnIntent('собери ТЗ по проекту visitka');
  assert.deepStrictEqual(bare.sections, ['freelance', 'software-engineering']);
});

test('estimateTurnIntent never matches an intent whose sample-only words are too broad', () => {
  // «тест кандидата» must NOT drag in software-engineering (bare тест/код excluded);
  // «чек-лист» must NOT drag in nalog (negative lookahead on чек).
  assert.strictEqual(estimateTurnIntent('напиши чек-лист по итогам недели'), null);
  const hh = estimateTurnIntent('пройди тест кандидата');
  assert.deepStrictEqual(hh ? hh.sections : null, ['recruiting/hh']);
});

// ── resolve(): profile ∩ intent, fail-open, invariants ────────────────────────

test('resolve + intent on a legacy profile mounts only core+intent subtree', () => {
  const r = resolve(catalog, null, readiness(), { intent: ['recruiting/hh'] });
  assert.deepStrictEqual(r.sections, ['core', 'recruiting', 'recruiting/hh'],
    'parent of the intent keeps its own modules; siblings under other branches stay out');
  assert.deepStrictEqual(r.siblings, ['hh-skills', 'search-skills']);
  assert.ok(r.modules.includes('hh-skills/90-hh.js'));
  assert.ok(!r.modules.includes('sales-skills/40-company.js'), 'recruiting/company not relevant');
  assert.ok(!r.modules.includes('trained-skills/95-illustrate.js'), 'illustrate not relevant');
  assert.deepStrictEqual(r.intent, { sections: ['recruiting/hh'], applied: true });
  // always-on core is untouched by the filter
  assert.ok(r.sections.includes('core'));
});

test('resolve + intent: profile ∩ intent — sections the profile does not enable stay out', () => {
  const r = resolve(catalog, { enabled: ['recruiting', 'gdrive'] }, readiness(), { intent: ['gdrive'] });
  assert.deepStrictEqual(r.sections, ['core', 'gdrive']);
  assert.ok(!r.sections.includes('recruiting'));
  assert.ok(r.siblings.includes('documents-skills'));
  assert.ok(!r.siblings.includes('hh-skills'));
});

test('resolve + intent: disjoint intent fails open to the full profile set (applied=false)', () => {
  const profile = { enabled: ['recruiting'] };
  const full = resolve(catalog, profile, readiness());
  const r = resolve(catalog, profile, readiness(), { intent: ['gdrive'] });
  assert.deepStrictEqual(r.sections, full.sections, 'the full PROFILE set mounted, not core-only');
  assert.deepStrictEqual(r.intent, { sections: ['gdrive'], applied: false });
  // A legacy profile (no skills.json) enables everything, so the same intent is NOT
  // disjoint there — it narrows to the intent, which is the whole point of L1.
  const legacy = resolve(catalog, null, readiness(), { intent: ['gdrive'] });
  assert.deepStrictEqual(legacy.sections, ['core', 'gdrive']);
  assert.deepStrictEqual(legacy.intent, { sections: ['gdrive'], applied: true });
});

test('resolve + intent: a profile-disabled section is never re-enabled by an intent', () => {
  const r = resolve(catalog, { enabled: ['recruiting'], disabled: ['recruiting/hh'] }, readiness(), { intent: ['recruiting/hh'] });
  assert.ok(!r.sections.includes('recruiting/hh'), 'disabled child stays off');
  assert.ok(r.sections.includes('recruiting'), 'the enabled parent is still intent-relevant');
  assert.ok(!r.modules.includes('hh-skills/90-hh.js'));
  assert.deepStrictEqual(r.intent, { sections: ['recruiting/hh'], applied: true });
});

test('resolve + intent: unknown intent ids are dropped, all-unknown → no intent at all', () => {
  const mixed = resolve(catalog, null, readiness(), { intent: ['recruiting/hh', 'nope'] });
  assert.deepStrictEqual(mixed.intent, { sections: ['recruiting/hh'], applied: true });
  const allBad = resolve(catalog, null, readiness(), { intent: ['nope', 'also/bad'] });
  assert.strictEqual(allBad.intent, null, 'all unknown → fail open, never mount nothing');
  assert.strictEqual(allBad.sections.length, Object.keys(catalog.sections).length);
  // Non-array / empty requests are ignored.
  assert.strictEqual(normalizeIntent([], catalog.sections), null);
  assert.strictEqual(normalizeIntent('hh', catalog.sections), null);
  assert.strictEqual(normalizeIntent(null, catalog.sections), null);
});

test('resolve + intent: software-engineering keeps its pinned tools', () => {
  const r = resolve(catalog, null, readiness(), { intent: ['software-engineering'] });
  assert.deepStrictEqual(r.pinned, { 'engineering-skills': ['engineering_spawn_workspace', 'engineering_release_workspace'] });
  if (catalog.domains['engineering']) assert.ok(r.promptDomains.includes('engineering'));
  assert.ok(!r.promptDomains.includes('hh'), 'other prompt domains dropped with their sections');
});

test('sectionRelevant: self / ancestor / descendant relevant, other branches not', () => {
  assert.ok(sectionRelevant('recruiting/hh', ['recruiting/hh']));
  assert.ok(sectionRelevant('recruiting', ['recruiting/hh']), 'ancestor of the intent');
  assert.ok(sectionRelevant('recruiting/hh', ['recruiting']), 'descendant of the intent');
  assert.ok(!sectionRelevant('recruiting/interview', ['recruiting/hh']), 'other child of the same parent');
  assert.ok(!sectionRelevant('gdrive', ['recruiting']));
});

// ── planFor(): legacy profiles get a plan only when a turn intent asks for one ─

test('planFor: no skills.json and no intent → null (unchanged legacy)', () => {
  const wd = tmpDir('legacy');
  assert.strictEqual(planFor(wd), null);
  const cfg = writeMcpConfig(wd, null, { siblingPaths: {} });
  assert.strictEqual(cfg, path.join(wd, '.mcp.json'), 'profile-level .mcp.json as before');
  assert.ok(!fs.existsSync(path.join(wd, EFFECTIVE_FILE)));
});

test('planFor + intent on a legacy profile → narrowed plan, per-run effective file', () => {
  const wd = tmpDir('narrow');
  const plan = planFor(wd, { intent: ['recruiting/hh'] });
  assert.ok(plan, 'a turn intent makes a plan even without skills.json');
  assert.deepStrictEqual(plan.sections, ['core', 'recruiting', 'recruiting/hh']);
  assert.ok(plan.hidden.siblings.includes('engineering-skills'));
  assert.ok(!plan.hidden.siblings.includes('hh-skills'));
  assert.ok(plan.hidden.modules.includes('95-illustrate.js'), 'hidden entries keep the catalog\'s own module ids');
  assert.strictEqual(plan.intent.applied, true);
  assert.strictEqual(plan.mode, 'legacy');
});

test('planFor: a broken skills.json still means profile=everything (never cut more than the intent)', () => {
  const wd = tmpDir('broken');
  fs.writeFileSync(path.join(wd, 'skills.json'), '{not json');
  const warns = [];
  assert.strictEqual(planFor(wd, { warn: m => warns.push(m) }), null, 'no intent → legacy as before');
  assert.ok(warns.some(w => w.includes('legacy')));
  const plan = planFor(wd, { intent: ['gdrive'], warn: () => {} });
  assert.ok(plan, 'intent still applies on top of the legacy profile');
  assert.deepStrictEqual(plan.sections, ['core', 'gdrive']);
});

test('computePlan + intent feeds hidden siblings/modules/domains of the mounted subset only', () => {
  const p = computePlan(catalog, null, { intent: ['crm-weeek'] });
  assert.ok(p.hidden.siblings.includes('hh-skills'));
  assert.ok(!p.hidden.siblings.includes('sales-skills'), 'crm-weeek owns sales/30-weeek.js');
  assert.ok(p.hidden.domains.includes('hh') && !p.hidden.domains.includes('weeek'));
});

// ── browser: per-run config files for a narrowed mount ────────────────────────

test('writeMcpConfig with runId → .mcp-runs/<id>.mcp.json + per-run effective file', () => {
  const wd = tmpDir('run');
  const plan = planFor(wd, { intent: ['recruiting/hh'] });
  const cfgPath = writeMcpConfig(wd, null, { siblingPaths: {}, skillsPlan: plan, runId: 'alice-123' });
  assert.strictEqual(cfgPath, path.join(wd, '.mcp-runs', 'alice-123.mcp.json'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(cfg.mcpServers['hh-skills'], 'hh mounted');
  assert.ok(!cfg.mcpServers['engineering-skills'], 'engineering hidden by the intent');
  const resolved = cfg.mcpServers['trained-skills'].env.SKILLS_RESOLVED;
  assert.strictEqual(resolved, path.join(wd, '.mcp-runs', 'alice-123.skills-effective.json'));
  const effective = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  assert.deepStrictEqual(effective.sections, plan.sections);
  // Nothing leaked into the profile-level pair — a parallel un-narrowed run owns those.
  assert.ok(!fs.existsSync(path.join(wd, '.mcp.json')));
  assert.ok(!fs.existsSync(path.join(wd, EFFECTIVE_FILE)));
});

test('writeMcpConfig without runId keeps the profile-level .mcp.json byte-compatible', () => {
  const wd = tmpDir('flat');
  const cfgPath = writeMcpConfig(wd, null, { siblingPaths: {}, skillsPlan: null });
  assert.strictEqual(cfgPath, path.join(wd, '.mcp.json'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(cfg.mcpServers.playwright && cfg.mcpServers['trained-skills']);
  assert.strictEqual(cfg.mcpServers['trained-skills'].env.SKILLS_RESOLVED, undefined, 'legacy → no effective file');
});

test('stale .mcp-runs files are garbage-collected on the next write', () => {
  const wd = tmpDir('gc');
  const dir = path.join(wd, '.mcp-runs');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'old-run.mcp.json');
  fs.writeFileSync(stale, '{}');
  const old = new Date(Date.now() - 7 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  const fresh = path.join(dir, 'other-live.mcp.json');
  fs.writeFileSync(fresh, '{}');
  const plan = planFor(wd, { intent: ['gdrive'] });
  writeMcpConfig(wd, null, { siblingPaths: {}, skillsPlan: plan, runId: 'current-run' });
  assert.ok(!fs.existsSync(stale), 'older than the TTL is removed');
  assert.ok(fs.existsSync(fresh), 'recent parallel run kept');
  assert.ok(fs.existsSync(path.join(dir, 'current-run.mcp.json')));
});

test('runId is sanitised — no path traversal out of .mcp-runs', () => {
  const wd = tmpDir('sanit');
  const cfgPath = writeMcpConfig(wd, null, { siblingPaths: {}, skillsPlan: null, runId: '../../etc/passwd' });
  assert.strictEqual(path.dirname(cfgPath), path.join(wd, '.mcp-runs'), cfgPath);
});

// ── Escalation net + mount note ───────────────────────────────────────────────

test('buildMountNote: names the mounted sections and demands the marker line', () => {
  const note = buildMountNote({ sections: ['core', 'recruiting/hh'] });
  assert.match(note, /recruiting\/hh/);
  assert.ok(note.includes(ESCALATION_MARKER));
  assert.match(note, /НЕ отказывайся/);
  assert.strictEqual(buildMountNote({ sections: [] }), '');
  assert.strictEqual(buildMountNote(), '');
});

test('detectEscalation: marker anywhere; soft phrase only in the final message', () => {
  const withMarker = detectEscalation('делал что мог.\nTOOL_ESCALATION: нужен hh_send_message');
  assert.ok(withMarker);
  assert.strictEqual(withMarker.via, 'marker');
  assert.strictEqual(withMarker.reason, 'нужен hh_send_message');
  assert.ok(detectEscalation(`text\n  ${ESCALATION_MARKER}: нужен gdrive`), 'indented marker');

  assert.strictEqual(detectEscalation('обычный ответ без проблем'), null);
  // Phrase in the middle of a long run is too risky to trust — only the last message.
  assert.strictEqual(detectEscalation('правило: если не хватает инструмента — пиши маркер', ''), null);
  assert.ok(detectEscalation('обычный текст', 'мне не хватает инструмента для этой задачи'));
  assert.ok(detectEscalation('', "I don't have the required tool"));
});

// ── Prompt-prefix metric inputs ───────────────────────────────────────────────

test('estimateToolTokens: per mounted server, drops when the plan hides modules', () => {
  const full = estimateToolTokens({ playwright: {}, 'trained-skills': {}, 'hh-skills': {} });
  assert.ok(full.per.playwright > 0, 'playwright counted via the measured constant');
  assert.ok(full.per['trained-skills'] > 0);
  assert.ok(full.per['hh-skills'] > 0, 'sibling counted from its static catalog');
  assert.strictEqual(full.total, full.per.playwright + full.per['trained-skills'] + full.per['hh-skills']);

  const plan = computePlan(catalog, null, { intent: ['recruiting/hh'] });
  const narrowed = estimateToolTokens({ playwright: {}, 'trained-skills': {}, 'hh-skills': {} }, { plan });
  assert.ok(narrowed.per['trained-skills'] < full.per['trained-skills'],
    'hidden core modules shrink the tool-schema estimate');
  assert.strictEqual(narrowed.per['hh-skills'], full.per['hh-skills'], 'mounted sibling counted whole');
  assert.strictEqual(narrowed.per.playwright, full.per.playwright);

  const legacy = estimateToolTokens({ playwright: {} });
  assert.strictEqual(legacy.total, legacy.per.playwright, 'no plan → nothing hidden');
});

test('estimateToolTokens ignores servers it cannot introspect instead of throwing', () => {
  const r = estimateToolTokens({ playwright: {}, mystery: {} });
  assert.ok(r.per.playwright > 0);
  assert.strictEqual(r.per.mystery, undefined);
  assert.strictEqual(Object.keys(r.per).length, 1);
});

// ── mcp-action (headless transport) assembles from the profile's sections ─────

test('mcp-action: buildCatalogForProfile honours skills.json sections, absent → full', async () => {
  const { buildCatalogForProfile } = require('../src/mcp-action');
  const full = buildCatalogForProfile();
  assert.ok(full.tools.some(t => t.name === 'tilda_status'), 'full catalog has the tilda tool');

  const wd = tmpDir('action');
  fs.writeFileSync(path.join(wd, 'skills.json'), JSON.stringify({ enabled: ['recruiting'] }));
  const scoped = buildCatalogForProfile({ workDir: wd });
  assert.ok(!scoped.tools.some(t => t.name === 'tilda_status'), 'tilda section off → tool gone');
  assert.ok(scoped.tools.some(t => t.name === 'connect'), 'core tools kept');
  assert.ok(scoped.owners.get('tilda_status') === undefined);
});
