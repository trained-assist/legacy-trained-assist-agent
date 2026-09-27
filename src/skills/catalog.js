'use strict';
// Loads config/skill-catalog.json and attaches prompt-domain gating (front matter of
// src/prompt-domains/*.md) so src/skills/resolve.js stays pure. Issue #1537.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG_PATH = path.join(ROOT, 'config', 'skill-catalog.json');

function loadCatalog({ file = CATALOG_PATH, domainsDir } = {}) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { loadDomains } = require('../prompt-domains');
  catalog.domains = {};
  for (const d of loadDomains(domainsDir)) {
    catalog.domains[d.name] = { server: d.server, module: d.module, when: d.when };
  }
  return catalog;
}

// Checkout dir of a sibling domain repo (next to core; hh honours HH_SKILL_DIR like hhLib).
function siblingRepoDir(repo) {
  if (repo === 'trained-assist-hh-skill') return require('../domains/hh/lib').hhSkillDir();
  return path.join(ROOT, '..', repo);
}

// Host path of a sibling server's MCP entry (same layout browser.js writeMcpConfig uses).
function siblingIndexPath(catalog, serverId) {
  const s = catalog.servers && catalog.servers[serverId];
  if (!s || s.kind !== 'sibling' || !s.repo) return null;
  return path.join(siblingRepoDir(s.repo), 'src', 'mcp-skills', 'index.js');
}

// workDir/skills.json → {enabled, disabled} | null (missing/unreadable → legacy).
function readProfileSkills(workDir) {
  const f = path.join(workDir, 'skills.json');
  if (!fs.existsSync(f)) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return { enabled: list(raw.enabled), disabled: list(raw.disabled) };
}

module.exports = { loadCatalog, siblingIndexPath, siblingRepoDir, readProfileSkills, CATALOG_PATH };
