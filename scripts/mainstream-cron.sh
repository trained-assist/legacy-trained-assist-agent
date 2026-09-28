#!/usr/bin/env bash
# Cron wrapper — loads secrets and runs one mainstream test cycle.
# Crontab entry: 0 */4 * * * /home/vova/agent-master/scripts/mainstream-cron.sh
set -euo pipefail

LOG_DIR="$HOME/agent-data/mainstream-logs"
mkdir -p "$LOG_DIR"

# Keep only last 30 log files (best-effort: empty dir must not abort the run under set -e)
ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +31 | xargs -r rm -- || true

LOGFILE="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"

{
  echo "[cron] mainstream test started $(date)"

  set -a
  source "$HOME/secrets.env"
  set +a

  ANTHROPIC_API_KEY=$(GOOGLE_APPLICATION_CREDENTIALS="" gcloud secrets versions access latest \
    --secret=ANTHROPIC_API_KEY --project=alesa-personal-assistent 2>/dev/null)
  export ANTHROPIC_API_KEY
  export SECRETS_SOURCE=env

  # Run the DEPLOYED code — the agent service runs from ~/agent-master, so the tester
  # must exercise the same code. The plain checkout ~/trained-assist-agent can sit on
  # an arbitrary feature branch (2026-09-28: pr-1446-fix3, no src/service-llm.js —
  # cron was silently testing a months-old decider).
  APP_DIR="$HOME/agent-master"
  if [[ ! -e "$APP_DIR/src/mainstream-tester/index.js" ]]; then
    APP_DIR="$HOME/trained-assist-agent"
  fi
  echo "[cron] code dir: $APP_DIR -> $(readlink -f "$APP_DIR" 2>/dev/null || echo '?')"

  cd "$APP_DIR"
  MAINSTREAM_STEPS=7 MAINSTREAM_RUNS=1 \
    timeout 900 node src/mainstream-tester/index.js

  echo "[cron] done $(date)"
} >> "$LOGFILE" 2>&1

# Summarize accumulated bug counts (durable cross-run logs, not per-invocation dir)
GLOBAL_BUGS="$HOME/agent-data/mainstream-test/bugs.jsonl"
DRIVER_LOG="$HOME/agent-data/mainstream-test/driver-errors.jsonl"
if [[ -f "$GLOBAL_BUGS" ]]; then
  BUG_COUNT=$(wc -l < "$GLOBAL_BUGS")
  echo "[cron] total accumulated bugs: $BUG_COUNT → $GLOBAL_BUGS" >> "$LOGFILE"
fi
if [[ -f "$DRIVER_LOG" ]]; then
  DRIVER_COUNT=$(wc -l < "$DRIVER_LOG")
  echo "[cron] total accumulated driver errors: $DRIVER_COUNT → $DRIVER_LOG" >> "$LOGFILE"
fi
