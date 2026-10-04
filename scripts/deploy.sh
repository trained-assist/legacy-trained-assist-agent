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
SALES_SKILL_DIR="${SALES_SKILL_DIR:-$AGENT_HOME/trained-assist-sales-skill}"
DOCUMENTS_SKILL_DIR="${DOCUMENTS_SKILL_DIR:-$AGENT_HOME/trained-assist-documents-skill}"
SPEECH_SKILL_DIR="${SPEECH_SKILL_DIR:-$AGENT_HOME/trained-assist-speech-skill}"
SEARCH_SKILL_DIR="${SEARCH_SKILL_DIR:-$AGENT_HOME/trained-assist-search-skill}"
MARKETING_SKILL_DIR="${MARKETING_SKILL_DIR:-$AGENT_HOME/trained-assist-marketing-skill}"
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

# Pre-deploy secrets gate (#1885). Before this, a bot enabled in bots.registry whose token
# the host cannot load only surfaced AFTER deploy.sh had already swapped ~/agent-master and
# restarted: the deploy job went red with the broken release live (a383f63, 01.10.2026 —
# SALES_BOT_TOKEN). The gate reads the TARGET release's own manifest + loader, so a new bot
# is checked in the commit that adds it, and it exits before anything below mutates prod.
# `exit 1`, not `false`: the ERR trap is not armed yet, and nothing has changed.
echo "==> Pre-deploy secrets gate (credential contract + bot tokens)..."
if ! DEPLOY_ENV="$DEPLOY_ENV" node "$RELEASE_DIR/scripts/check-deploy-secrets-gate.js" --release "$RELEASE_DIR" --env "$DEPLOY_ENV"; then
  echo "❌ Pre-deploy gate closed — refusing to deploy $TARGET; the previous release keeps serving" >&2
  exit 1
fi

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
  # The schedule manifest is optional (not every sibling is schedulable yet).
  git -C "$dir" show origin/main:action-provider-manifest.json > "$probe/action-provider-manifest.json" 2>/dev/null ||
    rm -f "$probe/action-provider-manifest.json"
  if git -C "$dir" archive origin/main src | tar -x -C "$probe" &&
     node "$RELEASE_DIR/scripts/check-mcp-conformance.js" "$probe" &&
     node "$RELEASE_DIR/scripts/check-skill-schedule.js" "$probe"; then
    git -C "$dir" reset --quiet --hard origin/main 2>/dev/null ||
      echo "  ⚠️  update failed — keeping existing checkout"
  else
    echo "  ⚠️  $(basename "$dir") origin/main violates the MCP/schedule contract — keeping $(git -C "$dir" rev-parse --short HEAD)"
  fi
  # Live code must be versioned: reset --hard keeps untracked files, and sessions load
  # them by path (a hand-copied src/ file ran in prod unreviewed, #1502).
  local stray
  stray="$(git -C "$dir" ls-files --others --exclude-standard -- src 2>/dev/null)"
  if [ -n "$stray" ]; then echo "  ⚠️  $(basename "$dir") has untracked live files: $(echo $stray)"; fi
  rm -rf "$probe"
}

# Domain skill repos (#1470): one checkout per sibling next to core, synced to main
# behind the MCP contract check, and linked into <releases>/ — releases resolve a
# sibling as <release>/../<repo> (browser.js / skill-siblings.js: 2 levels up from src/).
# Keep this list in sync with SKILL_SIBLINGS in src/skill-siblings.js.
ensure_sibling() {
  local repo="$1" dir="$2" url
  echo "==> Ensuring $repo sibling checkout exists..."
  if [ ! -d "$dir/.git" ]; then
    url=$(git -C "$REPO_DIR" remote get-url origin | sed "s#/trained-assist-agent\(\.git\)\?\$#/$repo.git#")
    echo "  Cloning $dir..."
    git clone --quiet "$url" "$dir" || echo "  ⚠️  clone failed — $repo will be unavailable until fixed"
  else
    sync_sibling_checked "$dir"
  fi
  $SUDO mkdir -p "$RELEASES_DIR"
  $SUDO ln -sfn "$dir" "$RELEASES_DIR/$repo"
}
ensure_sibling trained-assist-hh-skill "$HH_SKILL_DIR"
ensure_sibling trained-assist-engineering "$ENGINEERING_DIR"
ensure_sibling trained-assist-freelance-skill "$FREELANCE_SKILL_DIR"
ensure_sibling trained-assist-sales-skill "$SALES_SKILL_DIR"
ensure_sibling trained-assist-documents-skill "$DOCUMENTS_SKILL_DIR"
ensure_sibling trained-assist-speech-skill "$SPEECH_SKILL_DIR"
ensure_sibling trained-assist-search-skill "$SEARCH_SKILL_DIR"
ensure_sibling trained-assist-marketing-skill "$MARKETING_SKILL_DIR"

# Core no longer ships the gdrive/doc-export/deck tools (#1470) — they live only in
# trained-assist-documents-skill. `ensure_sibling` warns and continues on a failed clone,
# which here would silently drop the whole Google Drive domain from prod, so this one
# checkout must be hard-required. Placed before `trap on_deploy_error ERR` and before the
# release is activated: exiting here leaves the previous release serving, no rollback.
if [ ! -f "$RELEASES_DIR/trained-assist-documents-skill/src/mcp-skills/index.js" ]; then
  echo "❌ trained-assist-documents-skill checkout is missing — refusing to deploy (gdrive/doc-export/deck would vanish)" >&2
  exit 1
fi

# Same reasoning for speech: after the Ф0 extraction core no longer owns a Deepgram
# engine, so a missing checkout would silently break every video_analyze_batch. Exit
# before the release is activated → the previous release keeps serving.
if [ ! -f "$RELEASES_DIR/trained-assist-speech-skill/src/mcp-skills/index.js" ]; then
  echo "❌ trained-assist-speech-skill checkout is missing — refusing to deploy (video_analyze_batch would lose recognition)" >&2
  exit 1
fi

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

# Generic cron engine external alarm (#1489 P2.1) — only on the host that owns the cron DB.
if [ "$DEPLOY_ENV" = "gcp" ]; then
  for UNIT in assist-cron-tick.service assist-cron-tick.timer; do
    if [ -f "$RELEASE_DIR/systemd/$UNIT" ] && ! diff -q "$RELEASE_DIR/systemd/$UNIT" "/etc/systemd/system/$UNIT" >/dev/null 2>&1; then
      $SUDO cp "$RELEASE_DIR/systemd/$UNIT" "/etc/systemd/system/$UNIT"
      CHANGED=1
      echo "  $UNIT updated"
    fi
  done
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

# Engine binary = the owner's opencode fork (kobzevvv/opencode-forever), pinned in
# scripts/engine-forever.sh. It is MACHINE-level: switching releases (git) never
# touches it, so without this re-assert a rebuilt or re-provisioned box silently
# runs stock opencode and the two machines diverge again — which is how the fork
# ended up living only in hand-run ~/build scripts (2026-10-04).
# Runs BEFORE the downtime window: if the binary has to be built (~90 s) the old
# service is still serving. RU never gets here (deploy-ru-edge.sh; issue #1288: no
# runner, no OpenCode on that box), hence the gcp guard.
# Non-fatal on purpose: a provision failure leaves whatever engine is already
# installed and stock opencode still works — failing the deploy instead would take
# the whole agent down over engine packaging. The ⚠️ line makes it visible, not silent.
if [ "$DEPLOY_ENV" = "gcp" ]; then
  if bash "$RELEASE_DIR/scripts/engine-forever.sh" install; then
    echo "  engine: opencode fork pinned"
  else
    echo "  ⚠️  engine-forever install FAILED — engine stays as installed; opencode falls back to stock"
  fi
fi

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
# The invariant, enforced at the last possible moment: a pointer may only ever be
# flipped at a release that STILL verifies. Everything above (npm ci, Playwright,
# sibling sync, nginx, unit files) takes minutes — the snapshot has to be whole
# here, not only when it was built. A verification failure here aborts before the
# swap, so the previous release keeps serving (prod incident 2026-10-04: the
# pointer was repointed at a snapshot that had already lost its files, and the
# service restarted onto it).
if ! release_verify_release "$RELEASE_DIR" "$TARGET" || ! release_verify "$RELEASE_DIR" "$TARGET"; then
  echo "❌ $RELEASE_DIR no longer verifies — NOT activating. Previous release keeps serving." >&2
  exit 1
fi
release_set_link "$CURRENT_LINK" "$RELEASE_DIR"

echo "==> Starting service..."
# Clear any failed state (e.g. StartLimitBurst exhausted from crash loops).
$SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
$SUDO systemctl start "$SERVICE"

echo "==> Waiting for service to be healthy on $TARGET (up to 60s)..."
# Healthy = /health 200 AND it reports the commit we just built (SS-13): a bare
# 200 from a process still running the previous release must fail the deploy.
HEALTHY=0
for i in $(seq 1 60); do
  if node "$RELEASE_DIR/scripts/check-health-commit.js" http://localhost:8080/health "$TARGET" 2>/dev/null; then
    HEALTHY=1; echo "  healthy on ${TARGET:0:7} after ${i}s"; break
  fi
  sleep 1
done
[ "$HEALTHY" = "1" ] || node "$RELEASE_DIR/scripts/check-health-commit.js" http://localhost:8080/health "$TARGET" || true
$SUDO systemctl status "$SERVICE" --no-pager --lines=10 || true
if [ "$DEPLOY_ENV" = "gcp" ] && [ -f /etc/systemd/system/assist-cron-tick.timer ]; then
  $SUDO systemctl enable --now assist-cron-tick.timer || echo "  WARN: assist-cron-tick.timer not enabled"
fi
echo "==> Service journal (last 20 lines)..."
$SUDO journalctl -u "$SERVICE" --no-pager -n 20 || true

# Fail hard if service never came up — triggers on_deploy_error → rollback.
# Must use `false` (a failing command) not `exit 1` — bash's ERR trap fires only
# on non-zero command exits, not on an explicit `exit` statement.
if [ "$HEALTHY" = "0" ]; then
  echo "ERROR: /health did not report commit ${TARGET:0:7} within 60s — failing deploy to trigger rollback"
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

# claude-oauth-refresh block: installed from THIS release, so its wrapper path
# points at ~/agent-master instead of wherever someone last ran the installer
# from (2026-09-28: a checkout run left both entries on ~/trained-assist-agent,
# and that checkout sat on a stale feature branch — the cron then ran code that
# was never deployed).
echo "==> Installing claude-oauth-refresh cron..."
if sh "$RELEASE_DIR/scripts/install-claude-token-refresh.sh"; then
  echo "  claude-oauth-refresh cron installed"
else
  echo "  ⚠️  claude-oauth-refresh cron install failed"
fi

# Audit: every crontab entry must execute through the stable ~/agent-master
# symlink. Anything else means a scheduled job can run code this deploy did NOT
# ship (a checkout on an arbitrary branch) — exactly the class of bug that hides
# for days because nothing errors. Warn loudly; never block the deploy on it.
echo "==> Auditing crontab for non-release paths..."
CRON_AUDIT=$(crontab -l 2>/dev/null | grep -E '^[^#]' | grep -v 'agent-master/' | grep -E 'trained-assist-agent|agent-releases/' || true)
if [ -n "$CRON_AUDIT" ]; then
  echo "  ⚠️  CRON RUNS NON-RELEASE CODE — these entries do not go through ~/agent-master:"
  printf '%s\n' "$CRON_AUDIT" | sed 's/^/     /'
else
  echo "  all crontab entries run through ~/agent-master"
fi

echo "==> Garbage-collecting old releases..."
# The live release is protected explicitly: after a rollback it is OLDER than the
# three newest, and "newest N" alone would delete the release prod is running.
release_gc "$RELEASES_DIR" 3 "$RELEASE_DIR"

echo "==> Deploy complete ✅"
