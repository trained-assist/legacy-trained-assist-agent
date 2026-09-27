'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../scripts/skills-migration-dry-run.js');

test('maps local tools to catalog sections via mod.tools keys', () => {
  const { byTool, sibSection } = d.toolSectionMap();
  assert.ok(Object.keys(byTool).length > 100, 'most local tools mapped');
  assert.equal(byTool.expo_pipeline_run, 'flexi-expo');
  assert.equal(sibSection['hh-skills'], 'recruiting/hh');
  assert.equal(sibSection['engineering-skills'], 'software-engineering');
});

test('escapeDir matches Claude transcript dir naming; topLevel collapses children', () => {
  assert.equal(d.escapeDir('/home/vova/users/a_b'), '-home-vova-users-a-b');
  assert.deepEqual(d.topLevel(['recruiting/hh', 'recruiting/interview', 'gdrive']), ['gdrive', 'recruiting']);
});
