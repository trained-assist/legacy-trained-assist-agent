#!/bin/bash
# Deploy the RU-IP edge (src/ru-edge.js) as an immutable release (#1288, #1391).
#
# Same release-directory model as scripts/deploy.sh: prod runs from
# ~/agent-master -> ~/agent-releases/<sha>, built from the commit, never from
# the session worktree. Unlike the full agent there is no task-queue, no Claude,
# no MCP, no workspace migration and no HH sibling checkout — a plain restart.
#
# No engine on this box, by design (#1288): ru-edge never spawns opencode/claude,
# so scripts/engine-forever.sh (the pinned opencode fork) is deliberately NOT run
# here and must not be — there is no engine to provision. Verified 2026-10-04 on
# the live box: no opencode package, no engine processes, no engine database.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"

SERVICE="ru-edge"
REPO_DIR="${REPO_DIR:-$(pwd)}"                              # git source; may be a session worktree
# Absolute paths, NOT $HOME: on the shared RU box the SSH deploy user is not
# the service user (vova), while ru-edge.service hardcodes /home/vova/agent-master.
AGENT_HOME="${AGENT_HOME:-/home/vova}"
RELEASES_DIR="${RELEASES_DIR:-$AGENT_HOME/agent-releases}"
CURRENT_LINK="${CURRENT_LINK:-$AGENT_HOME/agent-master}"
TARGET="${DEPLOY_TARGET_COMMIT:-$(git -C "$REPO_DIR" rev-parse HEAD)}"
RELEASE_DIR="$RELEASES_DIR/$TARGET"
export REPO_DIR RELEASES_DIR CURRENT_LINK SERVICE

if [ "${ASSIST_DEPLOY_LOCKED:-}" != 1 ]; then
  exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-$HOME/.assist-deploy.lock}"
  flock -n 9 || { echo "Another deploy owns the lock"; exit 1; }
  export ASSIST_DEPLOY_LOCKED=1
fi

if [ ! -e "$CURRENT_LINK" ]; then
  echo "==> Bootstrap: agent-master absent; pointing it at $REPO_DIR for rollback safety"
  release_set_link "$CURRENT_LINK" "$REPO_DIR"
fi
PREV_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
export PREV_RELEASE

rollback() {
  if [ -z "$PREV_RELEASE" ] || [ ! -d "$PREV_RELEASE" ]; then
    echo "No previous release recorded; cannot roll back" >&2
    return 1
  fi
  echo "==> Rolling back to $PREV_RELEASE..."
  $SUDO systemctl stop "$SERVICE" || return 1
  release_set_link "$CURRENT_LINK" "$PREV_RELEASE" || return 1
  $SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
  $SUDO systemctl start "$SERVICE" || return 1
  echo "==> Rolled back to $PREV_RELEASE. Deploy failed."
}

on_deploy_error() {
  local code=$?
  trap - ERR
  echo "Deploy failed (exit $code); attempting rollback"
  rollback || echo "ROLLBACK FAILED: operator recovery required"
  exit "$code"
}

# ── Everything below until "Stopping service" runs while the old process keeps serving ──

echo "==> Building release for $TARGET..."
release_build "$REPO_DIR" "$TARGET" "$RELEASES_DIR"
RELEASE_DIR="$(readlink -f "$RELEASES_DIR/$TARGET")"

# ru-edge needs Playwright Chromium (nalog.ru/ESIA login + /playwright-fetch).
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  (cd "$RELEASE_DIR" && npx playwright install chromium --with-deps 2>&1 | tail -5) || true
fi

echo "==> Validating and applying nginx config (ru)..."
REPO_DIR="$RELEASE_DIR" DEPLOY_ENV=ru bash "$RELEASE_DIR/scripts/deploy-nginx.sh"

trap on_deploy_error ERR

echo "==> Installing systemd unit file..."
UNIT_SRC="$RELEASE_DIR/systemd/${SERVICE}.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
NOTIFY_SRC="$RELEASE_DIR/systemd/assist-agent-notify-failure.service"
NOTIFY_DST="/etc/systemd/system/assist-agent-notify-failure.service"
CHANGED=0
if ! diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
  $SUDO cp "$UNIT_SRC" "$UNIT_DST"
  CHANGED=1
  echo "  Unit file updated"
else
  echo "  Unit file unchanged"
fi
if [ -f "$NOTIFY_SRC" ] && ! diff -q "$NOTIFY_SRC" "$NOTIFY_DST" >/dev/null 2>&1; then
  $SUDO cp "$NOTIFY_SRC" "$NOTIFY_DST"
  CHANGED=1
  echo "  Notify-failure unit updated"
fi

# Retired: the old assist-agent-ru.service (Claude Code + task-queue on RU).
if [ -f /etc/systemd/system/assist-agent.service ] && systemctl list-unit-files | grep -q '^assist-agent.service'; then
  UNIT_TEXT=$(cat /etc/systemd/system/assist-agent.service 2>/dev/null || true)
  if echo "$UNIT_TEXT" | grep -q 'VM_NAME=ru-vm'; then
    echo "==> Retiring old assist-agent.service (RU Claude instance)..."
    $SUDO systemctl disable --now assist-agent.service 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/assist-agent.service
    CHANGED=1
  fi
fi

if [ "$CHANGED" = "1" ]; then
  $SUDO systemctl daemon-reload
  echo "  daemon reloaded"
fi

echo "==> Ensuring data directories exist..."
$SUDO -u vova mkdir -p /home/vova/agent-tokens /home/vova/users

# ── Downtime window starts here ──────────────────────────────────────────────

echo "==> Stopping service..."
$SUDO systemctl stop "$SERVICE" 2>/dev/null || true

cd "$RELEASE_DIR"

$SUDO fuser -k 8080/tcp 2>/dev/null || true

echo "==> Activating release (atomic symlink swap)..."
release_set_link "$CURRENT_LINK" "$RELEASE_DIR"

echo "==> Starting service..."
$SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
$SUDO systemctl enable --now "$SERVICE"

echo "==> Waiting for service to be healthy (up to 60s)..."
HEALTHY=0
for i in $(seq 1 60); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:8080/health 2>/dev/null || echo 000)
  if [ "$STATUS_CODE" = "200" ]; then HEALTHY=1; echo "  healthy after ${i}s"; break; fi
  sleep 1
done
$SUDO systemctl status "$SERVICE" --no-pager --lines=10 || true
echo "==> Service journal (last 20 lines)..."
$SUDO journalctl -u "$SERVICE" --no-pager -n 20 || true

if [ "$HEALTHY" = "0" ]; then
  echo "ERROR: service did not respond on /health after 60s — failing deploy to trigger rollback"
  false
fi
trap - ERR

echo "==> Garbage-collecting old releases..."
release_gc "$RELEASES_DIR" 3

echo "==> Deploy complete ✅"
