'use strict';
// Skill sections × attributes resolver (issue #1537, PR-A).
//
// resolve(catalog, profileSkills, readiness, opts?) → what one run of one profile exposes.
// Pure: no fs, no env, no clock. Callers load the catalog (src/skills/catalog.js),
// read workDir/skills.json and gather readiness.
//
//   catalog        config/skill-catalog.json, plus `domains` {name: {server, module, when}}
//                  (front matter of src/prompt-domains/*.md, attached by loadCatalog()).
//   profileSkills  {enabled: [sectionId], disabled: [sectionId]} from workDir/skills.json,
//                  or null → legacy mode: every section enabled = what the code exposes today.
//   readiness      { '<server>': bool                  server attached / present on host,
//                    '<server>/<module>': bool|null      module isReady() (null = unknown),
//                    '<server>/*': null }                server attached but not probeable
//   opts.intent    (issue #76 L1) section ids this TURN needs — a second, independent
//                  filter on top of profileSkills: mount profile ∩ intent. Unknown ids
//                  are dropped; if what survives selects nothing beyond `always`
//                  sections for this profile, the intent is ignored entirely
//                  (fail-open: never end up with nothing mounted, `intent.applied=false`).
//
// Section rules: `always` sections are always on. Otherwise a section is on when it or an
// ancestor is in `enabled` and neither it nor any ancestor is in `disabled` (disabled wins,
// a child cannot re-enable itself under a disabled parent). With an intent the section must
// ALSO be relevant to it (sectionRelevant below).
//
// Output:
//   sections       enabled section ids (catalog order)
//   modules        '<server>/<module>' fully exposed (ready or readiness unknown)
//   setupOnly      '<server>/<module>' in an enabled section but not ready → setup tools only
//   siblings       sibling server ids to mount in .mcp.json
//   promptDomains  prompt-domain names (same gating as prompt-domains selectDomains)
//   pinned         {server: [tool]} always-listed tools of enabled + attached servers
//   unknown        section ids in skills.json that the catalog doesn't know
//   intent         null, or {sections: [...normalized ids], applied: bool}
const LOCAL = 'trained-skills';

function parentOf(id) {
  const i = id.lastIndexOf('/');
  return i < 0 ? null : id.slice(0, i);
}

function lineage(id) {
  const out = [];
  for (let cur = id; cur; cur = parentOf(cur)) out.push(cur);
  return out;
}

function sectionEnabled(id, section, profileSkills) {
  if (section.always) return true;
  if (!profileSkills) return true; // legacy
  const enabled = new Set(profileSkills.enabled || []);
  const disabled = new Set(profileSkills.disabled || []);
  const chain = lineage(id);
  if (chain.some(s => disabled.has(s))) return false;
  return chain.some(s => enabled.has(s));
}

function serverAttached(server, readiness) {
  return server === LOCAL || readiness[server] === true;
}

// true | false | null(unknown) | undefined(module not shipped by that server)
function moduleReady(server, mod, readiness) {
  const key = `${server}/${mod}`;
  if (key in readiness) return readiness[key];
  if (readiness[`${server}/*`] === null) return null;
  return undefined;
}

// Turn-intent relevance (#76): a section is relevant when it IS one of the intent's
// sections, an ANCESTOR of one (intent=recruiting/hh keeps the parent's own modules),
// or a DESCENDANT of one (intent=recruiting keeps its whole subtree). Siblings under a
// different branch are not relevant — intent=recruiting/hh does NOT pull in
// recruiting/interview.
function sectionRelevant(id, intentIds) {
  for (const i of intentIds) {
    if (id === i || id.startsWith(i + '/') || i.startsWith(id + '/')) return true;
  }
  return false;
}

// Intent ids the catalog knows (unknown ones are dropped — a map edited without the
// catalog must fail open to "no intent", never to "mount nothing").
function normalizeIntent(intent, sections) {
  if (!Array.isArray(intent) || !intent.length) return null;
  const ids = [...new Set(intent.filter(x => typeof x === 'string' && Object.hasOwn(sections, x)))];
  return ids.length ? ids : null;
}

function resolve(catalog, profileSkills, readiness, opts = {}) {
  readiness = readiness || {};
  const servers = catalog.servers || {};
  const sections = catalog.sections || {};
  const domains = catalog.domains || {};
  const ps = profileSkills && typeof profileSkills === 'object' ? profileSkills : null;

  const out = {
    mode: ps ? 'profile' : 'legacy',
    sections: [], modules: [], setupOnly: [], siblings: [], promptDomains: [], pinned: {}, unknown: [],
    intent: null,
  };
  if (ps) {
    for (const id of [...(ps.enabled || []), ...(ps.disabled || [])]) {
      if (!(id in sections) && !out.unknown.includes(id)) out.unknown.push(id);
    }
  }

  // Issue #76 L1: profile ∩ intent. Fail-open — an intent that selects nothing beyond
  // `always` sections for THIS profile (disjoint, or every candidate disabled) is
  // ignored: mounting core-only when the profile has real sections on would only buy
  // an escalation. `applied` records which side happened, for logs/audit.
  const intentIds = normalizeIntent(opts.intent, sections);
  let intentApplied = false;
  if (intentIds) {
    intentApplied = Object.keys(sections).some(id =>
      sectionEnabled(id, sections[id], ps)
      && !sections[id].always
      && sectionRelevant(id, intentIds));
  }
  const effIntent = intentApplied ? intentIds : null;
  if (intentIds) out.intent = { sections: intentIds, applied: intentApplied };

  const modules = new Set();
  const setupOnly = new Set();
  const siblings = new Set();
  const relays = new Set();
  const domainNames = new Set();

  for (const [id, section] of Object.entries(sections)) {
    if (!sectionEnabled(id, section, ps)) continue;
    if (effIntent && !section.always && !sectionRelevant(id, effIntent)) continue;
    out.sections.push(id);
    for (const mod of section.modules || []) {
      // 'file.js' = a core module; '<server>/file.js' = a sibling domain repo's module.
      const [server, file] = mod.includes('/') ? mod.split('/') : [LOCAL, mod];
      if (server !== LOCAL) {
        if (!servers[server] || servers[server].kind !== 'sibling' || !serverAttached(server, readiness)) continue;
        siblings.add(server);
      }
      (moduleReady(server, file, readiness) === false ? setupOnly : modules).add(`${server}/${file}`);
    }
    for (const sib of section.siblings || []) {
      const srv = servers[sib];
      // A relay server (#2034) is mounted by browser.js under its own feature toggle,
      // not as a sibling checkout: it can be ATTACHED (mounted this run) without ever
      // becoming part of the `siblings` output other consumers resolve as repos.
      if (srv && srv.kind === 'relay') { if (readiness[sib] === true) relays.add(sib); continue; }
      if (!srv || srv.kind !== 'sibling') continue;
      if (serverAttached(sib, readiness)) siblings.add(sib);
    }
    for (const d of section.promptDomains || []) domainNames.add(d);
    for (const [server, tools] of Object.entries(section.pinned || {})) {
      if (!serverAttached(server, readiness)) continue;
      const list = out.pinned[server] || (out.pinned[server] = []);
      for (const t of tools) if (!list.includes(t)) list.push(t);
    }
  }

  // Sibling modules not addressed by any section come from readiness (the sibling
  // ships its own module list) — only for siblings mounted by a `siblings` entry.
  const catalogModules = new Set(Object.values(sections).flatMap(sec => (sec.modules || []).filter(m => m.includes('/'))));
  for (const sib of siblings) {
    for (const [key, val] of Object.entries(readiness)) {
      if (!key.startsWith(sib + '/') || key === `${sib}/*` || catalogModules.has(key)) continue;
      (val === false ? setupOnly : modules).add(key);
    }
  }
  // A module shared by several sections: ready in one = ready everywhere.
  for (const m of modules) setupOnly.delete(m);

  // Prompt domains: mirror src/prompt-domains selectDomains() exactly, restricted to
  // domains owned by enabled sections whose server is attached for this run.
  const attached = new Set([LOCAL, ...siblings, ...relays]);
  for (const name of Object.keys(domains).sort()) {
    if (!domainNames.has(name)) continue;
    const d = domains[name];
    if (!attached.has(d.server)) continue;
    const ready = moduleReady(d.server, d.module, readiness);
    if (ready === undefined) continue;                 // module not shipped
    if (ready === null) { if (d.when !== 'not-ready') out.promptDomains.push(name); continue; }
    if (d.when === 'present' || (d.when === 'ready' ? ready : !ready)) out.promptDomains.push(name);
  }

  out.modules = [...modules].sort();
  out.setupOnly = [...setupOnly].sort();
  out.siblings = [...siblings].sort();
  return out;
}

module.exports = { resolve, sectionEnabled, sectionRelevant, normalizeIntent, parentOf, LOCAL };
