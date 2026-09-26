const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RELEASE_LIB = path.resolve(__dirname, '../scripts/release-lib.sh');
const PREFLIGHT = path.resolve(__dirname, '../scripts/deploy-preflight.sh');
const WORKFLOWS = ['ci.yml', 'deploy-manual.yml'];

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function sh(script, env = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, ['init', '-q', '--bare', origin]);
  spawnSync('git', ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 't@t']);
  git(work, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(work, 'f'), 'a');
  git(work, ['add', 'f']);
  git(work, ['commit', '-qm', 'c1']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-q', 'origin', 'main']);
  const c1 = git(work, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(work, 'f'), 'b');
  git(work, ['commit', '-qam', 'c2']);
  git(work, ['push', '-q', 'origin', 'main']);
  const c2 = git(work, ['rev-parse', 'HEAD']);
  const releases = path.join(dir, 'releases');
  const link = path.join(dir, 'agent-master');
  return {
    dir, work, c1, c2, releases, link,
    checkout: (sha) => git(work, ['checkout', '-q', '--detach', sha]),
    head: () => git(work, ['rev-parse', 'HEAD']),
    preflight: (target) => spawnSync('bash', [PREFLIGHT, target], { cwd: work, encoding: 'utf8', env: { ...process.env, REPO_DIR: work } }),
    build: (target) => sh(`source "${RELEASE_LIB}"; SUDO= RELEASE_SKIP_DEPS=1 release_build "${work}" "${target}" "${releases}"`),
    setLink: (target) => sh(`source "${RELEASE_LIB}"; SUDO= release_set_link "${link}" "${target}"`),
    gc: (keep) => sh(`source "${RELEASE_LIB}"; SUDO= release_gc "${releases}" ${keep}`),
  };
}

test('preflight accepts an origin/main commit', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  assert.equal(f.preflight(f.c2).status, 0);
});

test('preflight refuses a commit that is not an ancestor of origin/main', (t) => {
  const f = fixture(t);
  git(f.work, ['checkout', '-q', '-b', 'feat', f.c1]);
  fs.writeFileSync(path.join(f.work, 'f'), 'z');
  git(f.work, ['commit', '-qam', 'feat']);
  const feat = f.head();
  const r = f.preflight(feat);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin\/main/);
});

test('a dirty session worktree no longer blocks a deploy (prod is a release, not the tree)', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  fs.writeFileSync(path.join(f.work, 'dirty'), 'x');
  assert.equal(f.preflight(f.c2).status, 0, 'preflight must not look at worktree dirt any more');
});

test('release_build materialises the committed revision, not the dirty worktree', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  fs.writeFileSync(path.join(f.work, 'f'), 'DIRTY'); // uncommitted
  const r = f.build(f.c2);
  assert.equal(r.status, 0, r.stderr);
  const released = path.join(f.releases, f.c2, 'f');
  assert.equal(fs.readFileSync(released, 'utf8'), 'b', 'release must contain the commit, not the working tree');
  assert.ok(fs.existsSync(path.join(f.releases, f.c2, '.release-complete')));
  assert.equal(fs.readFileSync(path.join(f.releases, f.c2, '.release-sha'), 'utf8').trim(), f.c2, 'release must expose its SHA for /health');
});

test('release_build is idempotent (reuses a completed release)', (t) => {
  const f = fixture(t);
  f.checkout(f.c2);
  assert.equal(f.build(f.c2).status, 0);
  const sentinel = path.join(f.releases, f.c2, '.keep-me');
  fs.writeFileSync(sentinel, 'x');
  const again = f.build(f.c2);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(fs.existsSync(sentinel), 'a completed release must not be rebuilt');
});

test('release_set_link repoints the symlink atomically', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.releases, f.c1), { recursive: true });
  fs.mkdirSync(path.join(f.releases, f.c2), { recursive: true });
  assert.equal(f.setLink(path.join(f.releases, f.c1)).status, 0);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(path.join(f.releases, f.c1)));
  assert.equal(f.setLink(path.join(f.releases, f.c2)).status, 0);
  assert.equal(fs.realpathSync(f.link), fs.realpathSync(path.join(f.releases, f.c2)));
});

test('release_gc keeps the newest releases and preserves the hh-skill and engineering sibling symlinks', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.releases, { recursive: true });
  for (let i = 1; i <= 4; i++) {
    fs.mkdirSync(path.join(f.releases, `r${i}`));
    fs.utimesSync(path.join(f.releases, `r${i}`), new Date(2026, 0, i), new Date(2026, 0, i));
  }
  const hhSibling = path.join(f.releases, 'trained-assist-hh-skill');
  fs.mkdirSync(path.join(f.dir, 'hh-src'));
  fs.symlinkSync(path.join(f.dir, 'hh-src'), hhSibling);
  const engSibling = path.join(f.releases, 'trained-assist-engineering');
  fs.mkdirSync(path.join(f.dir, 'eng-src'));
  fs.symlinkSync(path.join(f.dir, 'eng-src'), engSibling);
  const r = f.gc(2);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(f.releases, 'r3')));
  assert.ok(fs.existsSync(path.join(f.releases, 'r4')));
  assert.ok(!fs.existsSync(path.join(f.releases, 'r1')));
  assert.ok(!fs.existsSync(path.join(f.releases, 'r2')));
  assert.ok(fs.lstatSync(hhSibling).isSymbolicLink(), 'must not GC the hh-skill sibling symlink');
  assert.ok(fs.lstatSync(engSibling).isSymbolicLink(), 'must not GC the engineering sibling symlink');
});

test('deploy.sh provisions the trained-assist-engineering sibling checkout + releases symlink (#1418)', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '../scripts/deploy.sh'), 'utf8');
  assert.match(body, /ENGINEERING_DIR="\$\{ENGINEERING_DIR:-\$AGENT_HOME\/trained-assist-engineering\}"/);
  assert.match(body, /ln -sfn "\$ENGINEERING_DIR" "\$RELEASES_DIR\/trained-assist-engineering"/);
});

test('units serve from agent-master and no longer run a live-tree guard', () => {
  for (const name of ['assist-agent.service', 'ru-edge.service']) {
    const unit = fs.readFileSync(path.resolve(__dirname, '../systemd', name), 'utf8');
    assert.match(unit, /WorkingDirectory=\/home\/vova\/agent-master/, `${name} must serve the release symlink`);
    assert.doesNotMatch(unit, /live-dir-guard/, `${name} must not carry the obsolete live-tree guard`);
  }
});

test('deploy workflows build a release from the SHA instead of resetting the live tree', () => {
  for (const name of WORKFLOWS) {
    const body = fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8');
    assert.doesNotMatch(body, /git stash/, `${name} must not stash`);
    assert.doesNotMatch(body, /git reset --hard/, `${name} must not reset a live working tree`);
    assert.doesNotMatch(body, /git checkout --detach/, `${name} must not check out in a live working tree`);
    assert.match(body, /git archive "\$DEPLOY_TARGET_COMMIT" scripts/, `${name} must run deploy code from the target SHA`);
    assert.match(body, /deploy-preflight\.sh/, `${name} must run the ancestry preflight`);
  }
});

test('deploy scripts use the release mechanics', () => {
  for (const name of ['deploy.sh', 'deploy-ru-edge.sh']) {
    const body = fs.readFileSync(path.resolve(__dirname, '../scripts', name), 'utf8');
    assert.match(body, /source "\$SCRIPT_DIR\/release-lib\.sh"/, `${name} must source release-lib.sh`);
    assert.match(body, /release_build /, `${name} must build a release`);
    assert.match(body, /release_set_link /, `${name} must activate via symlink swap`);
  }
});

test('release paths are absolute /home/vova, not $HOME (RU deploy user is not the service user)', () => {
  for (const name of ['deploy.sh', 'deploy-ru-edge.sh']) {
    const body = fs.readFileSync(path.resolve(__dirname, '../scripts', name), 'utf8');
    assert.match(body, /AGENT_HOME="\$\{AGENT_HOME:-\/home\/vova\}"/, `${name} must default AGENT_HOME to /home/vova`);
    assert.doesNotMatch(body, /RELEASES_DIR="\$\{RELEASES_DIR:-\$HOME/, `${name} must not derive the release dir from $HOME`);
    assert.doesNotMatch(body, /CURRENT_LINK="\$\{CURRENT_LINK:-\$HOME/, `${name} must not derive the symlink from $HOME`);
  }
});

test('cron install tolerates a root-owned release dir', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '../ops/cron/install.sh'), 'utf8');
  assert.match(body, /chmod \+x[\s\S]*\|\| true/, 'cron chmod must be best-effort on a root-owned release');
});

test('disk-hygiene crons use the stable agent-master path, not the per-release path', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '../ops/cron/install.sh'), 'utf8');
  assert.match(body, /CRON_BASE=\$\{AGENT_CURRENT:-\$AGENT_HOME\/agent-master\}/, 'crons must resolve via the stable symlink');
  for (const script of ['ops/cron/disk-guard.sh', 'ops/cron/dead-tenant-sweep.sh', 'scripts/bugs-collector-cron.sh', 'scripts/issue-fixer-cron.sh', 'ops/cron/mcp-source-canary.sh']) {
    assert.match(body, new RegExp(`\\$CRON_BASE/${script.replace(/[.]/g, '\\.')}`), `${script} cron must run via $CRON_BASE`);
  }
  assert.doesNotMatch(body, /echo ".*\$REPO_DIR\/scripts\/(bugs-collector|issue-fixer)-cron\.sh"/, 'cron entries must not point at the per-release dir');
});



test('deploy.sh skips the restart when the target SHA is already live (PR run + push run double deploy)', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '../scripts/deploy.sh'), 'utf8');
  const skip = body.indexOf('already live');
  assert.ok(skip > 0, 'same-SHA guard present');
  assert.ok(skip < body.indexOf('==> Building release'), 'guard runs before build and before the service is stopped');
  assert.match(body, /FORCE_DEPLOY/);
  const manual = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy-manual.yml'), 'utf8');
  assert.match(manual, /FORCE_DEPLOY=1 DEPLOY_ENV=gcp/, 'manual deploy keeps forcing a restart');
});
