'use strict';
// A tool moved to a sibling domain repo while core still ships its copy must not
// take the headless catalog down (#1470): the sibling wins, core is reported as
// shadowed. Two siblings with the same action stay a CONFLICT (#1533).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildToolCatalog } = require('../src/action-tool-catalog');

test('sibling wins over a core duplicate; the core copy is reported as shadowed', () => {
  const c = buildToolCatalog({
    coreTools: [{ name: 'github_status', v: 'core' }, { name: 'connect' }],
    siblings: [{ id: 'engineering', mcpServerId: 'engineering-skills', tools: [{ name: 'github_status', v: 'sib' }] }],
  });
  assert.deepEqual(c.owners.get('github_status'), { kind: 'sibling', id: 'engineering' });
  assert.equal(c.tools.filter(t => t.name === 'github_status').length, 1);
  assert.equal(c.tools.find(t => t.name === 'github_status').v, 'sib');
  assert.deepEqual(c.shadowed, [{ name: 'github_status', by: 'engineering' }]);
  assert.deepEqual(c.owners.get('connect'), { kind: 'local', id: 'local' });
});

test('two siblings declaring the same action are still a CONFLICT', () => {
  assert.throws(() => buildToolCatalog({
    coreTools: [],
    siblings: [{ id: 'hh', tools: [{ name: 'x' }] }, { id: 'sales', tools: [{ name: 'x' }] }],
  }), e => e.code === 'CONFLICT' && /Duplicate action: x \(hh, sales\)/.test(e.message));
});
