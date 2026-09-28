#!/usr/bin/env node
// Post-deploy gate (SS-13, docs/user-scenarios/core/02-stop-and-supplement.md):
// the service is "healthy" only when /health answers 200 AND reports the commit
// this deploy built. A bare 200 also passes when the old process is still
// serving — then a merge silently never reaches prod.
//
// Usage: check-health-commit.js <healthUrl> <targetSha>   → exit 0 on match.
'use strict';

function commitMatches(reported, target) {
  const r = String(reported || '').trim().toLowerCase();
  const t = String(target || '').trim().toLowerCase();
  if (!r || r === 'unknown' || !t) return false;
  // /health reports a short sha; a full sha is also accepted.
  return r.length <= t.length ? t.startsWith(r) : r.startsWith(t);
}

async function checkHealthCommit(url, target, { timeoutMs = 2000 } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: `unreachable: ${e.message}` };
  }
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
  const body = await res.json().catch(() => ({}));
  if (!commitMatches(body.commit, target)) {
    return { ok: false, reason: `serving commit ${body.commit || 'none'}, expected ${String(target).slice(0, 7)}` };
  }
  return { ok: true, commit: body.commit };
}

module.exports = { commitMatches, checkHealthCommit };

if (require.main === module) {
  const [url, target] = process.argv.slice(2);
  if (!url || !target) {
    console.error('usage: check-health-commit.js <healthUrl> <targetSha>');
    process.exit(2);
  }
  checkHealthCommit(url, target).then(r => {
    if (!r.ok) console.error(`  health: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  });
}
