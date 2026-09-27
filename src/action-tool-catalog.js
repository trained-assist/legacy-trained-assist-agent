'use strict';

// Pure tool-catalog + owner resolution for the headless transport (/action and
// cron): core tools + every present sibling domain repo (hh, freelance,
// engineering). Core is never shadowed, and any duplicate action name across
// sources is a CONFLICT with no implicit precedence (action-provider-registry v1
// invariant, #1533). No fs/env access: callers pass the sources.

function ownerLabel(bucket) {
  return bucket.kind === 'local' ? 'local' : bucket.id;
}

function conflict(name, first, second) {
  return Object.assign(
    new Error(`Duplicate action: ${name} (${ownerLabel(first)}, ${ownerLabel(second)})`),
    { code: 'CONFLICT' },
  );
}

// coreTools:       [{ name, ... }]
// siblings:        [{ id, mcpServerId, tools: [{ name, ... }] }] — all present siblings.
function buildToolCatalog({ coreTools = [], siblings = [] } = {}) {
  const buckets = [
    { kind: 'local', id: 'local', tools: coreTools },
    ...siblings.map(s => ({ kind: 'sibling', id: s.id, tools: s.tools || [] })),
  ];

  const owners = new Map();
  const tools = [];
  for (const bucket of buckets) {
    for (const tool of bucket.tools) {
      const existing = owners.get(tool.name);
      if (existing) throw conflict(tool.name, existing, bucket);
      owners.set(tool.name, { kind: bucket.kind, id: bucket.id });
      tools.push(tool);
    }
  }
  return { tools, owners };
}

module.exports = { buildToolCatalog };
