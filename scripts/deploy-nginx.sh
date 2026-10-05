#!/usr/bin/env bash
# Explicit environment; validate the complete shared nginx configuration every time.
set -Eeuo pipefail
case "${DEPLOY_ENV:-}" in gcp|ru|vm2) ;; *) echo 'DEPLOY_ENV must be gcp, ru or vm2' >&2; exit 1;; esac
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
NGINX_ROOT=${NGINX_ROOT:-/etc/nginx}
backup=''
changed=()
restore() {
  if (( ${#changed[@]} )); then
    for name in "${changed[@]}"; do
      sudo rm -f "$NGINX_ROOT/sites-enabled/$name"
      if [[ -e "$backup/$name" || -L "$backup/$name" ]]; then
        sudo cp -a "$backup/$name" "$NGINX_ROOT/sites-enabled/$name"
      fi
    done
    echo "Restored previous nginx sites; backup: $backup" >&2
    sudo nginx -t || true
  fi
}
trap 'restore; exit 1' ERR
sudo nginx -t
sites=()
if [[ "$DEPLOY_ENV" == gcp ]]; then
  sites=(relay agent-trainedassist-store)
elif [[ "$DEPLOY_ENV" == vm2 ]]; then
  # The second agent host (issue #2114). One site, on this box's own origin:
  # it serves /agent/, /mcp, /tokens, /connect/*, /hh*. The stable branded
  # hostname stays on GCP until P2 moves consumers — installing it here would
  # be the cutover, and that is the owner's call, not a deploy's.
  sites=(agent-vm2)
elif [[ "${DEPLOY_RECRUITER_APEX:-}" == 1 || -e "$NGINX_ROOT/sites-enabled/recruiter-assistant" ]]; then
  sites=(recruiter-assistant)
  # Exhibition catalogs on <event_key>.sales-manager-assistant.ru. Separate
  # flag and separate gate: this config must never be installed on GCP, and it
  # needs a certificate that covers the wildcard.
  if [[ "${DEPLOY_SALES_APEX:-}" == 1 || -e "$NGINX_ROOT/sites-enabled/sales-manager-assistant" ]]; then
    sites+=(sales-manager-assistant)
  fi
fi
if (( ${#sites[@]} )); then
  # Both public hostnames must accept the same media sizes. The stable tunnel
  # hostname used by the gateway was previously outside deployment management.
  for name in "${sites[@]}"; do
    src="$REPO_DIR/infra/nginx/$name.conf"
    dst="$NGINX_ROOT/sites-enabled/$name"
    if ! sudo cmp -s "$src" "$dst"; then
      if [[ -z "$backup" ]]; then backup=$(sudo mktemp -d "$NGINX_ROOT/relay-backup.XXXXXX"); fi
      if [[ -e "$dst" || -L "$dst" ]]; then sudo cp -a "$dst" "$backup/$name"; fi
      changed+=("$name")
      sudo install -m 644 "$src" "$backup/candidate"
      sudo mv -T "$backup/candidate" "$dst"
    fi
  done
  sudo nginx -t
fi
# RU and VM2 never install relay. A broken pre-existing config fails loudly.
if sudo systemctl is-active --quiet nginx; then
  sudo systemctl reload nginx
else
  sudo systemctl start nginx
fi
trap - ERR
