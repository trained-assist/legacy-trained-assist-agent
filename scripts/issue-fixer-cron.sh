#!/usr/bin/env bash
# Cron wrapper — one issue-fixer pass: queue new candidates, gate pending ones,
# then execute anything the gate marked fixability=auto.
# Crontab entry: 0 * * * * /home/vova/trained-assist-agent/scripts/issue-fixer-cron.sh
#
# Hourly by design: unlike the bugs-collector (which debounces on file quiet-time and
# so benefits from a tight poll), each stage here makes GitHub API + LLM + (for execute)
# a full clone/npm-install/opencode/CI-check pass — expensive per issue, and there is no
# quiet-file gate to protect. Hourly keeps the backlog moving without hammering the API
# or burning OpenRouter/opencode spend on issues that haven't changed.
#
# No auto-merge anywhere in this pipeline (explicit from the owner's voice memo,
# ISSUES-TO-PR-SPEC.md §0/§3) — execute only opens a PR for a human to review.
set -euo pipefail

LOG_DIR="$HOME/agent-data/issue-fixer-logs"
mkdir -p "$LOG_DIR"

# Keep only the last 200 run logs (best-effort: empty dir must not abort the run under set -e)
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +201 | xargs -r rm -- || true

# GITHUB_ISSUES_TOKEN + OPENROUTER_API_KEY live in secrets.env (same source as bugs-collector-cron).
if [ -f "$HOME/secrets.env" ]; then
  set -a
  . "$HOME/secrets.env"
  set +a
fi

# Resolve the code dir through the release marker (ops/lib/cron-release.sh):
# this wrapper used to hardcode `cd ~/trained-assist-agent`, so it silently ran
# whatever branch that checkout happened to be on (2026-09-28: two days on a
# feature branch, stale code, no errors anywhere). Never hardcode it again.
#
# The banner goes to a status file, NOT stdout: cron mails any output and this
# job runs every 2 minutes (MAILTO unset + no MTA = syslog spam, not mail).
STATUS_FILE="$LOG_DIR/last-release.txt"
REL_LIB="$HOME/agent-master/ops/lib/cron-release.sh"
[ -f "$REL_LIB" ] || REL_LIB="$HOME/trained-assist-agent/ops/lib/cron-release.sh"
if [ -f "$REL_LIB" ]; then
  . "$REL_LIB"
  APP_DIR=$(cron_app_dir)
  { cron_banner "issue-fixer" "$APP_DIR"; echo "at $(date -u +%FT%TZ)"; } > "$STATUS_FILE"
  cd "$APP_DIR"
else
  # No helper (box predates it): keep the legacy path so the job still runs.
  echo "[release] issue-fixer: WARNING — cron-release.sh not found, using legacy ~/trained-assist-agent" > "$STATUS_FILE"
  cd "$HOME/trained-assist-agent"
fi

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
STAGE_FAILED=0

run_stage() {
  local flag="$1"
  if ! OUT="$(node src/issue-fixer.js "$flag" 2>&1)"; then
    { echo "[cron] issue-fixer $flag FAILED $(date)"; printf '%s\n' "$OUT"; } >> "$LOGFILE" 2>&1
    STAGE_FAILED=1
    return
  fi
  echo "[cron] issue-fixer $flag $(date)" >> "$LOGFILE" 2>&1
  printf '%s\n' "$OUT" >> "$LOGFILE" 2>&1
}

# Queue → gate → execute, in order: execute only acts on issues the gate already
# labelled this same pass (or a previous one) as fixability=auto.
run_stage ""
run_stage "--gate"
run_stage "--execute"

if [ "$STAGE_FAILED" -eq 0 ] && ! grep -qE 'candidates=[1-9]|pending=[1-9]|executable=[1-9]' "$LOGFILE"; then
  # Nothing happened this pass — drop the log to keep the directory quiet, same as
  # bugs-collector-cron's "no reports due" convention.
  rm -f "$LOGFILE"
fi

exit 0
