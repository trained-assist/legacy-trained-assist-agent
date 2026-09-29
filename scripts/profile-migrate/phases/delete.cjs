'use strict';
// phases/delete.cjs — the concrete M1 phase (#1784): every file the clean list
// marks DELETE (regenerable: node_modules, caches, logs, scrape html, …) is
// MOVED to quarantine. Nothing is ever unlinked here — irreversible destruction
// is the separate manual purge in quarantine.cjs, after the grace period.
//
// UNKNOWN / KEEP / SYSTEM / … never reach this phase: the runner only hands it
// items whose classified action is in `actions` (epic principle 2 — «неизвестное
// не удаляется»), and an ancestor directory that is itself UNKNOWN is never
// pruned even when it has been emptied.
const path = require('path');
const fs = require('fs');
const { hashPath } = require('../ledger.cjs');
const quarantine = require('../quarantine.cjs');

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

module.exports = {
  name: 'delete',
  description: 'M1 clean-list DELETE — regenerable files → quarantine (never unlinked)',
  actions: ['DELETE'],
  action: 'DELETE',
  failureAction: 'DELETE_FAILED',
  restoredAction: 'RESTORED',

  // READ-ONLY: identify the file and reserve its quarantine destination.
  // Runs before the ledger append (crash order: record first, action second).
  prepare(ctx, item) {
    const abs = path.join(ctx.profileRoot, item.path);
    const h = hashPath(abs); // throws if it vanished or is not a hashable file
    const dest = quarantine.reserveDest(ctx.profile, item.path);
    return { sha256: h.sha256, size: h.size, dest };
  },

  // Mutates the profile: rename into quarantine (cross-device = copy + verify +
  // unlink) and double-check the destination hash against the recorded one.
  apply(ctx, item, prepared) {
    const abs = path.join(ctx.profileRoot, item.path);
    quarantine.moveInto(ctx.profile, abs, prepared.dest, prepared.sha256);
    const got = hashPath(quarantine.quarantinePath(ctx.profile, prepared.dest));
    if (got.sha256 !== prepared.sha256) {
      throw new Error(`quarantine copy sha256 mismatch: ${prepared.dest}`);
    }
  },

  // Post-state of ONE folded ledger record.
  //   at-dest   → the quarantine copy must exist and hash to the record; the
  //               profile copy must be gone (`recreated` = it came back, e.g.
  //               npm ci reinstalled node_modules — quarantine is intact)
  //   returned  → the profile copy must exist. Its content is NOT re-hashed:
  //               the profile is live again and may legitimately have changed
  //               since the restore (byte-exactness was checked at restore time)
  //   purged    → the quarantine copy must be gone (a purge never touches the
  //               profile copy)
  verify(ctx, st) {
    const abs = path.join(ctx.profileRoot, st.path);
    const destAbs = st.dest ? quarantine.quarantinePath(ctx.profile, st.dest) : null;
    const destExists = destAbs ? exists(destAbs) : false;
    const pathExists = exists(abs);

    if (st.state === 'purged') {
      if (destExists) return { status: 'not-purged', message: `quarantine copy still exists after PURGE: ${st.dest}` };
      return { status: 'ok', message: 'purged' };
    }

    if (st.state === 'at-dest') {
      if (!destExists) {
        if (pathExists) return { status: 'missing-dest', message: 'quarantine copy missing while the profile copy exists (apply never completed?)' };
        return { status: 'lost', message: 'the file exists in neither the profile nor quarantine' };
      }
      const dh = hashPath(destAbs);
      if (dh.sha256 !== st.sha256) return { status: 'corrupt', message: `quarantine copy sha256 mismatch: ${st.dest}` };
      if (pathExists) return { status: 'recreated', message: 'profile copy regenerated after apply (quarantine intact)' };
      return { status: 'ok' };
    }

    // returned
    if (!pathExists) {
      if (destExists && st.sha256 && hashPath(destAbs).sha256 === st.sha256) {
        return { status: 'not-restored', message: `profile copy missing while the quarantine copy exists: ${st.dest}` };
      }
      return { status: 'lost', message: 'the file exists in neither the profile nor quarantine' };
    }
    return { status: 'ok', message: 'restored' };
  },

  // Restore one folded record. Refuses (conflict/lost/corrupt) instead of
  // guessing: byte-exact beats best-effort, and the operator decides.
  revert(ctx, st) {
    if (st.state !== 'at-dest') return { status: 'skip', reason: `already ${st.state}` };
    const abs = path.join(ctx.profileRoot, st.path);
    const destAbs = st.dest ? quarantine.quarantinePath(ctx.profile, st.dest) : null;

    if (!destAbs || !exists(destAbs)) {
      if (exists(abs)) {
        if (hashPath(abs).sha256 === st.sha256) return { status: 'already', reason: 'profile copy already in place' };
        return { status: 'conflict', reason: 'profile copy exists with different content and the quarantine copy is gone' };
      }
      return { status: 'lost', reason: 'the file exists in neither the profile nor quarantine' };
    }
    if (hashPath(destAbs).sha256 !== st.sha256) {
      return { status: 'corrupt', reason: `quarantine copy sha256 mismatch: ${st.dest} — refusing to restore` };
    }
    if (exists(abs)) {
      if (hashPath(abs).sha256 === st.sha256) return { status: 'already', reason: 'both copies are identical' };
      return { status: 'conflict', reason: 'profile copy exists with different content — refusing to overwrite it' };
    }
    quarantine.restoreFromQuarantine(ctx.profile, st.dest, abs, st.sha256);
    return { status: 'restored' };
  },
};
