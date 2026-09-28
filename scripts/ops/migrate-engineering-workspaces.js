#!/usr/bin/env node
'use strict';

// One-time move of engineering workspaces + mirrors from the shared data dir into each
// profile (issue #1649; new layout: src/data-paths.js engineeringWorkspaceRoot /
// engineeringMirrorsRoot). Dry run by default; --apply to change anything. Run as the
// service user, with the service stopped or quiet (no engineering step running).
//
//   old: $AGENT_DATA_DIR/engineering-workspaces/<p>/<repo>/ws-*/code   (+ shared store)
//        $AGENT_DATA_DIR/engineering-mirrors/<mirror>                  (shared by all)
//   new: $USERS_DIR/<p>/engineering-workspaces/<p>/<repo>/ws-*/code    (+ own store)
//        $USERS_DIR/<p>/engineering-mirrors/<mirror>                   (per profile copy)
//
// Store records (.engineering-workspaces/**.json) of a profile are copied with the old
// paths rewritten; worktree <-> mirror links are rebuilt with `git worktree repair`.
// Nothing old is deleted: the old dirs stay as they are (workspaces are moved, so their
// old place is empty; mirrors and the shared store are copied, not moved).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const GROUP = (process.argv.find(a => a.startsWith('--group=')) || '--group=ta-agents').split('=')[1];
const DATA = process.env.AGENT_DATA_DIR || path.join(process.env.HOME, 'agent-data');
const USERS = process.env.USERS_DIR || path.join(process.env.HOME, 'users');
const OLD_ROOT = path.join(DATA, 'engineering-workspaces');
const OLD_MIR = path.join(DATA, 'engineering-mirrors');
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const OLD_MIR_REAL = real(OLD_MIR);
const STORE = '.engineering-workspaces';

const log = (...a) => console.log(APPLY ? '' : '[dry-run]', ...a);
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

// ws-*/code worktrees of a principal and the mirror each belongs to (from its .git file)
function worktreesOf(pDir) {
  const out = [];
  for (const repo of fs.readdirSync(pDir, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    for (const ws of fs.readdirSync(path.join(pDir, repo.name), { withFileTypes: true })) {
      if (!ws.isDirectory() || !ws.name.startsWith('ws-')) continue;
      const code = path.join(pDir, repo.name, ws.name, 'code');
      let gitdir = null;
      try { gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(code, '.git'), 'utf8'))?.[1]?.trim(); } catch { /* not a worktree */ }
      // git records the real path — compare against the real mirrors root
      const base = gitdir && [OLD_MIR, OLD_MIR_REAL].find(r => gitdir.startsWith(r + path.sep));
      const mirror = base ? gitdir.slice(base.length + 1).split(path.sep)[0] : null;
      out.push({ code, rel: path.relative(pDir, code), mirror, gitdir, mirrorBase: base || null });
    }
  }
  return out;
}

function shareWithSlots(target) {
  try { execFileSync('getent', ['group', GROUP], { stdio: 'ignore' }); } catch { return; } // run-as not set up here
  const svc = require('os').userInfo().username;
  const spec = `g:${GROUP}:rwX,d:g:${GROUP}:rwX,d:u:${svc}:rwX,m::rwx,d:m::rwx`;
  if (APPLY) execFileSync('setfacl', ['-R', '-P', '-m', spec, target]); else log('setfacl -R -P -m', spec, target);
}

function main() {
  if (!fs.existsSync(OLD_ROOT)) { console.log(`nothing to migrate: ${OLD_ROOT} does not exist`); return; }
  const principals = fs.readdirSync(OLD_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== STORE).map(e => e.name);
  const storeFiles = fs.existsSync(path.join(OLD_ROOT, STORE))
    ? walk(path.join(OLD_ROOT, STORE)).filter(f => f.endsWith('.json')) : [];
  let problems = 0;

  for (const p of principals) {
    const oldP = path.join(OLD_ROOT, p);
    const profile = path.join(USERS, p);
    if (!fs.existsSync(profile)) { console.log(`skip ${p}: no profile dir ${profile}`); continue; }
    const newRoot = path.join(profile, 'engineering-workspaces');
    const newMir = path.join(profile, 'engineering-mirrors');
    const newP = path.join(newRoot, p);
    const wts = worktreesOf(oldP);
    const mirrors = [...new Set(wts.map(w => w.mirror).filter(Boolean))];
    console.log(`\n== ${p}: ${wts.length} worktree(s), mirrors: ${mirrors.join(', ') || '-'}`);
    if (fs.existsSync(newP)) { console.log(`   already migrated (${newP} exists) — skipped`); continue; }

    // 1. per-profile mirror copies
    for (const m of mirrors) {
      const dst = path.join(newMir, m);
      if (fs.existsSync(dst)) { log(`mirror exists: ${dst}`); continue; }
      log(`copy mirror ${path.join(OLD_MIR, m)} -> ${dst}`);
      if (APPLY) { fs.mkdirSync(newMir, { recursive: true }); execFileSync('cp', ['-a', path.join(OLD_MIR, m), dst]); }
    }
    // 2. move the principal's workspaces
    log(`move ${oldP} -> ${newP}`);
    if (APPLY) { fs.mkdirSync(newRoot, { recursive: true }); fs.renameSync(oldP, newP); }
    // 3. this principal's store records, paths rewritten
    const mine = storeFiles.filter(f => {
      const t = fs.readFileSync(f, 'utf8');
      const oldPReal = path.join(real(OLD_ROOT), p);
      return t.includes(`"${p}"`) || [oldP, oldPReal].some(x => t.includes(x + path.sep) || t.includes(x + '"'));
    });
    for (const f of mine) {
      const dst = path.join(newRoot, path.relative(OLD_ROOT, f));
      const oldRootReal = real(OLD_ROOT);
      const text = fs.readFileSync(f, 'utf8')
        .split(oldP).join(newP).split(path.join(oldRootReal, p)).join(newP)
        .split(OLD_MIR_REAL).join(newMir).split(OLD_MIR).join(newMir)
        .split(oldRootReal).join(newRoot).split(OLD_ROOT).join(newRoot);
      log(`store ${path.relative(OLD_ROOT, f)} -> ${dst}`);
      if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, text); }
    }
    if (APPLY && mine.length) for (const d of ['owners', 'workspaces', 'intents', 'operations', 'locks']) fs.mkdirSync(path.join(newRoot, STORE, d), { recursive: true });
    // 4. relink every worktree to the per-profile mirror copy. `git worktree repair`
    // alone keeps a link to the OLD mirror (it still exists and is valid), so both
    // ends are rewritten explicitly: <code>/.git -> new admin dir, admin gitdir -> <code>.
    for (const w of wts.filter(x => x.mirror)) {
      const code = path.join(newP, w.rel);
      const newAdmin = path.join(newMir, w.gitdir.slice(w.mirrorBase.length + 1));
      log(`relink ${code} -> ${newAdmin}`);
      if (!APPLY) continue;
      try {
        fs.writeFileSync(path.join(code, '.git'), `gitdir: ${newAdmin}\n`);
        fs.writeFileSync(path.join(newAdmin, 'gitdir'), `${path.join(code, '.git')}\n`);
        git(['status', '--porcelain'], code);
      } catch (e) { problems++; console.error(`   BROKEN worktree ${code}: ${String(e.stderr || e.message).trim()}`); }
    }
    // 5. slots of this profile may use them (moved/copied trees keep their old ACLs)
    for (const t of [newRoot, newMir]) if (!APPLY || fs.existsSync(t)) shareWithSlots(t);
  }
  console.log(`\n${APPLY ? 'done' : 'dry run only — re-run with --apply'}${problems ? ` — ${problems} problem(s), see above` : ''}`);
  if (problems) process.exitCode = 1;
}

main();
