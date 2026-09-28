// Durable JSON/text write: temp file + fsync + rename + directory fsync, so a crash or
// restart mid-write never leaves a half-written file behind.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// opts.mode: defaults to 0o600. An explicit `mode: undefined` (writeMode() under
// GCS_WORKSPACE_SYNC, see data-paths.js) means "no mode" → the platform default.
function resolveMode(opts) {
  return opts && 'mode' in opts ? opts.mode : 0o600;
}

function atomicText(file, text, opts) {
  const mode = resolveMode(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, text);
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

// opts.space mirrors JSON.stringify's indent argument: 0 (default) = compact, 2 = pretty.
function atomicJson(file, value, opts) {
  const space = (opts && opts.space) || 0;
  atomicText(file, space ? JSON.stringify(value, null, space) : JSON.stringify(value), opts);
}

module.exports = { atomicJson, atomicText };
