#!/bin/bash
# Release-directory mechanics for issue #1391 — sourced by the deploy scripts
# (scripts/deploy.sh, scripts/deploy-ru-edge.sh) and by tests.
#
# Prod is not a git working tree any more: a release is an immutable snapshot of
# a commit, built outside the session worktree, and the running version is chosen
# by atomically repointing a symlink. A session doing checkout/commit can no
# longer change what is served.
set -Eeuo pipefail

# SUDO is overridable so the mechanics can be exercised without root in tests.
# Use ${SUDO-sudo} (not :-) so an explicit empty SUDO stays empty.
SUDO="${SUDO-sudo}"

# release_verify <dir> [expected-sha]
#
# The invariant this file exists for: a release directory is a WHOLE immutable
# snapshot, and a pointer may only ever be flipped at a snapshot that verifies.
#
# `.release-complete` alone was not enough. It is one file: a snapshot whose other
# contents were removed still passes the "already built" check, so a deploy would
# happily report success and repoint ~/agent-master at a directory that no longer
# exists. The service then starts, keeps serving from modules it already loaded,
# and every lazy require() fails — a live-looking process on dead files, with
# /readiness answering 500 (prod incident 2026-10-04).
#
# So a release is verified by what it must CONTAIN, not by a marker:
#   • the directory exists and is a real directory;
#   • .release-complete marks the build as finished;
#   • .release-sha names the revision (and matches the one we asked for);
#   • the entrypoint is present — a snapshot without it cannot serve anything;
#   • node_modules is present unless deps were explicitly skipped.
release_verify() {
  local dir="$1" expected="${2:-}" missing=()
  [ -d "$dir" ] || missing+=("каталог отсутствует")
  [ -L "$dir" ] && [ ! -d "$dir" ] && missing+=("ссылка битая")
  if [ -d "$dir" ]; then
    [ -f "$dir/.release-complete" ] || missing+=("нет .release-complete")
    [ -f "$dir/.release-sha" ] || missing+=("нет .release-sha")
    if [ -n "$expected" ] && [ -f "$dir/.release-sha" ]; then
      [ "$(tr -d '[:space:]' < "$dir/.release-sha")" = "$expected" ] ||
        missing+=(".release-sha=$(
          tr -d '[:space:]' < "$dir/.release-sha"
        ) ожидался $expected")
    fi
    [ -f "$dir/src/server.js" ] || missing+=("нет точки входа src/server.js")
    if [ "${RELEASE_SKIP_DEPS:-}" != "1" ] && [ ! -d "$dir/node_modules" ]; then
      missing+=("нет node_modules")
    fi
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    printf '❌ release неполон: %s\n' "$dir" >&2
    printf '   - %s\n' "${missing[@]}" >&2
    return 1
  fi
  return 0
}

# release_build <repo> <target-sha> <releases-dir>
# Materialises <releases-dir>/<sha> from the commit via `git archive` + `npm ci`.
# Idempotent: a release that VERIFIES is reused; one that does not is rebuilt.
# Builds in a staging dir and atomically renames it into place so a half-built
# release is never activated, then verifies what actually landed in place.
release_build() {
  local repo="$1" target="$2" releases="$3"
  local dir="$releases/$target"
  # Stage in vova's home: npm/node live under voba (nvm), so deps must be
  # installed as vova, not root; the finished release is then chowned to root
  # and moved into the root-owned releases dir.
  local staging="$HOME/.agent-release-staging-$target-$$"

  if release_verify "$dir" "$target"; then
    echo "release $dir already built and verified" >&2
    return 0
  fi
  if [ -e "$dir" ]; then
    echo "  ⚠️  $dir exists but does not verify — rebuilding it" >&2
  fi

  echo "==> Building release $dir" >&2
  $SUDO rm -rf "$staging" "$dir"
  rm -rf "$staging"
  mkdir -p "$staging"
  git -C "$repo" archive "$target" | tar -x -C "$staging"

  if [ "${RELEASE_SKIP_DEPS:-}" = "1" ]; then
    echo "  RELEASE_SKIP_DEPS=1 — skipping npm ci" >&2
  else
    npm ci --prefix "$staging" --omit=dev >&2
  fi

  touch "$staging/.release-complete"
  # The release has no .git; expose the exact revision for /health and info cards.
  printf '%s\n' "$target" > "$staging/.release-sha"
  $SUDO mkdir -p "$releases"
  # Root-own the release so the session user cannot rewrite prod code, and make
  # it world-readable/traversable for the vova-run service.
  if [ -n "$SUDO" ]; then
    $SUDO chown -R root:root "$staging"
    $SUDO chmod -R a+rX "$staging"
  fi
  # `mv -T` is GNU; fall back to rm+mv where unsupported (BSD/macOS tests).
  $SUDO mv -T "$staging" "$dir" 2>/dev/null || { $SUDO rm -rf "$dir"; $SUDO mv "$staging" "$dir"; }

  # What landed in place must verify, not just what we built in staging: the
  # invariant is about the directory a pointer will be flipped at.
  release_verify "$dir" "$target"
}

# release_set_link <link> <target-dir>
# Atomically repoints <link> at <target-dir> (symlink swap via rename).
#
# Refuses a target that does not verify, and restores the previous pointer if the
# swap does not resolve. A pointer is the only thing that decides what prod runs,
# so it may never be left aimed at nothing (prod incident 2026-10-04: ~/agent-master
# pointed at a deleted release while the service was already restarting on it).
release_set_link() {
  local link="$1" target="$2" tmp="$1.new.$$"
  if ! release_verify "$target"; then
    echo "❌ refusing to point $link at an unverified target: $target" >&2
    return 1
  fi
  local previous
  previous="$(readlink -f "$link" 2>/dev/null || true)"
  $SUDO ln -sfn "$target" "$tmp"
  if [ "$(uname -s)" = "Darwin" ]; then
    $SUDO mv -h "$tmp" "$link"
  else
    $SUDO mv -T "$tmp" "$link"
  fi
  # The swap must land on something. If it did not, put the old pointer back.
  if [ ! -d "$(readlink -f "$link" 2>/dev/null || echo /nonexistent)" ]; then
    echo "❌ $link does not resolve after swap — restoring previous target" >&2
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      $SUDO ln -sfn "$previous" "$tmp"
      if [ "$(uname -s)" = "Darwin" ]; then
        $SUDO mv -h "$tmp" "$link"
      else
        $SUDO mv -T "$tmp" "$link"
      fi
    fi
    return 1
  fi
  return 0
}

# release_gc <releases-dir> [keep] [protected-dir...]
# Keeps the newest <keep> releases (default 3) so rollback and the current
# version always survive; removes older ones. Allowlist, not denylist: only real
# release directories (named by a commit sha, 7–40 hex chars, not symlinks) are ever
# candidates. Sibling-skill symlinks (hh, freelance, engineering, any future one)
# and staging dirs are never touched — a denylist missed the freelance symlink
# and `rm -rf link/` wiped the real checkout behind it (#1509).
#
# Protected dirs are never removed whatever their age. The caller passes the
# release ~/agent-master points at: after a rollback the live release is OLDER than
# the three newest, so "newest N" alone would delete the one prod is running and
# leave the pointer aimed at nothing — the same dangling-pointer failure the
# activation invariant exists to prevent (prod incident 2026-10-04).
release_gc() {
  local releases="$1" keep="${2:-3}"
  shift 2 2>/dev/null || shift $#
  local protected=("$@")
  local d name is_protected
  for d in "$releases"/.staging-*; do
    [ -e "$d" ] || continue
    [ -L "$d" ] && continue
    echo "==> GC stale staging dir $d" >&2
    $SUDO rm -rf "$d"
  done
  for d in "$releases"/*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    name="$(basename "$d")"
    [ "${#name}" -ge 7 ] && [ "${#name}" -le 40 ] || continue
    case "$name" in *[!0-9a-f]*) continue ;; esac
    is_protected=0
    for p in ${protected[@]+"${protected[@]}"}; do
      [ "$p" = "$d" ] && { is_protected=1; break; }
    done
    [ "$is_protected" = "1" ] && continue
    printf '%s\t%s\n' "$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d")" "$d"
  done | sort -rn | cut -f2- | tail -n +"$((keep + 1))" \
    | while read -r d; do
        echo "==> GC old release $d" >&2
        $SUDO rm -rf "$d"
      done
}
