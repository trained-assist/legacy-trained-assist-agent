#!/usr/bin/env bash
# opencode-switch-profile.sh — merge base + profile → ~/.config/opencode/opencode.json
#
# Usage:
#   ./infra/opencode-switch-profile.sh [service|doctor|free|russian|research]
#
# Reads OPENCODE_PROFILE from secrets.env if no arg given.
# Writes result to ~/.config/opencode/opencode.json on this machine.
#
# This sets the machine-wide BASELINE for anything that talks to `opencode` outside the agent's
# task runner (e.g. manual sanity checks on the VM). Per-task invocations get the same shape
# per-invocation via OPENCODE_CONFIG (writeOpencodeMcpConfig in claude-runner.js). Both come from
# src/opencode-ladder-provider.js: one `ladder` provider pointing at the llm-ladder, model
# ids `ladder/<ladder>:<role>` (issue #1687). A profile IS an llm-ladder ladder — the agent
# holds no provider keys, the llm-ladder owns the pools. The worker needs OPENCODE_LADDER_TOKEN
# in the env.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$REPO_DIR/.opencode/base.json"
OUT="${OPENCODE_CONFIG_OUT:-$HOME/.config/opencode/opencode.json}"

# Resolve profile name
if [[ -n "${1:-}" ]]; then
  PROFILE="$1"
else
  # Try reading from secrets.env
  SECRETS="${SECRETS_ENV:-$HOME/secrets.env}"
  if [[ -f "$SECRETS" ]]; then
    PROFILE=$(grep '^OPENCODE_PROFILE=' "$SECRETS" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)
  fi
  PROFILE="${PROFILE:-service}"
fi

# Normalize aliases. Profiles are llm-ladder ladders now; the legacy names (deepseek/value →
# service, max → doctor) still resolve so an old OPENCODE_PROFILE or a muscle-memory /profile
# call keeps working — see LEGACY_PROFILE_LADDER in src/opencode-ladder-provider.js.
case "$PROFILE" in
  ru|recruiter|rr|russian-recruiter) PROFILE="russian" ;;
  m|q|ll|mimo|quality|lavish-luna) echo "opencode-switch-profile: '$PROFILE' was retired in #1061 Фаза 1 — pick service|doctor|free" >&2; exit 1 ;;
  ds|deepseek|deepseek-go|deepseek-openrouter|value|v) PROFILE="service" ;;  # toggle halves + ladder's old name, removed 2026-09-27
  f)  PROFILE="free" ;;
  x|max) PROFILE="doctor" ;;
esac

mkdir -p "$(dirname "$OUT")"
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT
if ! OVERRIDES=$(node -e '
  const p = require(process.argv[1]);
  const name = process.argv[2];
  if (!p.PROFILES.includes(name)) { console.error(`unknown profile ${name} — available: ${p.PROFILES.join(" ")}`); process.exit(1); }
  process.stdout.write(JSON.stringify(p.buildOcProfileOverrides(name)));
' "$REPO_DIR/src/opencode-ladder-provider.js" "$PROFILE"); then
  echo "opencode-switch-profile: cannot resolve profile '$PROFILE' — keeping existing $OUT" >&2
  exit 1
fi
jq -n --slurpfile base "$BASE" --argjson o "$OVERRIDES" '$base[0] * $o' > "$TMP_OUT"

# opencode rejects the WHOLE config on `"model": null` ("Expected string | undefined, got null
# model") and every OpenCode task then exits 1 at start — the per-invocation OPENCODE_CONFIG
# override does not help, the global file is validated first. Never install such a config: keep
# the previous (working) one and fail the step loudly instead.
if ! jq -e '(.model | type == "string" and length > 0) and ([.agent[]?.model | select(. != null) | type == "string"] | all)' "$TMP_OUT" >/dev/null; then
  echo "opencode-switch-profile: profile '$PROFILE' resolved to no model — keeping existing $OUT" >&2
  exit 1
fi
mv "$TMP_OUT" "$OUT"
trap - EXIT

echo "opencode profile → $PROFILE ($OUT)"
