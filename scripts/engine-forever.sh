#!/usr/bin/env bash
# engine-forever.sh — provision the owner's opencode FORK as this machine's engine.
#
#   fork: https://github.com/kobzevvv/opencode-forever (branch `daily`)
#   the owner's accelerated build: engine-database compaction (the 11 GB opencode.db
#   class), memory trimming. Prod was switched to it on 2026-10-04 — but by
#   hand-run scripts under ~/build, which live in no checkout: not reviewable,
#   not reproducible on a rebuilt box, invisible in a PR. This script is the pinned,
#   repo-owned record of that switch, so the fork is a deploy, not a memory.
#
# Two things it must never get wrong:
#
#   1. The fork is built FROM branch `daily`, so its install channel is `daily` and
#      it opens $HOME/.local/share/opencode/daily.db / opencode-daily.db — a fresh,
#      EMPTY database. Session history would disappear and the runner's native
#      resume (`opencode run --session <id>`, src/runner/claude-runner.js) would
#      keep failing over to a context rebuild on every run. The wrapper therefore
#      exports OPENCODE_DB pointing at the real opencode.db, computed from $HOME:
#      engines run with HOME=<profile>/.agent-home, so one DB per user, exactly
#      like stock opencode.
#
#   2. Rollback stays one command and needs no rebuild: the wrapper is a single file
#      in $FOREVER_WRAPPER_DIR, ahead of stock /usr/bin/opencode in PATH. Delete it
#      and the machine is back on stock.
#
# The engine is machine-level, not part of a release: switching releases (git) never
# touches it — which is exactly why scripts/deploy.sh re-asserts it every deploy.
# RU has no engine at all by design (issue #1288: ru-edge has no runner, no OpenCode),
# so deploy-ru-edge.sh does not call this script.
#
# Usage:
#   scripts/engine-forever.sh              install (idempotent; builds if binary missing)
#   scripts/engine-forever.sh status       fork | stock | none — exit 0 only for fork
#   scripts/engine-forever.sh off          rollback to stock opencode
#
# Env overrides (tests, unusual boxes): AGENT_HOME, FOREVER_SHA, FOREVER_REPO,
#   FOREVER_BRANCH, FOREVER_ROOT, FOREVER_WRAPPER_DIR, FOREVER_BUILD_DIR
set -Eeuo pipefail

AGENT_HOME="${AGENT_HOME:-/home/vova}"
FOREVER_REPO="${FOREVER_REPO:-https://github.com/kobzevvv/opencode-forever.git}"
FOREVER_BRANCH="${FOREVER_BRANCH:-daily}"
# Single source of truth for WHICH fork build this fleet runs. Bump deliberately
# (build + smoke first), never silently: a wrong pin ships a broken engine to prod.
FOREVER_SHA="${FOREVER_SHA:-68545f8f5441f7651d57e1da09e0d69598f07f16}"
FOREVER_ROOT="${FOREVER_ROOT:-$AGENT_HOME/opencode-forever}"
FOREVER_WRAPPER_DIR="${FOREVER_WRAPPER_DIR:-$AGENT_HOME/.local/bin}"
FOREVER_BUILD_DIR="${FOREVER_BUILD_DIR:-$AGENT_HOME/build}"

BIN="$FOREVER_ROOT/$FOREVER_SHA/opencode"
WRAPPER="$FOREVER_WRAPPER_DIR/opencode"
SRC="$FOREVER_BUILD_DIR/opencode-forever"
ARTIFACT="$SRC/packages/opencode/dist/opencode-linux-x64/bin/opencode"

log() { printf '%s\n' "$*"; }
die() { printf 'engine-forever: %s\n' "$*" >&2; exit 1; }

# ── build side (only runs when the pinned binary is absent) ──────────────────────

ensure_toolchain() {
  if ! command -v gcc >/dev/null || ! command -v make >/dev/null || ! command -v python3 >/dev/null; then
    log "  installing build-essential (gcc/make/python3 missing)"
    sudo -n apt-get update -qq
    sudo -n apt-get install -y -qq build-essential python3 file
  fi
  if ! command -v bun >/dev/null; then
    log "  installing bun (fork builds with bun, packageManager bun@1.3.x)"
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    curl -fsSL https://bun.sh/install | bash
  fi
  export PATH="$BUN_INSTALL/bin:$PATH"
  # NODE_ENV=production makes bun/npm skip devDependencies → broken build.
  unset NODE_ENV
  log "  toolchain: $(gcc --version | head -1), $(bun --version | head -1 | sed 's/^/bun /')"
}

build_binary() {
  ensure_toolchain
  mkdir -p "$FOREVER_ROOT/$FOREVER_SHA" "$FOREVER_BUILD_DIR"
  if [ ! -d "$SRC/.git" ]; then
    git clone --quiet --branch "$FOREVER_BRANCH" --single-branch "$FOREVER_REPO" "$SRC"
  fi
  git -C "$SRC" fetch --quiet origin "$FOREVER_BRANCH"
  git -C "$SRC" checkout --quiet "$FOREVER_SHA"
  local head
  head="$(git -C "$SRC" rev-parse HEAD)"
  [ "$head" = "$FOREVER_SHA" ] || die "checkout gave $head, pinned $FOREVER_SHA"
  log "  building $FOREVER_SHA ($(git -C "$SRC" log -1 --format=%s)) — ~90 s, old service keeps serving"
  (cd "$SRC" && bun install --silent && bun run --cwd packages/opencode build --single --skip-embed-web-ui)
  [ -x "$ARTIFACT" ] || die "build produced no binary at $ARTIFACT"
  install -m 755 "$ARTIFACT" "$BIN"
  log "  built: $BIN ($(stat -c %s "$BIN") bytes)"
}

ensure_binary() {
  if [ -x "$BIN" ]; then
    return 0
  fi
  log "==> Fork binary for $FOREVER_SHA is missing — building it"
  build_binary
}

# ── install side ────────────────────────────────────────────────────────────────

write_wrapper() {
  mkdir -p "$FOREVER_WRAPPER_DIR"
  # Note the escaped $: HOME/OPENCODE_DB are resolved by the wrapper at RUN time,
  # by whatever user runs the engine (slot user, HOME=<profile>/.agent-home).
  cat > "$WRAPPER" <<EOF
#!/bin/sh
# opencode = owner's fork $FOREVER_SHA (kobzevvv/opencode-forever@$FOREVER_BRANCH).
# Written by scripts/engine-forever.sh; rollback: scripts/engine-forever.sh off.
#
# Why OPENCODE_DB: the fork is built from branch \`daily\`, so its install channel is
# \`daily\` and without this it would open a fresh opencode-daily.db — losing session
# history and breaking \`opencode run --session <id>\` resume on every run.
FORK="$BIN"
if [ -n "\${HOME:-}" ]; then
  OPENCODE_DB="\$HOME/.local/share/opencode/opencode.db"
  export OPENCODE_DB
fi
exec "\$FORK" "\$@"
EOF
  chmod 755 "$WRAPPER"
}

cmd_install() {
  ensure_binary
  [ -x "$BIN" ] || die "no binary at $BIN"
  write_wrapper
  # Prove the pin before declaring success: a wrapper pointing at an unrunnable
  # binary would only surface on the next model call, deep inside a run.
  local v
  if ! v="$("$WRAPPER" --version 2>&1 | head -1)"; then
    die "fork binary does not run: $v"
  fi
  log "engine: fork $FOREVER_SHA"
  log "  binary:  $BIN ($(stat -c %s "$BIN") bytes)"
  log "  wrapper: $WRAPPER → OPENCODE_DB=\$HOME/.local/share/opencode/opencode.db"
  log "  version: $v"
  log "  rollback: $0 off"
}

cmd_status() {
  local state stock
  stock="$(command -v opencode || true)"
  if [ -x "$WRAPPER" ]; then
    state="fork"
  elif [ -n "$stock" ]; then
    state="stock"
  else
    state="none"
  fi
  log "state:      $state"
  log "pinned:     $FOREVER_SHA ($FOREVER_REPO@$FOREVER_BRANCH)"
  log "wrapper:    $([ -x "$WRAPPER" ] && echo "$WRAPPER" || echo 'absent')"
  log "binary:     $([ -x "$BIN" ] && echo "$BIN ($(stat -c %s "$BIN") bytes)" || echo "absent (build on demand)")"
  if [ -x "$WRAPPER" ]; then
    log "wrapper --version: $("$WRAPPER" --version 2>&1 | head -1)"
    log "path resolves to:  $(PATH="$FOREVER_WRAPPER_DIR:$PATH" command -v opencode 2>/dev/null || echo 'n/a')"
  else
    log "path resolves to:  ${stock:-none}"
  fi
  [ "$state" = "fork" ]
}

cmd_off() {
  if [ -e "$WRAPPER" ]; then
    rm -f "$WRAPPER" || sudo -n rm -f "$WRAPPER"
    log "removed $WRAPPER — engine is stock again (binary kept: $BIN)"
  else
    log "no wrapper at $WRAPPER — already stock"
  fi
  local stock
  stock="$(command -v opencode || true)"
  log "path resolves to: ${stock:-none}"
}

case "${1:-install}" in
  install) cmd_install ;;
  status)  cmd_status ;;
  off)     cmd_off ;;
  *) die "unknown command '${1}' (install|status|off)" ;;
esac
