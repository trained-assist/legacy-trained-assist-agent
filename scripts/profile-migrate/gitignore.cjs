'use strict';
// gitignore.cjs — .gitignore generator from the clean list (#1923, M6 prep).
//
// config/profile-clean-list.yaml is the ONE definition of the profile boundary:
// the M0 classifier walks by it and M6's git image is generated from the SAME
// compiled rules, so the inventory and the image can never drift. The shape:
//
//   1. `*`        ignore everything — nothing enters the image by accident;
//   2. `!*/`      …but descend into every directory (git cannot re-include a
//                 file whose parent directory is excluded);
//   3. `!.gitignore`  the generator's own output is committed;
//   4. `!<KEEP>`  the whitelist — the profile's text image (M1 KEEP);
//   5. non-KEEP   DELETE / SYSTEM / ARCHIVE / MOVE / DEDUP are not part of the
//                 image either, so they are written as ignores (this is what
//                 stops `!**/*.md` from picking a README.md out of
//                 node_modules);
//   6. EXCLUDE    private data — written LAST, so no whitelist entry can
//                 re-include secrets, session traces, or agent runtime state.
//                 They are ignored *and* reported as their own class; they stay
//                 on disk untouched.
//
// Last matching rule wins in gitignore semantics — hence the fixed order above.
// Rules carrying a `when:` precondition are omitted: a conditional rule has no
// static .gitignore form (the `when: git-repo` `**` rule would otherwise blank
// the whole image).
//
// SCOPE (#1923, step 4): a library plus its test. Nothing here writes into a
// profile — `git init` / commit / push is M6, which calls buildGitIgnore() for
// the text.

// Compiled clean-list rule → gitignore pattern (without any `!` prefix).
// A clean-list name pattern (no "/") matches at any depth → `**/` in gitignore;
// a path pattern is already anchored at the profile root, which is where the
// generated .gitignore sits.
function gitPattern(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('gitPattern: rule must be an object');
  const p = rule.pattern;
  if (typeof p !== 'string' || !p.trim()) throw new Error('gitPattern: rule.pattern must be a non-empty string');
  const pattern = p.startsWith('/') ? p.slice(1) : p;
  if (!pattern) throw new Error('gitPattern: rule.pattern must be relative');
  if (pattern.startsWith('!') || pattern.startsWith('#')) {
    throw new Error(`gitPattern: "${p}" starts with a gitignore-significant character`);
  }
  if (/[\r\n]/.test(pattern)) throw new Error('gitPattern: rule.pattern must be a single line');
  const anchored = pattern.includes('/') || p.startsWith('/');
  return anchored ? pattern : `**/${pattern}`;
}

// rules — the compiled list from classifier.cjs loadRules()/compileRules().
// Returns the whole file content (newline-terminated).
function buildGitIgnore(rules, opts = {}) {
  if (!Array.isArray(rules)) throw new Error('buildGitIgnore: rules must be an array');
  const source = opts.source || 'config/profile-clean-list.yaml';
  const keep = [];
  const others = [];
  const excluded = [];
  const conditional = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') throw new Error('buildGitIgnore: every rule must be an object');
    if (typeof rule.action !== 'string' || !rule.action) throw new Error('buildGitIgnore: rule.action is required');
    if (rule.when) { conditional.push(rule); continue; }
    const pattern = gitPattern(rule);
    if (rule.action === 'KEEP') keep.push(`!${pattern}`);
    else if (rule.action === 'EXCLUDE') excluded.push(pattern);
    else others.push(pattern);
  }

  const out = [];
  out.push(`# .gitignore — GENERATED from ${source} — do not edit by hand.`);
  out.push('# KEEP is a whitelist; EXCLUDE is a hard ignore written last, so private data');
  out.push('# can never be re-included by a whitelist entry (#1923, blocker B1).');
  out.push('# Regenerate instead of editing:');
  out.push(`#   node -e "const c=require('./scripts/profile-migrate/classifier.cjs'),g=require('./scripts/profile-migrate/gitignore.cjs');process.stdout.write(g.buildGitIgnore(c.loadRules('${source}').rules))"`);
  out.push('*');
  out.push('!*/');
  out.push('!.gitignore');
  out.push('');
  out.push(`# KEEP — the profile's text image (${keep.length} rule(s))`);
  out.push(...keep);
  if (others.length) {
    out.push('');
    out.push(`# Not kept (DELETE / SYSTEM / ARCHIVE / MOVE / DEDUP) — out of the image (${others.length} rule(s))`);
    out.push(...others);
  }
  if (excluded.length) {
    out.push('');
    out.push(`# EXCLUDE — private data, local only, never pushed (#1923, #163) (${excluded.length} rule(s))`);
    out.push(...excluded);
  }
  if (conditional.length) {
    out.push('');
    out.push(`# ${conditional.length} rule(s) with a "when:" precondition are omitted — not expressible in a static .gitignore.`);
  }
  out.push('');
  return out.join('\n');
}

// M6 convenience: the file content for the shipped clean list (read-only, the
// caller decides where/whether to write it).
function buildDefaultGitIgnore(opts = {}) {
  // Required lazily so importing this module never drags the CLI parser in.
  const classifier = require('./classifier.cjs');
  const loaded = classifier.loadRules(opts.cleanList || classifier.DEFAULT_CLEAN_LIST);
  return buildGitIgnore(loaded.rules, { source: opts.source || 'config/profile-clean-list.yaml', ...opts });
}

module.exports = { gitPattern, buildGitIgnore, buildDefaultGitIgnore };
