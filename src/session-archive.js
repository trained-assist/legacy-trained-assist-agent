'use strict';
// session-archive.js — M2 archive / materialize core (epic #1784, issue #1916).
//
// The one place that knows how a session body or an engine transcript LEAVES the
// VM and comes back. Three callers, one implementation:
//   · PR-B  scripts/profile-migrate/phases/archive-sessions.cjs — the operator
//     driven CLI phase (lock → drain → flush → ledger → this module);
//   · PR-D  the post-run sweep in the runner — the same archive* calls after a
//     run (and after a quick answer, which also writes a session);
//   · PR-C  materialize* — wired into the read paths (admission before
//     resolveChatSession, native --resume, session_search, chat-history). Here
//     the functions exist and are tested; the wiring lands in PR-C.
//
// Exact payload — the clean-list ARCHIVE class is INHERITED by a whole subtree,
// so the phase filters and this module states what is actually archived:
//   sessions/<sessionId>.json                → profiles/<p>/sessions/<id>.json.gz
//   .agent-home/.claude/projects/<slug>/<id>.jsonl
//                                            → profiles/<p>/transcripts/<slug-cwd>/<id>.jsonl.gz
// Deliberately NOT archived (they stay local):
//   sessions/current-session*.json  live pointer files — admission reads them
//                                   between runs, they are not payload;
//   sessions/*.digest.json          session-digest's regenerable cache;
//   .agent-home/.claude/sessions/** covered by the same clean-list rule but not
//                                   session bodies this epic moves (M2 scope);
//   symlinks                        never — the target's bytes are not ours;
//   git working copies (when: git-repo rule)   M3;
//   sessions.json                   the index itself (KEEP, outside sessions/).
//
// Two hashes, stated once so they never blur:
//   rawSha256 — sha256 of the LOCAL file before gzip. This is what the ledger
//     records (same semantics as every other phase: hashPath of the origin file)
//     and what revert re-checks after gunzip. The `archived` index marker does
//     NOT duplicate it.
//   gzSha256 — sha256 of the STORED (gzipped) object, i.e. what upload() returns.
//     Goes into the sessions.json marker as {key, sha256, size, at} so a later
//     materialize can integrity-check a download BEFORE decompressing.
//
// «Ничего не удаляется без подтверждённой загрузки»: archive* uploads, then
// DOWNLOADS the object back and gunzips it until the bytes hash to the original
// local file — only then is the index marker written and the local file unlinked.
// Any failure leaves the local file exactly where it was (the runner appends an
// ARCHIVE_FAILED compensating record, see runner.cjs doApply).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { randomUUID } = require('crypto');
const { StringDecoder } = require('string_decoder');
const {
  createSessionBlobStore, sessionKey, transcriptKey, slugCwd, sha256Hex, isSafeSegment,
} = require('./session-blob-store');
const { atomicJson } = require('./atomic-json');

// = src/session-store.js SESSIONS_FILE / SESSIONS_DIR — the index the runner
// reads between runs. Kept as literals (not an import) so this module stays a
// leaf; if either name moves, move it here too.
const SESSIONS_FILE = 'sessions.json';
const SESSIONS_DIR = 'sessions';
const TRANSCRIPTS_DIR = '.agent-home/.claude/projects';

const SESSION_EXT = '.json';
const TRANSCRIPT_EXT = '.jsonl';
const TRANSCRIPT_PREFIX = TRANSCRIPTS_DIR.split('/');
// A cwd scan bounded like this: the `cwd` field sits on the first message lines
// (Claude writes a few metadata lines first), so anything beyond this either has
// no cwd at all or is not a transcript we can re-key.
const CWD_SCAN_MAX_BYTES = 8 << 20;

// Durable write primitive (same shape as src/atomic-json.js, buffer flavour):
// temp + fsync + rename + dir fsync, so a crash never leaves a torn file.
function atomicWriteBuffer(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* keep the original error */ } }
    try { fs.unlinkSync(tmp); } catch { /* keep the original error */ }
    throw e;
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* keep the original error */ }
    throw e;
  }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

// ── path classification (sync, no I/O) ───────────────────────────────────────
// The phase's filter and prepare both start here: a path either has a documented
// blob key derivable from it (session bodies) or from it + the cwd inside the
// file (transcripts), or it is not ours to archive.
function archiveRelKind(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const segs = rel.split('/');
  if (segs.length === 2 && segs[0] === SESSIONS_DIR && segs[1].endsWith(SESSION_EXT)) {
    const base = segs[1];
    if (base.startsWith('current-session')) return null; // pointer file — stays local
    if (base.endsWith('.digest.json')) return null;      // regenerable cache — stays local
    return 'session';
  }
  // .agent-home/.claude/projects/<slug>/<engineSessionId>.jsonl — exactly one
  // level below the projects dir, where Claude puts them.
  if (
    segs.length === TRANSCRIPT_PREFIX.length + 2
    && TRANSCRIPT_PREFIX.every((seg, i) => segs[i] === seg)
    && segs[segs.length - 1].endsWith(TRANSCRIPT_EXT)
  ) return 'transcript';
  return null;
}

function sessionRelId(rel) {
  if (archiveRelKind(rel) !== 'session') return null;
  const id = rel.slice(SESSIONS_DIR.length + 1, -SESSION_EXT.length);
  return isSafeSegment(id) ? id : null;
}

function transcriptRelId(rel) {
  if (archiveRelKind(rel) !== 'transcript') return null;
  const id = rel.slice(rel.lastIndexOf('/') + 1, -TRANSCRIPT_EXT.length);
  return isSafeSegment(id) ? id : null;
}

// profiles/<profile>/sessions/<sessionId>.json.gz — derivable from the path alone.
function sessionArchiveKey(profile, rel) {
  const id = sessionRelId(rel);
  return id ? sessionKey(profile, id) : null;
}

// profiles/<profile>/transcripts/<slug-cwd>/<engineSessionId>.jsonl.gz
// `cwd` is read OUT of the transcript (see readTranscriptCwd): Claude's own
// project directory slug is lossy and non-invertible, while PR-C recomputes this
// key from the cwd alone for native --resume — so the key must be built from the
// cwd, never from the directory name the file happens to sit in.
function transcriptArchiveKey(profile, rel, cwd) {
  const id = transcriptRelId(rel);
  if (!id) throw new Error(`not an archivable transcript path: ${rel}`);
  if (typeof cwd !== 'string' || !cwd) throw new Error(`no cwd for transcript ${rel}`);
  return transcriptKey(profile, slugCwd(cwd), id);
}

// `cwd` as Claude writes it into every message envelope of a transcript
// ({"type":"user","cwd":"/home/…",…}); the leading metadata lines carry none, so
// scan line by line until one does. Returns null when the file has no cwd — the
// caller (prepare) refuses to archive it rather than invent a key.
function readTranscriptCwd(absPath, { maxBytes = CWD_SCAN_MAX_BYTES } = {}) {
  const decoder = new StringDecoder('utf8');
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    let leftover = '';
    let scanned = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      scanned += n;
      leftover += decoder.write(chunk.subarray(0, n));
      const lines = leftover.split('\n');
      leftover = lines.pop(); // last element is a (possibly) partial line
      for (const line of lines) {
        const cwd = cwdFromLine(line);
        if (cwd) return cwd;
      }
      if (scanned > maxBytes) break;
    }
    return cwdFromLine(leftover + decoder.end());
  } finally {
    fs.closeSync(fd);
  }
}

function cwdFromLine(line) {
  const s = line.trim();
  if (!s || s[0] !== '{') return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null;
  } catch {
    return null;
  }
}

// ── integrity of one stored object ───────────────────────────────────────────
// Download → gunzip → the bytes must hash to the original local file. Never
// throws: an infrastructure failure is `error`, not `missing`/`corrupt` — the
// phase maps those differently (a timeout must not read as "the archive is gone").
// `raw` is kept only on success: it IS the restored content, so revert and
// verify share one download instead of fetching the object twice.
async function fetchArchivedBlob({ blob, key, rawSha256 }) {
  let gz;
  try {
    gz = await blob.download(key);
  } catch (e) {
    if (e && e.code === 'BLOB_NOT_FOUND') return { status: 'missing', message: `blob not found: ${key}` };
    return { status: 'error', message: e.message };
  }
  let raw;
  try {
    raw = zlib.gunzipSync(gz);
  } catch (e) {
    return { status: 'corrupt', message: `blob does not gunzip: ${key} (${e.message})` };
  }
  if (rawSha256 && sha256Hex(raw) !== rawSha256) {
    return { status: 'corrupt', message: `blob content sha256 mismatch: ${key}` };
  }
  return { status: 'ok', raw, gzSha256: sha256Hex(gz), gzSize: gz.length };
}

// The same check without carrying the content — for callers that only judge the
// state of the archive (verify) or prove an upload (apply).
async function checkArchivedBlob(o) {
  const r = await fetchArchivedBlob(o);
  if (r.status !== 'ok') return r;
  return { status: 'ok', gzSha256: r.gzSha256, gzSize: r.gzSize };
}

// ── archive one file ─────────────────────────────────────────────────────────
async function gzipLocalFile(abs, expected, relPath) {
  const raw = fs.readFileSync(abs); // throws ENOENT if it vanished — honest failure
  if (expected) {
    if (Number.isInteger(expected.size) && raw.length !== expected.size) {
      throw new Error(`${relPath} changed size between prepare and apply — refusing to archive bytes the ledger does not describe`);
    }
    if (expected.sha256 && sha256Hex(raw) !== expected.sha256) {
      throw new Error(`${relPath} changed between prepare and apply — refusing to archive bytes the ledger does not describe`);
    }
  }
  return { raw, rawSha256: sha256Hex(raw), rawSize: raw.length, gz: zlib.gzipSync(raw) };
}

async function uploadAndConfirm({ blob, key, gz, rawSha256 }) {
  const uploaded = await blob.upload(key, gz);
  const chk = await checkArchivedBlob({ blob, key, rawSha256 });
  if (chk.status !== 'ok') {
    throw new Error(`upload of ${key} could not be confirmed (${chk.status}): ${chk.message}`);
  }
  if (uploaded.sha256 !== sha256Hex(gz)) {
    throw new Error(`upload of ${key} returned a sha256 that does not match the bytes sent`);
  }
  return { key, gzSha256: uploaded.sha256, gzSize: uploaded.size, generation: uploaded.generation };
}

/**
 * Archive one session body: gzip → upload → confirm by re-downloading →
 * mark the index → unlink locally.
 *
 * @param {{blob, profile, profileRoot, relPath, expected?, expectedKey?, log?}} o
 *   `expected` = the ledger's {sha256, size} from prepare — the file must not
 *   have changed in between, or the ledger would describe bytes we never store.
 *   `expectedKey` = the ledger's `dest`; if the key derived now differs, the
 *   file no longer maps to what was recorded and archiving it would orphan the
 *   record (only a content-dependent key can trip this — the transcript's).
 * @returns {{key, sha256, size, rawSha256, rawSize, sessionId, marked}}
 *   sha256/size are the STORED object's (what the index marker records).
 */
async function archiveSessionBody({ blob, profile, profileRoot, relPath, expected, expectedKey, log }) {
  const key = sessionArchiveKey(profile, relPath);
  if (!key) throw new Error(`not an archivable session body: ${relPath}`);
  if (expectedKey && expectedKey !== key) {
    throw new Error(`${relPath}: derived blob key ${key} differs from the reserved one ${expectedKey}`);
  }
  const abs = path.join(profileRoot, relPath);
  const sessionId = sessionRelId(relPath);

  const { rawSha256, rawSize, gz } = await gzipLocalFile(abs, expected, relPath);
  const up = await uploadAndConfirm({ blob, key, gz, rawSha256 });

  // Marker BEFORE unlink (crash order: a marker without the unlink leaves both
  // copies — verify reports `pending`, the sweep finishes it; the reverse would
  // lose the key reference).
  const marked = markSessionArchived(profileRoot, sessionId, {
    key,
    sha256: up.gzSha256,
    size: up.gzSize,
    at: new Date().toISOString(),
  });
  if (!marked.marked && log) log(`session ${sessionId}: ${marked.reason} — archived to ${key} with no index marker`);

  fs.unlinkSync(abs);
  return {
    key, sha256: up.gzSha256, size: up.gzSize, rawSha256, rawSize, sessionId, marked: marked.marked,
  };
}

/**
 * Archive one engine transcript: cwd out of the JSONL → key → gzip → upload →
 * confirm → unlink locally. No index marker: the transcript's key is recomputed
 * from cwd + engineSessionId (PR-C native resume), it is not read from sessions.json.
 * @returns {{key, sha256, size, rawSha256, rawSize, cwd}}
 */
async function archiveTranscript({ blob, profile, profileRoot, relPath, expected, expectedKey }) {
  const abs = path.join(profileRoot, relPath);
  const cwd = readTranscriptCwd(abs);
  if (!cwd) {
    throw new Error(`no "cwd" in ${relPath} — cannot derive a stable transcript blob key, leaving the file local`);
  }
  const key = transcriptArchiveKey(profile, relPath, cwd);
  if (expectedKey && expectedKey !== key) {
    throw new Error(`${relPath}: derived blob key ${key} differs from the reserved one ${expectedKey} — the file changed since prepare`);
  }
  const { rawSha256, rawSize, gz } = await gzipLocalFile(abs, expected, relPath);
  const up = await uploadAndConfirm({ blob, key, gz, rawSha256 });
  fs.unlinkSync(abs);
  return { key, sha256: up.gzSha256, size: up.gzSize, rawSha256, rawSize, cwd };
}

// ── the index marker ─────────────────────────────────────────────────────────
// sessions.json is rewritten through atomic-json exactly like session-store
// does it, but with a STRICT read: a corrupt index is never silently replaced
// by `[]` (that would destroy the only reference to every session).
// Returns {marked:true} / {marked:false, reason} / throws on an unreadable index.
function markSessionArchived(profileRoot, sessionId, marker) {
  const file = path.join(profileRoot, SESSIONS_FILE);
  if (!fs.existsSync(file)) return { marked: false, reason: 'no index' };
  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${SESSIONS_FILE} is unreadable (${e.message}) — refusing to rewrite the index`);
  }
  if (!Array.isArray(index)) throw new Error(`${SESSIONS_FILE} is not a JSON array — refusing to rewrite the index`);
  const record = index.find((r) => r && r.id === sessionId);
  if (!record) return { marked: false, reason: `no index record for ${sessionId}` };
  record.archived = marker;
  atomicJson(file, index, { space: 2 });
  return { marked: true };
}

// ── restore (used by --revert) ───────────────────────────────────────────────
// Mode mirrors how the file is normally CREATED, not what umask would pick:
// session bodies 0600 (session-store writes them that way), transcripts 0644 —
// under agent-isolation the engine may run as a slot user that has to read the
// transcript back for a native resume.
function writeRestoredFile(profileRoot, relPath, raw) {
  const kind = archiveRelKind(relPath);
  if (!kind) throw new Error(`refusing to write a non-archivable path back: ${relPath}`);
  const abs = path.join(profileRoot, relPath);
  atomicWriteBuffer(abs, raw, kind === 'transcript' ? 0o644 : 0o600);
  return abs;
}

// ── materialize (PR-C wiring comes later; the function + its test are here) ──
/**
 * Download one archived object back to `destPath`.
 *
 * Nothing is written before BOTH checks pass (gz sha when the caller has the
 * marker's, raw sha when it has the ledger's) — a half-materialized session is
 * worse than a missing one. An existing destPath is left alone: the caller
 * (admission hook) decides whether a local copy means "already materialized".
 *
 * @returns {{status:'written'|'exists', destPath, size?, sha256?}}
 *   Rejections: `BLOB_NOT_FOUND` (nothing archived) or an integrity error.
 */
async function materializeBlob({ blob, key, destPath, gzSha256, rawSha256, mode = 0o600 }) {
  if (fs.existsSync(destPath)) return { status: 'exists', destPath };
  const gz = await blob.download(key);
  if (gzSha256 && sha256Hex(gz) !== gzSha256) {
    throw new Error(`materialize ${key}: downloaded object sha256 mismatch`);
  }
  let raw;
  try {
    raw = zlib.gunzipSync(gz);
  } catch (e) {
    throw new Error(`materialize ${key}: object does not gunzip (${e.message})`);
  }
  if (rawSha256 && sha256Hex(raw) !== rawSha256) {
    throw new Error(`materialize ${key}: content sha256 mismatch after gunzip`);
  }
  atomicWriteBuffer(destPath, raw, mode);
  return { status: 'written', destPath, size: raw.length, sha256: sha256Hex(raw) };
}

/**
 * PR-C entry point for a session body: the marker from the index record
 * (`archived: {key, sha256, size}`) + the ledger's raw sha when the caller has
 * it. Dest = the canonical local path, so resume/session_search read it back
 * exactly where they expect it. Transcript materialization takes a cwd-derived
 * dest from the caller (Claude's project directory is its own slug — see
 * transcriptArchiveKey), so it stays on materializeBlob.
 */
async function materializeSessionBody({ blob, profileRoot, sessionId, marker, rawSha256, mode = 0o600 }) {
  if (!marker || typeof marker.key !== 'string') {
    throw new Error(`session ${sessionId}: no archived marker in the index`);
  }
  const destPath = path.join(profileRoot, SESSIONS_DIR, `${sessionId}${SESSION_EXT}`);
  return materializeBlob({
    blob,
    key: marker.key,
    destPath,
    gzSha256: marker.sha256,
    rawSha256,
    mode,
  });
}

// Default store for the process environment (real GCS, or the GCS_FAKE_DIR test
// backend). Callers construct it LAZILY: dry-run/filter/prepare must never need
// ADC or a bucket — only apply/verify/revert touch it.
function createBlobStore() {
  return createSessionBlobStore();
}

module.exports = {
  SESSIONS_FILE,
  SESSIONS_DIR,
  TRANSCRIPTS_DIR,
  archiveRelKind,
  sessionRelId,
  transcriptRelId,
  sessionArchiveKey,
  transcriptArchiveKey,
  readTranscriptCwd,
  fetchArchivedBlob,
  checkArchivedBlob,
  archiveSessionBody,
  archiveTranscript,
  markSessionArchived,
  writeRestoredFile,
  materializeBlob,
  materializeSessionBody,
  createBlobStore,
};
