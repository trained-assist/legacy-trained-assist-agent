#!/bin/sh
# Idempotently install the Claude Code OAuth refresh broker as a user cron job.
#
# WHY CRON: this box's agent user is non-interactive (no user-DBus session), so
# `systemctl --user` is unavailable; every other scheduled ops job here lives in
# the user crontab (ops/cron/install.sh). The broker rides the same mechanism so
# a box reprovision re-creates it from deploy instead of silently dropping the
# guard that keeps the operator logged in. See docs/claude-oauth-refresh.md.
#
# (systemd units under scripts/systemd/ remain in the repo as an alternative for
# hosts that DO have an enabled user manager / linger.)
#
# Safe to run repeatedly: rewrites only the block between the markers below,
# leaving all other crontab entries untouched.
set -e
REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# The cron entry must point at the STABLE ~/agent-master symlink, never at
# $REPO_DIR: deploy runs this from /home/vova/agent-releases/<sha>, and that
# path dies with the next release GC (ops/cron/install.sh resolves the same way).
# $REPO_DIR stays as the dev fallback (a plain checkout has no agent-master).
CRON_BASE=${AGENT_CURRENT:-}
if [ -z "$CRON_BASE" ]; then
  if [ -d "$HOME/agent-master" ]; then CRON_BASE="$HOME/agent-master"; else CRON_BASE="$REPO_DIR"; fi
fi
WRAPPER="$CRON_BASE/ops/cron/claude-token-refresh.sh"
BEGIN="# >>> trained-assist claude-oauth-refresh (managed by scripts/install-claude-token-refresh.sh) >>>"
END="# <<< trained-assist claude-oauth-refresh <<<"

chmod +x "$WRAPPER" 2>/dev/null || true  # release dir may be root-owned

block() {
  echo "$BEGIN"
  # Every 30m: refresh iff < 3h left, so the token is always fresh before any
  # claude subprocess would refresh itself. OnBoot-equivalent handled by cron @reboot.
  echo "@reboot $WRAPPER"
  echo "*/30 * * * * $WRAPPER"
  echo "$END"
}

current=$(crontab -l 2>/dev/null || true)
# Strip any existing managed block and any legacy line referencing the wrapper by
# basename, so a box patched live before this was version-controlled migrates
# cleanly instead of running the broker twice.
stripped=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '
  $0==b {skip=1} skip && $0==e {skip=0; next} skip {next}
  /claude-token-refresh\.sh/ {next}
  {print}')
{ printf '%s\n' "$stripped" | sed '/^$/d'; block; } | crontab -

echo "Installed claude-oauth-refresh cron (user=$USER, repo=$REPO_DIR):"
crontab -l | sed -n "/claude-oauth-refresh/,/claude-oauth-refresh </p"
echo "Manual run:  node $REPO_DIR/scripts/claude-token-refresh.js --dry-run"
