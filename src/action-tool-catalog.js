'use strict';

// Pure tool-catalog + owner resolution for the headless transport (/action and
// cron). It mirrors src/browser.js's session-side mount rule exactly, so one
// profile is never served by two different copies of the same skill:
//
//   - an APPROVED external source that is enabled + eligible for the profile +
//     has an available artifact suppresses the sibling that mounts the same
//     mcpServerId — the sealed adapter wins, the sibling is the core fallback;
//   - core is never shadowed;
//   - any duplicate action name across the remaining core/sibling/approved
//     sources is a CONFLICT with no implicit precedence (action-provider-
//     registry v1 invariant, #1533).
//
// No fs/env/runtime access here: callers pass already-filtered sources, which
// keeps the routing decision unit-testable without a config or a checkout.

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
// siblings:        [{ id, mcpServerId, tools: [{ name, ... }] }] — all present
//                  siblings; the suppressed ones are dropped here.
// approvedSources: [{ id, providerId, mcpServerId, actions: [{ name, ... }] }]
//                  — only the ones enabled + eligible + available for the profile.
function buildToolCatalog({ coreTools = [], siblings = [], approvedSources = [] } = {}) {
  const sealedServerIds = new Set(approvedSources.map(s => s.mcpServerId).filter(Boolean));
  const buckets = [
    { kind: 'local', id: 'local', tools: coreTools },
    ...siblings
      .filter(s => !sealedServerIds.has(s.mcpServerId))
      .map(s => ({ kind: 'sibling', id: s.id, tools: s.tools || [] })),
    ...approvedSources.map(s => ({ kind: 'approved', id: s.id, tools: s.actions || [], source: s })),
  ];

  const owners = new Map();
  const tools = [];
  for (const bucket of buckets) {
    for (const tool of bucket.tools) {
      const existing = owners.get(tool.name);
      if (existing) throw conflict(tool.name, existing, bucket);
      owners.set(tool.name, { kind: bucket.kind, id: bucket.id, source: bucket.source || null });
      tools.push(tool);
    }
  }
  return { tools, owners };
}

module.exports = { buildToolCatalog };
