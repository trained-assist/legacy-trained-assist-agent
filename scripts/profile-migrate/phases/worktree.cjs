'use strict';
// phases/worktree.cjs — M3 «Рабочие копии кода» (epic #1784; epic #87 D1).
//
// The clean list classifies everything inside a git working copy as ARCHIVE
// under the `when: git-repo` rule and says what happens next is M3's call:
// «clean → DELETE, dirty → archive bundle». This phase IS that call, made once
// per working copy (the unit is a copy, not a file — hence the plan() hook):
//
//   CLEAN — no uncommitted/untracked changes AND every commit pushed
//   (#1784 «чистая копия … всё запушено»): every file the clean list hands this
//   phase MOVES into quarantine, byte-for-byte like phases/delete.cjs — a
//   ledger DELETE record per file, --revert restores it, destruction stays the
//   manual grace-period purge in quarantine.cjs. The copy itself is re-creatable
//   from its remote (M8 recreates worktrees from remotes).
//
//   DIRTY — changes, untracked files or unpushed commits (#1784 «незакоммиченная
//   / незапушенная копия не дропается»): ONE archive per copy goes to the GCS
//   blob store (src/session-blob-store.js, same ADC/no-keys-on-disk story as
//   M2), containing:
//     manifest.json    every OWNED file — path, sha256, size, mode, type. The
//                      completeness contract: verify and revert judge the state
//                      of the world against it, never against a re-scan.
//     worktree.bundle  `git bundle create --all HEAD` — refs + objects, so the
//                      archive restores with NO network and NO remote.
//     worktree.patch   `git diff --binary HEAD` — the uncommitted delta.
//     payload/         the owned files git cannot reproduce: all of .git
//                      (config, index, refs, loose objects), untracked and
//                      gitignored files. node_modules / reflogs (DELETE),
//                      secrets (EXCLUDE), session bodies (M2) are other
//                      classes and never reach this payload.
//
//   Deletion happens ONLY AFTER PROOF, in this order (record-before-action is
//   the runner's contract; these are the phase's own gates):
//     1. upload the gzipped tar, then download it back and check the sha256 of
//        the stored bytes against the ledger record («ничего не удаляется без
//        подтверждённой загрузки»);
//     2. rebuild the archive in a TEMP CLONE: extract → clone the bundle →
//        checkout the recorded HEAD → overlay payload → apply the patch →
//        every manifest entry must exist with the same sha256 AND mode
//        (эпик: «дерево совпадает с исходным по хешам»);
//     3. only now re-hash every live file against the manifest (bytes may not
//        change between prepare and delete) and remove exactly the manifest's
//        files, pruning the directories THEY emptied — up to and including the
//        copy's root, never an ancestor above it, and only while empty
//        (principle 2: an unknown file that is not ours stays; leftovers of
//        other classes keep the root alive, the next phase cleans them).
//   Any gate throwing → the runner appends ARCHIVE_FAILED, the fold lands on
//   `returned`, nothing is removed and the next run retries (epic acceptance:
//   «при несовпадении — копия цела, алерт»).
//
// Ownership: only files whose classified action is ARCHIVE under the
// `when: git-repo` rule are planned — DELETE/EXCLUDE/SYSTEM/M2-ARCHIVE files
// inside the copy belong to their own phases and are never touched here.
// A copy whose state git cannot determine (a fake .git, a corrupt repo) is
// DECLINED, not guessed (principle 2) — counted `filtered` and logged.
//
// Ledger: `path` of a DIRTY record ends with `/` (`workspace/repo/`) — that is
// the marker that tells verify/revert apart from the per-file quarantine
// records this same phase writes (both use RESTORED after --revert). `dest` is
// the blob key `profiles/<p>/worktrees/<slug>.tar.gz` (key segments are
// sanitized deterministically, see worktreeKey); `sha256`/`size` describe the
// tar BEFORE gzip — the same convention as archive-sessions.
//
// Enabled nowhere by default (issue #87 D1): the CLI defaults to --dry-run,
// nothing in systemd/timer invokes this phase, and --apply must be typed by an
// operator. dry-run runs `git status --no-optional-locks` per copy — it writes
// nothing, not even an index refresh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { hashPath, sha256File, sha256String, isSafeRelPath } = require('../ledger.cjs');
const quarantine = require('../quarantine.cjs');
const archive = require('../../../src/session-archive');
const deletePhase = require('./delete.cjs');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// A `git diff --binary` of a very large dirty copy can be big; below this the
// spawn fails loudly (prepare throws → no ledger record → nothing touched).
const MAX_GIT_BUFFER = 1024 * 1024 * 1024;
const MANIFEST_VERSION = 1;

// A problem with the ARCHIVE itself (extract, manifest, reconstruction) —
// verify/revert report it as `corrupt`, never as a crash. Anything else thrown
// here is an infrastructure failure and surfaces as `error`.
class ArchiveProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// ── git ───────────────────────────────────────────────────────────────────────
// GIT_OPTIONAL_LOCKS=0 everywhere: a plan/verify must not rewrite a repo's
// index stat cache («dry-run writes NOTHING» includes .git/index bytes).
// Buffer stdout: porcelain/ls-files/diff of a 155k-file copy outgrow spawnSync's
// default 1 MiB. `allowFail` is for probes (an unborn HEAD is not an error).
function git(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    const tail = (r.stderr ? r.stderr.toString('utf8') : '').trim().split('\n').filter(Boolean).slice(-3).join('; ');
    throw new Error(`git ${args.join(' ')} exited ${r.status}${tail ? `: ${tail}` : ''}`);
  }
  return r.stdout;
}

// Is this copy clean enough to simply drop (into quarantine)? #1784: no
// uncommitted state AND everything pushed. A repo without a remote or with
// local-only commits is DIRTY — its history is not recoverable from anywhere
// else, which is exactly what the bundle is for.
function inspectWorktree(rootAbs) {
  const status = git(['status', '--porcelain'], rootAbs);
  if (status.length) return { clean: false, reason: 'uncommitted or untracked changes' };
  const head = git(['rev-parse', '--verify', 'HEAD'], rootAbs, { allowFail: true });
  if (head) {
    // `--all HEAD --not --remotes`: every local ref AND the (possibly
    // detached) HEAD, minus anything a remote already has. Unborn HEAD → no
    // commits to lose → nothing to compare.
    const unpushed = git(['rev-list', '--count', '--all', 'HEAD', '--not', '--remotes'], rootAbs)
      .toString('utf8').trim();
    if (unpushed !== '0') return { clean: false, reason: `${unpushed} unpushed commit(s)` };
    return { clean: true, head: head.toString('utf8').trim() };
  }
  return { clean: true, head: null };
}

// ── blob key ──────────────────────────────────────────────────────────────────
// profiles/<profile>/worktrees/<sanitized root>.tar.gz — one key per copy, a
// directory-shaped key (GCS has no real directories, they are just bytes in the
// name). Every path segment that is not [A-Za-z0-9._-] is collapsed and gets a
// deterministic hash suffix, so two roots that sanitize alike still land on
// distinct keys and the key is always within session-blob-store's assertSafeKey.
function worktreeKey(profile, rootRel) {
  const seg = rootRel.split('/').map((s) => {
    const clean = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean || clean === '.' || clean === '..') return `r-${sha256String(s).slice(0, 12)}`;
    return clean === s ? clean : `${clean}-${sha256String(s).slice(0, 10)}`;
  }).join('/');
  return `profiles/${profile}/worktrees/${seg}.tar.gz`;
}

// ── archive building (prepare) ────────────────────────────────────────────────
// Manifest for one copy: identity of every owned file as it sits on disk right
// now. Runs under the profile lock (the runner took it before doApply), so the
// only writer that could race us is outside the agent.
function buildManifest(rootAbs, files) {
  const entries = [];
  for (const f of files) {
    const rel = f.path.slice(f.rootLen); // profile-relative → copy-relative
    const abs = path.join(rootAbs, rel);
    const h = hashPath(abs); // throws if the file vanished — honest failure
    const st = fs.lstatSync(abs);
    entries.push({
      path: rel,
      type: h.isSymlink ? 'symlink' : 'file',
      sha256: h.sha256,
      size: h.size,
      mode: st.mode & 0o777,
      ...(h.isSymlink ? { target: fs.readlinkSync(abs) } : {}),
    });
  }
  return entries;
}

// Which owned files the bundle+patch will reproduce: everything git tracks in
// HEAD or in the index. The rest (.git internals, untracked, gitignored) goes
// to payload/. An unborn HEAD reproduces nothing → everything is payload.
function coveredByGit(rootAbs, hasHead) {
  if (!hasHead) return new Set();
  const head = git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], rootAbs).toString('utf8');
  const index = git(['ls-files', '-z'], rootAbs).toString('utf8');
  return new Set([...head.split('\0'), ...index.split('\0')].filter(Boolean));
}

// Stage everything the archive needs under one temp root:
//   <work>/stage/manifest.json|worktree.bundle|worktree.patch|payload/…
//   <work>/archive.tar          (created by tar from stage/)
// The runner only reads {sha256, size, dest} off the result; manifest and the
// temp path ride along for apply (they are not ledger fields).
function stageArchive(ctx, item) {
  const rootAbs = path.join(ctx.profileRoot, item.root);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-worktree-'));
  try {
    const stage = path.join(work, 'stage');
    fs.mkdirSync(path.join(stage, 'payload'), { recursive: true });

    const headProbe = git(['rev-parse', '--verify', 'HEAD'], rootAbs, { allowFail: true });
    const head = headProbe ? headProbe.toString('utf8').trim() : null;
    const manifest = buildManifest(rootAbs, item.files);
    const covered = coveredByGit(rootAbs, head !== null);
    for (const e of manifest) e.covered = covered.has(e.path) ? 'git' : 'payload';

    if (head !== null) {
      git(['bundle', 'create', path.join(work, 'worktree.bundle'), '--all', 'HEAD'], rootAbs);
      const patch = git(['diff', '--binary', 'HEAD'], rootAbs);
      fs.renameSync(path.join(work, 'worktree.bundle'), path.join(stage, 'worktree.bundle'));
      if (patch && patch.length) {
        fs.writeFileSync(path.join(work, 'worktree.patch'), patch);
        fs.renameSync(path.join(work, 'worktree.patch'), path.join(stage, 'worktree.patch'));
      }
    }

    for (const e of manifest) {
      if (e.covered === 'git') continue;
      const src = path.join(rootAbs, e.path);
      const dst = path.join(stage, 'payload', e.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (e.type === 'symlink') fs.symlinkSync(e.target, dst);
      else {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, e.mode);
      }
      // The bytes that were staged must be the bytes the manifest describes.
      const got = e.type === 'symlink' ? sha256String(fs.readlinkSync(dst)) : sha256File(dst);
      if (got !== e.sha256) {
        throw new Error(`${e.path} changed while it was being archived — refusing to build an archive the ledger does not describe`);
      }
    }

    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify({
      version: MANIFEST_VERSION,
      root: item.root,
      head,
      createdAt: new Date().toISOString(),
      files: manifest,
    }, null, 1)}\n`);

    const tarPath = path.join(work, 'archive.tar');
    const r = spawnSync('tar', ['-cf', tarPath, '-C', stage, '.'], { encoding: 'utf8', maxBuffer: 1 << 20 });
    if (r.error) throw new Error(`tar: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tar create failed: ${(r.stderr || '').trim()}`);

    return { work, manifest, sha256: sha256File(tarPath), size: fs.statSync(tarPath).size };
  } catch (e) {
    // Nothing was written outside os.tmpdir — a failed prepare must not leave
    // staging junk behind (the runner has no record yet to hang a cleanup on).
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
}

// ── archive reconstruction (apply gate / verify / revert) ─────────────────────
function extractArchive(rawTar, work) {
  const dir = path.join(work, 'extract');
  fs.mkdirSync(dir, { recursive: true });
  const tarPath = path.join(work, 'archive.tar');
  fs.writeFileSync(tarPath, rawTar);
  const r = spawnSync('tar', ['-xf', tarPath, '-C', dir], { encoding: 'utf8', maxBuffer: 1 << 20 });
  if (r.error) throw new ArchiveProblem('corrupt', `tar extract: ${r.error.message}`);
  if (r.status !== 0) throw new ArchiveProblem('corrupt', `archive does not extract: ${(r.stderr || '').trim()}`);
  const mf = path.join(dir, 'manifest.json');
  if (!exists(mf)) throw new ArchiveProblem('corrupt', 'manifest.json missing from the archive');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (e) {
    throw new ArchiveProblem('corrupt', `manifest.json is not valid JSON: ${e.message}`);
  }
  if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.files)) {
    throw new ArchiveProblem('corrupt', 'manifest.json has an unexpected shape');
  }
  return { dir, manifest };
}

function copyTree(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      if (exists(d)) fs.rmSync(d, { recursive: true, force: true });
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      if (exists(d)) {
        const st = fs.lstatSync(d);
        if (st.isDirectory()) fs.rmSync(d, { recursive: true, force: true });
      }
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.lstatSync(s).mode & 0o777);
    }
  }
}

// Rebuild the working copy from the archive alone — the «проверка во временном
// клоне» of #87/#1784. Throws ArchiveProblem('corrupt') on any mismatch; a
// caller that has not deleted anything yet simply aborts with the copy intact.
function reconstruct(dir, manifest, work) {
  const recon = path.join(work, 'recon');
  fs.mkdirSync(recon, { recursive: true });

  if (manifest.head) {
    const bundle = path.join(dir, 'worktree.bundle');
    if (!exists(bundle)) throw new ArchiveProblem('corrupt', 'the manifest records a HEAD but the bundle is missing');
    const clone = spawnSync('git', ['clone', '-q', bundle, recon], {
      encoding: 'utf8', maxBuffer: 1 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (clone.error) throw new ArchiveProblem('corrupt', `git clone: ${clone.error.message}`);
    if (clone.status !== 0) throw new ArchiveProblem('corrupt', `the bundle does not clone: ${(clone.stderr || '').trim()}`);
    // Pin the exact tree the manifest was taken from (the clone may have
    // checked out whatever the bundle's HEAD resolves to).
    const co = spawnSync('git', ['-C', recon, 'checkout', '-q', '--force', manifest.head], {
      encoding: 'utf8', maxBuffer: 1 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    if (co.status !== 0) throw new ArchiveProblem('corrupt', `checkout ${manifest.head}: ${(co.stderr || '').trim()}`);
  }

  // payload first: the reconstruction then carries the ORIGINAL .git (config,
  // index, objects) while the patch still applies to the checked-out tree.
  const payload = path.join(dir, 'payload');
  if (exists(payload)) copyTree(payload, recon);

  const patch = path.join(dir, 'worktree.patch');
  if (exists(patch)) {
    const ap = spawnSync('git', ['-C', recon, 'apply', '--whitespace=nowarn', patch], {
      encoding: 'utf8', maxBuffer: 1 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    if (ap.status !== 0) throw new ArchiveProblem('corrupt', `worktree.patch does not apply: ${(ap.stderr || ap.stdout || '').trim()}`);
  }

  for (const e of manifest.files) {
    if (typeof e.path !== 'string' || !isSafeRelPath(e.path)) {
      throw new ArchiveProblem('corrupt', `unsafe path in manifest: ${JSON.stringify(e.path)}`);
    }
    const abs = path.join(recon, e.path);
    let st;
    try { st = fs.lstatSync(abs); } catch {
      throw new ArchiveProblem('corrupt', `the reconstruction is missing ${e.path}`);
    }
    if (e.type === 'symlink') {
      if (!st.isSymbolicLink()) throw new ArchiveProblem('corrupt', `${e.path} is not a symlink in the reconstruction`);
      if (fs.readlinkSync(abs) !== e.target) throw new ArchiveProblem('corrupt', `${e.path} points elsewhere in the reconstruction`);
    } else {
      if (!st.isFile()) throw new ArchiveProblem('corrupt', `${e.path} is not a regular file in the reconstruction`);
      if ((st.mode & 0o777) !== e.mode) throw new ArchiveProblem('corrupt', `${e.path} mode mismatch (${(st.mode & 0o777).toString(8)} ≠ ${e.mode.toString(8)})`);
      if (sha256File(abs) !== e.sha256) throw new ArchiveProblem('corrupt', `${e.path} sha256 mismatch in the reconstruction`);
    }
  }
  return recon;
}

// Download → extract → rebuild → hash-check. The single proof used by apply
// (before anything is deleted) and by revert (before anything is written back).
async function rebuildFromBlob(key, rawSha256) {
  const remote = await archive.fetchArchivedBlob({ blob: getBlob(), key, rawSha256 });
  if (remote.status === 'missing') throw new ArchiveProblem('lost', `blob not found: ${key}`);
  if (remote.status === 'corrupt') throw new ArchiveProblem('corrupt', remote.message);
  if (remote.status === 'error') throw new Error(remote.message); // infrastructure, not data
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-worktree-verify-'));
  try {
    const { dir, manifest } = extractArchive(remote.raw, work);
    const recon = reconstruct(dir, manifest, work);
    return { work, dir, manifest, recon };
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

// ── deletion of exactly what the manifest describes ──────────────────────────
function removeOwned(rootAbs, manifest) {
  // Pass 1: read-only. The bytes about to be deleted must still be the bytes
  // the manifest archived — checked for EVERY entry before the first unlink,
  // so a single changed file can never leave a half-removed copy.
  for (const e of manifest.files) {
    if (typeof e.path !== 'string' || !isSafeRelPath(e.path)) {
      throw new Error(`unsafe path in manifest: ${JSON.stringify(e.path)}`);
    }
    const abs = path.join(rootAbs, e.path);
    let st;
    try { st = fs.lstatSync(abs); } catch (err) {
      throw new Error(`${e.path} vanished while the archive was being confirmed (${err.message}) — nothing removed, the next run re-plans`);
    }
    if (e.type === 'symlink') {
      if (!st.isSymbolicLink() || fs.readlinkSync(abs) !== e.target) {
        throw new Error(`${e.path} changed since it was archived — refusing to delete it`);
      }
    } else if (!st.isFile() || sha256File(abs) !== e.sha256) {
      throw new Error(`${e.path} changed since it was archived — refusing to delete it`);
    }
  }

  // Pass 2: unlink, then prune every directory the removal emptied — deepest
  // first, only while empty (rmdir cannot remove anything else), never above
  // the copy's own root (an UNKNOWN ancestor above it is not ours to remove;
  // a dir holding other classes' files stays non-empty and stops the climb).
  // The whole subtree is walked because a dir that NEVER held an owned file
  // (`.git/refs/heads/` of an unborn repo) has no ancestor to be pruned from.
  for (const e of manifest.files) {
    fs.unlinkSync(path.join(rootAbs, e.path));
  }
  const dirs = [];
  const walkDirs = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(d, e.name);
      dirs.push(abs);
      walkDirs(abs);
    }
  };
  walkDirs(rootAbs);
  dirs.push(rootAbs);
  dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || b.localeCompare(a));
  for (const d of dirs) {
    try { fs.rmdirSync(d); } catch { /* not empty / gone — keep it */ }
  }
}

// ── record dispatch ───────────────────────────────────────────────────────────
// A DIRTY (bundle) record's path ends with '/', a per-file quarantine record's
// never can (it is a real profile-relative file path).
function isBundleRecord(st) {
  return typeof st.path === 'string' && st.path.endsWith('/');
}

function rootRelOf(st) {
  return st.path.replace(/\/+$/, '');
}

// Lazy: dry-run/filter/plan must run without ADC, without a bucket, without
// network — only apply/verify/revert get here (same rule as archive-sessions).
let blobStore = null;
function getBlob() {
  if (!blobStore) blobStore = archive.createBlobStore();
  return blobStore;
}

module.exports = {
  name: 'worktree',
  description: 'M3 git working copies — clean → quarantine (DELETE), dirty → bundle+diff to GCS, rebuild-verified in a temp clone, then removed',
  actions: ['ARCHIVE'],
  action: 'ARCHIVE',
  restoredAction: 'RESTORED',
  // quarantine IS used (the clean path); the dirty path uses blobs and simply
  // does not care that the runner pre-creates the quarantine root.

  // Only the `when: git-repo` rule's own class — the same predicate
  // archive-sessions uses to decline working copies (M2 keeps its payload,
  // M3 takes the copy).
  filter(ctx, e) {
    if (!ctx || !Array.isArray(ctx.rules)) return false;
    if (ctx.__gitRuleIdx === undefined) ctx.__gitRuleIdx = ctx.rules.findIndex(r => r && r.when === 'git-repo');
    return ctx.__gitRuleIdx >= 0 && e.ruleIdx === ctx.__gitRuleIdx;
  },

  // Self-planning (phases/index.cjs): group the classified files by their
  // working-copy root and ask git once per copy which side of M3 it is on.
  // Synchronous by contract. Returns {items, filtered}: items are the
  // per-file quarantine plan for a clean copy and ONE record for a dirty one;
  // filtered = owned files of copies whose state git could not determine —
  // declined, never guessed.
  plan(ctx, scan) {
    const byRoot = new Map();
    let filtered = 0;
    for (const it of scan.items) {
      if (!it.repoRoot) { filtered++; continue; } // profile-root repo (M6) / unattributable
      if (!byRoot.has(it.repoRoot)) byRoot.set(it.repoRoot, []);
      byRoot.get(it.repoRoot).push(it);
    }
    const items = [];
    for (const root of [...byRoot.keys()].sort()) {
      const files = byRoot.get(root);
      let state;
      try {
        state = inspectWorktree(path.join(ctx.profileRoot, root));
      } catch (e) {
        ctx.log(`worktree: ${root} left alone — cannot determine its state (${e.message})`);
        filtered += files.length;
        continue;
      }
      if (state.clean) {
        for (const f of files) {
          items.push({ ...f, action: 'DELETE', kind: 'file', cleanCopy: root });
        }
      } else {
        items.push({
          path: `${root}/`,
          action: 'ARCHIVE',
          kind: 'worktree',
          root,
          size: files.reduce((s, f) => s + f.size, 0),
          isSymlink: false,
          ruleIdx: files[0].ruleIdx,
          reason: files[0].reason,
          repoRoot: root,
          dirty: state.reason || 'dirty',
          files: files.map(f => ({ path: f.path, rootLen: root.length + 1, size: f.size })),
        });
      }
    }
    return { items, filtered };
  },

  // READ-ONLY (writes only under os.tmpdir). Clean copy → the delete phase's
  // own prepare: hash the file, reserve its quarantine destination. Dirty copy
  // → build the archive, hash the tar, reserve the blob key.
  async prepare(ctx, item) {
    if (item.kind !== 'worktree') {
      const abs = path.join(ctx.profileRoot, item.path);
      const h = hashPath(abs);
      return { sha256: h.sha256, size: h.size, dest: quarantine.reserveDest(ctx.profile, item.path), action: 'DELETE' };
    }
    const staged = stageArchive(ctx, item); // cleans its own temp dir on failure
    return {
      sha256: staged.sha256,
      size: staged.size,
      dest: worktreeKey(ctx.profile, item.root),
      action: 'ARCHIVE',
      // not ledger fields — carried to apply() only:
      manifest: staged.manifest,
      work: staged.work,
    };
  },

  // Clean copy → quarantine move (phases/delete.cjs semantics, byte-exact).
  // Dirty copy → upload → download-back + rebuild (the gate) → delete. The
  // temp staging dir dies in `finally` whatever happens.
  async apply(ctx, item, prepared) {
    if (item.kind !== 'worktree') {
      const abs = path.join(ctx.profileRoot, item.path);
      quarantine.moveInto(ctx.profile, abs, prepared.dest, prepared.sha256);
      const got = hashPath(quarantine.quarantinePath(ctx.profile, prepared.dest));
      if (got.sha256 !== prepared.sha256) throw new Error(`quarantine copy sha256 mismatch: ${prepared.dest}`);
      return;
    }

    const work = prepared.work;
    try {
      const blob = getBlob();
      const tar = fs.readFileSync(path.join(work, 'archive.tar'));
      const gz = zlib.gzipSync(tar);
      const uploaded = await blob.upload(prepared.dest, gz);
      if (uploaded.sha256 !== sha256Hex(gz)) {
        throw new Error(`upload of ${prepared.dest} returned a sha256 that does not match the bytes sent`);
      }

      // THE GATE: download the stored object back, check it hashes to the
      // ledger record, then rebuild the copy from those exact bytes — clone,
      // overlay, patch, every manifest entry by sha256 and mode. Any problem
      // here throws: the runner appends ARCHIVE_FAILED, the copy stays whole.
      const gate = await rebuildFromBlob(prepared.dest, prepared.sha256);
      try {
        removeOwned(path.join(ctx.profileRoot, item.root), gate.manifest);
        ctx.log(`worktree: ${item.root} → ${prepared.dest} (tar ${prepared.size} B, ${gate.manifest.files.length} file(s) removed)`);
      } finally {
        fs.rmSync(gate.work, { recursive: true, force: true });
      }
    } finally {
      if (work) { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } }
      delete prepared.work;
    }
  },

  async verify(ctx, st) {
    if (!isBundleRecord(st)) return deletePhase.verify(ctx, st);
    if (st.state === 'purged') return { status: 'ok', message: 'purged' };
    if (!st.dest) return { status: 'lost', message: 'no blob key in the record' };

    const rootAbs = path.join(ctx.profileRoot, rootRelOf(st));
    let rebuilt;
    try {
      rebuilt = await rebuildFromBlob(st.dest, st.sha256); // download + hash + rebuild
      fs.rmSync(rebuilt.work, { recursive: true, force: true });
    } catch (e) {
      if (e instanceof ArchiveProblem) {
        if (e.status === 'lost') {
          if (st.state === 'at-dest') {
            if (exists(rootAbs)) return { status: 'missing-dest', message: `the archive is gone while the copy still exists: ${st.dest}` };
            return { status: 'lost', message: `the archive is gone and so is the copy: ${st.dest}` };
          }
          // `returned` = the apply FAILED. The upload is the first gate, so a
          // failed apply that never uploaded also never deleted: the copy is
          // whole and the next run retries (the same posture as
          // archive-sessions: state `returned` + local copy present = ok).
          // Caveat in the message: if a bucket ever lost an object AFTER a
          // partial removal, only the ledger records of that run say so.
          if (exists(rootAbs)) {
            return { status: 'ok', message: 'the apply failed before anything was removed — the copy is present (archive missing)' };
          }
          return { status: 'lost', message: `the archive is gone and so is the copy: ${st.dest}` };
        }
        return { status: 'corrupt', message: e.message };
      }
      return { status: 'error', message: e.message };
    }

    // Archive intact. Judge the local side against its manifest: which of the
    // archived files are still on disk?
    let present = 0;
    for (const e of rebuilt.manifest.files) {
      if (exists(path.join(rootAbs, e.path))) present++;
    }
    if (present === 0) return { status: 'ok' };
    if (present === rebuilt.manifest.files.length && st.state !== 'at-dest') {
      // --revert put everything back, or an apply failed before deleting: the
      // copy is whole, the archive is whole — the next run retries.
      return { status: 'ok', message: 'profile copy present, archive intact' };
    }
    return {
      status: 'pending',
      message: `${present}/${rebuilt.manifest.files.length} archived file(s) still at ${rootRelOf(st)} — the archive is intact, the next apply finishes the removal`,
    };
  },

  async revert(ctx, st) {
    if (!isBundleRecord(st)) return deletePhase.revert(ctx, st);
    if (st.state !== 'at-dest') return { status: 'skip', reason: `already ${st.state}` };
    if (!st.dest) return { status: 'lost', reason: 'no blob key in the record' };

    let built;
    try {
      built = await rebuildFromBlob(st.dest, st.sha256);
    } catch (e) {
      if (e instanceof ArchiveProblem) return { status: e.status === 'lost' ? 'lost' : 'corrupt', reason: `${e.message} — refusing to restore` };
      return { status: 'error', reason: e.message };
    }

    const rootAbs = path.join(ctx.profileRoot, rootRelOf(st));
    try {
      // Conflict pre-scan BEFORE a single byte lands: byte-exact beats
      // best-effort (phases/delete.cjs posture), and a partial restore that
      // then discovers a conflict would be neither.
      for (const e of built.manifest.files) {
        const abs = path.join(rootAbs, e.path);
        if (!exists(abs)) continue;
        const cur = e.type === 'symlink'
          ? (fs.lstatSync(abs).isSymbolicLink() ? sha256String(fs.readlinkSync(abs)) : null)
          : (fs.lstatSync(abs).isFile() ? sha256File(abs) : null);
        if (cur === e.sha256) continue;
        return { status: 'conflict', reason: `${e.path} exists with different content — refusing to overwrite it` };
      }

      let restored = 0;
      for (const e of built.manifest.files) {
        const abs = path.join(rootAbs, e.path);
        if (exists(abs)) continue; // identical — checked above
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const src = path.join(built.recon, e.path);
        if (e.type === 'symlink') fs.symlinkSync(e.target, abs);
        else { fs.copyFileSync(src, abs); fs.chmodSync(abs, e.mode); }
        restored++;
      }
      if (!restored) return { status: 'already', reason: 'every archived file is already in place' };
      return { status: 'restored' };
    } finally {
      fs.rmSync(built.work, { recursive: true, force: true });
    }
  },

  // Test seams — production code never calls these.
  _setBlobStore(store) {
    blobStore = store;
  },
  _worktreeKey: worktreeKey,
  _inspectWorktree: inspectWorktree,
};
