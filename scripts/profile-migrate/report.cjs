#!/usr/bin/env node
'use strict';
// report.cjs — M0 aggregate inventory across profiles (epic #1784).
//
// Reads classifier output (scripts/profile-migrate/classifier.cjs --json) and
// prints one summary: total size, top offenders, class breakdown, and the
// unclassified share — the epic's M0 acceptance is "unclassified < 1% of
// volume"; when the real number is higher, the report lists the top
// unclassified patterns (by directory and by extension) so the M1 clean list
// (config/profile-clean-list.yaml) can grow.
//
// Two input modes:
//   --in <file|dir>   analyse saved JSON (repeatable; a dir is scanned for *.json)
//   --all             classify live, in-process (same flags as the classifier:
//                     --users-root/--profile/--clean-list/--scan-secrets)
//   (no --in and no --profile = --all)
//
// Flags: --top <n> (default 10), --json [file], --strict, --quiet, -h
//
// READ-ONLY: never writes inside a profile (same contract as the classifier).
// Exit codes: 0 ok · 1 usage/input error (or unclassified ≥ 1% with --strict) ·
//             2 completed with read/secret-scan errors.

const fs = require('fs');
const path = require('path');
const classifier = require('./classifier.cjs');

const SCHEMA = 'profile-migrate/report@1';
const TARGET_PCT = 1.0; // epic M0 acceptance: unclassified < 1% of volume

function usage() {
  return [
    'Usage:',
    '  node scripts/profile-migrate/report.cjs --in <file|dir> [flags]',
    '  node scripts/profile-migrate/report.cjs --all [flags]',
    '',
    'Flags:',
    '  --in <path>          classifier JSON file or directory of them (repeatable)',
    '  --all                classify every profile live, then summarise',
    '  --profile <name>     live mode: only this profile (repeatable)',
    '  --users-root <dir>   live mode: profiles root (default: $USERS_DIR or ~/users)',
    '  --clean-list <file>  live mode: rules file (default: config/profile-clean-list.yaml)',
    '  --scan-secrets       live mode: run gitleaks per profile (fails loudly if missing)',
    '  --top <n>            rows in top-offenders / top-unknown lists (default 10)',
    '  --json [file]        JSON aggregate to stdout, or to <file>',
    '  --strict             exit 1 when unclassified volume >= 1%',
    '  --quiet              no per-class table',
    '  -h, --help',
    '',
    'READ-ONLY: never writes inside a profile.',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = {
    inputs: [], all: false, profiles: [], usersRoot: null, cleanList: classifier.DEFAULT_CLEAN_LIST,
    scanSecrets: false, top: 10, json: null, jsonToStdout: false,
    strict: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--in': opts.inputs.push(next()); break;
      case '--all': opts.all = true; break;
      case '--profile': opts.profiles.push(next()); break;
      case '--users-root': opts.usersRoot = next(); break;
      case '--clean-list': opts.cleanList = next(); break;
      case '--scan-secrets': opts.scanSecrets = true; break;
      case '--top': opts.top = Number(next()); break;
      case '--json': {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('-')) opts.jsonToStdout = true;
        else { opts.json = v; i++; }
        break;
      }
      case '--strict': opts.strict = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) throw new Error('--top must be a positive integer');
  return opts;
}

// ── inputs ─────────────────────────────────────────────────────────────────
function parseProfileJson(text, source) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: invalid JSON — ${err.message}`);
  }
  if (doc?.schema === classifier.SCHEMA && Array.isArray(doc.profiles)) return doc.profiles;
  if (doc?.schema === classifier.SCHEMA && doc.totals && doc.classes) return [doc];
  throw new Error(`${source}: not a classifier report (expected schema ${classifier.SCHEMA})`);
}

function collectFromInputs(inputs) {
  const profiles = [];
  const sources = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      throw new Error(`cannot read --in ${abs}: ${err.message}`);
    }
    const files = stat.isDirectory()
      ? fs.readdirSync(abs).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(abs, f))
      : [abs];
    if (stat.isDirectory() && !files.length) throw new Error(`--in ${abs}: no *.json files found`);
    for (const file of files) {
      profiles.push(...parseProfileJson(fs.readFileSync(file, 'utf8'), file));
      sources.push(file);
    }
  }
  return { profiles, sources };
}

function collectLive(opts) {
  const usersRoot = opts.usersRoot ? path.resolve(opts.usersRoot) : classifier.defaultUsersRoot();
  const loaded = classifier.loadRules(opts.cleanList);
  let gitleaks = null;
  if (opts.scanSecrets) {
    gitleaks = classifier.resolveGitleaks();
    if (gitleaks.error) {
      throw new Error(`--scan-secrets requested but ${gitleaks.error}`);
    }
  }
  let names;
  if (opts.all && opts.profiles.length) throw new Error('pass either --profile <name> or --all, not both');
  if (opts.profiles.length) {
    names = opts.profiles;
    for (const name of names) {
      const dir = path.join(usersRoot, name);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`profile not found: ${dir}`);
    }
  } else {
    names = classifier.listProfiles(usersRoot);
    if (!names.length) throw new Error(`no profiles found under ${usersRoot}`);
  }
  const profiles = [];
  for (const name of names) {
    const root = path.join(usersRoot, name);
    const t0 = Date.now();
    const result = classifier.classifyProfile(root, { rules: loaded.rules, profileName: name });
    result.durationMs = Date.now() - t0;
    result.rules = { file: loaded.file, version: loaded.version, count: loaded.rules.length };
    result.secrets = opts.scanSecrets
      ? classifier.scanSecrets(root, gitleaks.bin, (m) => process.stderr.write(`${m}\n`))
      : { scanned: false, reason: 'not requested (--scan-secrets)' };
    profiles.push(result);
  }
  return { profiles, usersRoot, cleanList: { file: loaded.file, version: loaded.version, rules: loaded.rules.length } };
}

// ── aggregation ────────────────────────────────────────────────────────────
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);
const bump = (map, key, files, bytes, sample) => {
  const v = map[key] || (map[key] = { files: 0, bytes: 0, profiles: 0, sample });
  v.files += files;
  v.bytes += bytes;
};
const sorted = (map, limit) => Object.entries(map)
  .map(([key, v]) => ({ pattern: key, files: v.files, bytes: v.bytes, profiles: v.profiles || undefined, sample: v.sample }))
  .sort((a, b) => b.bytes - a.bytes || b.files - a.files)
  .slice(0, limit);

function aggregate(profiles, topN) {
  const classMap = {};
  for (const c of classifier.ALL_CLASSES) classMap[c] = { action: c, files: 0, bytes: 0 };
  const unknownPatterns = {};
  const unknownExts = {};
  let files = 0;
  let bytes = 0;
  let unclassifiedFiles = 0;
  let unclassifiedBytes = 0;
  let readErrors = 0;
  let secretFindings = 0;
  let secretFiles = 0;
  let secretsScanned = 0;

  for (const p of profiles) {
    files += p.totals.files;
    bytes += p.totals.bytes;
    for (const c of p.classes) {
      classMap[c.action].files += c.files;
      classMap[c.action].bytes += c.bytes;
    }
    const un = p.unclassified || p.classes.find((c) => c.action === classifier.UNKNOWN);
    unclassifiedFiles += un.files;
    unclassifiedBytes += un.bytes;
    readErrors += (p.errors || []).length;
    for (const u of p.topUnknownPatterns || []) bump(unknownPatterns, u.pattern, u.files, u.bytes, u.sample);
    for (const u of p.topUnknownExtensions || []) bump(unknownExts, u.pattern, u.files, u.bytes, u.sample);
    if (p.secrets?.scanned) {
      secretsScanned++;
      secretFindings += p.secrets.findings || 0;
      secretFiles += p.secrets.files || 0;
    }
  }
  // `profiles` counter on aggregated unknown patterns: how many profiles the
  // pattern appears in — the clean list is grown per pattern, not per profile.
  for (const [key, v] of Object.entries(unknownPatterns)) {
    v.profiles = profiles.filter((p) => (p.topUnknownPatterns || []).some((u) => u.pattern === key)).length;
  }

  const offenders = profiles
    .map((p) => ({
      profile: p.profile,
      files: p.totals.files,
      bytes: p.totals.bytes,
      pctBytes: pct(p.totals.bytes, bytes),
      unclassifiedPct: p.unclassified?.pctBytes ?? pct(p.unclassified?.bytes ?? 0, p.totals.bytes),
      readErrors: (p.errors || []).length,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const classes = classifier.ALL_CLASSES.map((action) => {
    const c = classMap[action];
    return {
      ...c,
      pctBytes: pct(c.bytes, bytes),
      pctFiles: pct(c.files, files),
    };
  });

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    totals: { profiles: profiles.length, files, bytes },
    classes,
    unclassified: {
      files: unclassifiedFiles,
      bytes: unclassifiedBytes,
      pctBytes: pct(unclassifiedBytes, bytes),
      pctFiles: pct(unclassifiedFiles, files),
    },
    acceptance: {
      targetPct: TARGET_PCT,
      actualPct: pct(unclassifiedBytes, bytes),
      pass: pct(unclassifiedBytes, bytes) < TARGET_PCT,
      note: 'unclassified share of volume (epic #1784 M0 acceptance: < 1%)',
    },
    topOffenders: offenders.slice(0, topN),
    topUnknownPatterns: sorted(unknownPatterns, topN),
    topUnknownExtensions: sorted(unknownExts, Math.max(topN, 10)),
    unknownPatternsTruncated: 'aggregated from each profile\'s top 100 unclassified directories',
    secrets: secretsScanned
      ? { scannedProfiles: secretsScanned, findings: secretFindings, files: secretFiles }
      : { scannedProfiles: 0, findings: null, note: 'gitleaks not run (pass --scan-secrets)' },
    readErrors,
  };
}

// ── output ────────────────────────────────────────────────────────────────
const fmtBytes = classifier.fmtBytes;
const fmtInt = (n) => n.toLocaleString('en-US');

function printReport(report, opts, meta) {
  const out = console.log;
  if (meta.cleanList) {
    out(`rules: ${path.relative(process.cwd(), meta.cleanList.file) || meta.cleanList.file} (v${meta.cleanList.version}, ${meta.cleanList.rules} rules)`);
  }
  out(`profiles: ${report.totals.profiles} · total ${fmtBytes(report.totals.bytes)} · ${fmtInt(report.totals.files)} files`);
  if (meta.usersRoot) out(`users root: ${meta.usersRoot}`);
  out('');
  out('class breakdown:');
  for (const c of report.classes) {
    if (!c.files && !c.bytes) continue;
    const flag = c.action === classifier.UNKNOWN ? '   ← unclassified' : '';
    out(`  ${c.action.padEnd(8)} ${fmtInt(c.files).padStart(10)} files  ${fmtBytes(c.bytes).padStart(9)}  ${String(c.pctBytes).padStart(6)}%${flag}`);
  }
  if (!opts.quiet) {
    out('');
    out(`top offenders (of ${report.totals.profiles}):`);
    report.topOffenders.forEach((p, i) => {
      out(`  ${String(i + 1).padStart(2)}. ${p.profile.padEnd(34)} ${fmtBytes(p.bytes).padStart(9)}  ${fmtInt(p.files).padStart(9)} files  unclassified ${String(p.unclassifiedPct).padStart(5)}%`);
    });
  }
  if (report.secrets.findings !== null) {
    out('');
    out(`secrets (gitleaks): ${report.secrets.findings} finding(s) in ${report.secrets.files} file(s), scanned ${report.secrets.scannedProfiles}/${report.totals.profiles} profiles`);
  }
  if (report.readErrors) {
    out('');
    out(`read errors: ${report.readErrors} path(s) could not be read (see per-profile errors[] in JSON)`);
  }
  out('');
  const a = report.acceptance;
  out(`unclassified volume: ${a.actualPct}% of ${fmtBytes(report.totals.bytes)} — ${a.pass ? 'PASS' : 'FAIL'} (target < ${a.targetPct}%)`);
  if (report.unclassified.bytes > 0) {
    out('');
    out(`top unclassified patterns (grow config/profile-clean-list.yaml to cover them):`);
    report.topUnknownPatterns.forEach((u, i) => {
      const eg = u.sample ? `  · e.g. ${u.sample.length > 64 ? `${u.sample.slice(0, 61)}...` : u.sample}` : '';
      out(`  ${String(i + 1).padStart(2)}. ${u.pattern.padEnd(46)} ${fmtBytes(u.bytes).padStart(9)}  ${fmtInt(u.files).padStart(7)} files  in ${u.profiles} profile(s)${eg}`);
    });
    if (report.topUnknownExtensions.length) {
      out('');
      out('top unclassified extensions:');
      for (const u of report.topUnknownExtensions.slice(0, 5)) {
        out(`  ${u.pattern.padEnd(20)} ${fmtBytes(u.bytes).padStart(9)}  ${fmtInt(u.files).padStart(7)} files`);
      }
    }
  }
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
  if (opts.inputs.length && (opts.all || opts.profiles.length || opts.scanSecrets)) {
    console.error('error: --in works on saved JSON; live flags (--all/--profile/--scan-secrets) are not combined with it\n');
    return 1;
  }

  let profiles;
  let meta = {};
  try {
    if (opts.inputs.length) {
      ({ profiles } = collectFromInputs(opts.inputs));
      meta.sources = opts.inputs;
    } else {
      const live = collectLive({ ...opts, all: opts.all || !opts.profiles.length });
      profiles = live.profiles;
      meta = { usersRoot: live.usersRoot, cleanList: live.cleanList };
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  if (!profiles.length) {
    console.error('error: no profiles to report on');
    return 1;
  }
  if (opts.inputs.length) {
    const r = profiles[0]?.rules;
    if (r) meta.cleanList = { file: r.file, version: r.version, rules: r.rules ?? r.count };
  }

  const report = aggregate(profiles, opts.top);
  const hasReadErrors = report.readErrors > 0;

  if (opts.jsonToStdout) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (opts.json) {
    const outPath = path.resolve(opts.json);
    const usersRoot = meta.usersRoot ? path.resolve(meta.usersRoot) : null;
    if (usersRoot && (outPath === usersRoot || outPath.startsWith(usersRoot + path.sep))) {
      console.error(`error: --json output must not be written inside the profiles root (${usersRoot})`);
      return 1;
    }
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`wrote ${outPath}\n`);
    printReport(report, opts, meta);
  } else {
    printReport(report, opts, meta);
  }

  if (hasReadErrors) return 2;
  if (opts.strict && !report.acceptance.pass) return 1;
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { SCHEMA, TARGET_PCT, aggregate, collectFromInputs, parseProfileJson, parseArgv };
