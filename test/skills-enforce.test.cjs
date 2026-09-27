'use strict';
// Skill sections enforcement (issue #1537 PR-B): workDir/skills.json decides which sibling
// servers land in .mcp.json, which local modules the registry lists and which prompt
// domains reach the system prompt. No skills.json / broken skills.json → legacy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeMcpConfig } = require('../src/browser');
const { planFor, computePlan, EFFECTIVE_FILE } = require('../src/skills/enforce');
const { loadCatalog } = require('../src/skills/catalog');
const pd = require('../src/prompt-domains');

const ROOT = path.join(__dirname, '..');
const SIBS = ['hh-skills', 'freelance-skills', 'engineering-skills'];

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `skills-enforce-${tag}-`)); }

// Fake sibling checkouts so the test doesn't depend on repos next to this one.
const sibDir = tmpDir('sibs');
const siblingPaths = {};
for (const id of SIBS) {
  const f = path.join(sibDir, id, 'src', 'mcp-skills', 'index.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '// fake sibling\n');
  siblingPaths[id] = f;
}

function writeAndRead(workDir, skills) {
  const f = path.join(workDir, 'skills.json');
  if (skills === undefined) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, typeof skills === 'string' ? skills : JSON.stringify(skills));
  const p = writeMcpConfig(workDir, null, { siblingPaths });
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Every server attached and every module "ready", plus a not-ready github → github.setup.
function probeFor(cfg) {
  const localMods = fs.readdirSync(path.join(ROOT, 'src', 'mcp-skills', 'tools')).filter(f => f.endsWith('.js'));
  const all = {
    'trained-skills': Object.fromEntries(localMods.map(m => [m, m !== '60-github.js'])),
    'hh-skills': { '90-hh.js': true },
    'freelance-skills': { '10-freelance-project.js': true },
    'engineering-skills': { '20-workspace.js': true },
  };
  return Object.fromEntries(Object.entries(all).filter(([id]) => id in cfg.mcpServers));
}

function domainsFor(workDir, cfg, probe) {
  const report = {};
  const block = pd.buildDomainBlock(path.join(workDir, '.mcp.json'), { probe: probe || probeFor(cfg), report });
  return { block, picked: report.picked };
}

test('no skills.json → legacy .mcp.json: every sibling, no SKILLS_RESOLVED, no effective file', () => {
  const wd = tmpDir('legacy');
  const cfg = writeAndRead(wd, undefined);
  for (const id of SIBS) assert.ok(cfg.mcpServers[id], `${id} mounted`);
  assert.ok(!('SKILLS_RESOLVED' in cfg.mcpServers['trained-skills'].env));
  assert.ok(!fs.existsSync(path.join(wd, EFFECTIVE_FILE)));
  assert.strictEqual(planFor(wd), null);
  const { picked } = domainsFor(wd, cfg);
  assert.ok(picked.includes('engineering') && picked.includes('github.setup') && picked.includes('hh'));
});

test("skills.json {enabled:['recruiting']} → no engineering/freelance sibling, no engineering prompt domain", () => {
  const wd = tmpDir('recruiting');
  const cfg = writeAndRead(wd, { enabled: ['recruiting'] });
  assert.ok(cfg.mcpServers['hh-skills'], 'recruiting/hh child is on');
  assert.ok(!cfg.mcpServers['engineering-skills'], 'engineering-skills must not be written');
  assert.ok(!cfg.mcpServers['freelance-skills'], 'freelance-skills must not be written');
  assert.ok(cfg.mcpServers.playwright && cfg.mcpServers['trained-skills'], 'core servers stay');

  const file = cfg.mcpServers['trained-skills'].env.SKILLS_RESOLVED;
  assert.strictEqual(file, path.join(wd, EFFECTIVE_FILE));
  assert.strictEqual(cfg.mcpServers['hh-skills'].env.SKILLS_RESOLVED, file);
  const eff = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(eff.hidden.modules.includes('60-github.js'));
  assert.ok(!eff.hidden.modules.includes('97b-candidate-client-report.js'));
  assert.ok(!eff.hidden.modules.includes('04-cron.js'), 'core is always on');
  assert.ok(!eff.hidden.modules.includes('40-company.js'), 'shared module on via recruiting/company');

  // Even if a probe claims engineering-skills attached, its domain is dropped.
  const probe = { ...probeFor(cfg), 'engineering-skills': { '20-workspace.js': true } };
  const { picked, block } = domainsFor(wd, cfg, probe);
  assert.ok(!picked.includes('engineering'), 'engineering prompt domain absent');
  assert.ok(!picked.includes('github.setup'));
  assert.ok(picked.includes('hh') && picked.includes('cron'));
  const engBody = pd.loadDomains().find(d => d.name === 'engineering').body;
  assert.ok(!block.includes(engBody));
});

test('sealed source for a switched-off sibling is not mounted either', () => {
  const wd = tmpDir('sealed');
  fs.writeFileSync(path.join(wd, 'skills.json'), JSON.stringify({ enabled: ['recruiting'] }));
  const p = writeMcpConfig(wd, null, { siblingPaths, extraServers: {
    'engineering-skills': { command: 'node', args: ['/x/sealed.js'] },
    'hh-skills': { command: 'node', args: ['/x/sealed-hh.js'] },
  } });
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(!cfg.mcpServers['engineering-skills']);
  assert.deepStrictEqual(cfg.mcpServers['hh-skills'].args, ['/x/sealed-hh.js']);
});

test('corrupted / malformed skills.json → exactly legacy', () => {
  const wd = tmpDir('corrupt');
  const legacy = writeAndRead(wd, undefined);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const bad of ['{not json', '[]', '{"enabled":"recruiting"}', '{}', 'null']) {
      const cfg = writeAndRead(wd, bad);
      assert.deepStrictEqual(cfg, legacy, `skills.json=${bad}`);
      assert.ok(!fs.existsSync(path.join(wd, EFFECTIVE_FILE)));
      assert.deepStrictEqual(domainsFor(wd, cfg).picked, domainsFor(wd, legacy).picked);
    }
  } finally { console.warn = origWarn; }
  assert.ok(warns.some(w => w.includes('[skills]') && w.includes('legacy')), 'broken config is warned about');
});

test('catalog load failure → legacy (never silently cut tools)', () => {
  const wd = tmpDir('nocat');
  fs.writeFileSync(path.join(wd, 'skills.json'), JSON.stringify({ enabled: ['recruiting'] }));
  const warns = [];
  const plan = planFor(wd, { catalog: { get sections() { throw new Error('boom'); } }, warn: m => warns.push(m) });
  assert.strictEqual(plan, null);
  assert.ok(warns[0].includes('boom'));
});

test('computePlan: disabled child, unknown sections, unlisted things never hidden', () => {
  const catalog = loadCatalog();
  const p = computePlan(catalog, { enabled: ['recruiting'], disabled: ['recruiting/hh'], });
  assert.deepStrictEqual(p.hidden.siblings, ['engineering-skills', 'freelance-skills', 'hh-skills']);
  assert.ok(p.hidden.domains.includes('hh') && !p.hidden.domains.includes('cron'));
  const all = computePlan(catalog, { enabled: Object.keys(catalog.sections) });
  assert.deepStrictEqual(all.hidden, { siblings: [], modules: [], domains: [] });
  const u = computePlan(catalog, { enabled: ['nope'] });
  assert.deepStrictEqual(u.unknown, ['nope']);
});

function listTools(env) {
  const r = spawnSync(process.execPath, ['-e',
    "process.stdout.write('\\n__T__'+JSON.stringify(require('./src/mcp-skills/registry').listTools().map(t=>t.name))+'\\n',()=>process.exit(0))"],
  { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 22 });
  const at = r.stdout.lastIndexOf('__T__');
  assert.ok(at >= 0, `registry child failed: ${r.stderr.slice(0, 500)}`);
  return { names: JSON.parse(r.stdout.slice(at + 5)), stderr: r.stderr };
}

test('registry tools/list: SKILLS_RESOLVED hides switched-off modules; unset/broken → legacy', () => {
  const wd = tmpDir('registry');
  const cfg = writeAndRead(wd, { enabled: ['recruiting'] });
  const file = cfg.mcpServers['trained-skills'].env.SKILLS_RESOLVED;
  const base = { SKILLS_RESOLVED: '' };
  const legacy = listTools(base).names;
  assert.ok(legacy.includes('github_status') && legacy.includes('candidate_report_context'));

  const filtered = listTools({ SKILLS_RESOLVED: file }).names;
  assert.ok(!filtered.includes('github_status'), 'software-engineering module hidden');
  assert.ok(filtered.includes('candidate_report_context'), 'recruiting module kept');
  assert.ok(filtered.includes('connect'), 'core kept');

  const broken = path.join(wd, 'broken.json');
  fs.writeFileSync(broken, '{nope');
  const b = listTools({ SKILLS_RESOLVED: broken });
  assert.deepStrictEqual(b.names, legacy);
  assert.ok(b.stderr.includes('[skills]'));
});
