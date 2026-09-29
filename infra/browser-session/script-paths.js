'use strict';
// Resolve the helper scripts that sit next to this file.
//
// These scripts used to be resolved via os.homedir()/browser-session/<name> — a hand copy
// that nothing deployed (infra/browser-session/setup.sh stopped copying login.js after #1866)
// and that silently drifted from the repo: the stale copy still reports «Успешно залогинился»
// on rejected credentials (#1875), so any consumer reading the homedir path got the pre-#1866
// behaviour while the MCP tool got the fixed one.
//
// The copy next to this file ships with every release, so a merged fix is live on the next
// deploy. homedir stays as a fallback for a legacy install that has no release layout.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function resolveShipped(name) {
  const shipped = path.join(__dirname, name);
  if (fs.existsSync(shipped)) return shipped;
  return path.join(os.homedir(), 'browser-session', name);
}

module.exports = { resolveShipped };
