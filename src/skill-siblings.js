'use strict';

// The extracted domain skill providers core knows about (#1470), in one place.
// Each lives in a sibling checkout next to core (…/trained-assist-hh-skill etc.)
// and is used only when that checkout is present — environments without it keep
// working unchanged. Adding a skill repo = one entry here, not a per-skill branch
// in the headless transport (mcp-action.js) or the cron registry (cron-runtime.js).

const fs = require('fs');
const path = require('path');

const SKILL_SIBLINGS = [
  { id: 'hh', repo: 'trained-assist-hh-skill' },
  { id: 'freelance', repo: 'trained-assist-freelance-skill' },
  { id: 'engineering', repo: 'trained-assist-engineering' },
];

const DEFAULT_ROOT = path.join(__dirname, '..', '..');

function siblingPaths(sibling, root = DEFAULT_ROOT) {
  const dir = path.join(root, sibling.repo);
  return {
    ...sibling,
    dir,
    indexPath: path.join(dir, 'src', 'mcp-skills', 'index.js'),
    registryPath: path.join(dir, 'src', 'mcp-skills', 'registry.js'),
    // Committed, core-valid action manifest (built + checked in the provider's CI).
    actionManifestPath: path.join(dir, 'action-provider-manifest.json'),
  };
}

// Siblings whose MCP server is checked out on this host.
function presentSiblings({ root = DEFAULT_ROOT, siblings = SKILL_SIBLINGS } = {}) {
  return siblings.map(s => siblingPaths(s, root)).filter(s => fs.existsSync(s.indexPath));
}

module.exports = { SKILL_SIBLINGS, siblingPaths, presentSiblings };
