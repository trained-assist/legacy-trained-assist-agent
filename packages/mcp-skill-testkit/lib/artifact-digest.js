'use strict';

// Deterministic artifact digest: sha256 over the sorted relative file list and
// bytes of a directory. Used by the source manifest (`artifactDigest`) so a
// consumer can recompute it and prove the artifact on disk is the approved one.
const { createHash } = require('crypto');
const fs = require('fs');
const { join, relative, sep } = require('path');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function artifactDigest(dir) {
  const files = walk(dir).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join('/');
    const bytes = fs.readFileSync(file);
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

module.exports = { artifactDigest };
