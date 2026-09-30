'use strict';
// phases/index.cjs — phase registry for the profile-migration runner (#1784).
//
// A phase is a SMALL self-contained module in this directory that declares
// which clean-list action classes it owns and what applying one item does to
// the filesystem. Phases register themselves by existing: `loadPhases()` picks
// up every `*.cjs` here (except this file), so M3–M5 (MOVE / DEDUP …)
// wire in later PRs by dropping a file in — no edit to the runner.
//
// Phase contract (all four functions are required; all four MAY be async — the
// runner awaits them, an archive is a blob upload):
//   actions: string[]                 clean-list classes this phase plans for
//   action:  string                   ledger action written by a successful apply
//   failureAction/restoredAction?: string   ledger actions for the compensating
//                                     record / the post-revert record
//   usesQuarantine?: false            skip the quarantine-root pre-flight mkdir
//                                     (a phase that archives to a blob store
//                                     never needs the dir — see archive-sessions)
//   filter(ctx, entry) -> boolean     OPTIONAL item selector. The clean-list
//                                     class is inherited by a whole subtree, so
//                                     class alone is not the plan: ARCHIVE hands
//                                     the phase its pointers, digest caches and
//                                     git working copies too, and the phase
//                                     declines them itself (declined entries are
//                                     counted `filtered`, never planned).
//   prepare(ctx, item) -> {sha256, size, dest}   READ-ONLY: hash + reserve the
//                                     destination. Runs before the ledger
//                                     append, so a record is never written for
//                                     a file that cannot be identified. For
//                                     ARCHIVE `dest` is the relative blob key
//                                     (isSafeRelPath contract unchanged).
//   apply(ctx, item, prepared)        perform the action (mutates the profile)
//   verify(ctx, st) -> {status, message?}   post-state check for one FOLDED
//                                     ledger record (status: ok | recreated |
//                                     pending | <failure>) — `pending` = both
//                                     copies exist (remote is good, the local
//                                     one is not removed yet): reported, never
//                                     a failure, the sweep finishes it.
//   revert(ctx, st) -> {status, reason?}     restore one folded record
//                                     (status: restored | already | skip |
//                                     conflict | lost | corrupt)
//
// Inventory phases (`inventory: true`, e.g. credentials-reachability) touch no
// file of the profile: they skip the clean-list plan and implement instead
//   scan(ctx)  -> items[]             READ-ONLY report (dry-run)
//   record(ctx, items)                apply: append the baseline to the ledger
//   check(ctx, items, folded) -> failures[]   verify: current state vs baseline
// --revert for them is a no-op (there is nothing to put back).
//
// ctx = { profile, profileRoot, quarantineRoot, rules, mode, log }.
// st  = { path, sha256, size, dest, state, action, index } — the last record for
// that (phase, path) after folding (see ledger.recordState).
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FUNCTIONS = ['prepare', 'apply', 'verify', 'revert'];
const INVENTORY_FUNCTIONS = ['scan', 'record', 'check'];

function validatePhase(mod, file) {
  const where = (msg) => new Error(`phase module ${path.basename(file)}: ${msg}`);
  if (!mod || typeof mod !== 'object') throw where('module.exports must be the phase object');
  if (typeof mod.name !== 'string' || !NAME_RE.test(mod.name)) {
    throw where(`"name" must match ${NAME_RE} (got ${JSON.stringify(mod.name)})`);
  }
  if (mod.inventory === true) {
    // Inventory phase: moves nothing, reports and ledgers a per-profile fact.
    for (const fn of INVENTORY_FUNCTIONS) {
      if (typeof mod[fn] !== 'function') throw where(`inventory phase is missing required function ${fn}()`);
    }
    return mod;
  }
  if (!Array.isArray(mod.actions) || !mod.actions.length || mod.actions.some(a => typeof a !== 'string' || !a)) {
    throw where('"actions" must be a non-empty array of class names');
  }
  if (typeof mod.action !== 'string' || !mod.action) throw where('"action" (the ledger action of a successful apply) is required');
  for (const fn of FUNCTIONS) {
    if (typeof mod[fn] !== 'function') throw where(`missing required function ${fn}()`);
  }
  return mod;
}

function loadPhases(dir = __dirname) {
  const phases = {};
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.cjs') && f !== 'index.cjs').sort();
  for (const f of files) {
    const file = path.join(dir, f);
    const mod = validatePhase(require(file), file);
    if (phases[mod.name]) throw new Error(`duplicate phase name "${mod.name}" (${f} and ${phases[mod.name].__file})`);
    Object.defineProperty(mod, '__file', { value: f, enumerable: false });
    phases[mod.name] = mod;
  }
  if (!Object.keys(phases).length) throw new Error(`no phase modules found in ${dir}`);
  return phases;
}

module.exports = { loadPhases, validatePhase, FUNCTIONS, INVENTORY_FUNCTIONS };
