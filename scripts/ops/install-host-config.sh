#!/usr/bin/env bash
# Install the per-host part of the assist-agent unit (issue #2114 P0.2).
#
# The base unit (systemd/assist-agent.service) is shared by every VM and holds
# only fleet-wide values. Everything that describes ONE machine — identity,
# public origins, cron role, capacity — lives in infra/systemd/host/<vm-name>.conf
# and is installed as
#   /etc/systemd/system/assist-agent.service.d/20-host-identity.conf
# so the repo is the single source of a box's identity and a fresh /etc never
# disagrees with it.
#
# Usage:
#   scripts/ops/install-host-config.sh <vm-name> [--no-restart]
#   scripts/ops/install-host-config.sh --list
#
# Existing hand-written drop-ins are overwritten on purpose: that file was the
# P0.3 landmine (VM2's hand edit still carried GCP's public URLs).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOST_DIR="$ROOT/infra/systemd/host"
SERVICE="${SERVICE:-assist-agent}"
DROPIN_NAME="20-host-identity.conf"
DROPIN_DST="${DROPIN_DST:-/etc/systemd/system/$SERVICE.service.d/$DROPIN_NAME}"
SUDO="${SUDO:-sudo}"
RESTART=1

list_hosts() {
  for f in "$HOST_DIR"/*.conf; do
    [ -e "$f" ] || continue
    printf '%-16s %s\n' "$(basename "$f" .conf)" "$f"
  done
}

case "${1:-}" in
  --list|"")
    echo "Known hosts (infra/systemd/host):"
    list_hosts
    [ $# -eq 0 ] || exit 0
    echo
    echo "Current unit on this host:"
    $SUDO systemctl cat "$SERVICE" 2>/dev/null | sed -n 's/^Environment=//p' || true
    exit 0
    ;;
  --help|-h)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

HOST="$1"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) RESTART=0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC="$HOST_DIR/$HOST.conf"
if [ ! -f "$SRC" ]; then
  echo "No host config for '$HOST'. Known hosts:" >&2
  list_hosts >&2
  exit 1
fi

# The manifest is the index of hosts (infra/env-manifest.json → vms). A host
# listed there without a drop-in — or vice versa — is the drift this whole
# mechanism exists to prevent.
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/infra/env-manifest.json" ]; then
  node -e '
    const fs = require("fs"), path = require("path");
    const [manifest, host, dropin] = process.argv.slice(1);
    const vms = JSON.parse(fs.readFileSync(manifest, "utf8")).vms || {};
    const listed = !!vms[host];
    const declared = /^Environment=VM_NAME=/m.test(fs.readFileSync(dropin, "utf8"));
    if (!listed)  { console.error(`  ⚠️  ${host} has no infra/env-manifest.json → vms.${host} entry`); process.exit(0); }
    if (!declared){ console.error(`  ❌ ${dropin} does not set VM_NAME — every host drop-in must, it is the identity key`); process.exit(1); }
    if (vms[host].vm_name !== host) { console.error(`  ❌ manifest vms.${host}.vm_name=${vms[host].vm_name} ≠ ${host}`); process.exit(1); }
  ' "$ROOT/infra/env-manifest.json" "$HOST" "$SRC"
fi

echo "==> Installing $SRC -> $DROPIN_DST"
if [ -f "$DROPIN_DST" ] && ! cmp -s "$SRC" "$DROPIN_DST"; then
  $SUDO cp -a "$DROPIN_DST" "$DROPIN_DST.bak.$(date +%Y%m%d%H%M%S)"
  echo "    previous copy kept as $DROPIN_DST.bak.<ts> (rollback: cp it back)"
fi
$SUDO install -D -m0644 "$SRC" "$DROPIN_DST"
$SUDO systemctl daemon-reload

echo "==> Effective per-host values now in the unit:"
$SUDO systemctl show "$SERVICE" -p Environment --no-pager | tr ' ' '\n' \
  | grep -E '^(VM_NAME|AGENT_PUBLIC_URL|HH_PLATFORM_URL|CRON_SCHEDULER_ROLE|MAX_CONCURRENT_TASKS)=' \
  | sed 's/^/    /' || echo "    (none — is $SERVICE installed on this host?)"

if [ "$RESTART" = 1 ]; then
  echo "==> Restarting $SERVICE (instant, no drain — running tasks resume from the journal)"
  $SUDO systemctl reset-failed "$SERVICE" 2>/dev/null || true
  $SUDO systemctl restart "$SERVICE"
  sleep 2
  curl -fsS -m 5 "http://127.0.0.1:${PORT:-8080}/health" && echo
else
  echo "==> Skipping restart (--no-restart). New values apply on the next start:"
  echo "    sudo systemctl restart $SERVICE"
fi