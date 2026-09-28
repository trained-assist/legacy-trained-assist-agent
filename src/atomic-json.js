// Durable JSON/text write: temp file + fsync + rename + directory fsync, so a crash or
// restart mid-write never leaves a half-written file behind.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function writeAtomic(file, text, mode) {
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

// `space` mirrors JSON.stringify's indent argument: 0 (default) = compact, 2 = pretty.
function atomicJson(file, value, { space = 0, mode = 0o600 } = {}) {
  writeAtomic(file, space ? JSON.stringify(value, null, space) : JSON.stringify(value), mode);
}

// Raw text (markdown, prompts, JSONL bodies) — same durability, no serialization.
function atomicText(file, text, { mode = 0o600 } = {}) {
  writeAtomic(file, text, mode);
}

module.exports = { atomicJson, atomicText };
