#!/bin/bash
# Deploy the agent as an IMMUTABLE RELEASE built from an origin/main commit (#1391).
#
# Prod never runs from a git working tree any more, so a session doing
# checkout/commit in the repo cannot change what is served. Deploy:
#   1. builds ~/agent-releases/<sha>/ from the commit (git archive + npm ci),
#      root-owned, outside the session worktree;
#   2. installs the units (WorkingDirectory=~/agent-master);
#   3. atomically repoints ~/agent-master -> the new release and restarts.
# Rollback = repoint the symlink to the previous release. Restart stays instant:
# no drain, no admission gate; tasks cut off by the stop resume from the journal.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-lib.sh
source "$SCRIPT_DIR/release-lib.sh"

case "${DEPLOY_ENV:-}" in
  gcp) UNIT_VARIANT="" ;;
  ru) UNIT_VARIANT="-ru" ;;
  *) echo "DEPLOY_ENV must be gcp or ru" >&2; exit 1 ;;
esac

SERVICE="assist-agent"
REPO_DIR="${REPO_DIR:-$(pwd)}"                              # git source; may be a session worktree
# Absolute paths, NOT $HOME: the SSH deploy user is not necessarily the service
# user (on the shared RU box it is not vova), while the units hardcode
# /home/vova/agent-master. Releases must land where the service looks.
AGENT_HOME="${AGENT_HOME:-/home/vova}"
RELEASES_DIR="${RELEASES_DIR:-$AGENT_HOME/agent-releases}"
CURRENT_LINK="${CURRENT_LINK:-$AGENT_HOME/agent-master}"
TARGET="${DEPLOY_TARGET_COMMIT:-$(git -C "$REPO_DIR" rev-parse HEAD)}"
RELEASE_DIR="$RELEASES_DIR/$TARGET"
HH_SKILL_DIR="${HH_SKILL_DIR:-$AGENT_HOME/trained-assist-hh-skill}"
ENGINEERING_DIR="${ENGINEERING_DIR:-$AGENT_HOME/trained-assist-engineering}"
FREELANCE_SKILL_DIR="${FREELANCE_SKILL_DIR:-$AGENT_HOME/trained-assist-freelance-skill}"
export REPO_DIR RELEASES_DIR CURRENT_LINK SERVICE

if [ "${ASSIST_DEPLOY_LOCKED:-}" != 1 ]; then
  exec 9>"${ASSIST_DEPLOY_LOCK_FILE:-$HOME/.assist-deploy.lock}"
  flock -n 9 || { echo "Another deploy owns the lock"; exit 1; }
  export ASSIST_DEPLOY_LOCKED=1
fi

# Bootstrap: on the very first release-dir deploy there is no agent-master yet.
# Point it at the current repo so a failed first cutover can still roll back to
# the pre-release behaviour (prod running from the worktree).
if [ ! -e "$CURRENT_LINK" ]; then
  echo "==> Bootstrap: agent-master absent; pointing it at $REPO_DIR for rollback safety"
  release_set_link "$CURRENT_LINK" "$REPO_DIR"
fi
PREV_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
export PREV_RELEASE

# Same-SHA no-op. An auto-merged PR is deployed twice: once by the pull_request run (merge sha) and
# again ~2.5 min later by the push-to-main run the merge itself triggers — both for the SAME commit.
# Each deploy SIGKILLs every running agent session, so the second one was pure damage (2026-09-26:
# 10 merges → 20 hard restarts; group chats died mid-answer twice per merge). FORCE_DEPLOY=1 opts out.
if [ "${FORCE_DEPLOY:-}" != 1 ] && [ -n "$PREV_RELEASE" ] \
   && [ "$(basename "$PREV_RELEASE")" = "$TARGET" ] \
   && $SUDO systemctl is-active --quiet "$SERVICE"; then
  echo "==> $TARGET is already live and $SERVICE is active — skipping restart (FORCE_DEPLOY=1 to override)"
  exit 0
fi

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

# Install Playwright Chromium if not already present (idempotent, shared cache).
if ! ls "$HOME/.cache/ms-playwright/chromium"* 2>/dev/null | grep -q chromium; then
  echo "==> Installing Playwright Chromium..."
  (cd "$RELEASE_DIR" && npx playwright install chromium --with-deps 2>&1 | tail -5) || true
fi

# Sibling MCP servers go live the moment their checkout moves (sessions spawn them by
# path), so a new sibling revision must pass the host's MCP contract (#1481: tool
# results are never empty) BEFORE the reset; a violating revision keeps the old one.
sync_sibling_checked() {
  local dir="$1" probe
  if ! git -C "$dir" fetch --quiet origin main 2>/dev/null; then
    echo "  ⚠️  update failed — keeping existing checkout"; return 0
  fi
  probe="$(mktemp -d)"
  if git -C "$dir" archive origin/main src | tar -x -C "$probe" &&
     node "$RELEASE_DIR/scripts/check-mcp-conformance.js" "$probe"; then
    git -C "$dir" reset --quiet --hard origin/main 2>/dev/null ||
      echo "  ⚠️  update failed — keeping existing checkout"
  else
    echo "  ⚠️  $(basename "$dir") origin/main violates the MCP contract — keeping $(git -C "$dir" rev-parse --short HEAD)"
  fi
  rm -rf "$probe"
}

echo "==> Ensuring trained-assist-hh-skill sibling checkout exists (feeds the HH skill fallback)..."
if [ ! -d "$HH_SKILL_DIR/.git" ]; then
  HH_SKILL_URL=$(git -C "$REPO_DIR" remote get-url origin | sed 's#/trained-assist-agent\(\.git\)\?$#/trained-assist-hh-skill.git#')
  echo "  Cloning $HH_SKILL_DIR..."
  git clone --quiet "$HH_SKILL_URL" "$HH_SKILL_DIR" || echo "  ⚠️  clone failed — hh skill fallback will be unavailable until fixed"
else
  sync_sibling_checked "$HH_SKILL_DIR"
fi
# Releases resolve the sibling as <release>/../../trained-assist-hh-skill, i.e.
# <releases>/trained-assist-hh-skill — link that to the canonical checkout.
$SUDO mkdir -p "$RELEASES_DIR"
$SUDO ln -sfn "$HH_SKILL_DIR" "$RELEASES_DIR/trained-assist-hh-skill"

echo "==> Ensuring trained-assist-engineering sibling checkout exists (feeds engineering_spawn_workspace, #1418)..."
if [ ! -d "$ENGINEERING_DIR/.git" ]; then
  ENGINEERING_URL=$(git -C "$REPO_DIR" remote get-url origin | sed 's#/trained-assist-agent\(\.git\)\?$#/trained-assist-engineering.git#')
  echo "  Cloning $ENGINEERING_DIR..."
  git clone --quiet "$ENGINEERING_URL" "$ENGINEERING_DIR" || echo "  ⚠️  clone failed — engineering_spawn_workspace will be unavailable until fixed"
else
  sync_sibling_checked "$ENGINEERING_DIR"
fi
# Same resolution depth as trained-assist-hh-skill above: both browser.js's
# sibling mount (2 levels up from src/) and 61-dev.js's engineeringLibPath()
# (4 levels up from src/mcp-skills/tools/) land on <releases>/, since a release
# dir itself is one path segment (<releases>/<sha>/src/...).
$SUDO ln -sfn "$ENGINEERING_DIR" "$RELEASES_DIR/trained-assist-engineering"

# Freelance skill: same sibling pattern (server.js / browser.js resolve
# <release>/../../trained-assist-freelance-skill). Was never synced nor linked for
# releases, so live freelance lagged main and releases could not resolve it (#1481).
echo "==> Ensuring trained-assist-freelance-skill sibling checkout exists..."
if [ ! -d "$FREELANCE_SKILL_DIR/.git" ]; then
  FREELANCE_SKILL_URL=$(git -C "$REPO_DIR" remote get-url origin | sed 's#/trained-assist-agent\(\.git\)\?$#/trained-assist-freelance-skill.git#')
  echo "  Cloning $FREELANCE_SKILL_DIR..."
  git clone --quiet "$FREELANCE_SKILL_URL" "$FREELANCE_SKILL_DIR" || echo "  ⚠️  clone failed — freelance skill will be unavailable until fixed"
else
  sync_sibling_checked "$FREELANCE_SKILL_DIR"
fi
$SUDO ln -sfn "$FREELANCE_SKILL_DIR" "$RELEASES_DIR/trained-assist-freelance-skill"

echo "==> Validating and applying nginx config ($DEPLOY_ENV)..."
REPO_DIR="$RELEASE_DIR" bash "$RELEASE_DIR/scripts/deploy-nginx.sh"

trap on_deploy_error ERR

echo "==> Installing systemd unit file..."
UNIT_SRC="$RELEASE_DIR/systemd/${SERVICE}${UNIT_VARIANT}.service"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
NOTIFY_SRC="$RELEASE_DIR/systemd/assist-agent-notify-failure.service"
NOTIFY_DST="/etc/systemd/system/assist-agent-notify-failure.service"
CHANGED=0
if [ -f "$UNIT_SRC" ]; then
  if ! diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
    $SUDO cp "$UNIT_SRC" "$UNIT_DST"
    CHANGED=1
    echo "  Unit file updated"
  else
    echo "  Unit file unchanged"
  fi
fi
if [ -f "$NOTIFY_SRC" ]; then
  if ! diff -q "$NOTIFY_SRC" "$NOTIFY_DST" >/dev/null 2>&1; then
    $SUDO cp "$NOTIFY_SRC" "$NOTIFY_DST"
    CHANGED=1
    echo "  Notify-failure unit updated"
  fi
fi

# The drain-aware restart coordinator (timer + service) is gone: restarts are instant now.
if [ -f /etc/systemd/system/assist-agent-restart.timer ] || [ -f /etc/systemd/system/assist-agent-restart.service ]; then
  echo "==> Removing retired restart coordinator timer..."
  $SUDO systemctl disable --now assist-agent-restart.timer 2>/dev/null || true
  $SUDO systemctl stop assist-agent-restart.service 2>/dev/null || true
  $SUDO rm -f /etc/systemd/system/assist-agent-restart.timer /etc/systemd/system/assist-agent-restart.service
  CHANGED=1
fi
if [ "$CHANGED" = "1" ]; then
  $SUDO systemctl daemon-reload
  echo "  daemon reloaded"
fi

echo "==> Stopping legacy conflicting services (alesa-agent, trained-assist-agent)..."
for OLD_SVC in alesa-agent trained-assist-agent; do
  if systemctl list-unit-files | grep -q "^${OLD_SVC}.service"; then
    $SUDO systemctl stop "$OLD_SVC" 2>/dev/null || true
    $SUDO systemctl disable "$OLD_SVC" 2>/dev/null || true
    echo "  Stopped and disabled $OLD_SVC"
  fi
done

echo "==> Migrating data directory (alesa-data → agent-data) if needed..."
if [ -d "/home/vova/alesa-data" ] && [ ! -d "/home/vova/agent-data" ]; then
  mv /home/vova/alesa-data /home/vova/agent-data
  echo "  Migrated: alesa-data → agent-data"
else
  echo "  No migration needed"
fi

echo "==> Ensuring data directories exist..."
DATA_DIR="${AGENT_DATA_DIR:-/home/vova/agent-data}"
mkdir -p "$DATA_DIR/system-flags"
chown -R vova:vova "$DATA_DIR" 2>/dev/null || true
rm -f "$DATA_DIR/maintenance.json.drain" "$DATA_DIR/maintenance.json.recipients" 2>/dev/null || true

echo "==> Applying OpenCode profile..."
bash "$RELEASE_DIR/infra/opencode-switch-profile.sh" || echo "opencode-switch-profile: skipped (jq missing or no profile set)"

# ── Downtime window starts here ──────────────────────────────────────────────────────

echo "==> Stopping service..."
$SUDO systemctl stop "$SERVICE"

cd "$RELEASE_DIR"

# Orphan processes (started outside systemd) stay alive on port 8080 and serve stale code.
$SUDO fuser -k 8080/tcp 2>/dev/null || true

# ── Workspace storage migration (legacy AGENT_DATA_DIR/sessions → USERS_DIR) ──────
# Idempotent + ledgered. Runs while the service is stopped so the new code starts
# with data already in the canonical root (identity ≠ location).
echo "==> Migrating legacy per-profile workspaces (agent-data/sessions → users)..."
USERS_DIR="${USERS_DIR:-$HOME/users}" AGENT_DATA_DIR="${AGENT_DATA_DIR:-$HOME/agent-data}" \
  node "$RELEASE_DIR/scripts/migrate-workspaces.mjs" --apply --quiet \
  || echo "  ⚠️  workspace migration reported issues — re-run scripts/migrate-workspaces.mjs (see ledger)"

echo "==> Activating release (atomic symlink swap)..."
release_set_link "$CURRENT_LINK" "$RELEASE_DIR"

echo "==> Starting service..."
# Clear any failed state (e.g. StartLimitBurst exhausted from crash loops).
$SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
$SUDO systemctl start "$SERVICE"

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

# Fail hard if service never came up — triggers on_deploy_error → rollback.
# Must use `false` (a failing command) not `exit 1` — bash's ERR trap fires only
# on non-zero command exits, not on an explicit `exit` statement.
if [ "$HEALTHY" = "0" ]; then
  echo "ERROR: service did not respond on /health after 60s — failing deploy to trigger rollback"
  false
fi
trap - ERR

echo "==> HH skill extraction parity smoke test (informational, does not block deploy)..."
node "$RELEASE_DIR/scripts/hh-extraction-parity-smoke.js" || echo "  ⚠️  parity smoke test failed — see output above; HH skill fallback may be degraded"

echo "==> Installing disk-hygiene crons..."
if [ -x "$RELEASE_DIR/ops/cron/install.sh" ]; then
  if sh "$RELEASE_DIR/ops/cron/install.sh"; then
    echo "  disk-hygiene crons installed"
  else
    echo "  ⚠️  cron install failed — disk guard may be stale"
  fi
fi

echo "==> Garbage-collecting old releases..."
release_gc "$RELEASES_DIR" 3

echo "==> Deploy complete ✅"
