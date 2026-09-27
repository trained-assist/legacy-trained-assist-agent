#!/bin/sh
# Idempotently install the prod-box managed crons.
#
# Durable, version-controlled home of:
#   disk-guard.sh        hourly   Tier1 age-guarded .pma reclaim + Tier2 emergency
#                                 reclaim when root fs crosses 85%.
#   dead-tenant-sweep.sh weekly   REPORT-ONLY tenant hygiene ledger (never deletes).
#   bugs-collector-cron.sh */2min cross-profile Bugs & Features collector (files GitHub
#                                 issues once a report folder has been quiet for
#                                 BUGS_COLLECTOR_QUIET_MS, default 3 min). Runs often
#                                 BY DESIGN so the quiet gate — not the cron — decides
#                                 when a report is ready; 6h+ cadence would add hours of
#                                 latency for no benefit. See src/bugs-collector.js.
#   issue-fixer-cron.sh  hourly   queue -> relevance-gate -> execute pass over the issue
#                                 backlog (src/issue-fixer.js). Hourly, not tight-poll like
#                                 the collector: each stage costs a GitHub/LLM call and
#                                 execute costs a full clone+CI pass, with no quiet-file
#                                 gate protecting it. No auto-merge — execute only opens
#                                 a PR for a human to review.
#
# These first built live on the box (.pma runaway incident 2026-09-13, collector 2026-09-22).
# Keeping them here + installing from deploy means a box reprovision re-creates them instead
# of silently dropping them.
#
# Safe to run repeatedly: it rewrites only the block between the markers below,
# leaving any other user crontab entries untouched.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$DIR/../.." && pwd)
# Crons run the deployed code through the STABLE agent-master symlink, not the
# per-release path: they then survive release GC and always execute whatever is
# currently deployed. Absolute (not $HOME) — the deploy user is not the service
# user on the shared RU box.
AGENT_HOME=${AGENT_HOME:-/home/vova}
CRON_BASE=${AGENT_CURRENT:-$AGENT_HOME/agent-master}
BEGIN="# >>> trained-assist disk-hygiene (managed by ops/cron/install.sh) >>>"
END="# <<< trained-assist disk-hygiene <<<"

# Exec bits come from git (all four are 100755); the release dir is root-owned
# and not chmod-able by the deploy user, so this is best-effort only.
chmod +x "$DIR/disk-guard.sh" "$DIR/dead-tenant-sweep.sh" "$REPO_DIR/scripts/bugs-collector-cron.sh" "$REPO_DIR/scripts/issue-fixer-cron.sh" 2>/dev/null || true

block() {
  echo "$BEGIN"
  echo "0 * * * * $CRON_BASE/ops/cron/disk-guard.sh"
  echo "30 6 * * 1 $CRON_BASE/ops/cron/dead-tenant-sweep.sh"
  echo "*/2 * * * * $CRON_BASE/scripts/bugs-collector-cron.sh"
  echo "5 * * * * $CRON_BASE/scripts/issue-fixer-cron.sh"
  echo "$END"
}

current=$(crontab -l 2>/dev/null || true)
# Strip (a) any existing managed block and (b) any legacy hand-installed line
# referencing these scripts by basename — so a box that was patched live before
# this was version-controlled migrates cleanly instead of running each cron twice.
stripped=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0==b {skip=1} skip && $0==e {skip=0; next} skip {next}
  /disk-guard\.sh/ {next} /dead-tenant-sweep\.sh/ {next} /bugs-collector-cron\.sh/ {next} /issue-fixer-cron\.sh/ {next} /mcp-source-canary\.sh/ {next}
  {print}')
{ printf '%s\n' "$stripped" | sed '/^$/d'; block; } | crontab -

echo "Installed disk-hygiene crons:"
crontab -l | sed -n "/$(printf '%s' "$BEGIN" | sed 's/[][\/.*^$]/\\&/g')/,/$(printf '%s' "$END" | sed 's/[][\/.*^$]/\\&/g')/p"
