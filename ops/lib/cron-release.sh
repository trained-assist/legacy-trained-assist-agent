#!/bin/sh
# Which code is a scheduled job about to run? — the release, or a plain checkout?
#
# WHY (2026-09-28 incident): three cron wrappers hardcoded
# `cd "$HOME/trained-assist-agent"`, while `~/trained-assist-agent` is a *working
# checkout* that sessions flip between branches. It sat on `pr-1446-fix3` for two
# days, the mainstream tester silently ran a stale decider without src/service-llm.js,
# and every one of its 12 steps collapsed into the same fallback answer — with zero
# errors in the log, because from inside the checkout nothing looks wrong.
#
# The deployed code lives behind ~/agent-master (issue #1391) and carries a
# `.release-sha` written by scripts/release-lib.sh. So:
#   * resolve the code dir through the release marker, not through habit;
#   * print one signed line per cron run — `release=<sha>` in the log is the
#     receipt that the run exercised what is actually deployed;
#   * shout when a job is running from a checkout instead of the release.
#
# Usage in a cron wrapper (bash or sh):
#   . "$HOME/agent-master/ops/lib/cron-release.sh"
#   APP_DIR=$(cron_app_dir)
#   cron_banner "bugs-collector" "$APP_DIR"
#   cd "$APP_DIR"
#
# Both functions only ever print to stdout — they never exit non-zero, so a
# `set -euo pipefail` wrapper cannot die on them.

# Prefer the release; fall back to the checkout only when no release exists
# (a freshly provisioned box before its first deploy).
cron_app_dir() {
  _master="${AGENT_CURRENT:-$HOME/agent-master}"
  if [ -f "$_master/.release-sha" ]; then
    printf '%s\n' "$_master"
  else
    printf '%s\n' "${CRON_FALLBACK_DIR:-$HOME/trained-assist-agent}"
  fi
}

# One signed line per run. Human-readable, greppable, and loud on a checkout.
cron_banner() {
  _label="$1"
  _dir="$2"
  if [ -f "$_dir/.release-sha" ]; then
    _sha=$(cat "$_dir/.release-sha" 2>/dev/null | tr -d '[:space:]')
    printf '[release] %s: release=%.12s path=%s\n' "$_label" "${_sha:-unknown}" "$_dir"
    return 0
  fi
  # Not a release: say which checkout and which branch, so a stale-branch run is
  # obvious in the log instead of looking like a product bug.
  _branch=$(git -C "$_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  _sha=$(git -C "$_dir" rev-parse --short HEAD 2>/dev/null || echo '?')
  printf '[release] %s: CHECKOUT branch=%s sha=%s path=%s\n' "$_label" "$_branch" "$_sha" "$_dir"
  printf '[release] %s: WARNING — cron is running a plain checkout, NOT the deployed release. Breaks as soon as anyone checks out another branch.\n' "$_label"
  return 0
}
