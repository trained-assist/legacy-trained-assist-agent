#!/usr/bin/env bash
# Shared host deploy must preserve an explicitly selected immutable HH release.
# No marker keeps the existing origin/main policy. A marker never falls back to
# main if its immutable artifact is missing or fails either contract gate.
hh_pin_file() { printf '%s' "${HH_DEPLOY_TARGET_FILE:-$AGENT_HOME/hh-deploy-target}"; }
hh_pin_revision() {
  local file revision
  file="$(hh_pin_file)"
  [[ -f "$file" ]] || return 1
  revision="$(cat "$file")"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid HH deployment target marker' >&2; return 2; }
  printf '%s' "$revision"
}
hh_pin_matches_current() {
  local file revision target current
  file="$(hh_pin_file)"
  [[ -e "$file" ]] || return 0
  revision="$(hh_pin_revision)" || return 1
  target="${HH_RELEASES_DIR:-$AGENT_HOME/hh-releases}/$revision"
  current="$(readlink -f "$RELEASES_DIR/trained-assist-hh-skill" 2>/dev/null || true)"
  [[ "$current" = "$target" && -f "$target/.release-complete" && "$(cat "$target/.release-sha" 2>/dev/null)" = "$revision" ]]
}
ensure_hh_sibling() {
  local file revision target link current
  file="$(hh_pin_file)"
  if [[ ! -e "$file" ]]; then
    ensure_sibling trained-assist-hh-skill "$HH_SKILL_DIR"
    return
  fi
  revision="$(hh_pin_revision)" || return 1
  target="${HH_RELEASES_DIR:-$AGENT_HOME/hh-releases}/$revision"
  [[ -d "$target" && -f "$target/.release-complete" && "$(cat "$target/.release-sha" 2>/dev/null)" = "$revision" ]] || {
    echo "Pinned HH release $revision is missing/incomplete; refusing host deploy" >&2
    return 1
  }
  node "$RELEASE_DIR/scripts/check-mcp-conformance.js" "$target" || return 1
  node "$RELEASE_DIR/scripts/check-skill-schedule.js" "$target" || return 1
  link="$RELEASES_DIR/trained-assist-hh-skill"
  current="$(readlink -f "$link" 2>/dev/null || true)"
  if [[ "$current" != "$target" ]]; then
    $SUDO mkdir -p "$RELEASES_DIR"
    release_set_link "$link" "$target"
  fi
  echo "==> Preserving pinned immutable HH revision $revision"
}
