'use strict';
// System-prompt diet: core prompt stays small and domain-free; domain rules are
// gated per user by the same isReady() that gates their tools.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pd = require('../src/prompt-domains');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'src', 'agent-system-prompt.txt'), 'utf8');

test('core prompt stays within budget', () => {
  assert.ok(Buffer.byteLength(CORE) <= 4096, `core is ${Buffer.byteLength(CORE)} bytes > 4096 — put domain rules in src/prompt-domains/*.md`);
});

test('core prompt carries no domain skill rules or hardcoded dates', () => {
  const banned = [/\bhh_/i, /headhunter/i, /weeek/i, /flexi/i, /getcourse/i, /\bgc_/, /\bexpo_/, /сколково/i, /gdrive_(setup|read)/, /nalog/i, /tilda/i, /\b20\d\d-\d\d-\d\d\b/];
  for (const re of banned) assert.ok(!re.test(CORE), `core prompt matches ${re} — move it to src/prompt-domains/`);
});

test('every domain file parses and trained-skills gates point at real modules', () => {
  const tools = new Set(fs.readdirSync(path.join(ROOT, 'src', 'mcp-skills', 'tools')));
  const domains = pd.loadDomains();
  assert.ok(domains.length > 0);
  for (const d of domains) {
    assert.ok(d.body.length > 0, d.name);
    if (d.server === 'trained-skills') assert.ok(tools.has(d.module), `${d.name}: no module ${d.module}`);
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(d.body), `${d.name}: hardcoded date`);
  }
});

test('selectDomains gates by readiness, presence and attached servers', () => {
  const domains = [
    { name: 'a', server: 's', module: 'a.js', when: 'ready' },
    { name: 'a-setup', server: 's', module: 'a.js', when: 'not-ready' },
    { name: 'b', server: 's', module: 'b.js', when: 'ready' },
    { name: 'b-setup', server: 's', module: 'b.js', when: 'not-ready' },
    { name: 'c', server: 's', module: 'c.js', when: 'present' },
    { name: 'gone', server: 's', module: 'missing.js', when: 'present' },
    { name: 'other', server: 'absent', module: 'x.js', when: 'present' },
    { name: 'u', server: 'u', module: 'x.js', when: 'ready' },
    { name: 'u-setup', server: 'u', module: 'x.js', when: 'not-ready' },
  ];
  const picked = pd.selectDomains(domains, { s: { 'a.js': true, 'b.js': false, 'c.js': false }, u: null }).map(d => d.name);
  assert.deepStrictEqual(picked, ['a', 'b-setup', 'c', 'u']);
});

test('end-to-end: probe runs module isReady() under the server env', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
  const tools = path.join(tmp, 'srv', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'srv', 'index.js'), '');
  fs.writeFileSync(path.join(tools, 'a.js'), "console.log('noise'); setInterval(()=>{},1e6); module.exports={isReady:()=>process.env.USER_ID==='42',tools:{}};");
  const dom = path.join(tmp, 'domains');
  fs.mkdirSync(dom);
  fs.writeFileSync(path.join(dom, 'a.md'), '---\nserver: srv\nmodule: a.js\nwhen: ready\n---\n## A rules\n');
  fs.writeFileSync(path.join(dom, 'a.setup.md'), '---\nserver: srv\nmodule: a.js\nwhen: not-ready\n---\n## A setup\n');
  const cfg = uid => {
    const f = path.join(tmp, `mcp-${uid}.json`);
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { srv: { command: 'node', args: [path.join(tmp, 'srv', 'index.js')], env: { USER_ID: uid } } } }));
    return f;
  };
  const ready = pd.buildDomainBlock(cfg('42'), { dir: dom });
  assert.match(ready, /## A rules/);
  assert.doesNotMatch(ready, /A setup/);
  const notReady = pd.buildDomainBlock(cfg('7'), { dir: dom });
  assert.match(notReady, /## A setup/);
  assert.doesNotMatch(notReady, /A rules/);
});

test('real trained-skills + sales sibling: no-secret user gets setup lines, not connected-skill workflows', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')), 'mcp.json');
  // Weeek lives in the sales-skills sibling (#1470) — attach it like browser.js does.
  const sales = require('../src/skill-siblings').SKILL_SIBLINGS.find(s => s.id === 'sales');
  const salesIndex = require('../src/skill-siblings').siblingPaths(sales).indexPath;
  const env = { USER_ID: '', HOME: os.tmpdir() };
  fs.writeFileSync(f, JSON.stringify({ mcpServers: {
    'trained-skills': { command: 'node', args: [path.join(ROOT, 'src', 'mcp-skills', 'index.js')], env },
    'sales-skills': { command: 'node', args: [salesIndex], env },
  } }));
  const block = pd.buildDomainBlock(f);
  assert.match(block, /Weeek CRM — not connected/);
  assert.doesNotMatch(block, /AmVtckIKTfluL0od/);   // Weeek funnel id only for connected Weeek
  assert.doesNotMatch(block, /Exhibition catalog/); // expo only when enabled
  assert.doesNotMatch(block, /HeadHunter recruiting/); // hh-skills not attached
});
