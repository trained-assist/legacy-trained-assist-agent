'use strict';
// phases/archive-sessions.cjs — the M2 ARCHIVE phase (epic #1784, issue #1916 PR-B).
//
// The clean list hands this phase every ARCHIVE-class file, and that class is
// INHERITED by a whole subtree — so `filter` is where the real scope lives:
// archive exactly the payload (session bodies under sessions/, Claude transcripts
// under .agent-home/.claude/projects/) and decline everything else that rode
// along: current-session* pointers (admission reads them between runs),
// *.digest.json (regenerable session-digest cache), symlinks, anything whose
// blob key could not be spelled from its path, and the `when: git-repo` working
// copies — those are M3, not this phase.
//
// The mechanics live in src/session-archive.js (shared with the PR-D post-run
// sweep): gzip → upload → download-back + sha check → index marker → unlink.
// Nothing leaves the VM without a confirmed upload; a failure leaves the file
// exactly where it was (the runner appends ARCHIVE_FAILED, verify says the
// profile copy is present, the next run retries).
//
// Ledger: `dest` = the relative blob key (profiles/<p>/…), so isSafeRelPath and
// revert work unchanged; `sha256`/`size` = the local file before gzip — what
// revert re-checks after gunzip.
const path = require('path');
const fs = require('fs');
const { hashPath } = require('../ledger.cjs');
const archive = require('../../../src/session-archive');

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// Built lazily and memoized: dry-run, filter and prepare must run without ADC,
// without a bucket and without network — only apply/verify/revert get here.
let blobStore = null;
function getBlob() {
  if (!blobStore) blobStore = archive.createBlobStore();
  return blobStore;
}

module.exports = {
  name: 'archive-sessions',
  description: 'M2 clean-list ARCHIVE — session bodies + transcripts → GCS blob store (never unlinked without a confirmed upload)',
  actions: ['ARCHIVE'],
  action: 'ARCHIVE',
  failureAction: 'ARCHIVE_FAILED',
  restoredAction: 'RESTORED',
  usesQuarantine: false, // blobs, not quarantine — no pre-flight quarantine dir

  // The phase's item selector (see phases/index.cjs): sync, path-based, no I/O —
  // deciding whether a file is payload must not read every transcript.
  filter(ctx, e) {
    if (!e.isFile || e.isSymlink) return false;
    const rule = ctx.rules && ctx.rules[e.ruleIdx];
    if (rule && rule.when === 'git-repo') return false; // working copies are M3
    const kind = archive.archiveRelKind(e.rel);
    if (kind === 'session') return archive.sessionRelId(e.rel) !== null;
    if (kind === 'transcript') return archive.transcriptRelId(e.rel) !== null;
    return false;
  },

  // READ-ONLY: identity (hashPath, same as every phase) + the blob key. For a
  // transcript the key needs the cwd recorded INSIDE the file (slugCwd(cwd), the
  // key PR-C recomputes for native --resume) — no cwd means no stable key, so
  // refuse instead of inventing one.
  prepare(ctx, item) {
    const abs = path.join(ctx.profileRoot, item.path);
    const h = hashPath(abs);
    const kind = archive.archiveRelKind(item.path);
    let dest;
    if (kind === 'session') {
      dest = archive.sessionArchiveKey(ctx.profile, item.path);
      if (!dest) throw new Error(`cannot build a blob key for ${item.path}`);
    } else if (kind === 'transcript') {
      const cwd = archive.readTranscriptCwd(abs);
      if (!cwd) {
        throw new Error(`no "cwd" in ${item.path} — cannot derive a stable transcript blob key, leaving the file local`);
      }
      dest = archive.transcriptArchiveKey(ctx.profile, item.path, cwd);
    } else {
      throw new Error(`not an archivable path: ${item.path}`);
    }
    return { sha256: h.sha256, size: h.size, dest };
  },

  // Mutates the profile: gzip → upload → confirm by downloading back →
  // (session bodies only) mark `archived` in the index → unlink locally.
  async apply(ctx, item, prepared) {
    const opts = {
      blob: getBlob(),
      profile: ctx.profile,
      profileRoot: ctx.profileRoot,
      relPath: item.path,
      expected: { sha256: prepared.sha256, size: prepared.size },
      expectedKey: prepared.dest,
      log: ctx.log,
    };
    if (archive.archiveRelKind(item.path) === 'session') await archive.archiveSessionBody(opts);
    else await archive.archiveTranscript(opts);
  },

  // Post-state of ONE folded ledger record:
  //   at-dest (ARCHIVE)  local gone + blob intact            → ok
  //                      both copies                        → pending (PR-D sweep)
  //                      local gone + blob missing/corrupt  → fail (lost/corrupt)
  //                      blob missing + local present       → missing-dest
  //   returned (ARCHIVE_FAILED / RESTORED) local present    → ok (retry next run)
  //   purged            not written for this phase (no quarantine copy) → ok
  async verify(ctx, st) {
    if (!st.dest) return { status: 'lost', message: 'no blob key in the record' };
    if (st.state === 'purged') return { status: 'ok', message: 'purged' };

    const abs = path.join(ctx.profileRoot, st.path);
    const local = exists(abs);

    if (st.state !== 'at-dest') {
      if (local) return { status: 'ok', message: 'profile copy present' };
      const remote = await archive.checkArchivedBlob({ blob: getBlob(), key: st.dest, rawSha256: st.sha256 });
      if (remote.status === 'ok') {
        return { status: 'not-restored', message: `profile copy missing while the blob exists: ${st.dest}` };
      }
      if (remote.status === 'error') return { status: 'error', message: remote.message };
      return { status: 'lost', message: 'the file exists in neither the profile nor the blob store' };
    }

    const remote = await archive.checkArchivedBlob({ blob: getBlob(), key: st.dest, rawSha256: st.sha256 });
    if (remote.status === 'error') return { status: 'error', message: remote.message };
    if (remote.status === 'missing') {
      if (local) return { status: 'missing-dest', message: `blob missing while the profile copy exists: ${st.dest}` };
      return { status: 'lost', message: `blob missing and the profile copy is gone: ${st.dest}` };
    }
    if (remote.status === 'corrupt') return { status: 'corrupt', message: remote.message };
    // The blob is intact.
    if (local) return { status: 'pending', message: `both copies exist — the post-run sweep removes the local one: ${st.path}` };
    return { status: 'ok' };
  },

  // Restore one folded record: download → gunzip → sha (and therefore byte-exact)
  // check before a single byte lands in the profile. Refuses (conflict/lost/
  // corrupt) instead of guessing — same posture as phases/delete.cjs.
  async revert(ctx, st) {
    if (st.state !== 'at-dest') return { status: 'skip', reason: `already ${st.state}` };
    if (!st.dest) return { status: 'lost', reason: 'no blob key in the record' };
    const abs = path.join(ctx.profileRoot, st.path);

    const remote = await archive.fetchArchivedBlob({ blob: getBlob(), key: st.dest, rawSha256: st.sha256 });
    if (remote.status === 'missing') return { status: 'lost', reason: `blob not found: ${st.dest}` };
    if (remote.status === 'corrupt') return { status: 'corrupt', reason: `${remote.message} — refusing to restore` };
    if (remote.status === 'error') return { status: 'error', reason: remote.message };

    if (exists(abs)) {
      const localSha = hashPath(abs).sha256;
      if (localSha === st.sha256) return { status: 'already', reason: 'profile copy already in place' };
      return { status: 'conflict', reason: 'profile copy exists with different content — refusing to overwrite it' };
    }
    archive.writeRestoredFile(ctx.profileRoot, st.path, remote.raw);
    return { status: 'restored' };
  },

  // Test seam: hand in a blob store (the injected-bucket shape of PR-A) instead
  // of the environment-derived one. Production code never calls this.
  _setBlobStore(store) {
    blobStore = store;
  },
};
