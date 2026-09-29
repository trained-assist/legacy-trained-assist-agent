'use strict';
// phases/credentials-reachability.cjs — migration invariant «credential →
// reachable by its consumer» (#1891, epic #1885). Precondition for moving
// profiles to Google Storage (#1789/#1808) and for turning on encryption.
//
// For every entry of config/credentials.json (src/credential-registry.js) and
// one profile it answers: reachable yes/no, and from where (source) — the env
// name that carried it, or the declared file relative to its root. Names and
// sha256 of file content only; a value never reaches the report or the ledger.
//
//   --dry-run  report (writes nothing)
//   --apply    ledger the report as the BEFORE baseline (moves nothing)
//   --verify   report again: a profile credential reachable in the baseline and
//              unreachable now fails the phase (exit 2) with its name
//   --revert   no-op
//
// «Reachable» (requirements R1): a declared env name (canonical or alias) is set
// and non-empty, or a declared file exists and reads through credential-store
// (so an encrypted file without CRED_ENCRYPTION_KEY is NOT reachable).
// Platform credentials (host env, the same for every profile) are reported but
// never fail verify: a profile migration cannot change the host env, and the
// operator's shell env differs between runs.
const fs = require('fs');
const path = require('path');
const ledger = require('../ledger.cjs');

const REACHABLE = 'CRED_REACHABLE';
const UNREACHABLE = 'CRED_UNREACHABLE';

// Per call, not at load: tests and the sandbox point AGENT_TOKENS_DIR elsewhere.
const registry = () => require('../../../src/credential-registry.js');
const dataPaths = () => require('../../../src/data-paths.js');
const credentialStore = () => require('../../../src/credential-store.js');

function envSource(names, env) {
  return names.find(n => typeof env[n] === 'string' && env[n] !== '') || null;
}

function fileProbe(ctx, root, rel) {
  const base = root === 'profile' ? ctx.profileRoot : path.join(dataPaths().tokensRoot(), ctx.profile);
  const abs = path.join(base, rel);
  try {
    if (!fs.statSync(abs).isFile()) return null;
    credentialStore().readCredentialFile(abs); // decrypts if encrypted; value is dropped here
    return { source: `file:${root}/${rel}`, sha256: ledger.hashPath(abs).sha256 };
  } catch {
    return null;
  }
}

function scanWith(ctx, reg, env = process.env) {
  const out = [];
  for (const c of reg.credentials) {
    const envNames = c.env || [];
    if (c.scope === 'platform') {
      for (const name of envNames) {
        const src = envSource([name, ...(envNames.length === 1 ? c.aliases || [] : [])], env);
        out.push({ consumer: c.consumer, name, scope: c.scope, reachable: !!src, source: src, invariant: false });
      }
      continue;
    }
    const name = envNames[0] || c.consumer;
    let hit = null;
    const src = envSource([...envNames, ...(c.aliases || [])], env);
    if (src) hit = { source: src };
    for (const f of c.files || []) {
      const probe = fileProbe(ctx, c.filesRoot || 'tokens', f);
      if (probe) { hit = hit ? { ...hit, sha256: probe.sha256 } : probe; break; }
    }
    out.push({
      consumer: c.consumer, name, scope: c.scope, reachable: !!hit, source: hit ? hit.source : null,
      ...(hit && hit.sha256 ? { sha256: hit.sha256 } : {}), invariant: true,
    });
  }
  return out;
}

const ledgerPathOf = item => `credentials/${item.consumer}/${item.name}`;

module.exports = {
  name: 'credentials-reachability',
  description: 'invariant: every credential reachable before the migration is reachable after (names + hashes only)',
  inventory: true,
  resultKey: 'credentials',

  scan(ctx) {
    return scanWith(ctx, registry().load());
  },

  record(ctx, items) {
    for (const it of items) {
      ledger.appendRecord(ctx.profile, {
        ...ledger.makeRecord({
          phase: this.name, profile: ctx.profile, path: ledgerPathOf(it),
          sha256: it.sha256 || null, size: 0, action: it.reachable ? REACHABLE : UNREACHABLE, dest: null,
        }),
        scope: it.scope, source: it.source, invariant: it.invariant,
      });
    }
  },

  check(ctx, items, folded) {
    const now = new Map(items.map(it => [ledgerPathOf(it), it]));
    const failures = [];
    for (const st of folded) {
      if (st.action !== REACHABLE) continue;
      const cur = now.get(st.path);
      // An entry removed from the registry is a reviewed code change, not a loss
      // caused by the migration; platform entries never gate (see header).
      if (!cur || !cur.invariant || cur.reachable) continue;
      failures.push({
        path: st.path, state: 'reachable-before', status: 'unreachable-now',
        message: `${cur.name} (${cur.consumer}) is no longer reachable by its consumer`,
      });
    }
    return failures;
  },

  scanWith,
};
