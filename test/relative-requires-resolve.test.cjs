// Every literal relative require() in src/ must resolve. Best-effort blocks
// (`try { require('./x') } catch {}`) swallow a wrong path silently — that is how
// run-input snapshots were never written in prod (#1568: src/runner required
// './run-input-store' instead of '../run-input-store'). Static check, no execution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const REQ_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (/\.(c?js)$/.test(e.name)) yield p;
  }
}

test('all literal relative requires under src/ resolve', () => {
  const broken = [];
  for (const file of jsFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(REQ_RE)) {
      try { require.resolve(m[2], { paths: [path.dirname(file)] }); }
      catch { broken.push(`${path.relative(SRC, file)}: require('${m[2]}')`); }
    }
  }
  assert.deepEqual(broken, [], `unresolvable requires:\n${broken.join('\n')}`);
});
