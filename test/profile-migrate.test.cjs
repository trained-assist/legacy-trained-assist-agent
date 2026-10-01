'use strict';
// Tests for the M0 profile-migration inventory (#1784):
//   config/profile-clean-list.yaml parsing + matching, the read-only
//   classifier walk, CLI guards, and the aggregate report.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const classifier = require('../scripts/profile-migrate/classifier.cjs');
const report = require('../scripts/profile-migrate/report.cjs');

const CLS = path.join(__dirname, '..', 'scripts', 'profile-migrate', 'classifier.cjs');
const REP = path.join(__dirname, '..', 'scripts', 'profile-migrate', 'report.cjs');
const REPO_CLS = path.join(__dirname, '..', 'config', 'profile-clean-list.yaml');
const RULES = classifier.loadRules(REPO_CLS);

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A miniature profile exercising every class + the tricky orderings.
function buildFixture(root) {
  const p = path.join(root, 'alice');
  write(path.join(p, 'node_modules/pkg/index.js'), '123456789012');       // DELETE (12)
  write(path.join(p, 'repo/node_modules/x/y.js'), '123456789012');        // DELETE, inside a repo
  write(path.join(p, '.mcp-runs/run.json'), 'rrrr');                       // DELETE (4)
  write(path.join(p, 'logs/run.log'), 'logline');                          // DELETE (7)
  write(path.join(p, 'hermes-tmp/x.txt'), 'tmp');                          // DELETE via *-tmp (3)
  write(path.join(p, 'sessions/s-1.json'), 'ssss');                        // ARCHIVE (4)
  write(path.join(p, 'sessions/photo-in-session.jpg'), '1234567890');      // ARCHIVE wins over MOVE (10)
  write(path.join(p, 'repo/.git/HEAD'), 'HEAD');                           // ARCHIVE (git-repo) (4)
  write(path.join(p, 'repo/src/app.py'), 'print(1)');                      // ARCHIVE (git-repo) (8)
  write(path.join(p, 'repo/package.json'), '{}');                          // ARCHIVE — worktree unit, not KEEP (2)
  write(path.join(p, '.agent-home/.claude/projects/s1/sess.jsonl'), '{"t"}'); // ARCHIVE (5)
  write(path.join(p, 'usage.json'), 'uuuuuuuu');                           // SYSTEM (8)
  write(path.join(p, 'prompt-audit.jsonl'), 'pppppppppp');                 // SYSTEM (10)
  write(path.join(p, '.agent-home/.local/share/opencode/opencode.db'), 'db'); // SYSTEM (2)
  write(path.join(p, 'photo.jpg'), '0123456789');                          // MOVE (10)
  write(path.join(p, 'expo-pipeline/c.html'), '<html>');                   // DELETE html cache (7)
  write(path.join(p, 'projects/p2/expo-pipeline/p.html'), '<html>');       // DELETE nested html cache (7)
  write(path.join(p, 'persona.md'), '# persona');                          // KEEP (9)
  write(path.join(p, 'contexts/hh/key.json'), '{"k":1}');                  // KEEP (7)
  write(path.join(p, '.agent-home/.claude/settings.json'), '{}');          // KEEP (2)
  write(path.join(p, 'weird.bin'), 'zzzz');                                // UNKNOWN (4)
  write(path.join(p, 'readme'), 'noreadme');                               // UNKNOWN (8)
  write(path.join(root, 'bob', 'notes.txt'), 'bob-keep');                  // KEEP (8)
  write(path.join(root, 'bob', 'blob.dat'), 'bob-blob');                   // UNKNOWN (8)
  return root;
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { out.push(`d ${path.relative(dir, full)}`); walk(full); }
      else {
        const st = fs.lstatSync(full);
        out.push(`f ${path.relative(dir, full)} ${st.size} ${st.mtimeMs} ${st.mode}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

const cli = (args, env = {}) => spawnSync(process.execPath, [CLS, ...args], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
});

// ── clean list ─────────────────────────────────────────────────────────────
test('clean list parses: version, every rule has action+reason', () => {
  assert.ok(RULES.version >= 2, 'the EXCLUDE action bumped the clean-list schema version');
  assert.ok(RULES.rules.length >= 50, `expected the M1 table to be fully transcribed, got ${RULES.rules.length}`);
  const actions = new Set(RULES.rules.map((r) => r.action));
  for (const a of ['DELETE', 'ARCHIVE', 'MOVE', 'SYSTEM', 'KEEP', 'EXCLUDE']) {
    assert.ok(actions.has(a), `action ${a} must be present in the M1 clean list`);
  }
  for (const r of RULES.rules) {
    assert.ok(r.reason.length > 0);
    assert.ok(classifier.ALL_CLASSES.includes(r.action));
  }
  assert.deepStrictEqual(classifier.ACTIONS, ['DELETE', 'ARCHIVE', 'MOVE', 'DEDUP', 'SYSTEM', 'KEEP', 'EXCLUDE'],
    'EXCLUDE is an action of the enum, reported before UNKNOWN');
});

test('clean list rejects malformed rules loudly', () => {
  const parse = (text) => classifier.compileRules(classifier.parseCleanListYaml(text, 't').rules, 't');
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: x\n    action: NOPE\n    reason: "r"\n'), /action/);
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: x\n    action: DELETE\n'), /reason/);
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: x\n    action: DELETE\n    reason: "r"\n    bogus: 1\n'), /unknown field/);
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: "a[bc]"\n    action: DELETE\n    reason: "r"\n'), /unsupported glob/);
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: "!x"\n    action: DELETE\n    reason: "r"\n'), /negation/);
  assert.throws(() => parse('version: 1\nrules:\n  - pattern: x\n    action: DELETE\n    reason: "r"\n    when: sometimes\n'), /when/);
  assert.throws(() => classifier.parseCleanListYaml('version: 1\n\trules: []\n', 't'), /tabs/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-yaml-'));
  try {
    const noVersion = path.join(tmp, 'cl.yaml');
    fs.writeFileSync(noVersion, 'rules:\n  - pattern: x\n    action: DELETE\n    reason: "r"\n');
    assert.throws(() => classifier.loadRules(noVersion), /version/);
    const noRules = path.join(tmp, 'cl2.yaml');
    fs.writeFileSync(noRules, 'version: 1\n');
    assert.throws(() => classifier.loadRules(noRules), /rules/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('glob semantics: bare = any-depth name, slash = root-anchored, ** crosses dirs', () => {
  const find = (pattern, extra = {}) => classifier.compileRules(
    [{ pattern, action: 'DELETE', reason: 'r', ...extra }], 't')[0];
  const m = (rule, rel, inRepo = false) => classifier.ruleMatches(rule, rel, inRepo);

  const nm = find('node_modules');
  assert.ok(m(nm, 'node_modules'));
  assert.ok(m(nm, 'projects/x/node_modules'));
  assert.ok(!m(nm, 'node_modules_backup'));

  const log = find('*.log');
  assert.ok(m(log, 'run.log'));
  assert.ok(m(log, 'deep/nested/run.log'));
  assert.ok(!m(log, 'run.log.gz'));

  const html = find('**/expo-pipeline/**/*.html');
  assert.ok(m(html, 'expo-pipeline/a.html'));
  assert.ok(m(html, 'projects/slug/expo-pipeline/sub/a.html'));
  assert.ok(!m(html, 'projects/slug/expo-pipeline/a.json'));

  const repoRule = find('**', { when: 'git-repo' });
  assert.ok(m(repoRule, 'anything/deep', true));
  assert.ok(!m(repoRule, 'anything/deep', false));
});

test('first matching rule wins; no rule → UNKNOWN', () => {
  // Mirror of the shipped order: junk rule above the media rule.
  const rules = classifier.compileRules([
    { pattern: 'node_modules', action: 'DELETE', reason: 'junk' },
    { pattern: '*.png', action: 'MOVE', reason: 'media' },
    { pattern: 'sessions', action: 'ARCHIVE', reason: 'sessions' },
    { pattern: '*.json', action: 'KEEP', reason: 'text' },
  ], 't');
  // Bare rules match the entry's own name; a matched directory propagates to
  // its subtree through parentIdx (the walk's job) — modelled here explicitly.
  const nmDirIdx = classifier.classifyIndex('a/node_modules', Infinity, false, rules);
  assert.strictEqual(rules[nmDirIdx].action, 'DELETE');
  assert.strictEqual(rules[classifier.classifyIndex('a/node_modules/x.png', nmDirIdx, false, rules)].action, 'DELETE');
  assert.strictEqual(rules[classifier.classifyIndex('media/x.png', Infinity, false, rules)].action, 'MOVE');
  // *.png sits ABOVE the sessions rule in this list → MOVE wins for media in
  // sessions. The shipped list orders it the other way (sessions above media).
  assert.strictEqual(rules[classifier.classifyIndex('sessions/x.png', Infinity, false, rules)].action, 'MOVE');
  assert.strictEqual(rules[classifier.classifyIndex('notes.json', Infinity, false, rules)].action, 'KEEP');
  assert.strictEqual(classifier.classifyIndex('odd.bin', Infinity, false, rules), -1);

  const flipped = classifier.compileRules([
    { pattern: 'sessions', action: 'ARCHIVE', reason: 'sessions' },
    { pattern: '*.png', action: 'MOVE', reason: 'media' },
  ], 't');
  const flipDirIdx = classifier.classifyIndex('sessions', Infinity, false, flipped);
  assert.strictEqual(flipped[flipDirIdx].action, 'ARCHIVE');
  assert.strictEqual(flipped[classifier.classifyIndex('sessions/x.png', flipDirIdx, false, flipped)].action, 'ARCHIVE',
    'a rule matched on the directory (parentIdx) beats a later rule matching the file');
});

// ── EXCLUDE: secrets, local only, never in the git image (#1923, B1/#1808) ──
// Every file the B1 red-team listed as "пересоздаётся внутри профиля каждым
// запуском" and that `*.json → KEEP` used to classify as pushable.
const B1_SECRETS = [
  'playwright-storage-state.json',                    // src/browser.js:158 — rewritten every run (86/94 profiles)
  'sites/hh/storage-state.json',                      // src/user-sites.js saveStorageState (mode 0600)
  'sites/hh/creds.json',                              // src/user-sites.js saveSiteCreds (mode 0600)
  '.agent-home/.codex/auth.json',                     // src/agent-isolation.js staged + syncBack
  '.agent-home/.local/share/opencode/auth.json',      // src/agent-isolation.js staged
  '.local/share/opencode/auth.json',                  // legacy layout, no .agent-home
  '.mcp.json',                                        // plaintext AGENT_SECRET in 10/22 profiles
  '.webpasswd',                                       // src/web-auth.js PASSWD_FILE
  'kinescope-creds',                                  // ZeroCreds credential file
  'gc_export/.cookies',                               // observed cookie jar (VM scan 2026-09-28)
  'cookies.json',
  'cookies.txt',
  'chrome/Default/Cookies',                           // Chrome cookie DB (3 profiles)
];

test('EXCLUDE: every B1 secret classifies as EXCLUDE — never KEEP, never UNKNOWN', () => {
  for (const rel of B1_SECRETS) {
    const idx = classifier.classifyIndex(rel, Infinity, false, RULES.rules);
    assert.notEqual(idx, -1, `${rel} must be classified`);
    assert.strictEqual(RULES.rules[idx].action, 'EXCLUDE', `${rel} classified as ${idx === -1 ? 'UNKNOWN' : RULES.rules[idx].action}`);
  }
});

test('EXCLUDE beats every rule that takes a file somewhere — including a git worktree', () => {
  const action = (rel, inRepo = false) => {
    const idx = classifier.classifyIndex(rel, Infinity, inRepo, RULES.rules);
    return idx === -1 ? 'UNKNOWN' : RULES.rules[idx].action;
  };
  // The `when: git-repo` `**` rule archives a whole working copy — a secret
  // inside one must not travel with it (this is the first-push leak of B1).
  assert.strictEqual(action('engineering-workspaces/w/code/auth.json', true), 'EXCLUDE');
  assert.strictEqual(action('projects/p/clone/.mcp.json', true), 'EXCLUDE');
  // …and above the KEEP catch-alls it used to fall through to.
  assert.strictEqual(action('sessions/playwright-storage-state.json'), 'EXCLUDE');
  assert.strictEqual(action('contexts/hh/.mcp.json'), 'EXCLUDE');

  const firstExclude = RULES.rules.findIndex((r) => r.action === 'EXCLUDE');
  assert.ok(firstExclude >= 0, 'the clean list has an EXCLUDE block');
  assert.ok(firstExclude < RULES.rules.findIndex((r) => r.pattern === '*.json'),
    'concrete secret paths come BEFORE *.json → KEEP (first-match-wins)');
  assert.ok(firstExclude < RULES.rules.findIndex((r) => r.pattern === '**' && r.when === 'git-repo'),
    'EXCLUDE comes BEFORE the worktree ARCHIVE rule');
  assert.ok(firstExclude > RULES.rules.findIndex((r) => r.pattern === 'node_modules'),
    'EXCLUDE comes AFTER DELETE — a regenerable subtree keeps its DELETE semantics');
  assert.ok(RULES.rules.filter((r) => r.action === 'EXCLUDE').every((r) => !r.when),
    'EXCLUDE rules are unconditional');
});

test('classifyProfile counts EXCLUDE as its own class — reported, never planned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-ex-'));
  try {
    const p = path.join(root, 'alice');
    const secrets = {
      'playwright-storage-state.json': 'SECRET-STATE-1234',
      '.agent-home/.codex/auth.json': '{"SECRET":1}',
      '.mcp.json': '{"mcpServers":{}}',
      '.webpasswd': 'pw',
      'recruiter-creds': 'cred',
    };
    for (const [rel, body] of Object.entries(secrets)) write(path.join(p, rel), body);
    write(path.join(p, 'persona.md'), '# persona');       // KEEP — the whitelist still works
    write(path.join(p, 'keep.json'), '{}');               // KEEP — a json that is not a secret
    write(path.join(p, 'weird.bin'), 'zz');               // UNKNOWN

    const r = classifier.classifyProfile(p, { rules: RULES.rules, profileName: 'alice' });
    const by = Object.fromEntries(r.classes.map((c) => [c.action, c]));
    assert.strictEqual(by.EXCLUDE.files, 5, 'EXCLUDE class holds every secret');
    assert.strictEqual(by.KEEP.files, 2, 'KEEP untouched by the secret rules');
    assert.strictEqual(by.UNKNOWN.files, 1);
    assert.strictEqual(by.EXCLUDE.bytes, Object.values(secrets).reduce((s, v) => s + v.length, 0));
    assert.strictEqual(r.totals.files, r.classes.reduce((s, c) => s + c.files, 0), 'classes sum to total');
    assert.ok(r.classes.some((c) => c.action === 'EXCLUDE'), 'the class survives into the report JSON');
    assert.deepStrictEqual(r.errors, [], 'no read errors');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── classifier walk ────────────────────────────────────────────────────────
test('classifyProfile: every file lands in the right class, subtree inheritance works', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-'));
  try {
    buildFixture(root);
    const r = classifier.classifyProfile(path.join(root, 'alice'), { rules: RULES.rules, profileName: 'alice' });
    const by = Object.fromEntries(r.classes.map((c) => [c.action, c]));

    assert.strictEqual(r.totals.files, 22, 'all fixture files counted');
    // DELETE: node_modules(2) + .mcp-runs + logs + hermes-tmp + 2 html caches
    assert.strictEqual(by.DELETE.files, 7, 'DELETE files');
    assert.strictEqual(by.DELETE.bytes, 12 + 12 + 4 + 7 + 3 + 6 + 6, 'DELETE bytes');
    // ARCHIVE: sessions(2) + repo/.git/HEAD + repo/src/app.py + repo/package.json + claude transcripts
    assert.strictEqual(by.ARCHIVE.files, 6, 'ARCHIVE files');
    // SYSTEM: usage.json + prompt-audit.jsonl + opencode.db
    assert.strictEqual(by.SYSTEM.files, 3, 'SYSTEM files');
    assert.strictEqual(by.SYSTEM.bytes, 8 + 10 + 2, 'SYSTEM bytes');
    // MOVE: only media outside sessions/repo
    assert.strictEqual(by.MOVE.files, 1, 'MOVE files');
    assert.strictEqual(by.MOVE.bytes, 10, 'MOVE bytes');
    // KEEP: persona.md + contexts + settings.json
    assert.strictEqual(by.KEEP.files, 3, 'KEEP files');
    // UNKNOWN: weird.bin + readme
    assert.strictEqual(by.UNKNOWN.files, 2, 'UNKNOWN files');
    assert.strictEqual(by.UNKNOWN.bytes, 12, 'UNKNOWN bytes');

    assert.strictEqual(r.totals.files, r.classes.reduce((s, c) => s + c.files, 0), 'classes sum to total');
    assert.strictEqual(r.totals.bytes, r.classes.reduce((s, c) => s + c.bytes, 0), 'class bytes sum to total');
    assert.ok(r.unclassified.pctBytes > 0);
    assert.deepStrictEqual(r.topUnknownPatterns.map((u) => u.pattern), ['(root)'], 'unknown dirs reported for growing the list');
    assert.strictEqual(r.topUnknownExtensions.length, 2, 'unknown extensions reported');
    assert.deepStrictEqual(r.errors, [], 'no read errors');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classifier is READ-ONLY: file set, sizes, mtimes and modes unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-ro-'));
  try {
    buildFixture(root);
    const before = snapshot(root);
    classifier.classifyProfile(path.join(root, 'alice'), { rules: RULES.rules });
    assert.strictEqual(snapshot(root), before, 'profile tree must not change');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI ────────────────────────────────────────────────────────────────────
test('CLI: --json stdout schema, guards for profile/output path/flag combos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-cli-'));
  try {
    buildFixture(root);

    const j = cli(['--all', '--users-root', root, '--json']);
    assert.strictEqual(j.status, 0, j.stderr);
    const doc = JSON.parse(j.stdout);
    assert.strictEqual(doc.schema, classifier.SCHEMA);
    assert.strictEqual(doc.kind, 'batch');
    assert.strictEqual(doc.profiles.length, 2);
    assert.strictEqual(doc.cleanList.version, RULES.version);

    const badProfile = cli(['--profile', 'nope', '--users-root', root]);
    assert.strictEqual(badProfile.status, 1);
    assert.match(badProfile.stderr, /profile not found/);

    const noMode = cli(['--users-root', root]);
    assert.strictEqual(noMode.status, 1);
    assert.match(noMode.stderr, /exactly one of --profile/);

    const both = cli(['--profile', 'alice', '--all', '--users-root', root]);
    assert.strictEqual(both.status, 1);

    const inside = cli(['--all', '--users-root', root, '--json', path.join(root, 'out.json')]);
    assert.strictEqual(inside.status, 1);
    assert.match(inside.stderr, /must not be written inside the profiles root/);

    // --scan-secrets must fail loudly when gitleaks is unavailable (exit 1).
    const noGitleaks = cli(['--profile', 'alice', '--users-root', root, '--scan-secrets'], {
      GITLEAKS_BIN: path.join(root, 'missing-gitleaks'),
    });
    assert.strictEqual(noGitleaks.status, 1, noGitleaks.stdout);
    assert.match(noGitleaks.stderr, /--scan-secrets requested but/);
    assert.match(noGitleaks.stderr, /gitleaks/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: --json <file> writes outside the users root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-out-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-json-'));
  try {
    buildFixture(root);
    const out = path.join(outDir, 'r.json');
    const j = cli(['--profile', 'alice', '--users-root', root, '--json', out]);
    assert.strictEqual(j.status, 0, j.stderr);
    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(doc.profile, 'alice');
    assert.strictEqual(doc.rules.count, RULES.rules.length);
    assert.strictEqual(doc.secrets.scanned, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

// ── report ─────────────────────────────────────────────────────────────────
function fakeProfile(name, { files, bytes, unknownBytes, unknownFiles = 1 }) {
  const cls = classifier.ALL_CLASSES.map((action) => ({ action, files: 0, bytes: 0, pctBytes: 0, pctFiles: 0 }));
  const set = (action, f, b) => { const c = cls.find((x) => x.action === action); c.files = f; c.bytes = b; };
  set('KEEP', files - unknownFiles, bytes - unknownBytes);
  set('UNKNOWN', unknownFiles, unknownBytes);
  return {
    schema: classifier.SCHEMA,
    profile: name,
    root: `/tmp/${name}`,
    totals: { files, bytes, dirs: 0, symlinks: 0 },
    classes: cls,
    unclassified: { files: unknownFiles, bytes: unknownBytes, pctBytes: 0, pctFiles: 0 },
    topUnknownPatterns: [{ pattern: '.agent-home/.local/share/opencode', files: unknownFiles, bytes: unknownBytes }],
    topUnknownExtensions: [{ pattern: '.db', files: unknownFiles, bytes: unknownBytes }],
    errors: [],
    secrets: { scanned: false },
  };
}

test('report.aggregate: totals, acceptance PASS/FAIL, top offenders and unknown patterns', () => {
  const mb = 1024 * 1024;
  const pass = report.aggregate([
    fakeProfile('big', { files: 100, bytes: 1000 * mb, unknownBytes: 5 * mb }),
    fakeProfile('small', { files: 50, bytes: 100 * mb, unknownBytes: 1 * mb }),
  ], 10);
  assert.strictEqual(pass.totals.profiles, 2);
  assert.strictEqual(pass.totals.bytes, 1100 * mb);
  assert.strictEqual(pass.totals.files, 150);
  assert.strictEqual(pass.unclassified.bytes, 6 * mb);
  assert.strictEqual(pass.acceptance.actualPct, 0.55, '6MB / 1100MB rounded');
  assert.strictEqual(pass.acceptance.pass, true);
  assert.strictEqual(pass.topOffenders[0].profile, 'big');
  assert.strictEqual(pass.topUnknownPatterns[0].pattern, '.agent-home/.local/share/opencode');
  assert.strictEqual(pass.topUnknownPatterns[0].profiles, 2, 'pattern aggregated across profiles');

  const fail = report.aggregate([fakeProfile('only', { files: 10, bytes: 100 * mb, unknownBytes: 5 * mb })], 10);
  assert.strictEqual(fail.acceptance.pass, false);
  assert.strictEqual(fail.acceptance.actualPct, 5);
  assert.strictEqual(fail.classes.find((c) => c.action === 'KEEP').bytes, 95 * mb);
});

test('report CLI: reads saved classifier JSON, prints acceptance verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-rep-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fixture-rep-json-'));
  try {
    buildFixture(root);
    const saved = path.join(outDir, 'batch.json');
    const run = spawnSync(process.execPath, [CLS, '--all', '--users-root', root, '--json', saved], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);

    const rep = spawnSync(process.execPath, [REP, '--in', saved], { encoding: 'utf8' });
    assert.strictEqual(rep.status, 0, rep.stderr);
    assert.match(rep.stdout, /class breakdown:/);
    assert.match(rep.stdout, /unclassified volume: \d/);
    assert.match(rep.stdout, /target < 1%/);
    assert.match(rep.stdout, /top unclassified patterns/, 'FAIL path must list patterns to grow the clean list');

    const strict = spawnSync(process.execPath, [REP, '--in', saved, '--strict'], { encoding: 'utf8' });
    assert.strictEqual(strict.status, 1, 'fixture has unknown volume, --strict must fail');

    // A saved report must not be mistaken for a classifier profile dump.
    const savedReport = path.join(outDir, 'agg.json');
    fs.writeFileSync(savedReport, JSON.stringify(report.aggregate([fakeProfile('x', { files: 1, bytes: 1, unknownBytes: 0 })], 5)));
    assert.throws(() => report.parseProfileJson(fs.readFileSync(savedReport, 'utf8'), savedReport), /not a classifier report/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
