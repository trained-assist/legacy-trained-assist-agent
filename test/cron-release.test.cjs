const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ops/lib/cron-release.sh answers one question for every cron wrapper: which code
// is about to run — the deployed release, or a plain checkout someone flipped to
// another branch? (2026-09-28: a wrapper hardcoded ~/trained-assist-agent, that
// checkout sat on a feature branch for two days, and cron ran code that was never
// deployed — with no error anywhere.) The helper must therefore:
//   1. prefer the release (marked by .release-sha) over the checkout,
//   2. honour AGENT_CURRENT for tests/box overrides,
//   3. sign a release run with `release=<sha>`,
//   4. shout CHECKOUT + WARNING when only a checkout is available,
//   5. never exit non-zero — wrappers run under `set -euo pipefail`.

const HELLO = path.join(__dirname, '..', 'ops', 'lib', 'cron-release.sh');

// `sh` by default: the helpers must stay POSIX-clean (on the Ubuntu CI runner
// `sh` is dash — stricter than macOS bash, which is the point). The pipefail
// test below opts into `bash`, because that is the shell the cron wrappers
// actually declare (#!/usr/bin/env bash) and dash has no pipefail at all.
function sh(script, env = {}, shell = 'sh') {
  return spawnSync(shell, ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env },
  });
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-release-'));
  const master = path.join(root, 'agent-master');
  const checkout = path.join(root, 'trained-assist-agent');
  fs.mkdirSync(path.join(master, 'ops', 'lib'), { recursive: true });
  fs.mkdirSync(checkout, { recursive: true });
  fs.copyFileSync(HELLO, path.join(master, 'ops', 'lib', 'cron-release.sh'));
  return { root, master, checkout };
}

const load = (master, checkout) => `. '${master}/ops/lib/cron-release.sh'`;

test('release wins: cron_app_dir returns the release when .release-sha exists', () => {
  const { root, master, checkout } = sandbox();
  fs.writeFileSync(path.join(master, '.release-sha'), 'abc123def456\n');
  const r = sh(`${load(master, checkout)}; cron_app_dir`, {
    AGENT_CURRENT: master, HOME: root,
    CRON_FALLBACK_DIR: checkout,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), master);
});

test('no release → falls back to the checkout instead of failing', () => {
  const { root, master, checkout } = sandbox();
  const r = sh(`${load(master, checkout)}; cron_app_dir`, {
    HOME: root, AGENT_CURRENT: master, CRON_FALLBACK_DIR: checkout,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), checkout);
});

test('AGENT_CURRENT override is honoured (box can point elsewhere)', () => {
  const { root, master, checkout } = sandbox();
  const other = path.join(root, 'other-release');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '.release-sha'), 'ffeedd\n');
  const r = sh(`${load(master, checkout)}; cron_app_dir`, {
    HOME: root, AGENT_CURRENT: other, CRON_FALLBACK_DIR: checkout,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), other);
});

test('a release run is signed with release=<sha> in the banner', () => {
  const { root, master, checkout } = sandbox();
  fs.writeFileSync(path.join(master, '.release-sha'), 'abc123def456789\n');
  const r = sh(`${load(master, checkout)}; cron_banner "bugs-collector" "${master}"`, {
    HOME: root,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[release\] bugs-collector: release=abc123def456 path=/);
});

test('a checkout run screams CHECKOUT + WARNING with branch and sha', () => {
  const { root, master, checkout } = sandbox();
  // A real checkout: the whole point is that a stale branch is DETECTABLE.
  spawnSync('git', ['init', '-q', checkout]);
  spawnSync('git', ['-C', checkout, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', checkout, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(checkout, 'x.txt'), 'x');
  spawnSync('git', ['-C', checkout, 'add', '.']);
  spawnSync('git', ['-C', checkout, 'commit', '-qm', 'x']);
  spawnSync('git', ['-C', checkout, 'checkout', '-qb', 'some-feature-branch']);
  const r = sh(`${load(master, checkout)}; cron_banner "issue-fixer" "${checkout}"`, {
    HOME: root,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CHECKOUT branch=some-feature-branch sha=[0-9a-f]+/);
  assert.match(r.stdout, /WARNING — cron is running a plain checkout, NOT the deployed release/);
});

test('neither helper ever exits non-zero (wrappers run under set -euo pipefail)', () => {
  const { root, master, checkout } = sandbox();
  // Missing dirs, missing git, unwritable HOME edge — all must still be 0.
  const r = sh(
    `set -euo pipefail; ${load(master, checkout)}; cron_banner "x" "${path.join(root, 'nowhere')}"; cron_app_dir >/dev/null; echo SURVIVED`,
    { HOME: root },
    'bash',
  );
  assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stdout, /SURVIVED/);
  assert.match(r.stdout, /CHECKOUT branch=\? sha=\?/);
});
