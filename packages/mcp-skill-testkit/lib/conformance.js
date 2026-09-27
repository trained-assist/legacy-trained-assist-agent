'use strict';

// Conformance gate for a domain-skill repo (trained-assist-<domain>-skill).
// Encodes the machine-checkable half of docs/domain-skill-repo-test-rules.md:
// required artifacts, manifest conformance, a non-empty mandatory suite set and
// the L3 static guards. It does NOT replace L1/L2/L3 tests — it is the single
// command a domain repo (and its PR checklist) runs to prove it follows the
// rules.
//
//   const { ok, checks } = checkDomainSkillRepo('/path/to/repo');
//   node bin/mcp-skill-conformance.js /path/to/repo

const fs = require('fs');
const { join, relative, sep } = require('path');
const { assertManifestConforms } = require('./manifest');

const REQUIRED_ARTIFACTS = [
  'mcp.manifest.json',
  'src/mcp-skills',
  'src/mcp-skills/index.js',
  'docs/user-scenarios',
  'scenarios',
  'fixtures',
  '.github/workflows/ci.yml',
  'checklist.md',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walk(p, out); }
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

// The mandatory suite set lives next to the replay runner: `staging/` in a
// scaffolded repo, `scripts/staging/` in repos that vendored the Phase 1 runner
// (core, hh-skill). Either layout is conformant; the first match wins.
const SUITES_LOCATIONS = ['staging/suites.json', 'scripts/staging/suites.json'];

function findSuites(repo) {
  return SUITES_LOCATIONS.find((rel) => fs.existsSync(join(repo, rel))) || null;
}

function checkArtifacts(repo) {
  const missing = REQUIRED_ARTIFACTS.filter((rel) => !fs.existsSync(join(repo, rel)));
  if (!findSuites(repo)) missing.push(SUITES_LOCATIONS.join(' | '));
  const total = REQUIRED_ARTIFACTS.length + 1;
  return { name: 'required-artifacts', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `${total} artifacts present` };
}

function checkManifest(repo, schemaPath) {
  const manifestPath = join(repo, 'mcp.manifest.json');
  if (!fs.existsSync(manifestPath)) return { name: 'manifest-conformance', ok: false, detail: 'mcp.manifest.json missing' };
  try {
    assertManifestConforms(manifestPath, schemaPath);
    return { name: 'manifest-conformance', ok: true, detail: 'conforms to mcp-skill-sources.schema.json' };
  } catch (e) {
    return { name: 'manifest-conformance', ok: false, detail: e.message };
  }
}

function checkSuites(repo) {
  const rel = findSuites(repo);
  if (!rel) return { name: 'mandatory-suites', ok: false, detail: `${SUITES_LOCATIONS.join(' | ')} missing` };
  try {
    const suites = JSON.parse(fs.readFileSync(join(repo, rel), 'utf8'));
    const entries = Object.values(suites).filter(Array.isArray).flat();
    if (!entries.length) return { name: 'mandatory-suites', ok: false, detail: `${rel} has no mandatory scenarios (empty run cannot approve a release)` };
    // A renamed/deleted test left in the set silently shrinks the gate or breaks
    // it only at release time — catch stale paths here.
    const stale = entries.filter((f) => typeof f !== 'string' || !fs.existsSync(join(repo, f)));
    if (stale.length) return { name: 'mandatory-suites', ok: false, detail: `${rel} lists missing files: ${stale.join(', ')}` };
    return { name: 'mandatory-suites', ok: true, detail: `${entries.length} mandatory scenario file(s) in ${rel}` };
  } catch (e) {
    return { name: 'mandatory-suites', ok: false, detail: `invalid suites.json: ${e.message}` };
  }
}

const BROWSER_FETCH_MARKER = /mcp-skill-conformance:\s*browser-fetch\b/;

function checkGuards(repo) {
  const files = walk(join(repo, 'src'));
  const toolsDir = join(repo, 'src', 'mcp-skills', 'tools');
  const violations = [];

  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(repo, file);

    // L3.1 — quick-action tools must never spawn Claude / the core runner.
    const isTool = file.startsWith(toolsDir + sep) || file === toolsDir;
    if (isTool && /spawn\(\s*['"]claude['"]|require\([^)]*runner['"]?\s*\)/.test(src)) {
      violations.push(`${rel}: tool spawns Claude or requires the core runner`);
    }

    // L3.2 — every external HTTP call needs a timeout (file-level heuristic).
    // Files that only emit browser-side JS (HTML page generators) opt out with
    // an explicit, reviewable marker: `mcp-skill-conformance: browser-fetch`.
    if (/\bfetch\s*\(/.test(src) && !/AbortSignal\.timeout|signal\s*:/.test(src) && !BROWSER_FETCH_MARKER.test(src)) {
      violations.push(`${rel}: fetch() without AbortSignal.timeout / signal`);
    }

    // L3.4 — profile paths via a resolver, never inline os.homedir().
    if (/os\.homedir\(\)/.test(src) && !/data-paths/.test(rel)) {
      violations.push(`${rel}: os.homedir() instead of a data-paths resolver`);
    }
  }

  // L3.3 — secrets must not be logged.
  for (const file of files) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    lines.forEach((line, i) => {
      if (/console\.(log|error|warn|info)\s*\([^)]*\b(token|password|secret|api_?key)\b/i.test(line)) {
        violations.push(`${relative(repo, file)}:${i + 1}: console call may log a secret`);
      }
    });
  }

  return { name: 'l3-guards', ok: violations.length === 0, detail: violations.length ? violations.join('; ') : 'no guard violations' };
}

function checkDomainSkillRepo(repo, { schemaPath } = {}) {
  const checks = [
    checkArtifacts(repo),
    checkManifest(repo, schemaPath),
    checkSuites(repo),
    checkGuards(repo),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

function reportDomainSkillRepo(repo, opts) {
  const { ok, checks } = checkDomainSkillRepo(repo, opts);
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}`);
  return { ok, checks };
}

module.exports = { checkDomainSkillRepo, reportDomainSkillRepo, REQUIRED_ARTIFACTS };
