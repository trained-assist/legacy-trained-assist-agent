#!/usr/bin/env node
'use strict';
// classifier.cjs — M0 profile inventory classifier (epic #1784).
//
// Walks a profile directory, applies config/profile-clean-list.yaml (M1 rules)
// to EVERY file and reports volume/count per class + the unclassified share.
//
// READ-ONLY by contract: this script never writes, moves or deletes anything
// inside a profile. Its only writes are (a) an optional --json report path,
//   which is rejected if it points inside the users root, and (b) a temp file
// for the gitleaks report (in os.tmpdir, deleted afterwards). The mutating
// half of the migration lives in runner.cjs and reuses THIS walk through the
// `opts.onEntry` callback, so a plan can never drift from the classification:
//   opts.onEntry({kind:'file'|'dir', rel, action, ruleIdx, size?, isSymlink?, isFile?})
// called once per directory entry (size only for files). Callback exceptions
// propagate — they are a caller bug, not a classification error.
//
// Usage:
//   node scripts/profile-migrate/classifier.cjs --profile <name> [flags]
//   node scripts/profile-migrate/classifier.cjs --all [flags]
//
// Flags:
//   --profile <name>     classify one profile (repeatable)
//   --all                classify every directory under the users root
//   --users-root <dir>   profiles root (default: $USERS_DIR or ~/users)
//   --clean-list <file>  rules file (default: config/profile-clean-list.yaml)
//   --json [file]        machine-readable output to stdout, or to <file>
//   --scan-secrets       run gitleaks per profile (fails loudly if missing)
//   --quiet              text mode: totals only, no per-class table
//   -h, --help
//
// Exit codes: 0 ok · 1 usage/config error (incl. gitleaks missing) ·
//             2 completed but some paths could not be read.
//
// Classification semantics are documented in config/profile-clean-list.yaml.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCHEMA = 'profile-migrate/classifier@1';
// EXCLUDE (issue #1923, blocker B1 of #1808): the file stays on disk — never
// deleted, archived or moved — but it never enters the git image (M6 .gitignore,
// generator in scripts/profile-migrate/gitignore.cjs). No phase declares EXCLUDE
// in its `actions`, so the runner's `actions.includes(e.action)` filter hands it
// to nobody; it is only counted, as its own class, in classSummary / reports.
const ACTIONS = ['DELETE', 'ARCHIVE', 'MOVE', 'DEDUP', 'SYSTEM', 'KEEP', 'EXCLUDE'];
const UNKNOWN = 'UNKNOWN';
const ALL_CLASSES = [...ACTIONS, UNKNOWN];
const DEFAULT_CLEAN_LIST = path.join(__dirname, '..', '..', 'config', 'profile-clean-list.yaml');

// ─────────────────────────────────────────────────────────────── YAML subset ─
// Strict, fail-loud parser for the clean-list schema only (see the file header
// for the supported grammar). Deliberately hand-rolled: one config file, zero
// runtime dependencies, and every unsupported construct is a hard error rather
// than a silently misparsed rule (a misparsed rule could misclassify volume).
function yamlError(lineNo, msg, src) {
  return new Error(`${src || 'clean list'}:${lineNo}: ${msg}`);
}

function stripYamlComment(s, lineNo, src) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  if (quote) throw yamlError(lineNo, 'unterminated quote', src);
  return s.trimEnd();
}

function parseYamlScalar(raw, lineNo, src) {
  const s = raw.trim();
  if (!s) throw yamlError(lineNo, 'empty scalar', src);
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') throw yamlError(lineNo, 'unterminated double-quoted string', src);
    const body = s.slice(1, -1);
    if (/\\[^"\\]/.test(body)) throw yamlError(lineNo, 'only \\" and \\\\ escapes are supported', src);
    return body.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") throw yamlError(lineNo, 'unterminated single-quoted string', src);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if ('[{&!|>%@`'.includes(s[0])) throw yamlError(lineNo, `unsupported YAML construct "${s[0]}"`, src);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function parseCleanListYaml(text, src) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (let n = 0; n < rawLines.length; n++) {
    const line = rawLines[n];
    const indentStr = /^[\s]*/.exec(line)[0];
    if (indentStr.includes('\t')) throw yamlError(n + 1, 'tabs are not allowed in indentation', src);
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const content = stripYamlComment(line.trim(), n + 1, src);
    if (!content) continue;
    lines.push({ indent: indentStr.length, content, line: n + 1 });
  }
  if (!lines.length) throw yamlError(1, 'empty file', src);
  const [value, next] = parseYamlBlock(lines, 0, lines[0].indent, src);
  if (next !== lines.length) throw yamlError(lines[next].line, 'unexpected trailing content', src);
  return value;
}

function parseYamlBlock(lines, i, indent, src) {
  if (lines[i].indent !== indent) throw yamlError(lines[i].line, `expected indent ${indent}, got ${lines[i].indent}`, src);
  return /^-(\s|$)/.test(lines[i].content) ? parseYamlList(lines, i, indent, src) : parseYamlMap(lines, i, indent, src);
}

function parseYamlList(lines, i, indent, src) {
  const out = [];
  while (i < lines.length && lines[i].indent === indent && /^-(\s|$)/.test(lines[i].content)) {
    const dash = lines[i];
    const rest = dash.content.replace(/^-\s*/, '');
    if (!rest) throw yamlError(dash.line, 'empty list item (nested lists are not supported)', src);
    if (!rest.includes(':')) { out.push(parseYamlScalar(rest, dash.line, src)); i++; continue; }
    // Re-enter map parsing: the `- key: value` line becomes the item's first
    // key/value at indent + 2; real lines of the item follow at that indent.
    const virtual = { indent: indent + 2, content: rest, line: dash.line };
    const [map, next] = parseYamlMap(lines, i + 1, indent + 2, src, virtual);
    out.push(map);
    i = next;
  }
  if (i < lines.length && lines[i].indent > indent) throw yamlError(lines[i].line, 'unexpected indent inside list', src);
  return [out, i];
}

function parseYamlMap(lines, i, indent, src, virtualFirst) {
  const map = {};
  let pending = virtualFirst || null;
  for (;;) {
    let line;
    if (pending) { line = pending; pending = null; }
    else {
      if (i >= lines.length || lines[i].indent < indent) break;
      if (lines[i].indent > indent) throw yamlError(lines[i].line, `unexpected indent (expected ${indent})`, src);
      if (/^-(\s|$)/.test(lines[i].content)) break;
      line = lines[i];
      i++;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line.content);
    if (!m) throw yamlError(line.line, `expected "key: value", got "${line.content}"`, src);
    const key = m[1].trim();
    if (Object.prototype.hasOwnProperty.call(map, key)) throw yamlError(line.line, `duplicate key "${key}"`, src);
    const rest = m[2];
    if (rest === '') {
      if (i >= lines.length || lines[i].indent <= indent) throw yamlError(line.line, `key "${key}" has no value`, src);
      const [value, next] = parseYamlBlock(lines, i, lines[i].indent, src);
      map[key] = value;
      i = next;
    } else {
      map[key] = parseYamlScalar(rest, line.line, src);
    }
  }
  return [map, i];
}

// ───────────────────────────────────────────────────────────────── glob ────
// Supports `**/`, `**`, `*`, `?` and literals. `[`, `{`, `}` are rejected at
// load time rather than silently treated as literals.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function compileRules(list, src) {
  if (!Array.isArray(list)) throw new Error(`${src || 'clean list'}: "rules" must be a list`);
  if (!list.length) throw new Error(`${src || 'clean list'}: "rules" is empty`);
  return list.map((rule, i) => {
    const where = (msg) => new Error(`${src || 'clean list'}: rule #${i + 1}: ${msg}`);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw where('must be a mapping');
    for (const key of Object.keys(rule)) {
      if (!['pattern', 'action', 'reason', 'when'].includes(key)) throw where(`unknown field "${key}"`);
    }
    const { pattern, action, reason, when } = rule;
    if (typeof pattern !== 'string' || !pattern.trim()) throw where('"pattern" must be a non-empty string');
    if (typeof reason !== 'string' || !reason.trim()) throw where('"reason" is required');
    if (!ACTIONS.includes(action)) throw where(`"action" must be one of ${ACTIONS.join('|')}, got ${JSON.stringify(action)}`);
    if (when !== undefined && when !== 'git-repo') throw where(`unsupported "when" precondition ${JSON.stringify(when)} (only "git-repo")`);
    if (pattern.includes('[') || pattern.includes('{') || pattern.includes('}')) throw where(`unsupported glob syntax in ${JSON.stringify(pattern)} — only *, ? and ** are supported`);
    if (pattern.startsWith('!')) throw where('negation ("!") is not supported');
    const clean = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    if (!clean) throw where('"pattern" must be relative');
    if (clean.split('/').some((seg) => seg === '..')) throw where('".." is not allowed in patterns');
    const kind = clean.includes('/') ? 'path' : 'name';
    return { i, pattern: clean, action, reason, when: when || null, kind, re: globToRegExp(clean) };
  });
}

function loadRules(file) {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, 'utf8');
  let doc;
  try {
    doc = parseCleanListYaml(text, path.relative(process.cwd(), abs) || abs);
  } catch (err) {
    throw err;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${abs}: top level must be a mapping`);
  for (const key of Object.keys(doc)) {
    if (!['version', 'rules'].includes(key)) throw new Error(`${abs}: unknown top-level key "${key}"`);
  }
  if (!Number.isInteger(doc.version)) throw new Error(`${abs}: "version" must be an integer`);
  if (!Array.isArray(doc.rules)) throw new Error(`${abs}: "rules" must be a list`);
  return { file: abs, version: doc.version, rules: compileRules(doc.rules, path.relative(process.cwd(), abs) || abs) };
}

// rule matches this entry (ancestors are covered by the inherited index)?
function ruleMatches(rule, relPath, inRepo) {
  if (rule.when === 'git-repo' && !inRepo) return false;
  if (rule.kind === 'name') {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    return rule.re.test(name);
  }
  return rule.re.test(relPath);
}

// First matching rule wins; a match on any ancestor prefix counts (propagated
// down the walk as parentIdx). Returns the rule index, or -1 for UNKNOWN.
function classifyIndex(relPath, parentIdx, inRepo, rules) {
  if (parentIdx === 0) return 0;
  const limit = parentIdx === Infinity ? rules.length : parentIdx;
  for (let i = 0; i < limit; i++) {
    if (ruleMatches(rules[i], relPath, inRepo)) return i;
  }
  if (parentIdx !== Infinity) return parentIdx;
  return -1;
}

// ─────────────────────────────────────────────────────── classification ────
function emptyCounter() {
  const byAction = {};
  for (const a of ALL_CLASSES) byAction[a] = { files: 0, bytes: 0 };
  return byAction;
}

function classifyProfile(profileRoot, opts = {}) {
  const rules = opts.rules;
  if (!Array.isArray(rules) || !rules.length) throw new Error('classifyProfile: compiled rules are required');
  const onEntry = typeof opts.onEntry === 'function' ? opts.onEntry : null;
  const absRoot = path.resolve(profileRoot);
  const stat = {
    files: 0, bytes: 0, dirs: 0, symlinks: 0,
    classes: emptyCounter(),
    ruleHits: rules.map(() => ({ files: 0, bytes: 0 })),
    byTopDir: {},
    unknownDirs: {},
    unknownExts: {},
    errors: [],
  };

  const add = (bucket, files, bytes) => {
    bucket.files += files;
    bucket.bytes += bytes;
  };

  const walk = (relDir, parentIdx, inRepo) => {
    const absDir = relDir ? path.join(absRoot, relDir) : absRoot;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      stat.errors.push({ path: relDir || '.', code: err.code || 'ERROR', message: err.message });
      return;
    }
    // A directory containing .git (file = linked worktree, dir = normal repo)
    // is a git working copy: everything inside it (including entries directly
    // at the repo root) classifies under the `when: git-repo` rule. Checked
    // from the already-read entry list — no extra syscall per directory.
    const repoHere = inRepo || entries.some((e) => e.name === '.git');
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stat.dirs++;
        const idx = classifyIndex(rel, parentIdx, repoHere, rules);
        // -1 (UNKNOWN) must not poison the subtree: an unclassified directory
        // just means "no rule hit yet", so children start from scratch.
        if (onEntry) onEntry({ kind: 'dir', rel, action: idx === -1 ? UNKNOWN : rules[idx].action, ruleIdx: idx });
        walk(rel, idx === -1 ? Infinity : idx, repoHere);
        continue;
      }
      let size = 0;
      if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          size = fs.lstatSync(path.join(absRoot, rel)).size;
        } catch (err) {
          stat.errors.push({ path: rel, code: err.code || 'ERROR', message: err.message });
          continue;
        }
        if (entry.isSymbolicLink()) stat.symlinks++;
      }
      // fifo/socket/device: counted and classified by path, size 0.
      stat.files++;
      stat.bytes += size;
      const idx = classifyIndex(rel, parentIdx, repoHere, rules);
      const action = idx === -1 ? UNKNOWN : rules[idx].action;
      if (onEntry) onEntry({ kind: 'file', rel, action, ruleIdx: idx, size, isSymlink: entry.isSymbolicLink(), isFile: entry.isFile() });
      add(stat.classes[action], 1, size);
      if (idx !== -1) {
        add(stat.ruleHits[idx], 1, size);
      } else {
        const dirKey = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(root)';
        const bucket = stat.unknownDirs[dirKey] || (stat.unknownDirs[dirKey] = { files: 0, bytes: 0, sample: rel });
        bucket.files += 1;
        bucket.bytes += size;
        const name = rel.slice(rel.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot).toLowerCase() : '(no extension)';
        const extBucket = stat.unknownExts[ext] || (stat.unknownExts[ext] = { files: 0, bytes: 0, sample: rel });
        extBucket.files += 1;
        extBucket.bytes += size;
      }
      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
      const tb = stat.byTopDir[top] || (stat.byTopDir[top] = { files: 0, bytes: 0 });
      tb.files += 1;
      tb.bytes += size;
    }
  };

  walk('', Infinity, false);

  const unclassified = stat.classes[UNKNOWN];
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);
  const sortMap = (m, limit) => Object.entries(m)
    .map(([key, v]) => ({ pattern: key, files: v.files, bytes: v.bytes, ...(v.sample ? { sample: v.sample } : {}) }))
    .sort((a, b) => b.bytes - a.bytes || b.files - a.files)
    .slice(0, limit);

  return {
    schema: SCHEMA,
    profile: opts.profileName || path.basename(absRoot),
    root: absRoot,
    durationMs: opts.durationMs || 0,
    totals: {
      files: stat.files, bytes: stat.bytes, dirs: stat.dirs, symlinks: stat.symlinks,
    },
    classes: ALL_CLASSES.map((action) => ({
      action,
      files: stat.classes[action].files,
      bytes: stat.classes[action].bytes,
      pctBytes: pct(stat.classes[action].bytes, stat.bytes),
      pctFiles: pct(stat.classes[action].files, stat.files),
    })),
    unclassified: {
      files: unclassified.files,
      bytes: unclassified.bytes,
      pctBytes: pct(unclassified.bytes, stat.bytes),
      pctFiles: pct(unclassified.files, stat.files),
    },
    ruleHits: rules.map((r) => ({
      pattern: r.pattern, action: r.action, when: r.when,
      files: stat.ruleHits[r.i].files, bytes: stat.ruleHits[r.i].bytes,
    })),
    byTopDir: sortMap(stat.byTopDir, 25),
    topUnknownPatterns: sortMap(stat.unknownDirs, 100),
    topUnknownExtensions: sortMap(stat.unknownExts, 50),
    errors: stat.errors,
  };
}

// ───────────────────────────────────────────────────────────── gitleaks ────
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function which(bin, pathEnv) {
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// Resolves gitleaks without touching PATH permanently (the GCP VM keeps it at
// ~/.local/bin/gitleaks, which is often not on the service PATH).
function resolveGitleaks(env = process.env) {
  if (env.GITLEAKS_BIN) {
    return isExecutable(env.GITLEAKS_BIN)
      ? { bin: env.GITLEAKS_BIN, source: 'GITLEAKS_BIN' }
      : { error: `GITLEAKS_BIN=${env.GITLEAKS_BIN} is not an executable file` };
  }
  const fromPath = which('gitleaks', env.PATH);
  if (fromPath) return { bin: fromPath, source: 'PATH' };
  const home = env.HOME || os.homedir();
  const local = path.join(home, '.local', 'bin', 'gitleaks');
  if (isExecutable(local)) return { bin: local, source: `${home}/.local/bin` };
  return {
    error: 'gitleaks not found (looked in $GITLEAKS_BIN, $PATH and ~/.local/bin/gitleaks). '
      + 'Install gitleaks 8.30.1 or set GITLEAKS_BIN=/path/to/gitleaks.',
  };
}

function gitleaksVersion(bin) {
  const r = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? String(r.stdout || '').trim() : 'unknown';
}

// Read-only for the profile: the JSON report goes to a temp dir outside it and
// is deleted immediately after parsing. Secrets themselves are redacted.
function scanSecrets(profileRoot, bin, log = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-migrate-gitleaks-'));
  const reportPath = path.join(tmp, 'report.json');
  try {
    log(`gitleaks scanning ${profileRoot} ...`);
    const r = spawnSync(bin, [
      'dir', profileRoot,
      '--no-banner', '--redact', '--exit-code', '0',
      '--report-format', 'json', '--report-path', reportPath,
      '--timeout', '600',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    if (r.error) return { scanned: false, error: `failed to run gitleaks: ${r.error.message}` };
    if (r.status !== 0) {
      const tail = String(r.stderr || '').split('\n').slice(-5).join('\n');
      return { scanned: false, error: `gitleaks exited with code ${r.status}${tail ? `:\n${tail}` : ''}` };
    }
    let findings = [];
    if (fs.existsSync(reportPath)) {
      const raw = fs.readFileSync(reportPath, 'utf8').trim();
      findings = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(findings)) return { scanned: false, error: 'gitleaks report is not an array' };
    }
    const byRule = {};
    const byFile = {};
    const rootPrefix = path.resolve(profileRoot) + path.sep;
    for (const f of findings) {
      const rule = f.RuleID || f.Rule || '(unknown rule)';
      const file = String(f.File || '(unknown file)');
      const relFile = file.startsWith(rootPrefix) ? file.slice(rootPrefix.length) : file;
      byRule[rule] = (byRule[rule] || 0) + 1;
      byFile[relFile] = (byFile[relFile] || 0) + 1;
    }
    const files = Object.keys(byFile).length;
    const topFiles = Object.entries(byFile)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      scanned: true,
      findings: findings.length,
      files,
      byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])),
      topFiles,
    };
  } catch (err) {
    return { scanned: false, error: err.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────── CLI ───────
function usage() {
  return [
    'Usage:',
    '  node scripts/profile-migrate/classifier.cjs --profile <name> [flags]',
    '  node scripts/profile-migrate/classifier.cjs --all [flags]',
    '',
    'Flags:',
    '  --profile <name>     classify one profile (repeatable)',
    '  --all                classify every directory under the users root',
    '  --users-root <dir>   profiles root (default: $USERS_DIR or ~/users)',
    '  --clean-list <file>  rules file (default: config/profile-clean-list.yaml)',
    '  --json [file]        JSON output to stdout, or to <file> (outside users root)',
    '  --scan-secrets       run gitleaks per profile (fails loudly if missing)',
    '  --quiet              text mode without the per-class table',
    '  -h, --help',
    '',
    'READ-ONLY: never writes inside a profile.',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = {
    profiles: [], all: false, usersRoot: null, cleanList: DEFAULT_CLEAN_LIST,
    json: null, jsonToStdout: false, scanSecrets: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--profile': opts.profiles.push(next()); break;
      case '--all': opts.all = true; break;
      case '--users-root': opts.usersRoot = next(); break;
      case '--clean-list': opts.cleanList = next(); break;
      case '--json': {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('-')) opts.jsonToStdout = true;
        else { opts.json = v; i++; }
        break;
      }
      case '--scan-secrets': opts.scanSecrets = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function defaultUsersRoot(env = process.env) {
  return path.resolve(env.USERS_DIR || path.join(os.homedir(), 'users'));
}

function listProfiles(usersRoot) {
  let entries;
  try {
    entries = fs.readdirSync(usersRoot, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read users root ${usersRoot}: ${err.message}`);
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const fmtInt = (n) => n.toLocaleString('en-US');

function printProfileText(result, quiet) {
  console.log(`${result.profile}  ${fmtBytes(result.totals.bytes)}  ${fmtInt(result.totals.files)} files  (dirs ${fmtInt(result.totals.dirs)}, symlinks ${fmtInt(result.totals.symlinks)})`);
  if (!quiet) {
    for (const c of result.classes) {
      if (!c.files && !c.bytes) continue;
      const flag = c.action === UNKNOWN ? '  ← unclassified' : '';
      console.log(`  ${c.action.padEnd(8)} ${fmtInt(c.files).padStart(10)}  ${fmtBytes(c.bytes).padStart(9)}  ${String(c.pctBytes).padStart(6)}%${flag}`);
    }
  }
  if (result.secrets && result.secrets.scanned) {
    console.log(`  secrets: ${result.secrets.findings} finding(s) in ${result.secrets.files} file(s)`);
  }
  if (result.secrets && result.secrets.error) {
    console.log(`  secrets: ERROR ${result.secrets.error}`);
  }
  if (result.errors.length) {
    console.log(`  read errors: ${result.errors.length} (first: ${result.errors[0].path}: ${result.errors[0].message})`);
  }
}

function assertOutputOutsideProfiles(outFile, usersRoot) {
  const abs = path.resolve(outFile);
  const root = path.resolve(usersRoot);
  if (abs === root || abs.startsWith(root + path.sep)) {
    throw new Error(`--json output must not be written inside the profiles root (${root}); it would pollute the inventory`);
  }
  return abs;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n\n${usage()}`);
    return 1;
  }
  if (opts.help) { console.log(usage()); return 0; }
  if (opts.all === (opts.profiles.length > 0)) {
    console.error(`error: pass exactly one of --profile <name> or --all\n\n${usage()}`);
    return 1;
  }

  const usersRoot = opts.usersRoot ? path.resolve(opts.usersRoot) : defaultUsersRoot();
  let loaded;
  try {
    loaded = loadRules(opts.cleanList);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  let gitleaks = null;
  if (opts.scanSecrets) {
    gitleaks = resolveGitleaks();
    if (gitleaks.error) {
      // Fail loudly BEFORE doing any work: --scan-secrets was explicitly asked
      // for, a silent skip would understate the report.
      console.error(`error: --scan-secrets requested but ${gitleaks.error}`);
      return 1;
    }
  }

  let names;
  try {
    names = opts.all ? listProfiles(usersRoot) : opts.profiles;
    if (!opts.all) {
      for (const name of names) {
        const dir = path.join(usersRoot, name);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          throw new Error(`profile not found: ${dir}`);
        }
      }
    } else if (!names.length) {
      throw new Error(`no profiles found under ${usersRoot}`);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  let outPath = null;
  if (opts.json && !opts.jsonToStdout) {
    try {
      outPath = assertOutputOutsideProfiles(opts.json, usersRoot);
    } catch (err) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) {
      console.error(`error: --json output directory does not exist: ${dir}`);
      return 1;
    }
  }

  const log = (msg) => process.stderr.write(`${msg}\n`);
  const results = [];
  let hadReadErrors = false;
  for (const name of names) {
    const t0 = Date.now();
    const root = path.join(usersRoot, name);
    const result = classifyProfile(root, { rules: loaded.rules, profileName: name, durationMs: 0 });
    result.durationMs = Date.now() - t0;
    result.rules = { file: loaded.file, version: loaded.version, count: loaded.rules.length };
    if (opts.scanSecrets) {
      result.secrets = scanSecrets(root, gitleaks.bin, log);
      if (result.secrets.error) hadReadErrors = true;
    } else {
      result.secrets = { scanned: false, reason: 'not requested (--scan-secrets)' };
    }
    if (result.errors.length) hadReadErrors = true;
    results.push(result);
  }

  const payload = opts.all
    ? {
      schema: SCHEMA, kind: 'batch', generatedAt: new Date().toISOString(),
      usersRoot, cleanList: { file: loaded.file, version: loaded.version, rules: loaded.rules.length },
      profiles: results,
    }
    : results[0];

  if (opts.jsonToStdout) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (outPath) {
      fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
      process.stderr.write(`wrote ${outPath}\n`);
    }
    for (const r of results) printProfileText(r, opts.quiet);
    if (results.length > 1) {
      const files = results.reduce((s, r) => s + r.totals.files, 0);
      const bytes = results.reduce((s, r) => s + r.totals.bytes, 0);
      console.log(`total: ${results.length} profiles, ${fmtBytes(bytes)}, ${fmtInt(files)} files`);
    }
  }

  return hadReadErrors ? 2 : 0;
}

module.exports = {
  SCHEMA, ACTIONS, UNKNOWN, ALL_CLASSES, DEFAULT_CLEAN_LIST,
  parseCleanListYaml, compileRules, loadRules, globToRegExp, ruleMatches, classifyIndex,
  classifyProfile, resolveGitleaks, scanSecrets, listProfiles, defaultUsersRoot,
  fmtBytes, parseArgv, assertOutputOutsideProfiles,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
