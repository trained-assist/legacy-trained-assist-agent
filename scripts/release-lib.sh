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

# release_build <repo> <target-sha> <releases-dir>
# Materialises <releases-dir>/<sha> from the commit via `git archive` + `npm ci`.
# Idempotent: an already-completed release is reused. Builds in a staging dir and
# atomically renames it into place so a half-built release is never activated.
release_build() {
  local repo="$1" target="$2" releases="$3"
  local dir="$releases/$target"
  # Stage in vova's home: npm/node live under vova (nvm), so deps must be
  # installed as vova, not root; the finished release is then chowned to root
  # and moved into the root-owned releases dir.
  local staging="$HOME/.agent-release-staging-$target-$$"

  if [ -f "$dir/.release-complete" ]; then
    echo "release $dir already built" >&2
    return 0
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
}

# release_set_link <link> <target-dir>
# Atomically repoints <link> at <target-dir> (symlink swap via rename).
release_set_link() {
  local link="$1" target="$2" tmp="$1.new.$$"
  $SUDO ln -sfn "$target" "$tmp"
  if [ "$(uname -s)" = "Darwin" ]; then
    $SUDO mv -h "$tmp" "$link"
  else
    $SUDO mv -T "$tmp" "$link"
  fi
}

# release_gc <releases-dir> [keep]
# Keeps the newest <keep> releases (default 3) so rollback and the current
# version always survive; removes older ones. Allowlist, not denylist: only real
# release directories (named by a commit sha, 7–40 hex chars, not symlinks) are ever
# candidates. Sibling-skill symlinks (hh, freelance, engineering, any future one)
# and staging dirs are never touched — a denylist missed the freelance symlink
# and `rm -rf link/` wiped the real checkout behind it (#1509).
release_gc() {
  local releases="$1" keep="${2:-3}"
  local d name
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
    printf '%s\t%s\n' "$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d")" "$d"
  done | sort -rn | cut -f2- | tail -n +"$((keep + 1))" \
    | while read -r d; do
        echo "==> GC old release $d" >&2
        $SUDO rm -rf "$d"
      done
}
