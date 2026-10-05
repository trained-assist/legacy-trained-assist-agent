'use strict';
// Skills shadow (issue #1537, PR-A): once per run, resolve the skill catalog for this
// profile, write workDir/.skills-resolved.json and log ONE line comparing it with what
// the current code actually exposed (siblings in .mcp.json, prompt domains picked by
// src/prompt-domains). Observation only: never throws, never changes what is exposed.
const fs = require('fs');
const path = require('path');
const { resolve } = require('./resolve');
const { loadCatalog, siblingIndexPath, readProfileSkills } = require('./catalog');
const { atomicJson } = require('../atomic-json');

// probe: {serverId: {file: bool|null} | null} from prompt-domains probeServers().
function buildReadiness(catalog, { probe, siblingExists } = {}) {
  const exists = siblingExists || (p => !!p && fs.existsSync(p));
  const readiness = {};
  for (const [id, s] of Object.entries(catalog.servers || {})) {
    // A relay (#2034 capability-relay) has no checkout to stat: attached = mounted in
    // this run's .mcp.json, which is exactly what the prompt-domain probe reports.
    if (s.kind === 'relay') { readiness[id] = Boolean(probe && Object.hasOwn(probe, id)); continue; }
    if (s.kind !== 'sibling') continue;
    readiness[id] = exists(siblingIndexPath(catalog, id));
  }
  for (const [id, mods] of Object.entries(probe || {})) {
    if (!mods) { readiness[`${id}/*`] = null; continue; }
    for (const [file, val] of Object.entries(mods)) readiness[`${id}/${file}`] = val;
  }
  return readiness;
}

function setDiff(want, have) {
  const w = new Set(want); const h = new Set(have);
  return { add: [...w].filter(x => !h.has(x)).sort(), drop: [...h].filter(x => !w.has(x)).sort() };
}

function fmtDiff(label, d) {
  return [...d.add.map(x => `+${label}:${x}`), ...d.drop.map(x => `-${label}:${x}`)];
}

// actual: {siblings: [id], relays: [id], promptDomains: [name] | null}
function compare(resolved, actual) {
  const out = [...fmtDiff('sib', setDiff(resolved.siblings, actual.siblings || []))];
  // Relay servers are compared in their own channel (#2034): the catalog resolves them
  // out of `relays`, so folding them into the sibling diff would report a permanent
  // false +/- pair on every run that mounts one.
  out.push(...fmtDiff('rel', setDiff(resolved.relays || [], actual.relays || [])));
  if (Array.isArray(actual.promptDomains)) out.push(...fmtDiff('dom', setDiff(resolved.promptDomains, actual.promptDomains)));
  return out;
}

function runShadow({ workDir, username, audience, mcpConfigPath, domainReport, catalog, siblingExists, intent = null, log = console.log } = {}) {
  try {
    catalog = catalog || loadCatalog();
    let mcpServers = {};
    try { mcpServers = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers || {}; } catch { /* compare what we can */ }
    const report = domainReport || {};
    const readiness = buildReadiness(catalog, { probe: report.probe, siblingExists });
    const profileSkills = readProfileSkills(workDir);
    // intent (#76 L1): the same per-turn filter the mount used, so `diff` compares
    // like with like and .skills-resolved.json reflects THIS turn's exposure.
    const resolved = resolve(catalog, profileSkills, readiness, { intent });
    const actual = {
      siblings: Object.keys(mcpServers).filter(id => catalog.servers?.[id]?.kind === 'sibling').sort(),
      relays: Object.keys(mcpServers).filter(id => catalog.servers?.[id]?.kind === 'relay').sort(),
      promptDomains: Array.isArray(report.picked) ? [...report.picked].sort() : null,
    };
    const diff = compare(resolved, actual);

    // Preview: what the audience default (PR-E migration) would hide, legacy profiles only.
    // Skipped while a turn intent is actually narrowing the mount — then `resolved` is
    // the turn's subset, not the profile's baseline, and the diff would be meaningless.
    let preview = null;
    const aud = audience && catalog.audienceDefaults?.[audience];
    if (!profileSkills && aud && !(resolved.intent && resolved.intent.applied)) {
      const p = resolve(catalog, aud, readiness);
      preview = { audience, skills: aud, hides: {
        siblings: setDiff(resolved.siblings, p.siblings).add,
        relays: setDiff(resolved.relays || [], p.relays || []).add,
        promptDomains: setDiff(resolved.promptDomains, p.promptDomains).add,
        modules: setDiff([...resolved.modules, ...resolved.setupOnly], [...p.modules, ...p.setupOnly]).add,
      } };
    }

    const record = { at: new Date().toISOString(), user: username || null, audience: audience || null, resolved, actual, diff, preview };
    try { atomicJson(path.join(workDir, '.skills-resolved.json'), record, { space: 2 }); } catch (e) { log(`[skills-shadow] write: ${e.message}`); }
    const prev = preview ? ` preview[${audience}]=-${preview.hides.siblings.length}sib/-${preview.hides.promptDomains.length}dom/-${preview.hides.modules.length}mod` : '';
    log(`[skills-shadow] user=${username || '?'} mode=${resolved.mode} diff=${diff.length ? diff.join(',') : '0'} sections=${resolved.sections.length} siblings=${resolved.siblings.join('|') || '-'} relays=${(resolved.relays || []).join('|') || '-'} rel=${(preview && preview.hides.relays.length) || 0}${prev}`);
    return record;
  } catch (e) {
    try { log(`[skills-shadow] user=${username || '?'} error=${String(e && e.message).slice(0, 200)}`); } catch { /* never throw */ }
    return null;
  }
}

module.exports = { compare, runShadow, buildReadiness, setDiff };
