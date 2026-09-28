#!/usr/bin/env bash
# Cron wrapper — one bugs-collector pass across all profiles.
# Crontab entry: */2 * * * * /home/vova/trained-assist-agent/scripts/bugs-collector-cron.sh
#
# Collection is debounced in src/bugs-collector.js: a report is only filed once nothing
# under its folder changed for BUGS_COLLECTOR_QUIET_MS (default 3 min). So the cron can
# run often without ever grabbing a half-written report.
#
# Quiet by default: a pass that finds nothing due writes no log file; only activity or a
# failure leaves an artifact, and the last 200 artifacts are kept.
set -euo pipefail

LOG_DIR="$HOME/agent-data/bugs-collector-logs"
mkdir -p "$LOG_DIR"

# Keep only the last 200 run logs (best-effort: empty dir must not abort the run under set -e)
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +201 | xargs -r rm -- || true

# GITHUB_ISSUES_TOKEN + OPENROUTER_API_KEY live in secrets.env (same source as mainstream-cron).
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
  { cron_banner "bugs-collector" "$APP_DIR"; echo "at $(date -u +%FT%TZ)"; } > "$STATUS_FILE"
  cd "$APP_DIR"
else
  # No helper (box predates it): keep the legacy path so the job still runs.
  echo "[release] bugs-collector: WARNING — cron-release.sh not found, using legacy ~/trained-assist-agent" > "$STATUS_FILE"
  cd "$HOME/trained-assist-agent"
fi

if ! OUT="$(node src/bugs-collector.js 2>&1)"; then
  LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
  { echo "[cron] bugs-collector FAILED $(date)"; printf '%s\n' "$OUT"; } >> "$LOGFILE" 2>&1
  exit 0
fi

# Log only when there was something to report — silence means "nothing due".
if ! printf '%s' "$OUT" | grep -q 'no reports due'; then
  LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
  { echo "[cron] $(date)"; printf '%s\n' "$OUT"; } >> "$LOGFILE" 2>&1
fi
