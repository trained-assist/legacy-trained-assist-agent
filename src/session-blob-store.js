'use strict';
// Session blob store — the GCS archive backend of epic #1784 M2 (issue #1916, PR-A).
//
// What it is for: after a run the session body and the engine transcript leave the
// VM (gzip → GCS → verify sha → delete locally), and come back on the next touch
// (materialize before resume / session_search). Nothing else lives in this bucket:
// it is an archive of immutable gzipped objects, keyed so a key alone tells you
// which profile/session it belongs to.
//
// Key schema (built here, never assembled by callers):
//   profiles/<profile>/sessions/<sessionId>.json.gz
//   profiles/<profile>/transcripts/<slug-cwd>/<engineSessionId>.jsonl.gz
// <slug-cwd> is the absolute session cwd turned into one path segment (slugCwd):
// the profile does not move between VMs, so the slug is stable across runs — the
// native `--resume` lookup can recompute it from cwd alone.
//
// Auth: Application Default Credentials via the GCP metadata server — a key file
// is NEVER read from disk (no GOOGLE_APPLICATION_CREDENTIALS, no keyFilename):
// the VM's service account needs `storage.objectAdmin` on the bucket and that's
// the whole credential story (infra check, issue #1916 PR-A).
//
// Bucket: $GCS_BUCKET, default trained-assist-workspaces (documented in
// infra/env-manifest.json → systemd_env_vars.gcp, set in systemd/assist-agent.service).
//
// API (all async, all reject rather than return null on infrastructure failure —
// the caller decides whether a failure means "keep the file locally"):
//   upload(key, data) -> {sha256, size, generation}   sha256 of the bytes STORED
//     (the caller gzips first — keys end in .gz — so the hash is what a later
//     verify/revert must reproduce byte-for-byte); generation is the GCS object
//     generation, i.e. the identity of that exact upload.
//   download(key)     -> Buffer                       rejects `code:'BLOB_NOT_FOUND'`
//   exists(key)       -> boolean
//
// Injection: createSessionBlobStore({bucket}) — tests hand in a fake bucket
// (the `bucket.file(key).save/getMetadata/download/exists` shape) and never touch
// ADC, the network or a real bucket. The @google-cloud/storage require is lazy
// for exactly that reason.
//
// File-backed test backend: `GCS_FAKE_DIR=<dir>` (test-only, NEVER set in
// systemd — createSessionBlobStore refuses it under NODE_ENV=production) makes
// the default store read/write plain files under that directory instead of GCS.
// That is how the profile-migrate phase runner is tested: it spawns the CLI as a
// child process, so the fake has to travel through the environment, not through
// a module seam. Same bucket shape as the injected fake in the unit tests.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BUCKET = 'trained-assist-workspaces';
const DEFAULT_TIMEOUT_MS = 60_000;
const CONTENT_TYPE = 'application/gzip';

// Profile name: same contract as scripts/profile-migrate/ledger.cjs.
const PROFILE_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// One key path segment (sessionId, slug-cwd, engineSessionId) — same contract as
// src/session-trace-store.js SESSION_RE.
const SEGMENT_RE = /^[a-zA-Z0-9_.-]{1,200}$/;
const KEY_CHAR_RE = /^[a-zA-Z0-9._/-]+$/;

function blobError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Bucket names are a strict little language (3–63 chars, lowercase, alnum ends);
// catching a bad one here beats a 400 from GCS inside a post-run sweep.
function resolveBucketName(env = process.env) {
  const raw = typeof env.GCS_BUCKET === 'string' ? env.GCS_BUCKET.trim() : '';
  const name = raw || DEFAULT_BUCKET;
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name) || name.includes('..')) {
    throw new Error(`invalid GCS bucket name: ${JSON.stringify(name)} (set GCS_BUCKET to a valid bucket, or leave it unset for the default)`);
  }
  return name;
}

function assertProfileName(profile) {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new Error(`invalid profile name: ${JSON.stringify(profile)} (expected ${PROFILE_RE})`);
  }
  return profile;
}

// One key path segment (sessionId, slug-cwd, engineSessionId) — same contract as
// src/session-trace-store.js SESSION_RE. Exported so callers that build a path
// shape themselves (src/session-archive.js) can test a segment WITHOUT paying
// for a throw: "can I name this file?" is a filter question, not an error.
function isSafeSegment(value) {
  return typeof value === 'string' && SEGMENT_RE.test(value) && value !== '.' && value !== '..';
}

function assertSegment(value, field) {
  if (!isSafeSegment(value)) {
    throw new Error(`invalid ${field}: ${JSON.stringify(value)} (expected one path segment, ${SEGMENT_RE})`);
  }
  return value;
}

// A blob key must be a plain relative POSIX path made of safe characters: no
// absolute paths, no NUL, no ".." of any kind (also blocks backslash tricks).
// Same contract as ledger.cjs isSafeRelPath — PR-B stores these keys as the
// ledger `dest`, and a key that escaped that contract would make revert resolve
// outside the bucket namespace.
function assertSafeKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\0') || key.startsWith('/') || !KEY_CHAR_RE.test(key)) {
    throw new Error(`unsafe blob key: ${JSON.stringify(key)}`);
  }
  const segs = key.split('/');
  if (!segs.every(s => s !== '' && s !== '.' && s !== '..')) {
    throw new Error(`unsafe blob key: ${JSON.stringify(key)} (no "." / ".." segments)`);
  }
  return key;
}

// profiles/<profile>/sessions/<sessionId>.json.gz
function sessionKey(profile, sessionId) {
  return `profiles/${assertProfileName(profile)}/sessions/${assertSegment(sessionId, 'sessionId')}.json.gz`;
}

// profiles/<profile>/transcripts/<slug-cwd>/<engineSessionId>.jsonl.gz
// `slug` is slugCwd(cwd) — named `slug` here so it never shadows the helper.
function transcriptKey(profile, slug, engineSessionId) {
  return `profiles/${assertProfileName(profile)}/transcripts/${assertSegment(slug, 'slugCwd')}/${assertSegment(engineSessionId, 'engineSessionId')}.jsonl.gz`;
}

// Absolute cwd → one stable path segment. Collapses every run of characters
// outside [A-Za-z0-9._-] into a single "-", trims the edges. Case is preserved:
// the VM is Linux, where /A/b and /a/b are different directories.
//
// Determinism beats prettiness here — PR-C recomputes the transcript key from the
// cwd alone (native --resume), so a cwd the regex cannot express must still map
// somewhere stable instead of throwing:
//   * nothing ASCII left (/дом/проект), or what is left reads as "." / ".."
//     → `cwd-<sha256(cwd)[0:16]>`;
//   * a path deeper than 180 chars → truncated + the same hash suffix, so two
//     long cwds that share a prefix stay distinct.
//
// The mapping is LOSSY on purpose — exactly like Claude's own ~/.claude/projects
// slugs ("/a b" and "/a-b" both become "a-b"). That cannot corrupt an archive:
// the last key segment is the engineSessionId, and one engine session belongs to
// exactly one cwd, so a slug collision never puts two objects on the same key.
// Two different sessions from the same cwd differ by engineSessionId.
function slugCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error(`invalid cwd: ${JSON.stringify(cwd)}`);
  const hash = () => sha256Hex(cwd).slice(0, 16);
  let slug = cwd.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') return `cwd-${hash()}`;
  if (slug.length > 180) slug = `${slug.slice(0, 180).replace(/-+$/, '')}-${hash()}`;
  if (!SEGMENT_RE.test(slug)) throw new Error(`cannot slug cwd ${JSON.stringify(cwd)} into a path segment (got ${JSON.stringify(slug)})`);
  return slug;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError(`upload(key, data): data must be a Buffer or string, got ${typeof data}`);
}

function isNotFound(err) {
  return !!err && (err.code === 404 || err.code === 'ENOENT' || err.code === 'NotFound');
}

// Every call is bounded: an external API that hangs must surface as a failure the
// caller can act on (PR-B keeps the local file), never as a stuck post-run sweep.
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  // If the timeout wins the race, the underlying call may still reject later —
  // attach a no-op handler so that late rejection is never an unhandled one.
  Promise.resolve(promise).catch(() => {});
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(blobError('BLOB_TIMEOUT', `${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Lazy on purpose: constructing a Storage client reads ADC, which must not happen
// in a process that injected a fake bucket (tests) or in a process that merely
// loaded this module.
function defaultBucket(bucketName) {
  const { Storage } = require('@google-cloud/storage');
  const projectId = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || undefined;
  return new Storage({ projectId }).bucket(bucketName);
}

// ── file-backed test backend (GCS_FAKE_DIR) ───────────────────────────────────
// A directory standing in for the bucket: the same `bucket.file(key).{save,
// getMetadata, download, exists}` shape @google-cloud/storage exposes, so every
// caller path (upload → download → exists, BLOB_NOT_FOUND on 404) behaves as it
// does against real GCS. Objects are files under <dir>/<key>; keys have already
// passed assertSafeKey before they reach here, so the join is traversal-safe.
//
// GCS_FAKE_FAIL=<op[,op…]> (test-only) makes the named operation(s) throw —
// how a test proves "nothing is deleted without a confirmed upload" without a
// network. Operations: save, getMetadata, download, exists.
function createFileBackedBucket(dir, env = process.env) {
  if (typeof dir !== 'string' || !dir) throw new Error('createFileBackedBucket: a directory is required');
  const root = path.resolve(dir);

  function failOps() {
    const raw = typeof env.GCS_FAKE_FAIL === 'string' ? env.GCS_FAKE_FAIL : '';
    return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }

  function objectPath(key) {
    return path.join(root, ...key.split('/'));
  }

  function notFound(key) {
    const err = new Error(`No such object: ${key}`);
    err.code = 404;
    return err;
  }

  function maybeFail(op, key) {
    if (failOps().has(op)) {
      const err = new Error(`GCS_FAKE_FAIL=${op}: injected failure for ${key}`);
      err.code = 'EINJECTED';
      throw err;
    }
  }

  return {
    name: 'gcs-fake',
    root,
    file(key) {
      const abs = objectPath(key);
      return {
        async save(data) {
          maybeFail('save', key);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          const tmp = `${abs}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, data);
          fs.renameSync(tmp, abs);
        },
        async getMetadata() {
          maybeFail('getMetadata', key);
          let st;
          try { st = fs.statSync(abs); } catch { throw notFound(key); }
          return [{ generation: String(st.mtimeMs), size: String(st.size) }];
        },
        async download() {
          maybeFail('download', key);
          let data;
          try { data = fs.readFileSync(abs); } catch { throw notFound(key); }
          return [data];
        },
        async exists() {
          maybeFail('exists', key);
          return [fs.existsSync(abs)];
        },
      };
    },
  };
}

// GCS_FAKE_DIR is a test switch: refusing it in production means a stray env
// var can never silently redirect real archives into a local directory.
function resolveFakeDir(env = process.env) {
  const raw = typeof env.GCS_FAKE_DIR === 'string' ? env.GCS_FAKE_DIR.trim() : '';
  if (!raw) return null;
  if (env.NODE_ENV === 'production') {
    throw new Error('GCS_FAKE_DIR is a test-only switch and must never be set with NODE_ENV=production');
  }
  return raw;
}

/**
 * @param {{bucket?: object, bucketName?: string, timeoutMs?: number}} [options]
 *   `bucket` — injected client (tests / alternate backends), the
 *   `bucket.file(key)` shape; `bucketName` — override $GCS_BUCKET;
 *   `timeoutMs` — per-call deadline, 0 disables.
 *   With no `bucket`, `$GCS_FAKE_DIR` (test-only) swaps in the file-backed
 *   backend; otherwise the real GCS client is constructed (reads ADC).
 */
function createSessionBlobStore(options = {}) {
  const fakeDir = options.bucket ? null : resolveFakeDir();
  const bucketName = options.bucketName || options.bucket?.name || (fakeDir ? 'gcs-fake' : resolveBucketName());
  const bucket = options.bucket || (fakeDir ? createFileBackedBucket(fakeDir) : defaultBucket(bucketName));
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

  async function upload(key, data) {
    assertSafeKey(key);
    const buf = toBuffer(data);
    const sha256 = sha256Hex(buf);
    const file = bucket.file(key);
    // contentType only — never gzip:true / content-encoding: gzip: the bytes are
    // already gzipped by the caller, and download() must return them verbatim so
    // the sha256 returned here still matches the stored object.
    await withTimeout(file.save(buf, { contentType: CONTENT_TYPE, timeout: timeoutMs }), timeoutMs, `blob upload ${key}`);
    let meta = null;
    try {
      const res = await withTimeout(file.getMetadata(), timeoutMs, `blob stat ${key}`);
      meta = Array.isArray(res) ? res[0] : res;
    } catch (err) {
      // The object IS uploaded at this point; losing only the generation would
      // make the caller believe the upload failed and retry an overwrite.
      throw blobError('BLOB_UPLOAD_UNVERIFIED', `blob upload ${key} succeeded but the object metadata could not be read: ${err.message}`);
    }
    return { sha256, size: buf.length, generation: meta && meta.generation != null ? String(meta.generation) : null };
  }

  async function download(key) {
    assertSafeKey(key);
    const file = bucket.file(key);
    let res;
    try {
      res = await withTimeout(file.download(), timeoutMs, `blob download ${key}`);
    } catch (err) {
      if (isNotFound(err)) throw blobError('BLOB_NOT_FOUND', `blob not found: ${key}`);
      throw err;
    }
    const buf = Array.isArray(res) ? res[0] : res;
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  async function exists(key) {
    assertSafeKey(key);
    const res = await withTimeout(bucket.file(key).exists(), timeoutMs, `blob exists ${key}`);
    return !!(Array.isArray(res) ? res[0] : res);
  }

  return { bucketName, upload, download, exists };
}

module.exports = {
  createSessionBlobStore,
  createFileBackedBucket,
  sessionKey,
  transcriptKey,
  slugCwd,
  resolveBucketName,
  sha256Hex,
  assertSafeKey,
  isSafeSegment,
  DEFAULT_BUCKET,
  DEFAULT_TIMEOUT_MS,
};
