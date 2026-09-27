'use strict';

// Pure tool-catalog + owner resolution for the headless transport (/action and
// cron): core tools + every present sibling domain repo (hh, sales, freelance,
// engineering). No fs/env access: callers pass the sources.
//
// Duplicates:
//   - two sibling repos declaring the same action → CONFLICT (action-provider-
//     registry v1 invariant, #1533 — no implicit precedence between domains);
//   - a core tool also served by a sibling → the sibling wins and the core copy is
//     reported in `shadowed`. That is exactly the state between "domain repo ships
//     the moved tool" and "core deletes its copy" (#1470): the sibling is the
//     single source of truth, so it must not take the whole catalog down (every
//     /action, cron run and hh-routes schedule call failed with CONFLICT while such
//     a pair of PRs was in flight, 2026-09-27).

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
  const byName = new Map();
  const shadowed = [];
  for (const bucket of buckets) {
    for (const tool of bucket.tools) {
      const existing = owners.get(tool.name);
      if (existing && !(existing.kind === 'local' && bucket.kind === 'sibling')) throw conflict(tool.name, existing, bucket);
      if (existing) shadowed.push({ name: tool.name, by: bucket.id });
      owners.set(tool.name, { kind: bucket.kind, id: bucket.id });
      byName.set(tool.name, tool);
    }
  }
  return { tools: [...byName.values()], owners, shadowed };
}

module.exports = { buildToolCatalog };
