// Durable JSON write: temp file + fsync + rename + directory fsync, so a crash or
// restart mid-write never leaves a half-written file behind.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function atomicJson(file, value) {
  atomicText(file, JSON.stringify(value));
}

module.exports = { atomicJson, atomicText };
