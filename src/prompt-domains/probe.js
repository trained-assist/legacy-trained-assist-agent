'use strict';
// Child-process probe: loads every module of one registry-style MCP tools dir under
// the env the MCP server itself gets (USER_ID, …) and prints {file: ready} as JSON.
// Runs out-of-process because modules read USER_ID at require time — the same
// isReady() that gates tools/list then gates the prompt text (src/prompt-domains).
const fs = require('fs');
const path = require('path');

const toolsDir = process.argv[2];
const out = {};
for (const file of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
  try {
    const mod = require(path.join(toolsDir, file));
    out[file] = typeof mod.isReady === 'function' ? !!mod.isReady() : true;
  } catch (e) {
    out[file] = null; // load error → unknown, caller fails open
  }
}
// Marker: a module may log to stdout on require. exit() — a module may leave timers.
process.stdout.write('\n__PROBE__' + JSON.stringify(out) + '\n', () => process.exit(0));
