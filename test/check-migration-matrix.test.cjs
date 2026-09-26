'use strict';

// Guards the migration control-plane gate (issue #1511): the matrix must not
// lie about where each domain skill is served, and the core<->domain toggle
// must be a pure admin-config change. Dependency-free, offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realMatrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/migration/domain-skill-migration.json'), 'utf8'));

let check;
test.before(async () => { ({ check } = await import('../scripts/check-migration-matrix.mjs')); });

const clone = () => JSON.parse(JSON.stringify(realMatrix));
const entry = (m, id) => m.entries.find(e => e.skill === id);
const hhConfig = (over = {}) => ({
  version: 1,
  sources: [{ id: 'hh', providerId: 'hh', mcpServerId: 'hh-skills', enabled: true,
    profiles: ['trained-assist-product-owner'], ...over }],
});

test('the committed matrix is consistent with tools/, canaries/ and config/', () => {
  const { errors, summary } = check();
  assert.deepEqual(errors, []);
  assert.equal(summary.entries, 7);
});

test('core=yes fails when a listed core tool file is missing', () => {
  const m = clone();
  entry(m, 'hh').coreTools.push('99-does-not-exist.js');
  const { errors } = check({ matrix: m });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /99-does-not-exist\.js is missing/);
});

test('domain=yes fails when the canary spec is missing', () => {
  const m = clone();
  entry(m, 'expo').domain = 'yes'; // but scripts/staging/canaries/expo.json absent
  const { errors } = check({ matrix: m });
  assert.ok(errors.some(e => /expo: domain=yes but scripts\/staging\/canaries\/expo\.json is missing/.test(e)));
});

test('serving=domain fails without a matching config source', () => {
  const m = clone();
  entry(m, 'hh').serving = 'domain';
  const { errors } = check({ matrix: m, config: { version: 1, sources: [] } });
  assert.ok(errors.some(e => /hh: serving=domain but no source/.test(e)));
});

test('serving=domain fails when the source is disabled or has no profiles', () => {
  const m = clone();
  entry(m, 'hh').serving = 'domain';
  assert.ok(check({ matrix: m, config: hhConfig({ enabled: false }) }).errors
    .some(e => /not enabled/.test(e)));
  assert.ok(check({ matrix: m, config: hhConfig({ profiles: [] }) }).errors
    .some(e => /no profiles allowlist/.test(e)));
});

test('serving=core without core=yes is rejected', () => {
  const m = clone();
  entry(m, 'expo').core = 'no';
  const { errors } = check({ matrix: m });
  assert.ok(errors.some(e => /expo: serving=core but core=no/.test(e)));
});

test('toggle core -> domain -> core on hh is a single config/matrix field change', () => {
  // 1. cutover: matrix says domain, config approves hh for the sandbox profile
  const cutover = clone();
  entry(cutover, 'hh').serving = 'domain';
  assert.deepEqual(check({ matrix: cutover, config: hhConfig() }).errors, []);

  // 2. rollback: flip serving back to core, config emptied — green again
  const rolledBack = clone();
  entry(rolledBack, 'hh').serving = 'core';
  assert.deepEqual(check({ matrix: rolledBack, config: { version: 1, sources: [] } }).errors, []);

  // 3. drift while cut over: config still says domain but source removed => caught
  assert.ok(check({ matrix: cutover, config: { version: 1, sources: [] } }).errors.length > 0);
});

test('duplicate skill entries and bad enum values are rejected', () => {
  const dup = clone();
  dup.entries.push(JSON.parse(JSON.stringify(entry(dup, 'hh'))));
  assert.ok(check({ matrix: dup }).errors.some(e => /duplicate skill entry/.test(e)));

  const bad = clone();
  entry(bad, 'hh').serving = 'both';
  assert.ok(check({ matrix: bad }).errors.some(e => /invalid serving "both"/.test(e)));
});
