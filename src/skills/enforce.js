'use strict';
// Skills enforcement (issue #1537, PR-B): turn workDir/skills.json into what a run must
// NOT expose — sibling MCP servers left out of .mcp.json, local MCP modules skipped by
// the trained-skills registry, prompt domains dropped from the system prompt.
//
// Opt-in per profile: no workDir/skills.json → planFor() returns null → every consumer
// keeps its legacy behaviour byte-for-byte. Fail-safe: any resolver/catalog/skills.json
// error → console.warn + null (legacy) — tools are never cut because of a broken config.
// Only things the catalog knows can be hidden: a module/sibling/domain that no section
// lists (e.g. added after the catalog) always stays exposed.
//
// Consumers:
//   src/browser.js writeMcpConfig  → skips hiddenSiblings, writes EFFECTIVE_FILE and sets
//                                    SKILLS_RESOLVED=<path> in the MCP servers' env
//   src/mcp-skills/registry.js      → readHidden(process.env.SKILLS_RESOLVED).modules
//   src/prompt-domains buildDomainBlock → readHidden(<trained-skills env>).domains
//   src/browser.js writeMcpConfig  → skips hidden.relays (a disabled section must not
//                                    mount its relay server, #2034)
const fs = require('fs');
const path = require('path');
const { resolve } = require('./resolve');
const { atomicJson } = require('../atomic-json');

const EFFECTIVE_FILE = '.skills-effective.json';
const LOCAL = 'trained-skills';

function union(sections, ids, key) {
  const out = new Set();
  for (const id of ids) for (const x of (sections[id] && sections[id][key]) || []) out.add(x);
  return out;
}

// A section's sibling servers: listed ones plus the owners of its sibling modules
// ('<server>/<file>' entries — a domain repo's modules gated per section, #1470).
// Relay servers (#2034) are NOT siblings: they have no checkout and no domain
// manifest, but they ARE gated per section (a disabled section must not mount its
// relay), so they travel in their own hidden channel.
function sectionSiblings(sections, ids) {
  const out = union(sections, ids, 'siblings');
  for (const m of union(sections, ids, 'modules')) if (m.includes('/')) out.add(m.split('/')[0]);
  return out;
}

// Pure: catalog + profileSkills + optional turn intent (#76 L1) →
// { sections, unknown, mode, intent, hidden: {siblings, relays, modules, domains} }.
function computePlan(catalog, profileSkills, { intent = null } = {}) {
  const sections = catalog.sections || {};
  const all = Object.keys(sections);
  // Readiness is irrelevant for *which sections* are on; resolve() only needs it for
  // the sibling attach check, so claim every sibling attached.
  const readiness = {};
  for (const [id, s] of Object.entries(catalog.servers || {})) if (s.kind === 'sibling') readiness[id] = true;
  const r = resolve(catalog, profileSkills, readiness, { intent });
  const on = r.sections;
  const minus = (a, b) => [...a].filter(x => !b.has(x)).sort();
  return {
    sections: on,
    unknown: r.unknown,
    mode: r.mode,
    // {sections, applied} when a turn intent was requested (applied=false → the intent
    // fell open to the full profile set, see resolve()), null otherwise.
    intent: r.intent,
    hidden: {
      siblings: minus(sectionSiblings(sections, all), sectionSiblings(sections, on)),
      relays: minus(union(sections, all, 'relays'), union(sections, on, 'relays')),
      modules: minus(union(sections, all, 'modules'), union(sections, on, 'modules')),
      domains: minus(union(sections, all, 'promptDomains'), union(sections, on, 'promptDomains')),
    },
  };
}

// workDir → plan | null. null = legacy (no skills.json and no turn intent, or catalog
// unreadable → warn). `intent` (issue #76 L1) makes a plan even for a legacy profile:
// the per-turn mount set is profile(=everything here) ∩ intent. A broken skills.json
// still means "profile = everything" — never cut tools because of a broken config.
function planFor(workDir, { catalog, warn = console.warn, intent = null } = {}) {
  if (!workDir) return null;
  const f = path.join(workDir, 'skills.json');
  let profileSkills = null;
  if (fs.existsSync(f)) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.enabled)) {
        throw new Error('skills.json must be an object with an "enabled" array');
      }
      const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
      profileSkills = { enabled: list(raw.enabled), disabled: list(raw.disabled) };
    } catch (e) {
      warn(`[skills] ${f}: ${e.message} — legacy exposure (nothing hidden)`);
      profileSkills = null;
    }
  }
  // Legacy profile and no per-turn intent → today's behaviour byte-for-byte.
  if (!profileSkills && !intent) return null;
  try {
    catalog = catalog || require('./catalog').loadCatalog();
    const plan = computePlan(catalog, profileSkills, { intent });
    if (plan.unknown.length) warn(`[skills] ${f}: unknown sections ${plan.unknown.join(',')} (ignored)`);
    return plan;
  } catch (e) {
    warn(`[skills] ${f}: ${e.message} — legacy exposure (nothing hidden)`);
    return null;
  }
}

// Writes the plan next to .mcp.json (or at `file`, a per-run path under .mcp-runs/ —
// #76: a narrowed plan must not be clobbered by a parallel run of the same profile);
// returns its path (null on write failure → legacy).
function writeEffective(workDir, plan, { warn = console.warn, file = null } = {}) {
  const target = file || path.join(workDir, EFFECTIVE_FILE);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 0660 like .mcp.json (see writeMcpConfig): the MCP server reads it as the slot user.
    atomicJson(target, { at: new Date().toISOString(), ...plan }, { space: 2, mode: 0o660 });
    return target;
  } catch (e) {
    warn(`[skills] write ${target}: ${e.message} — legacy exposure`);
    return null;
  }
}

// SKILLS_RESOLVED file → {modules:Set, domains:Set, siblings:Set, relays:Set} | null
// (unset/unreadable → null = no filter).
function readHidden(file, { warn = console.warn } = {}) {
  if (!file) return null;
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8')).hidden || {};
    const set = v => new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
    return { modules: set(h.modules), domains: set(h.domains), siblings: set(h.siblings), relays: set(h.relays) };
  } catch (e) {
    warn(`[skills] SKILLS_RESOLVED=${file}: ${e.message} — no filter`);
    return null;
  }
}

module.exports = { computePlan, planFor, writeEffective, readHidden, EFFECTIVE_FILE, LOCAL };
