#!/usr/bin/env node
// cli.mjs — single entry point for the profile-migration phase runner (#1784).
//
//   node scripts/profile-migrate/cli.mjs <phase> --profile <name>|--all
//       [--users-root <path>] [--dry-run|--apply|--verify|--revert] [--json]
//
// READ-ONLY unless --apply or --revert is passed explicitly: the default mode
// is --dry-run and neither --verify nor a bare invocation writes a single byte
// (no lock, no flush, no ledger, no quarantine directory).
//
// Modes
//   --dry-run   (default) report what the phase would do; writes NOTHING
//   --apply     lock → drain → flush → act; every action is ledgered, DELETE
//               files are moved to quarantine (never unlinked)
//   --verify    re-check the post-state against the ledger (read-only)
//   --revert    replay the ledger for this phase in reverse (byte-exact)
//
// Exit codes
//   0  success
//   1  usage / configuration error
//   2  operational failure (apply/verify/revert reported errors)
//   3  refused: the profile maintenance lock was held for --apply/--revert
//
// Politeness: for --apply/--revert the whole run is re-executed under
// `ionice -c3 -n7 nice -n10` when those tools exist (Linux); macOS dev boxes
// only get `nice`, and a platform with neither runs unprefixed — degradation is
// always graceful, never an error.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import runner from './runner.cjs';
import classifier from './classifier.cjs';

const MODE_FLAGS = {
  '--dry-run': 'dry-run',
  '--apply': 'apply',
  '--verify': 'verify',
  '--revert': 'revert',
};

const EXIT = { OK: 0, USAGE: 1, FAILURE: 2, LOCKED: 3 };

const scriptPath = fileURLToPath(import.meta.url);

function usage(phases) {
  const names = phases ? Object.entries(phases).map(([n, p]) => `  ${n.padEnd(10)} ${p.description}`).join('\n') : '';
  return [
    'Usage:',
    '  node scripts/profile-migrate/cli.mjs <phase> --profile <name>|--all [flags]',
    '  node scripts/profile-migrate/cli.mjs --phase <name> --profile <name> [flags]',
    '',
    'Modes (exactly one; default --dry-run):',
    '  --dry-run   report only, writes NOTHING (default)',
    '  --apply     execute the phase (lock → drain → flush → ledger + quarantine)',
    '  --verify    re-check post-state against the ledger (read-only)',
    '  --revert    replay the ledger in reverse for this phase',
    '',
    'Flags:',
    '  --profile <name>       profile to migrate (repeatable)',
    '  --all                  every directory under the users root',
    '  --users-root <dir>     profiles root (default: $USERS_DIR or ~/users)',
    '  --clean-list <file>    rules file (default: config/profile-clean-list.yaml)',
    '  --lock-timeout <ms>    how long --apply/--revert wait for the profile lock (default 30000)',
    '  --drain-timeout <ms>   how long to wait for in-flight runs (default 900000, 0 = skip drain)',
    '  --flush-url <url>      base URL of the agent for POST /internal/flush-profile',
    '  --json                 machine-readable output on stdout (logs stay on stderr)',
    '  -h, --help',
    '',
    'Phases:',
    names,
    '',
    'Exit codes: 0 ok · 1 usage · 2 operational failure · 3 profile lock refused',
    '',
    'READ-ONLY unless --apply or --revert.',
  ].join('\n');
}

function parseArgv(argv) {
  const opts = {
    phase: null,
    positionalPhase: null,
    profiles: [],
    all: false,
    usersRoot: null,
    cleanList: null,
    mode: null,
    json: false,
    lockTimeoutMs: null,
    drainTimeoutMs: null,
    flushUrl: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (Object.hasOwn(MODE_FLAGS, a)) {
      const mode = MODE_FLAGS[a];
      if (opts.mode && opts.mode !== mode) throw new Error(`conflicting modes: --${opts.mode} and ${a}`);
      opts.mode = mode;
      continue;
    }
    switch (a) {
      case '--phase': opts.phase = next(); break;
      case '--profile': opts.profiles.push(next()); break;
      case '--all': opts.all = true; break;
      case '--users-root': opts.usersRoot = next(); break;
      case '--clean-list': opts.cleanList = next(); break;
      case '--lock-timeout': opts.lockTimeoutMs = Number(next()); break;
      case '--drain-timeout': opts.drainTimeoutMs = Number(next()); break;
      case '--flush-url': opts.flushUrl = next(); break;
      case '--json': opts.json = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown argument: ${a}`);
        if (opts.positionalPhase) throw new Error(`unexpected argument: ${a}`);
        opts.positionalPhase = a;
    }
  }
  for (const [k, v] of [['--lock-timeout', opts.lockTimeoutMs], ['--drain-timeout', opts.drainTimeoutMs]]) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`${k} must be a non-negative number`);
  }
  opts.phase = opts.phase || opts.positionalPhase;
  if (opts.phase && opts.positionalPhase && opts.phase !== opts.positionalPhase) {
    throw new Error(`phase given twice and they differ: "${opts.positionalPhase}" vs "${opts.phase}"`);
  }
  opts.mode = opts.mode || 'dry-run';
  return opts;
}

function listProfiles(usersRoot, opts) {
  if (opts.all === (opts.profiles.length > 0)) {
    throw new runner.UsageError('pass exactly one of --profile <name> or --all');
  }
  if (opts.all) {
    const names = classifier.listProfiles(usersRoot);
    if (!names.length) throw new runner.UsageError(`no profiles found under ${usersRoot}`);
    return names;
  }
  return opts.profiles;
}

// Re-exec under ionice/nice for the mutating modes. `PROFILE_MIGRATE_NICED=1`
// marks the prefixed child so this can never loop; if spawning the prefixed
// command fails, the run continues unprefixed instead of failing the migration.
function maybeRenice(argv, mode) {
  if (!runner.MUTATING_MODES.has(mode)) return null;
  if (process.env.PROFILE_MIGRATE_NICED === '1') return null;
  const prefix = runner.buildNicePrefix();
  if (!prefix.length) return null;
  const r = spawnSync(prefix[0], [...prefix.slice(1), process.execPath, scriptPath, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, PROFILE_MIGRATE_NICED: '1' },
  });
  if (r.error) {
    process.stderr.write(`[phase-runner] ${prefix.join(' ')} unavailable (${r.error.message}) — running unprefixed\n`);
    process.env.PROFILE_MIGRATE_NICED = '1';
    return null;
  }
  if (r.signal) return 1;
  return r.status ?? 1;
}

function fmtBytes(n) {
  return classifier.fmtBytes(n);
}

function printProfile(r, opts) {
  const head = [`${r.phase}/${r.mode} ${r.profile}:`];
  const filtered = r.filtered ? `  filtered ${r.filtered} (phase declined)` : '';
  if (r.mode === 'dry-run' || r.mode === 'apply') {
    head.push(`planned ${r.planned} file(s) ${fmtBytes(r.plannedBytes)}`);
    if (r.mode === 'apply') head.push(`applied ${r.applied} failed ${r.failed} pruned ${r.prunedDirs} dir(s)`);
    if (r.unknown) head.push(`UNKNOWN untouched ${r.unknown.files} file(s) ${fmtBytes(r.unknown.bytes)}`);
    if (r.specialSkipped) head.push(`non-regular skipped ${r.specialSkipped}`);
  } else if (r.mode === 'verify' && r.verify) {
    head.push(`ok ${r.verify.ok} recreated ${r.verify.recreated} pending ${r.verify.pendingCount} failures ${r.verify.failures.length}`);
    if (r.verify.pendingArchived && r.verify.pendingArchived.length) head.push(`both-copies ${r.verify.pendingArchived.length}`);
    if (r.verify.skippedLines) head.push(`torn lines skipped ${r.verify.skippedLines}`);
  } else if (r.mode === 'revert' && r.revert) {
    head.push(`restored ${r.revert.restored} already ${r.revert.already} skipped ${r.revert.skipped} failures ${r.revert.failures.length}`);
  }
  if (r.lock) head.push(r.lock.refused ? 'LOCK REFUSED' : 'locked');
  if (r.flush) head.push(r.flush.skipped ? 'flush: no server' : r.flush.ok ? `flushed ${r.flush.flushed}` : 'flush FAILED');
  process.stdout.write(`${head.join('  ')}${filtered}\n`);

  const limit = 10;
  if (r.credentials) {
    // Inventory phase (credentials-reachability): names and sources, never values.
    for (const c of r.credentials) {
      process.stdout.write(`  ${c.reachable ? 'reachable  ' : 'UNREACHABLE'} ${c.name} (${c.consumer}, ${c.scope})${c.source ? ` ← ${c.source}` : ''}\n`);
    }
    for (const f of (r.verify ? r.verify.failures : [])) process.stdout.write(`  FAIL ${f.path} [${f.state}/${f.status}]: ${f.message}\n`);
  } else if (r.mode === 'dry-run') {
    for (const it of r.items.slice(0, limit)) {
      process.stdout.write(`  ${it.action} ${it.path}  ${fmtBytes(it.size)}${it.reason ? `  (${it.reason})` : ''}\n`);
    }
    if (r.items.length > limit) process.stdout.write(`  … ${r.items.length - limit} more (use --json for the full list)\n`);
  } else if (r.mode === 'apply') {
    const failed = r.items.filter(i => i.status === 'failed');
    for (const it of failed.slice(0, limit)) process.stdout.write(`  FAILED ${it.path}: ${it.error}\n`);
    if (failed.length > limit) process.stdout.write(`  … ${failed.length - limit} more failures\n`);
    if (r.applied) {
      process.stdout.write(`  ledger ${r.ledgerFile}\n`);
      if (r.quarantineRoot) process.stdout.write(`  quarantine ${r.quarantineRoot}\n`);
    }
  } else if (r.mode === 'verify' && r.verify) {
    for (const f of r.verify.failures.slice(0, limit)) process.stdout.write(`  FAIL ${f.path} [${f.state}/${f.status}]: ${f.message}\n`);
    for (const p of (r.verify.pendingArchived || []).slice(0, limit)) {
      process.stdout.write(`  BOTH-COPIES ${p.path}: ${p.message}\n`);
    }
    if (r.verify.pendingCount) {
      process.stdout.write(`  pending ${r.verify.pendingCount} planned file(s) with no ledger record (first ${Math.min(limit, r.verify.pending.length)}):\n`);
      for (const p of r.verify.pending.slice(0, limit)) process.stdout.write(`    ${p.path}\n`);
    }
  } else if (r.mode === 'revert' && r.revert) {
    for (const f of r.revert.failures.slice(0, limit)) process.stdout.write(`  FAIL ${f.path} [${f.status}]: ${f.reason}\n`);
    if (r.revert.failures.length > limit) process.stdout.write(`  … ${r.revert.failures.length - limit} more failures\n`);
  }

  // EXCLUDE (#1923): counted in classSummary (r.stats) but planned by no phase —
  // spelled out so a dry-run/apply report cannot be read as "nothing secret here".
  const excluded = r.stats && r.stats.EXCLUDE;
  if (excluded && (excluded.files || excluded.bytes)) {
    process.stdout.write(`  EXCLUDE ${excluded.files} secret file(s) ${fmtBytes(excluded.bytes)} — local only, never in the git image\n`);
  }

  for (const e of r.errors) process.stderr.write(`  error [${r.profile}]: ${e}\n`);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n`);
    process.stderr.write(`${usage(null)}\n`);
    return EXIT.USAGE;
  }

  let phases = null;
  try {
    phases = runner.loadPhases();
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  if (opts.help || !opts.phase) {
    process.stdout.write(`${usage(phases)}\n`);
    return opts.help ? EXIT.OK : EXIT.USAGE;
  }

  const usersRoot = opts.usersRoot ? path.resolve(opts.usersRoot) : runner.defaultUsersRoot();
  let profiles;
  try {
    profiles = listProfiles(usersRoot, opts);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const prefixed = maybeRenice(argv, opts.mode);
  if (prefixed !== null) return prefixed;

  const batchArgs = {
    phase: opts.phase,
    mode: opts.mode,
    profiles,
    usersRoot,
    cleanList: opts.cleanList,
    lockTimeoutMs: opts.lockTimeoutMs,
    drainTimeoutMs: opts.drainTimeoutMs,
    flushUrl: opts.flushUrl,
  };

  let summary;
  try {
    if (opts.json) {
      // Foreign stdout writers (src/profile-lock.js logs via console.log) would
      // corrupt a machine-readable payload — reroute everything written while
      // the run is in flight to stderr, then print the summary to the real
      // stdout. Restored in `finally` so a throw cannot leave stdout hijacked.
      const realWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => process.stderr.write(chunk, ...args);
      try {
        summary = await runner.runBatch({ ...batchArgs });
      } finally {
        process.stdout.write = realWrite;
      }
    } else {
      summary = await runner.runBatch({ ...batchArgs });
    }
  } catch (e) {
    if (e instanceof runner.UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    process.stderr.write(`error: ${e.message}\n`);
    return EXIT.FAILURE;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const r of summary.profiles) printProfile(r, opts);
    if (summary.profiles.length > 1) {
      process.stdout.write(`${summary.profiles.length} profile(s): ${summary.errorCount} error(s), ${summary.lockRefused} lock refusal(s)\n`);
    }
  }

  if (summary.errorCount > 0) return EXIT.FAILURE;
  if (summary.lockRefused > 0) return EXIT.LOCKED;
  return EXIT.OK;
}

process.exitCode = await main(process.argv.slice(2));
