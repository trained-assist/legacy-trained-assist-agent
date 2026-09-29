'use strict';
// The repo must not carry a shared PR-tracker file: every PR appending to one
// root checklist.md was a guaranteed merge conflict (hit twice in a day — #1790,
// #1829) and bought nothing GitHub itself doesn't show. Rule: README.md
// «This repo is for durable documents». Trackers = issues / PR bodies; the GTD
// controller's checklist.md convention lives only in profile projectDirs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

test('checklist.md is not tracked in the repo', () => {
  const tracked = require('node:child_process')
    .execFileSync('git', ['ls-files', '--', 'checklist.md'], { cwd: repoRoot, encoding: 'utf8' })
    .trim();
  assert.equal(tracked, '', 'checklist.md must not be tracked — see README «This repo is for durable documents»');
});

test('checklist.md is gitignored so an accidental write cannot be committed', () => {
  const gi = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.ok(
    gi.split('\n').some((l) => l.trim() === 'checklist.md'),
    '.gitignore must contain a bare checklist.md entry',
  );
});

test('the durable-documents rule stays documented in README', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('### This repo is for durable documents'),
    'README must keep the «This repo is for durable documents» section',
  );
  assert.ok(!readme.includes('always write a checklist.md'), 'the old "always write a checklist.md" rule must be gone');
});
