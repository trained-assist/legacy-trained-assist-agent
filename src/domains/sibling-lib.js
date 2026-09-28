'use strict';

// In-process access to a sibling domain repo's module (#1470) — for the few core
// paths that read domain state synchronously (quick answers). The sibling checkout
// (src/skill-siblings.js) is the single copy of the code; core never vendors it.
// A missing/broken checkout fails only those calls: every export becomes a function
// that throws the load error (same contract as src/domains/hh/lib.js hhLib).
const fs = require('fs');
const path = require('path');
const { SKILL_SIBLINGS, siblingPaths } = require('../skill-siblings');

const unavailable = new Map();

function siblingModulePath(id, relPath) {
  const sibling = SKILL_SIBLINGS.find(s => s.id === id);
  if (!sibling) throw new Error(`unknown skill sibling: ${id}`);
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) throw new Error(`bad sibling module path: ${relPath}`);
  return path.join(siblingPaths(sibling).dir, relPath);
}

function siblingLib(id, relPath) {
  const file = siblingModulePath(id, relPath);
  try {
    return require(file);
  } catch (err) {
    if (!unavailable.has(file)) {
      console.error(`[sibling-lib] ${id}:${relPath} unavailable (${file}): ${err.message}`);
      const fail = () => { throw new Error(`${id} module ${relPath} unavailable: ${err.message}`); };
      unavailable.set(file, new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : fail) }));
    }
    return unavailable.get(file);
  }
}

// Extension point: every sibling that ships `relPath` contributes its module (#1717) —
// e.g. src/quick-answers.js, src/project-types.js. Siblings without the file are skipped.
function siblingModules(relPath) {
  const out = [];
  for (const { id } of SKILL_SIBLINGS) {
    if (fs.existsSync(siblingModulePath(id, relPath))) out.push({ id, mod: siblingLib(id, relPath) });
  }
  return out;
}

module.exports = { siblingLib, siblingModulePath, siblingModules };
