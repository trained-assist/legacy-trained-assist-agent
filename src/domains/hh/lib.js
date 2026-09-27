'use strict';

// HH domain code lives in trained-assist-hh-skill (epic #1470) — the single
// source of truth. Core reaches it here, from the sibling checkout that
// deploy.sh already syncs and links next to every release (same pattern as
// 61-dev.js → trained-assist-engineering). No copies of hh-*.js in core.
//
//   <releases>/<sha>/src/domains/hh/lib.js  →  <releases>/trained-assist-hh-skill/src
//
// HH_SKILL_DIR (same var deploy.sh uses) overrides the checkout location — CI
// and local runs point it at any hh-skill clone.

const path = require('path');

function hhSkillDir() {
  return process.env.HH_SKILL_DIR || path.join(__dirname, '..', '..', '..', '..', 'trained-assist-hh-skill');
}

function hhModulePath(name) {
  if (!/^hh-[a-z-]+$/.test(name)) throw new Error(`not an hh-skill module: ${name}`);
  return path.join(hhSkillDir(), 'src', name);
}

// A missing/broken sibling must not take the whole server down with it: the
// failure is logged once per module and every export becomes a function that
// throws the load error, so only HH paths fail — with a clear message.
const unavailable = new Map();
function unavailableModule(name, err) {
  if (!unavailable.has(name)) {
    console.error(`[hh-lib] ${name} unavailable (${hhModulePath(name)}): ${err.message}`);
    const fail = () => { throw new Error(`hh-skill module ${name} unavailable: ${err.message}`); };
    unavailable.set(name, new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : fail) }));
  }
  return unavailable.get(name);
}

function hhLib(name) {
  try {
    return require(hhModulePath(name));
  } catch (err) {
    return unavailableModule(name, err);
  }
}

module.exports = { hhLib, hhSkillDir, hhModulePath };
