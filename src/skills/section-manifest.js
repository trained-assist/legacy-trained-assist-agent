'use strict';
// Domain section manifests (#1753): a sibling repo describes its own share of the skill
// catalog in config/skill-sections.json (schema: contracts/skill-sections.schema.json,
// contract: docs/domain-section-manifest.md). Core keeps the section skeleton (ids,
// tree, `always`), `servers` and `audienceDefaults`; the domain owns the payload.
//
// Pure functions only — no disk, no sibling checkouts. P1 wires mergeManifests() into
// loadCatalog(); splitCatalog() is its inverse and pins that the contract can express
// today's catalog without loss (test/skill-sections-manifest.test.cjs).

const LOCAL = 'trained-skills';

function foreignServer(mod) {
  const i = mod.indexOf('/');
  return i < 0 ? null : mod.slice(0, i);
}

// catalog + names of core's own prompt domains → { core, manifests: {server → manifest} }.
// A prompt domain that core doesn't ship goes to the section's only foreign server;
// a section with no single foreign owner for such a domain is a catalog error.
function splitCatalog(catalog, coreDomains) {
  const core = { ...catalog, sections: {} };
  const manifests = {};
  const manifest = server => manifests[server] || (manifests[server] = { version: 1, server, sections: {} });

  for (const [id, section] of Object.entries(catalog.sections || {})) {
    const local = { ...section };
    delete local.modules; delete local.siblings; delete local.promptDomains; delete local.pinned;
    const payload = {};
    const at = server => payload[server] || (payload[server] = {});

    const localModules = [];
    for (const mod of section.modules || []) {
      const server = foreignServer(mod);
      if (!server) { localModules.push(mod); continue; }
      (at(server).modules || (at(server).modules = [])).push(mod.slice(server.length + 1));
    }
    for (const sib of section.siblings || []) at(sib).mount = true;
    for (const [server, tools] of Object.entries(section.pinned || {})) {
      if (server === LOCAL) { local.pinned = { ...(local.pinned || {}), [server]: tools }; continue; }
      at(server).pinned = [...tools];
    }
    const localDomains = [];
    for (const d of section.promptDomains || []) {
      if (coreDomains.has(d)) { localDomains.push(d); continue; }
      const owners = Object.keys(payload);
      if (owners.length !== 1) {
        throw new Error(`section ${id}: prompt domain '${d}' is not core's and the section has ${owners.length} foreign servers — owner is ambiguous`);
      }
      (at(owners[0]).promptDomains || (at(owners[0]).promptDomains = [])).push(d);
    }
    if (localModules.length) local.modules = localModules;
    if (localDomains.length) local.promptDomains = localDomains;

    // A section wholly owned by one domain hands it the title too; mixed ones keep core's.
    const owners = Object.keys(payload);
    const whollyForeign = owners.length === 1 && !localModules.length && !localDomains.length && !local.pinned;
    if (whollyForeign && local.title) { payload[owners[0]].title = local.title; delete local.title; }

    core.sections[id] = local;
    for (const server of owners) manifest(server).sections[id] = payload[server];
  }
  return { core, manifests };
}

// core catalog + manifests → merged catalog, plus warnings for what was skipped.
// Union, never replace: a mixed section keeps its core modules. Skips (warn) a manifest
// whose server isn't a registered sibling and any section id core doesn't know — ids
// are core's contract with profiles' skills.json. A prompt-domain name claimed by two
// owners throws: silently letting one win would bypass the other's prompt rules.
function mergeManifests(coreCatalog, manifests) {
  const warnings = [];
  const servers = coreCatalog.servers || {};
  const sections = {};
  for (const [id, s] of Object.entries(coreCatalog.sections || {})) {
    sections[id] = {
      ...s,
      ...(s.modules ? { modules: [...s.modules] } : {}),
      ...(s.siblings ? { siblings: [...s.siblings] } : {}),
      ...(s.promptDomains ? { promptDomains: [...s.promptDomains] } : {}),
      ...(s.pinned ? { pinned: { ...s.pinned } } : {}),
    };
  }
  const domainOwner = new Map();
  for (const [id, s] of Object.entries(sections)) {
    for (const d of s.promptDomains || []) domainOwner.set(d, `core (section ${id})`);
  }

  for (const m of manifests) {
    const server = m && m.server;
    if (!servers[server] || servers[server].kind !== 'sibling') {
      warnings.push(`manifest for '${server}': not a registered sibling server — skipped`);
      continue;
    }
    for (const [id, p] of Object.entries(m.sections || {})) {
      const s = sections[id];
      if (!s) { warnings.push(`${server}: unknown section '${id}' — skipped (section ids are registered in core)`); continue; }
      for (const file of p.modules || []) {
        const ref = `${server}/${file}`;
        const list = s.modules || (s.modules = []);
        if (!list.includes(ref)) list.push(ref);
      }
      if (p.mount) {
        const list = s.siblings || (s.siblings = []);
        if (!list.includes(server)) list.push(server);
      }
      for (const d of p.promptDomains || []) {
        const owner = `${server} (section ${id})`;
        const prev = domainOwner.get(d);
        if (prev && prev !== owner) throw new Error(`prompt domain '${d}' claimed by ${prev} and ${owner}`);
        domainOwner.set(d, owner);
        const list = s.promptDomains || (s.promptDomains = []);
        if (!list.includes(d)) list.push(d);
      }
      if (p.pinned && p.pinned.length) {
        const pinned = s.pinned || (s.pinned = {});
        const list = pinned[server] || (pinned[server] = []);
        for (const t of p.pinned) if (!list.includes(t)) list.push(t);
      }
      if (p.title && !s.title) s.title = p.title;
    }
  }
  return { catalog: { ...coreCatalog, sections }, warnings };
}

module.exports = { splitCatalog, mergeManifests };
