'use strict';

// src/review-links.js must emit byte-identical links to the HH helpers it
// replaces in runner/index.js (hh-quick.hhReviewUrl, hh-autoscan.proactiveUrlFor),
// which hh-skill keeps emitting from its own tools (epic #1470 P1.3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const links = require('../src/review-links');

const ENVS = [
  { AGENT_SECRET: 's3cret', HH_COLD_SEARCH_PUBLIC_URL: 'https://x.example/' },
  { AGENT_SECRET: 'other', HH_COLD_SEARCH_PUBLIC_URL: '' },
];

test('reviewUrl / proactiveUrl match the legacy HH helpers', () => {
  for (const env of ENVS) {
    Object.assign(process.env, env);
    const legacyQuick = require('../src/hh-quick');
    const legacyAutoscan = require('../src/hh-autoscan');
    for (const [u, v] of [['kobzevvv', null], ['user x', '123'], ['u', 'a&b']]) {
      assert.equal(links.reviewUrl(u, v), legacyQuick.hhReviewUrl(u, v));
      assert.equal(links.proactiveUrl(u, v), legacyAutoscan.proactiveUrlFor(u, v));
    }
  }
});

test('no AGENT_SECRET → no token param on the review link', () => {
  process.env.AGENT_SECRET = '';
  assert.doesNotMatch(links.reviewUrl('u', '1'), /token=/);
});
