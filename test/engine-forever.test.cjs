'use strict';
// Wiring guard for the pinned opencode fork engine (scripts/engine-forever.sh).
//
// The fork was switched in on prod 2026-10-04 by hand-run scripts under ~/build —
// in no checkout, so nothing could review or reproduce it, and the two VMs could
// silently diverge on the engine again. These assertions pin the three facts that
// made that switch safe, so a later edit cannot quietly drop them:
//
//   1. a full-SHA pin — a branch/ref moves, and prod would then run an unreviewed build;
//   2. the OPENCODE_DB export inside the wrapper — the fork is built from branch
//      `daily`, so its install channel is `daily`: without it opencode opens a fresh,
//      EMPTY opencode-daily.db, every session history disappears and the runner's
//      native resume (`opencode run --session <id>`) rebuilds context on every run;
//   3. the deploy hook — re-asserted on gcp only, non-fatal, and absent from the RU
//      deploy (issue #1288: ru-edge has no runner and no engine to provision).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const live = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // commented-out ≠ present

const script = read('scripts/engine-forever.sh');
const deploy = read('scripts/deploy.sh');
const ruDeploy = read('scripts/deploy-ru-edge.sh');

test('engine-forever.sh pins a full commit SHA and the fork repo', () => {
  const pin = script.match(/FOREVER_SHA:-([0-9a-f]+)\}/);
  assert.ok(pin, 'no FOREVER_SHA default found in scripts/engine-forever.sh');
  assert.match(pin[1], /^[0-9a-f]{40}$/, `pin "${pin[1]}" is not a full 40-char commit SHA`);
  assert.match(script, /kobzevvv\/opencode-forever/, 'fork repo URL missing');
  assert.match(script, /FOREVER_BRANCH:-daily\}/, 'fork branch must stay `daily` (that is the build the owner maintains)');
});

test('wrapper exports OPENCODE_DB — else the fork opens an empty daily DB and resume breaks', () => {
  const liveScript = live(script);
  // NB: these are literal strings in the heredoc, so the `$` is escaped in the file too.
  assert.ok(liveScript.includes('OPENCODE_DB="\\$HOME/.local/share/opencode/opencode.db"'),
    'wrapper must pin OPENCODE_DB to the real opencode.db (resolved from $HOME at run time)');
  assert.ok(liveScript.includes('export OPENCODE_DB'), 'wrapper must export OPENCODE_DB, not just set it');
  assert.ok(liveScript.includes('exec "\\$FORK" "\\$@"'),
    'wrapper must exec the pinned fork binary with all original args');
});

test('deploy.sh re-asserts the fork, gcp-only, and a failure warns instead of failing the deploy', () => {
  const liveDeploy = live(deploy);
  const guard = liveDeploy.indexOf('[ "$DEPLOY_ENV" = "gcp" ]');
  const hook = liveDeploy.indexOf('engine-forever.sh" install');
  assert.ok(hook >= 0, 'scripts/deploy.sh never runs scripts/engine-forever.sh install — the fork would not survive a rebuilt box');
  assert.ok(guard >= 0, 'deploy.sh has no gcp guard around the engine hook — RU would get an engine it must not have (#1288)');
  assert.ok(guard < hook, 'the gcp guard does not cover the engine-forever hook');
  assert.match(liveDeploy, /engine-forever install FAILED/,
    'a failed install must print a visible ⚠️ line — a silent skip is how prod drifted the first time');
  assert.match(deploy, /engine-forever\.sh" install; then/,
    'the hook must be an if/else, not a bare call: under `set -e` + the deploy ERR trap a bare failure would take the agent down over engine packaging');
});

test('deploy-ru-edge.sh never provisions an engine (RU runs no engine at all)', () => {
  assert.doesNotMatch(live(ruDeploy), /engine-forever\.sh/,
    'RU must not get the engine: ru-edge spawns no engine (#1288), so this would be dead weight');
});
