'use strict';
// .gitignore generator from the clean list (#1923, M6 preparation):
//   · KEEP is the whitelist — those paths may enter the profile's git image;
//   · EXCLUDE (private data) is a hard ignore written LAST, so no whitelist entry
//     (`!**/*.json`) can re-include auth.json / .mcp.json / a storage-state;
//   · the rest (DELETE / SYSTEM / ARCHIVE / MOVE) stays out too — that is what
//     keeps a README.md inside node_modules out of the image;
//   · rules with a `when:` precondition are omitted (no static gitignore form);
//   · the whole thing is checked against a REAL `git` (add + status) when one
//     is available — gitignore semantics are the contract, not our reading of
//     them. Applying it to a live profile is M6, deliberately not here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const classifier = require('../scripts/profile-migrate/classifier.cjs');
const gitignore = require('../scripts/profile-migrate/gitignore.cjs');

const RULES = classifier.loadRules(classifier.DEFAULT_CLEAN_LIST).rules;
const EXCLUDE_RULES = RULES.filter((r) => r.action === 'EXCLUDE');
const KEEP_RULES = RULES.filter((r) => r.action === 'KEEP');
const HAS_GIT = !spawnSync('git', ['--version'], { encoding: 'utf8' }).error;

// ── pattern translation ─────────────────────────────────────────────────────
test('gitPattern: name patterns match at any depth, path patterns stay anchored', () => {
  assert.strictEqual(gitignore.gitPattern({ pattern: '.mcp.json', kind: 'name' }), '**/.mcp.json');
  assert.strictEqual(gitignore.gitPattern({ pattern: '*-creds', kind: 'name' }), '**/*-creds');
  assert.strictEqual(gitignore.gitPattern({ pattern: '.agent-home/**/auth.json', kind: 'path' }), '.agent-home/**/auth.json');
  assert.strictEqual(gitignore.gitPattern({ pattern: '/chrome/Default/Cookies', kind: 'path' }), 'chrome/Default/Cookies');
  assert.throws(() => gitignore.gitPattern(null), /object/);
  assert.throws(() => gitignore.gitPattern({ pattern: '' }), /non-empty/);
  assert.throws(() => gitignore.gitPattern({ pattern: '!keep' }), /gitignore-significant/);
  assert.throws(() => gitignore.gitPattern({ pattern: '#comment' }), /gitignore-significant/);
});

// ── structure ───────────────────────────────────────────────────────────────
test('buildGitIgnore: KEEP whitelist, then everything else, EXCLUDE last', () => {
  const text = gitignore.buildGitIgnore(RULES);
  const lines = text.split('\n');

  // 1–3: ignore everything, descend into directories, keep the file itself.
  assert.strictEqual(lines[lines.length - 1], '', 'newline-terminated');
  assert.ok(lines.includes('*'), 'catch-all first');
  assert.ok(lines.includes('!*/'), 'descend into every directory (git cannot re-include under an excluded dir)');
  assert.ok(lines.includes('!.gitignore'), 'the generated file itself is committed');
  assert.ok(lines.indexOf('!*/') > lines.indexOf('*'));
  assert.ok(lines.indexOf('!.gitignore') > lines.indexOf('*'));

  // Every rule of the shipped clean list is represented exactly once, with the
  // right sign — nothing silently dropped.
  for (const rule of RULES) {
    const pattern = gitignore.gitPattern(rule);
    const line = rule.action === 'KEEP' ? `!${pattern}` : pattern;
    const hits = lines.filter((l) => l === line);
    if (rule.when) {
      assert.deepStrictEqual(hits, [], `${rule.action} rule "${rule.pattern}" (when: ${rule.when}) must be omitted`);
      continue;
    }
    assert.strictEqual(hits.length, 1, `${rule.action} rule "${rule.pattern}" appears exactly once as "${line}"`);
  }

  // Ordering is the semantics: last match wins in gitignore, so every `!` must
  // precede every positive ignore — and EXCLUDE must be the last block.
  const lastBang = lines.reduce((acc, l, i) => (l.startsWith('!') ? i : acc), -1);
  const positives = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i > 2 && l && !l.startsWith('#') && !l.startsWith('!') && l !== '*');
  assert.ok(positives.length > 0, 'there are positive ignore lines');
  assert.ok(Math.min(...positives.map((p) => p.i)) > lastBang,
    'no positive ignore may follow a `!` (it would be overridden)');

  const firstExclude = lines.findIndex((l) => EXCLUDE_RULES.some((r) => gitignore.gitPattern(r) === l));
  assert.ok(firstExclude >= 0, 'EXCLUDE rules are emitted');
  for (const { i } of positives.filter(({ l }) => !EXCLUDE_RULES.some((r) => gitignore.gitPattern(r) === l))) {
    assert.ok(i < firstExclude, 'non-EXCLUDE ignores come before the EXCLUDE block');
  }

  // The acceptance of #1923: the image gets KEEP, never EXCLUDE.
  for (const rule of KEEP_RULES) assert.ok(lines.includes(`!${gitignore.gitPattern(rule)}`));
  for (const rule of EXCLUDE_RULES) {
    assert.ok(!lines.includes(`!${gitignore.gitPattern(rule)}`), `EXCLUDE ${rule.pattern} is never whitelisted`);
  }
  assert.ok(lines.some((l) => l.startsWith('# EXCLUDE')), 'the private-data block is labelled');
});

test('buildGitIgnore: fail-loud on a malformed rules argument', () => {
  assert.throws(() => gitignore.buildGitIgnore('nope'), /must be an array/);
  assert.throws(() => gitignore.buildGitIgnore([null]), /object/);
  assert.throws(() => gitignore.buildGitIgnore([{ pattern: 'x' }]), /action/);
  assert.throws(() => gitignore.buildGitIgnore([{ action: 'KEEP' }]), /pattern/);
});

// ── against the real git ────────────────────────────────────────────────────
test('the generated .gitignore stages KEEP and nothing EXCLUDE — checked by git itself', { skip: HAS_GIT ? false : 'git not available' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-gitignore-'));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_SYSTEM: path.join(tmp, 'gitconfig-system'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (args, cwd = tmp) => spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  try {
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
    fs.writeFileSync(gitEnv.GIT_CONFIG_SYSTEM, '');
    fs.writeFileSync(path.join(tmp, '.gitignore'), gitignore.buildDefaultGitIgnore());

    const keepFiles = {
      'persona.md': '# persona',
      'keep.json': '{"keep":true}',
      'contexts/hh/key.json': '{"k":1}',
      'notes/todo.txt': 'note',
    };
    const secrets = {
      'playwright-storage-state.json': '{"cookies":["SECRET-STATE"]}',
      '.mcp.json': '{"mcpServers":{"x":{"env":{"AGENT_SECRET":"SECRET-MCP"}}}}',
      '.agent-home/.codex/auth.json': '{"SECRET-AUTH":1}',
      'sites/hh/storage-state.json': '{"SECRET-SITE":1}',
      'recruiter-creds': 'SECRET-CREDS',
      '.webpasswd': 'SECRET-WEBPASSWD',
      'gc_export/.cookies': 'SECRET-COOKIE',
      'chrome/Default/Cookies': 'SECRET-CHROME-COOKIE',
    };
    const junk = {
      'node_modules/pkg/README.md': '# regenerable, must not be picked up by !**/*.md',
      'logs/app.log': 'log',
      'weird.bin': 'UNKNOWN, not in the whitelist',
    };
    for (const [rel, body] of Object.entries({ ...keepFiles, ...secrets, ...junk })) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), body);
    }

    assert.equal(git(['init', '-q']).status, 0, 'git init');
    assert.equal(git(['add', '-A']).status, 0, 'git add -A');

    const staged = git(['status', '--porcelain'])
      .stdout.split('\n').filter(Boolean).map((l) => l.slice(3)).sort();
    assert.deepStrictEqual(staged, ['.gitignore', ...Object.keys(keepFiles).sort()],
      'exactly the image: .gitignore + the KEEP whitelist');

    // Belt and braces: every secret is positively ignored, even though the
    // whitelist already covers its extension.
    for (const rel of Object.keys(secrets)) {
      const r = git(['check-ignore', '-q', rel]);
      assert.equal(r.status, 0, `${rel} must be ignored by git`);
    }
    for (const rel of Object.keys(keepFiles)) {
      assert.equal(git(['check-ignore', '-q', rel]).status, 1, `${rel} must NOT be ignored`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
